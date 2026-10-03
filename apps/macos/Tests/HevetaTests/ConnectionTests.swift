import Foundation
import Testing
@testable import Heveta

// Opt-in local integration test; no production user, keychain entry or files.
// HEVETA_TEST_DEVICE points to an ignored fixture created with the local RPC.
@Suite(.serialized) @MainActor struct ConnectionTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["HEVETA_TEST_DEVICE"] != nil && ProcessInfo.processInfo.environment["HEVETA_TEST_LIVE_DEVICE"] == nil)) func nativeTransportAcceptsRealBrokerHandshake() async throws {
        guard let path = ProcessInfo.processInfo.environment["HEVETA_TEST_DEVICE"] else { return }
        struct Fixture: Decodable {
            struct Device: Decodable { let id: String }
            let device: Device; let userId: String; let credential: String; let origin: URL
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        var url = URLComponents(url: fixture.origin.appendingPathComponent("device/connect"), resolvingAgainstBaseURL: false)!
        url.scheme = "ws"
        var request = URLRequest(url: url.url!); request.setValue("Bearer \(fixture.credential)", forHTTPHeaderField: "Authorization")
        let socket = URLSession.shared.webSocketTask(with: request); socket.resume()
        defer { socket.cancel(with: .normalClosure, reason: nil) }
        let frame = try await socket.receive()
        guard case .string(let text) = frame else { Issue.record("Expected native hello"); return }
        let message = try JSONDecoder().decode([String: JSONValue].self, from: Data(text.utf8))
        #expect(message.text("type") == "hello"); #expect(message.number("version") == 1)
        try await socket.send(.string("{\"type\":\"status\",\"screenAllowed\":false,\"inputAllowed\":false}"))
        try await socket.send(.string("ping"))
        let pong = try await socket.receive()
        if case .string(let value) = pong { #expect(value == "pong") } else { Issue.record("Expected heartbeat response") }
    }
    @Test(.enabled(if: ProcessInfo.processInfo.environment["HEVETA_TEST_DEVICE"] != nil && ProcessInfo.processInfo.environment["HEVETA_TEST_LIVE_DEVICE"] == nil))
    func nativeControllerKeepsNewBindingAndRejectsAnotherAccount() async throws {
        guard let path = ProcessInfo.processInfo.environment["HEVETA_TEST_DEVICE"] else { return }
        struct Fixture: Decodable {
            struct Device: Decodable { let id: String }
            let device: Device; let userId: String; let credential: String; let origin: URL
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard AppConfiguration.hasAppOrigin(fixture.origin) else { Issue.record("Set HEVETA_APP_URL to the local fixture origin"); return }
        let account = "qa-controller-" + UUID().uuidString
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? DeviceKeychain.save(nil, account: account); try? FileManager.default.removeItem(at: directory) }
        let controller = DeviceController(workspaceURL: directory.appendingPathComponent("Workspace"), keychainAccount: account)
        await controller.syncUser(fixture.userId)
        try await controller.bind(deviceId: fixture.device.id, userId: fixture.userId, credential: fixture.credential)
        try await controller.setEnabled(true)
        for _ in 0..<100 { if controller.connected { break }; try await Task.sleep(for: .milliseconds(30)) }
        #expect(controller.connected)
        let removing = Task { try await controller.unbind() }
        await Task.yield()
        let credential = UUID().uuidString.lowercased() + UUID().uuidString.lowercased()
        try await controller.bind(deviceId: fixture.device.id, userId: fixture.userId, credential: credential)
        try await removing.value
        #expect(controller.binding?.credential == credential)
        #expect(try DeviceKeychain.load(account: account)?.credential == credential)
        #expect(!controller.enabled)
        await controller.syncUser("another-qa-account")
        #expect(!controller.canEnable)
        await #expect(throws: DeviceError.self) { try await controller.setEnabled(true) }
        await #expect(throws: DeviceError.self) { try await controller.bind(deviceId: fixture.device.id, userId: fixture.userId, credential: credential) }
        try await controller.unbind()
    }

}
