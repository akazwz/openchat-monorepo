import AppKit
@preconcurrency import ApplicationServices

@Observable final class DesktopPermissions {
    var screenAllowed = CGPreflightScreenCaptureAccess()
    var inputAllowed = AXIsProcessTrusted()
    func refresh() {
        screenAllowed = CGPreflightScreenCaptureAccess()
        inputAllowed = AXIsProcessTrusted()
    }
    func requestScreen() {
        _ = CGRequestScreenCaptureAccess()
        refresh()
        if !screenAllowed { openSettings("Privacy_ScreenCapture") }
    }
    func requestInput() {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        refresh()
    }
    private func openSettings(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }
}
