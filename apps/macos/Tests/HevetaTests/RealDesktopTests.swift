import AppKit
import ApplicationServices
import Foundation
import Testing
@testable import Heveta

@MainActor private final class DesktopQAText: NSTextView {
    private(set) var leftArrowReceived = false
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 123 { leftArrowReceived = true }
        super.keyDown(with: event)
    }
}

@MainActor private final class DesktopQATarget: NSObject {
    static let expectedText = "Heveta 中文🙂"
    let window: NSWindow
    let text = DesktopQAText(frame: NSRect(x: 0, y: 0, width: 480, height: 100))
    private(set) var pointerVerified = false

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 240),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Heveta remote desktop QA"
        window.isReleasedWhenClosed = false
        text.isRichText = false; text.font = .systemFont(ofSize: 20)
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.documentView = text
        let label = NSTextField(labelWithString: "Send “\(Self.expectedText)”, press Left Arrow in the video, then click Verify pointer.")
        label.maximumNumberOfLines = 3; label.lineBreakMode = .byWordWrapping
        let button = NSButton(title: "Verify pointer", target: self, action: #selector(verifyPointer))
        let stack = NSStackView(views: [label, scroll, button])
        stack.orientation = .vertical; stack.spacing = 12; stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView(); window.contentView = content; content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 100),
        ])
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(); window.makeFirstResponder(text)
    }

    @objc private func verifyPointer() {
        if NSApplication.shared.currentEvent?.type == .leftMouseUp { pointerVerified = true }
    }
}

// The positive test runs only after explicit user approval and OS permission.
// It uses the production controller, capture, input and peer implementation;
// no generated frames or intercepted input stand in for the desktop.
@MainActor struct RealDesktopTests {
    @Test(.enabled(if: !CGPreflightScreenCaptureAccess() || !AXIsProcessTrusted()))
    func unavailableDesktopPermissionsAreRejected() async {
        if !CGPreflightScreenCaptureAccess() {
            await #expect(throws: DeviceError.self) { _ = try await DesktopCapture().screenshot() }
        }
        if !AXIsProcessTrusted() {
            #expect(throws: DeviceError.self) {
                try DesktopInput().receive(["action": .string("type"), "text": .string("must not be typed")],
                                           bounds: CGDisplayBounds(CGMainDisplayID()))
            }
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["HEVETA_TEST_REAL_DESKTOP"] != nil))
    func screenCaptureAndRemoteInputOnOwnedQAWindow() async throws {
        guard let path = ProcessInfo.processInfo.environment["HEVETA_TEST_REAL_DESKTOP"] else { return }
        struct Fixture: Decodable {
            struct Device: Decodable { let id: String }
            let device: Device; let userId: String; let credential: String; let origin: URL
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard ["localhost", "127.0.0.1", "::1"].contains(fixture.origin.host ?? ""),
              AppConfiguration.hasAppOrigin(fixture.origin) else {
            throw DeviceError.message("Use a local QA fixture and set HEVETA_APP_URL to its origin")
        }
        guard CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() else {
            throw DeviceError.message("Real desktop QA needs user-approved Screen Recording and Accessibility permissions; this test does not request or grant them")
        }
        guard ProcessInfo.processInfo.environment["HEVETA_TEST_DEVICE"] == nil,
              ProcessInfo.processInfo.environment["HEVETA_TEST_LIVE_DEVICE"] == nil else {
            throw DeviceError.message("Run real desktop QA separately from the other network fixtures")
        }

        let root = URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("RealDesktop")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let ready = root.appendingPathComponent("ready.json")
        try? FileManager.default.removeItem(at: ready)
        let account = "qa-real-desktop-" + UUID().uuidString
        let controller = DeviceController(workspaceURL: root.appendingPathComponent(UUID().uuidString).appendingPathComponent("Workspace"), keychainAccount: account)
        let target = DesktopQATarget()
        defer { target.window.close(); try? DeviceKeychain.save(nil, account: account); try? FileManager.default.removeItem(at: ready) }
        do {
            await controller.syncUser(fixture.userId)
            try await controller.bind(deviceId: fixture.device.id, userId: fixture.userId, credential: fixture.credential)
            try await controller.setEnabled(true)
            for _ in 0..<100 {
                if controller.connected { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            try #require(controller.connected)
            let (png, width, height) = try await DesktopCapture().screenshot()
            let image = try #require(NSBitmapImageRep(data: png))
            #expect(image.pixelsWide == width && image.pixelsHigh == height)
            #expect(width > 0 && width <= 1920 && height > 0 && height <= 1080)
            let screenshot = root.appendingPathComponent("desktop.png")
            try png.write(to: screenshot, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: screenshot.path)
            try JSONSerialization.data(withJSONObject: ["deviceId": fixture.device.id, "expectedText": DesktopQATarget.expectedText])
                .write(to: ready, options: .atomic)

            // The browser must receive live video, use the production control
            // DataChannel to type Unicode, send a physical key, and click this
            // test-owned button. Keyboard activation cannot prove a mouse click.
            for _ in 0..<1800 {
                if target.text.string == DesktopQATarget.expectedText && target.text.leftArrowReceived && target.pointerVerified { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            #expect(target.text.string == DesktopQATarget.expectedText)
            #expect(target.text.leftArrowReceived)
            #expect(target.pointerVerified)
            await controller.disable()
            try await controller.unbind()
            #expect(!controller.enabled && !controller.connected)
        } catch {
            await controller.disable()
            try? await controller.unbind()
            throw error
        }
    }
}
