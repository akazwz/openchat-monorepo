import Foundation
@preconcurrency import WebRTC

nonisolated private final class RTCEvents: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, @unchecked Sendable {
    let signal: @Sendable ([String: JSONValue]) -> Void
    let input: @Sendable (Data) -> Void
    init(signal: @escaping @Sendable ([String: JSONValue]) -> Void, input: @escaping @Sendable (Data) -> Void) { self.signal = signal; self.input = input }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        if newState == .failed { signal(["error": .string("WebRTC connection failed")]) }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        signal(["candidate": .object(["candidate": .string(candidate.sdp), "sdpMid": candidate.sdpMid.map(JSONValue.string) ?? .null, "sdpMLineIndex": .number(Double(candidate.sdpMLineIndex))])])
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) { dataChannel.close() }
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}
    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        if !buffer.isBinary && buffer.data.count <= 64 * 1024 { input(buffer.data) }
    }
}

final class RemoteDesktopSession {
    let control: Bool
    let peer: RTCPeerConnection
    let channel: RTCDataChannel
    private let events: RTCEvents
    private var candidates: [RTCIceCandidate] = []
    private var remoteReady = false
    private let signal: @Sendable ([String: JSONValue]) -> Void
    init(factory: RTCPeerConnectionFactory, source: RTCVideoSource, control: Bool, ice: [[String: JSONValue]],
         signal: @escaping @Sendable ([String: JSONValue]) -> Void, input: @escaping @Sendable (Data) -> Void) throws {
        self.control = control; self.signal = signal
        events = RTCEvents(signal: signal, input: input)
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        configuration.iceServers = ice.map { server in RTCIceServer(urlStrings: server["urls"]?.array?.compactMap(\.string) ?? [], username: server.text("username"), credential: server.text("credential")) }
        configuration.continualGatheringPolicy = .gatherContinually
        guard let peer = factory.peerConnection(with: configuration, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: events) else { throw DeviceError.message("Cannot create WebRTC connection") }
        self.peer = peer
        _ = peer.add(factory.videoTrack(with: source, trackId: "screen"), streamIds: ["desktop"])
        let config = RTCDataChannelConfiguration(); config.isOrdered = true
        guard let channel = peer.dataChannel(forLabel: "desktop", configuration: config) else { peer.close(); throw DeviceError.message("Cannot create desktop input channel") }
        self.channel = channel; channel.delegate = events
    }
    func offer() async throws {
        let description: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            peer.offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { description, error in
                if let error { continuation.resume(throwing: error) }
                else if let description { continuation.resume(returning: description) }
                else { continuation.resume(throwing: DeviceError.message("Cannot create offer")) }
            }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(description) { error in if let error { continuation.resume(throwing: error) } else { continuation.resume() } }
        }
        signal(["description": .object(["type": .string("offer"), "sdp": .string(description.sdp)])])
    }
    func receive(_ signal: [String: JSONValue]) async throws {
        if let description = signal["description"]?.object, description.text("type") == "answer" {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: description.text("sdp"))) { error in if let error { continuation.resume(throwing: error) } else { continuation.resume() } }
            }
            remoteReady = true
            for candidate in candidates { try await add(candidate) }
            candidates.removeAll()
        } else if let value = signal["candidate"]?.object, !value.text("candidate").isEmpty {
            let candidate = RTCIceCandidate(sdp: value.text("candidate"), sdpMLineIndex: Int32(min(max(value.number("sdpMLineIndex"), 0), 65535)), sdpMid: value["sdpMid"]?.string)
            if remoteReady { try await add(candidate) } else if candidates.count < 256 { candidates.append(candidate) }
        }
    }
    private func add(_ candidate: RTCIceCandidate) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.add(candidate) { error in if let error { continuation.resume(throwing: error) } else { continuation.resume() } }
        }
    }
    func close() { channel.delegate = nil; channel.close(); peer.delegate = nil; peer.close() }
}
