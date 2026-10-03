import Foundation
import WebRTC

final class DesktopController {
    var signal: (@Sendable ([String: JSONValue]) async -> Void)?
    var statusSent = false
    private let capture = DesktopCapture()
    private let input = DesktopInput()
    private lazy var factory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    private lazy var source = factory.videoSource(forScreenCast: true)
    private var sessions: [String: RemoteDesktopSession] = [:]
    private var pending = Set<String>()
    private var starting: Task<Void, Error>?
    private var agentInputOwner: String?
    private var controller: String?
    func receive(_ message: [String: JSONValue]) async {
        let id = message.text("sessionId")
        guard !id.isEmpty else { return }
        do {
            switch message.text("type") {
            case "remote_start":
                guard sessions[id] == nil, !pending.contains(id), sessions.count + pending.count < 8 else { throw DeviceError.message("Remote session limit reached") }
                guard !message.flag("control") || DesktopPermissions().inputAllowed else { throw DeviceError.message("Accessibility permission is required to control this Mac") }
                guard !message.flag("control") || controller == nil else { throw DeviceError.message("Another session controls this Mac") }
                if message.flag("control") { input.release(); agentInputOwner = nil; controller = id }
                pending.insert(id)
                if starting == nil {
                    let capture = self.capture, source = self.source
                    starting = Task { [weak self] in try await capture.start(source: source) { [weak self] error in Task { @MainActor in await self?.captureFailed(error) } } }
                }
                try await starting!.value
                guard pending.remove(id) != nil else { return }
                let session = try RemoteDesktopSession(factory: factory, source: source, control: message.flag("control"), ice: message["iceServers"]?.array?.compactMap(\.object) ?? [], signal: { [weak self] data in
                    Task { @MainActor in await self?.send(id, data: data) }
                }, input: { [weak self] data in Task { @MainActor in self?.receiveInput(id, data: data) } })
                sessions[id] = session
                try await session.offer()
            case "remote_stop": stop(id)
            case "signal": if let data = message["signal"]?.object { try await sessions[id]?.receive(data) }
            default: break
            }
        } catch {
            stop(id)
            await signal?(["type": .string("remote_error"), "sessionId": .string(id), "error": .string(error.localizedDescription)])
        }
    }
    private func send(_ id: String, data: [String: JSONValue]) async {
        guard sessions[id] != nil else { return }
        if let error = data["error"] {
            stop(id); await signal?(["type": .string("remote_error"), "sessionId": .string(id), "error": error])
        } else { await signal?(["type": .string("signal"), "sessionId": .string(id), "signal": .object(data)]) }
    }
    private func receiveInput(_ id: String, data: Data) {
        guard let session = sessions[id], session.control, controller == id,
              let args = try? JSONDecoder().decode([String: JSONValue].self, from: data) else { return }
        try? input.receive(args, bounds: capture.bounds)
    }
    private func captureFailed(_ error: String) async {
        for id in sessions.keys { await signal?(["type": .string("remote_error"), "sessionId": .string(id), "error": .string(error)]) }
        stopAll()
    }
    private func stop(_ id: String) {
        pending.remove(id)
        if controller == id { input.release(); controller = nil }
        if let session = sessions.removeValue(forKey: id) { if session.control { input.release() }; session.close() }
        if sessions.isEmpty && pending.isEmpty { starting?.cancel(); starting = nil; capture.stop() }
    }
    func stopAll() {
        pending.removeAll()
        for session in sessions.values { session.close() }
        sessions.removeAll(); input.release(); agentInputOwner = nil; controller = nil; starting?.cancel(); starting = nil; capture.stop(); statusSent = false
    }
    func permissionsChanged(screen: Bool, input: Bool) {
        if !screen { stopAll() }
        else if !input { for (id, session) in sessions where session.control { stop(id) } }
    }
    func perform(_ command: DeviceCommand, files: DeviceFiles) async throws -> [String: JSONValue] {
        let owner = String(command.id.split(separator: ":", maxSplits: 1).first ?? "")
        if command.method == "release_input" {
            if agentInputOwner == owner { input.release(); agentInputOwner = nil }
            return ["output": .string("Run input released")]
        }
        let action = command.method == "screenshot" ? "screenshot" : command.arguments.text("action")
        if action != "screenshot" {
            guard controller == nil else { throw DeviceError.message("A person controls the desktop; wait for them to release it") }
            guard agentInputOwner == nil || agentInputOwner == owner else { throw DeviceError.message("Another task holds desktop input") }
            try input.receive(command.arguments, bounds: CGDisplayBounds(CGMainDisplayID()))
            if action == "release" || action == "type" { agentInputOwner = nil }
            else { agentInputOwner = owner }
            return ["output": .string("Desktop action completed")]
        }
        let (data, width, height) = try await capture.screenshot()
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("heveta-screen-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: url) }
        try data.write(to: url)
        let file = try await files.upload(url, jobId: command.id, mimeType: "image/png")
        return ["output": .string("Main display screenshot: \(width) × \(height). Input coordinates are normalized from 0 to 1."), "file": .object(file)]
    }
}
