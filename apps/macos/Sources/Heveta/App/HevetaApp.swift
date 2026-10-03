import AppKit
import SwiftUI

@main
struct HevetaApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var device = DeviceController.shared

    var body: some Scene {
        MenuBarExtra("Heveta", systemImage: "bubble.left.and.bubble.right") {
            Button("Open Heveta") { appDelegate.openMainWindow() }
                .keyboardShortcut("n")
            Divider()
            Text(String(localized: device.connected ? "Connected" : device.enabled ? "Reconnecting…" : "Access disabled"))
            Toggle("Allow access to this Mac", isOn: Binding(get: { device.enabled }, set: { value in Task { try? await device.setEnabled(value) } }))
                .disabled(!device.canEnable)
            Button("Screen Recording permission") { device.permissions.requestScreen() }
            Button("Accessibility permission") { device.permissions.requestInput() }
            if let error = device.error { Text(error) }
            Divider()
            Button("Quit Heveta") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q")
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Open Heveta") { appDelegate.openMainWindow() }.keyboardShortcut("n")
            }
        }
    }
}
