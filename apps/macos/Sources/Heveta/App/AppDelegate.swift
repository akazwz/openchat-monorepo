import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var mainWindow: NSWindowController?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)
        openMainWindow()
    }
    func applicationDidBecomeActive(_ notification: Notification) {
        Task { await DeviceController.shared.updatePermissions() }
    }
    func openMainWindow() {
        if mainWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "Heveta"
            window.minSize = NSSize(width: 760, height: 540)
            window.setFrameAutosaveName("HevetaMainWindow")
            window.center(); window.isReleasedWhenClosed = false; window.delegate = self
            window.contentView = NSHostingView(rootView: WebAppView(url: AppConfiguration.appURL))
            mainWindow = NSWindowController(window: window)
        }
        mainWindow?.showWindow(nil)
        mainWindow?.window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate()
    }
    func windowWillClose(_ notification: Notification) {
        // Dispose the web window and its viewer connections. The native
        // device controller and executor remain owned by the application.
        mainWindow?.window?.contentView = nil
        mainWindow = nil
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { openMainWindow() }
        return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task { await DeviceController.shared.disable(); sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
