import Foundation
import WebKit

final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let script = """
    (() => {
      if (window.top !== window) return;
      const invoke = (method, args = {}) => window.webkit.messageHandlers.hevetaNative.postMessage({method, args});
      Object.defineProperty(window, 'hevetaNative', {value: Object.freeze({
        version: 1, info: () => invoke('info'), bind: args => invoke('bind', args),
        syncUser: userId => invoke('syncUser', {userId}), setEnabled: enabled => invoke('setEnabled', {enabled}), unbind: () => invoke('unbind'),
        screenPermission: () => invoke('screenPermission'), inputPermission: () => invoke('inputPermission')
      }), writable: false});
    })();
    """
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, AppConfiguration.hasAppOrigin(url),
              let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, "Untrusted native bridge request"); return
        }
        let args = body["args"] as? [String: Any] ?? [:]
        Task { @MainActor in
            let device = DeviceController.shared
            do {
                switch method {
                case "info": await device.updatePermissions()
                case "bind":
                    guard let id = args["deviceId"] as? String, let user = args["userId"] as? String, let credential = args["credential"] as? String else { throw DeviceError.message("Invalid binding") }
                    try await device.bind(deviceId: id, userId: user, credential: credential)
                case "setEnabled":
                    guard let enabled = args["enabled"] as? Bool else { throw DeviceError.message("Invalid switch value") }
                    try await device.setEnabled(enabled)
                case "syncUser":
                    guard let userId = args["userId"] as? String else { throw DeviceError.message("Invalid account") }
                    await device.syncUser(userId)
                case "unbind": try await device.unbind()
                case "screenPermission": device.permissions.requestScreen(); await device.updatePermissions()
                case "inputPermission": device.permissions.requestInput(); await device.updatePermissions()
                default: throw DeviceError.message("Unknown native method")
                }
                let data = try JSONEncoder().encode(device.info)
                replyHandler(try JSONSerialization.jsonObject(with: data), nil)
            } catch { replyHandler(nil, error.localizedDescription) }
        }
    }
}
