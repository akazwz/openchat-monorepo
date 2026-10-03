import Foundation

enum AppConfiguration {
    static let appURL: URL = {
        if let value = ProcessInfo.processInfo.environment["HEVETA_APP_URL"],
           let url = URL(string: value),
           url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")) {
            return url
        }
        return URL(string: "https://app.heveta.com")!
    }()

    static func hasAppOrigin(_ url: URL) -> Bool {
        url.scheme == appURL.scheme && url.host == appURL.host && url.port == appURL.port
    }
}
