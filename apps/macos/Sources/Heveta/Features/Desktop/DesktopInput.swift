import ApplicationServices
import Foundation

final class DesktopInput {
    private var keys = Set<CGKeyCode>()
    private var buttons = Set<Int>()
    private var point = CGPoint.zero
    private var flags: CGEventFlags = []
    static let codes: [String: CGKeyCode] = [
        "KeyA":0,"KeyS":1,"KeyD":2,"KeyF":3,"KeyH":4,"KeyG":5,"KeyZ":6,"KeyX":7,"KeyC":8,"KeyV":9,
        "KeyB":11,"KeyQ":12,"KeyW":13,"KeyE":14,"KeyR":15,"KeyY":16,"KeyT":17,"Digit1":18,"Digit2":19,
        "Digit3":20,"Digit4":21,"Digit6":22,"Digit5":23,"Equal":24,"Digit9":25,"Digit7":26,"Minus":27,
        "Digit8":28,"Digit0":29,"BracketRight":30,"KeyO":31,"KeyU":32,"BracketLeft":33,"KeyI":34,"KeyP":35,
        "Enter":36,"KeyL":37,"KeyJ":38,"Quote":39,"KeyK":40,"Semicolon":41,"Backslash":42,"Comma":43,
        "Slash":44,"KeyN":45,"KeyM":46,"Period":47,"Tab":48,"Space":49,"Backquote":50,"Backspace":51,
        "Escape":53,"MetaRight":54,"MetaLeft":55,"ShiftLeft":56,"CapsLock":57,"AltLeft":58,"ControlLeft":59,
        "ShiftRight":60,"AltRight":61,"ControlRight":62,"F17":64,"NumpadDecimal":65,"NumpadMultiply":67,
        "NumpadAdd":69,"NumLock":71,"NumpadDivide":75,"NumpadEnter":76,"NumpadSubtract":78,"F18":79,
        "F19":80,"NumpadEqual":81,"Numpad0":82,"Numpad1":83,"Numpad2":84,"Numpad3":85,"Numpad4":86,
        "Numpad5":87,"Numpad6":88,"Numpad7":89,"F20":90,"Numpad8":91,"Numpad9":92,"F5":96,"F6":97,
        "F7":98,"F3":99,"F8":100,"F9":101,"F11":103,"F13":105,"F16":106,"F14":107,"F10":109,
        "F12":111,"F15":113,"Insert":114,"Home":115,"PageUp":116,"Delete":117,"F4":118,"End":119,
        "F2":120,"PageDown":121,"F1":122,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126,
    ]
    private func modifiers(_ args: [String: JSONValue]) -> CGEventFlags {
        var result: CGEventFlags = []
        if args.flag("meta") { result.insert(.maskCommand) }
        if args.flag("ctrl") { result.insert(.maskControl) }
        if args.flag("alt") { result.insert(.maskAlternate) }
        if args.flag("shift") { result.insert(.maskShift) }
        return result
    }
    func receive(_ args: [String: JSONValue], bounds: CGRect) throws {
        guard AXIsProcessTrusted() else { release(); throw DeviceError.message("Accessibility permission is required") }
        flags = modifiers(args)
        switch args.text("action") {
        case "move", "down", "up", "click":
            let x = args.number("x"), y = args.number("y")
            guard x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else { throw DeviceError.message("Pointer coordinates must be normalized from 0 to 1") }
            point = CGPoint(x: bounds.minX + x * bounds.width, y: bounds.minY + y * bounds.height)
            let button = Int(min(max(args.number("button"), 0), 2))
            let action = args.text("action")
            if action == "click" {
                for index in 1...Int(min(max(args.number("count", default: 1), 1), 2)) { mouse("down", button: button, clicks: index); mouse("up", button: button, clicks: index) }
            } else { mouse(action, button: button) }
        case "scroll":
            let dy = Int32(min(max(args.number("dy"), -1000), 1000)), dx = Int32(min(max(args.number("dx"), -1000), 1000))
            let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0)
            event?.flags = flags; event?.post(tap: .cghidEventTap)
        case "key":
            guard let code = Self.codes[args.text("code")] else { throw DeviceError.message("Unsupported key code") }
            let down = args.flag("down")
            if down { keys.insert(code) } else { keys.remove(code) }
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
            event?.flags = flags; event?.post(tap: .cghidEventTap)
        case "type":
            release()
            let text = args.text("text")
            guard text.count <= 8000 else { throw DeviceError.message("Text is too long") }
            // A Unicode scalar's UTF-16 units stay together (including emoji).
            for scalar in text.unicodeScalars {
                let units = Array(String(scalar).utf16)
                for down in [true, false] {
                    let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                    units.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
                    event?.post(tap: .cghidEventTap)
                }
            }
        case "release": release()
        default: throw DeviceError.message("Unsupported input action")
        }
    }
    private func mouse(_ action: String, button: Int, clicks: Int = 1) {
        let button = action == "move" ? buttons.first ?? button : button
        let b: CGMouseButton = button == 2 ? .right : button == 1 ? .center : .left
        let type: CGEventType
        if action == "down" { buttons.insert(button); type = button == 2 ? .rightMouseDown : button == 1 ? .otherMouseDown : .leftMouseDown }
        else if action == "up" { buttons.remove(button); type = button == 2 ? .rightMouseUp : button == 1 ? .otherMouseUp : .leftMouseUp }
        else { type = buttons.contains(0) ? .leftMouseDragged : buttons.contains(2) ? .rightMouseDragged : buttons.contains(1) ? .otherMouseDragged : .mouseMoved }
        let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: b)
        event?.flags = flags
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
        event?.post(tap: .cghidEventTap)
    }
    func release() {
        for code in keys { CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap) }
        keys.removeAll()
        for button in Array(buttons) { mouse("up", button: button) }
        flags = []
    }
}
