import AppKit
import SwiftUI
import WebKit
import Observation

@Observable final class WebAppState {
    var failed = false
    weak var view: WKWebView?
}

struct WebAppView: View {
    let url: URL
    @State private var state = WebAppState()
    var body: some View {
        ZStack {
            WebContentView(url: url, state: state)
            if state.failed {
                VStack(spacing: 16) {
                    Image(systemName: "wifi.exclamationmark").font(.largeTitle)
                    Text("Heveta could not load. Check your connection and try again.")
                    Button("Try again") { state.failed = false; state.view?.load(URLRequest(url: url)) }
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.windowBackground)
            }
        }
    }
}

private struct WebContentView: NSViewRepresentable {
    let url: URL
    let state: WebAppState

    func makeCoordinator() -> Coordinator { Coordinator(state: state) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.addScriptMessageHandler(context.coordinator.bridge, contentWorld: .page, name: "hevetaNative")
        configuration.userContentController.addUserScript(WKUserScript(source: NativeBridge.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        context.coordinator.view = view
        state.view = view
        context.coordinator.observeStatus()
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        coordinator.view = nil
        coordinator.state.view = nil
        nsView.stopLoading()
        nsView.configuration.userContentController.removeScriptMessageHandler(forName: "hevetaNative", contentWorld: .page)
        nsView.navigationDelegate = nil
        nsView.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        let state: WebAppState
        init(state: WebAppState) { self.state = state }
        let bridge = NativeBridge()
        weak var view: WKWebView?
        func observeStatus() {
            guard view != nil else { return }
            withObservationTracking { _ = DeviceController.shared.info } onChange: { [weak self] in
                Task { @MainActor in self?.publishStatus(); self?.observeStatus() }
            }
        }
        func publishStatus() {
            guard let view, let url = view.url, AppConfiguration.hasAppOrigin(url), let data = try? JSONEncoder().encode(DeviceController.shared.info), let json = String(data: data, encoding: .utf8) else { return }
            view.evaluateJavaScript("window.dispatchEvent(new CustomEvent('heveta:device',{detail:\(json)}))", completionHandler: nil)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { state.failed = false; publishStatus() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            if (error as NSError).code != NSURLErrorCancelled { state.failed = true }
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            if (error as NSError).code != NSURLErrorCancelled { state.failed = true }
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard action.targetFrame?.isMainFrame != false, let url = action.request.url else { return .allow }
            if action.shouldPerformDownload { return .download }
            if url.scheme == "blob", let origin = URL(string: String(url.absoluteString.dropFirst(5))), AppConfiguration.hasAppOrigin(origin) { return .download }
            guard !AppConfiguration.hasAppOrigin(url) else { return .allow }
            if ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            return .cancel
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            response.canShowMIMEType ? .allow : .download
        }
        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
            let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename
            return await panel.begin() == .OK ? panel.url : nil
        }
        func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
            let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = parameters.allowsDirectories
            return await panel.begin() == .OK ? panel.urls : nil
        }
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
            let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: String(localized: "OK")); alert.runModal()
        }
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
            let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: String(localized: "OK")); alert.addButton(withTitle: String(localized: "Cancel")); return alert.runModal() == .alertFirstButtonReturn
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, ["https", "http", "mailto"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
            return nil
        }
    }
}
