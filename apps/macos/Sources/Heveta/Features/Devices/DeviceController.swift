import AppKit
import Foundation
import Observation

@Observable final class DeviceController {
    static let shared = DeviceController()
    let permissions = DesktopPermissions()
    let workspace: URL
    let clientId: String
    private let keychainAccount: String
    private(set) var webUserId: String?
    var canEnable: Bool { binding != nil && (webUserId == nil || webUserId == binding?.userId) }
    private(set) var binding: DeviceBinding?
    private(set) var enabled = false
    private(set) var connected = false
    private(set) var error: String?
    private var connection: Task<Void, Never>?
    private var stopping: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var executor: DeviceExecutor?
    private var generation = UUID()
    // Installed by the desktop module; owned outside any web window.
    let desktop = DesktopController()
    init(workspaceURL: URL? = nil, keychainAccount: String = "binding") {
        self.keychainAccount = keychainAccount
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Heveta", isDirectory: true)
        workspace = workspaceURL ?? support.appendingPathComponent("Workspace", isDirectory: true)
        clientId = UserDefaults.standard.string(forKey: "deviceClientId") ?? UUID().uuidString.lowercased()
        UserDefaults.standard.set(clientId, forKey: "deviceClientId")
        do {
            try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            binding = try DeviceKeychain.load(account: keychainAccount)
            if let binding, !AppConfiguration.hasAppOrigin(binding.origin) { self.binding = nil }
        } catch { self.error = error.localizedDescription }
    }
    var info: [String: JSONValue] {
        ["clientId": .string(clientId), "name": .string(Host.current().localizedName ?? "Mac"),
         "osVersion": .string(ProcessInfo.processInfo.operatingSystemVersionString), "workspacePath": .string(workspace.path),
         "deviceId": .string(binding?.deviceId ?? ""), "userId": .string(binding?.userId ?? ""),
         "enabled": .bool(enabled), "online": .bool(connected),
         "screenAllowed": .bool(permissions.screenAllowed), "inputAllowed": .bool(permissions.inputAllowed),
         "error": error.map(JSONValue.string) ?? .null]
    }
    func bind(deviceId: String, userId: String, credential: String) async throws {
        guard UUID(uuidString: deviceId) != nil, !userId.isEmpty, credential.range(of: "^[a-f0-9-]{72}$", options: .regularExpression) != nil else { throw DeviceError.message("Invalid device binding") }
        guard webUserId == nil || webUserId == userId else { throw DeviceError.message("The signed-in account changed") }
        await disable()
        guard webUserId == nil || webUserId == userId else { throw DeviceError.message("The signed-in account changed") }
        let binding = DeviceBinding(deviceId: deviceId, userId: userId, credential: credential, origin: AppConfiguration.appURL)
        try DeviceKeychain.save(binding, account: keychainAccount)
        self.binding = binding; error = nil
    }
    func setEnabled(_ value: Bool) async throws {
        if !value { await disable(); return }
        if let stopping { await stopping.value }
        guard let binding, canEnable else { throw DeviceError.message("Sign in to the account bound to this Mac or connect it again") }
        if enabled { return }
        generation = UUID()
        let current = generation
        executor = try DeviceExecutor(binding: binding, workspace: workspace, emit: { [weak self] id, result in
            await self?.result(id, result, generation: current)
        }, desktop: { [weak self] command in
            guard let self else { throw DeviceError.message("Client exited") }
            return try await self.desktop.perform(command, files: DeviceFiles(workspace: self.workspace, binding: binding))
        })
        enabled = true; error = nil
        desktop.signal = { [weak self] message in await self?.send(message) }
        connection = Task { await self.connect(binding: binding, generation: current) }
    }
    func disable() async {
        if let stopping { await stopping.value; return }
        enabled = false; connected = false
        desktop.stopAll()
        let previous = executor; executor = nil
        let transport = socket
        let task = Task { [self] in
            await previous?.stop()
            if let transport {
                // Keep the receive loop alive while the ordered shutdown frame
                // is sent. A network loss still falls back to journal recovery.
                let deadline = Task { try? await Task.sleep(for: .seconds(2)); if !Task.isCancelled { transport.cancel(with: .goingAway, reason: nil) } }
                try? await transport.send(.string("{\"type\":\"disabled\"}"))
                deadline.cancel()
            }
            generation = UUID()
            connection?.cancel(); connection = nil
            transport?.cancel(with: .goingAway, reason: nil); socket = nil
            stopping = nil
        }
        stopping = task
        await task.value
    }
    func syncUser(_ userId: String) async {
        webUserId = userId
        if binding?.userId != userId { await disable() }
    }
    func unbind() async throws {
        let previous = binding
        await disable()
        guard binding == previous else { return }
        try DeviceKeychain.save(nil, account: keychainAccount)
        binding = nil
    }
    private func result(_ id: String, _ result: DeviceResult, generation: UUID) async {
        guard generation == self.generation, enabled else { return }
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(result)) else { return }
        await send(["type": .string("result"), "id": .string(id), "result": value])
    }
    func send(_ message: [String: JSONValue]) async {
        guard let socket, let data = try? JSONEncoder().encode(message), let text = String(data: data, encoding: .utf8) else { return }
        do { try await socket.send(.string(text)) } catch { socket.cancel(with: .goingAway, reason: nil) }
    }
    private func connect(binding: DeviceBinding, generation: UUID) async {
        var backoff = 1.0
        while enabled && generation == self.generation && !Task.isCancelled {
            var url = URLComponents(url: binding.origin.appendingPathComponent("device/connect"), resolvingAgainstBaseURL: false)!
            url.scheme = url.scheme == "https" ? "wss" : "ws"
            var request = URLRequest(url: url.url!)
            request.setValue("Bearer \(binding.credential)", forHTTPHeaderField: "Authorization")
            let transport = URLSession.shared.webSocketTask(with: request)
            transport.maximumMessageSize = 512 * 1024
            socket = transport; transport.resume()
            var lastPong = Date()
            let heartbeat = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(20)); if Date().timeIntervalSince(lastPong) > 35 { throw DeviceError.message("Device heartbeat timed out") }; try await transport.send(.string("ping")); await self?.updatePermissions() }
                    catch { transport.cancel(with: .goingAway, reason: nil); return }
                }
            }
            do {
                while generation == self.generation && !Task.isCancelled {
                    let frame = try await transport.receive()
                    guard generation == self.generation, !Task.isCancelled else { break }
                    guard case .string(let text) = frame else { throw DeviceError.message("Invalid device frame") }
                    if text == "pong" { lastPong = Date(); continue }
                    let message = try JSONDecoder().decode([String: JSONValue].self, from: Data(text.utf8))
                    switch message.text("type") {
                    case "hello":
                        guard enabled else { continue }
                        guard message.number("version") == 1 else { throw DeviceError.message("Unsupported device protocol") }
                        lastPong = Date(); connected = true; desktop.statusSent = false; backoff = 1; error = nil
                        await updatePermissions()
                    case "execute":
                        guard enabled else { continue }
                        let command = try JSONDecoder().decode(DeviceCommand.self, from: Data(text.utf8))
                        await executor?.execute(command)
                    case "collect": await executor?.collect(message.text("id"))
                    case "cancel": await executor?.cancel(message.text("id"))
                    case "revoked":
                        error = "Device access was revoked"
                        try? await unbind()
                    case "remote_start", "remote_stop", "signal": if enabled { await desktop.receive(message) }
                    default: break
                    }
                }
            } catch {
                if enabled && generation == self.generation {
                    if (transport.response as? HTTPURLResponse)?.statusCode == 401 {
                        self.error = "Device access was revoked"
                        try? await unbind()
                    } else { self.error = error.localizedDescription }
                }
            }
            heartbeat.cancel(); transport.cancel(with: .goingAway, reason: nil)
            guard generation == self.generation else { return }
            connected = false; socket = nil; desktop.stopAll()
            if enabled { try? await Task.sleep(for: .seconds(backoff)); backoff = min(backoff * 2, 30) }
        }
    }
    func updatePermissions() async {
        let oldScreen = permissions.screenAllowed, oldInput = permissions.inputAllowed
        permissions.refresh()
        if !permissions.screenAllowed || !permissions.inputAllowed { desktop.permissionsChanged(screen: permissions.screenAllowed, input: permissions.inputAllowed) }
        if connected && (oldScreen != permissions.screenAllowed || oldInput != permissions.inputAllowed || !desktop.statusSent) {
            desktop.statusSent = true
            await send(["type": .string("status"), "screenAllowed": .bool(permissions.screenAllowed), "inputAllowed": .bool(permissions.inputAllowed)])
        }
    }
}
