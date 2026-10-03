import AppKit
import CoreVideo
import Foundation
import Testing
@preconcurrency import WebRTC
@testable import Heveta

@MainActor private final class InputCount { var value = 0 }

// Opt-in end-to-end fixture: a real native executor and real libwebrtc connect
// to the local Worker. Generated video isolates transport from TCC; it never
// reads the user's desktop or injects input. All account data is local QA data.
@MainActor struct LiveDeviceTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["HEVETA_TEST_LIVE_DEVICE"] != nil))
    func localWorkerNativeExecutorAndBrowserTransport() async throws {
        guard let path = ProcessInfo.processInfo.environment["HEVETA_TEST_LIVE_DEVICE"] else { return }
        struct Fixture: Decodable {
            struct Device: Decodable { let id: String }
            let device: Device; let userId: String; let credential: String; let origin: URL
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard ["localhost", "127.0.0.1", "::1"].contains(fixture.origin.host ?? "") else {
            throw DeviceError.message("Use a local QA fixture")
        }
        let root = URL(fileURLWithPath: path).deletingLastPathComponent()
        let workspace = root.appendingPathComponent("Workspace")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        // Each run must produce fresh evidence; an old file is not proof that
        // this fixture received an agent command or accepted a new connection.
        for file in [root.appendingPathComponent("live-ready"), root.appendingPathComponent("rtc-input-count"), workspace.appendingPathComponent("native-proof.txt")] {
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        }
        defer { try? FileManager.default.removeItem(at: root.appendingPathComponent("live-ready")) }
        let binding = DeviceBinding(deviceId: fixture.device.id, userId: fixture.userId, credential: fixture.credential, origin: fixture.origin)
        var components = URLComponents(url: fixture.origin.appendingPathComponent("device/connect"), resolvingAgainstBaseURL: false)!
        components.scheme = "ws"
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(fixture.credential)", forHTTPHeaderField: "Authorization")
        let socket = URLSession.shared.webSocketTask(with: request); socket.resume()
        defer { socket.cancel(with: .normalClosure, reason: nil) }
        @Sendable func send(_ message: [String: JSONValue]) async {
            if let text = String(data: (try? JSONEncoder().encode(message)) ?? Data(), encoding: .utf8) { try? await socket.send(.string(text)) }
        }
        let executor = try DeviceExecutor(binding: binding, workspace: workspace, emit: { id, result in
            if let value = try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(result)) {
                await send(["type": .string("result"), "id": .string(id), "result": value])
            }
        }, desktop: { _ in throw DeviceError.message("The transport fixture does not access the real desktop") })
        let factory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
        let source = factory.videoSource(forScreenCast: true)
        let capturer = RTCVideoCapturer(delegate: source)
        var sessions: [String: RemoteDesktopSession] = [:]
        let inputCount = InputCount()
        let frames = Task { @MainActor in
            while !Task.isCancelled {
                var buffer: CVPixelBuffer?
                if CVPixelBufferCreate(kCFAllocatorDefault, 640, 360, kCVPixelFormatType_32ARGB, nil, &buffer) == kCVReturnSuccess, let buffer {
                    CVPixelBufferLockBaseAddress(buffer, [])
                    if let bytes = CVPixelBufferGetBaseAddress(buffer) {
                        let words = bytes.bindMemory(to: UInt32.self, capacity: CVPixelBufferGetBytesPerRow(buffer) / 4 * 360)
                        for y in 0..<360 { for x in 0..<640 { words[y * CVPixelBufferGetBytesPerRow(buffer) / 4 + x] = 0x009933ff } }
                    }
                    CVPixelBufferUnlockBaseAddress(buffer, [])
                    source.capturer(capturer, didCapture: RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: buffer), rotation: ._0, timeStampNs: Int64(ProcessInfo.processInfo.systemUptime * 1_000_000_000)))
                }
                try? await Task.sleep(for: .milliseconds(66))
            }
        }
        let expiry = Task { try? await Task.sleep(for: .seconds(180)); socket.cancel(with: .normalClosure, reason: nil) }
        defer { frames.cancel(); expiry.cancel(); for session in sessions.values { session.close() } }
        do {
            while true {
                guard case .string(let text) = try await socket.receive() else { continue }
                if text == "pong" { continue }
                let message = try JSONDecoder().decode([String: JSONValue].self, from: Data(text.utf8))
                let id = message.text("sessionId")
                switch message.text("type") {
                case "hello":
                    await send(["type": .string("status"), "screenAllowed": .bool(true), "inputAllowed": .bool(true)])
                    try Data("ready".utf8).write(to: root.appendingPathComponent("live-ready"))
                case "execute": await executor.execute(try JSONDecoder().decode(DeviceCommand.self, from: Data(text.utf8)))
                case "collect": await executor.collect(message.text("id"))
                case "cancel": await executor.cancel(message.text("id"))
                case "remote_start":
                    let session = try RemoteDesktopSession(factory: factory, source: source, control: message.flag("control"), ice: message["iceServers"]?.array?.compactMap(\.object) ?? [], signal: { data in
                        Task { await send(["type": .string("signal"), "sessionId": .string(id), "signal": .object(data)]) }
                    }, input: { _ in Task { @MainActor in
                        inputCount.value += 1
                        try? Data(String(inputCount.value).utf8).write(to: root.appendingPathComponent("rtc-input-count"))
                    } })
                    sessions[id] = session; try await session.offer()
                case "signal": if let signal = message["signal"]?.object { try await sessions[id]?.receive(signal) }
                case "remote_stop": sessions.removeValue(forKey: id)?.close()
                default: break
                }
            }
        } catch { if !expiry.isCancelled { /* Local QA runner ends after the bounded fixture lifetime. */ } }
        await executor.stop()
        #expect(FileManager.default.fileExists(atPath: workspace.appendingPathComponent("native-proof.txt").path))
        #expect(inputCount.value > 0)
    }
}
