import AppKit
import CoreMedia
import ScreenCaptureKit
import WebRTC

nonisolated final class CaptureFrames: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let source: RTCVideoSource
    let capturer: RTCVideoCapturer
    let failed: @Sendable (String) -> Void
    init(source: RTCVideoSource, failed: @escaping @Sendable (String) -> Void) {
        self.source = source; capturer = RTCVideoCapturer(delegate: source); self.failed = failed
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, buffer.isValid, let pixel = buffer.imageBuffer else { return }
        let nanos = Int64(CMTimeGetSeconds(buffer.presentationTimeStamp) * 1_000_000_000)
        source.capturer(capturer, didCapture: RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: pixel), rotation: ._0, timeStampNs: nanos))
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { failed(error.localizedDescription) }
}
final class DesktopCapture {
    private(set) var bounds = CGDisplayBounds(CGMainDisplayID())
    private var stream: SCStream?
    private var frames: CaptureFrames?
    private var generation = UUID()
    private func configuration(_ display: SCDisplay) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        let width = CGDisplayPixelsWide(display.displayID), height = CGDisplayPixelsHigh(display.displayID)
        let scale = min(1, min(1920 / Double(width), 1080 / Double(height)))
        config.width = max(2, Int(Double(width) * scale) / 2 * 2)
        config.height = max(2, Int(Double(height) * scale) / 2 * 2)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.queueDepth = 3; config.showsCursor = true; config.capturesAudio = false
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        return config
    }
    private func display() async throws -> SCDisplay {
        guard CGPreflightScreenCaptureAccess() else { throw DeviceError.message("Screen Recording permission is required") }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { throw DeviceError.message("No display available") }
        bounds = CGDisplayBounds(display.displayID)
        return display
    }
    func screenshot() async throws -> (Data, Int, Int) {
        let display = try await display()
        let config = configuration(display)
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: config)
        return try await Task.detached {
            guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw DeviceError.message("Cannot encode screenshot") }
            return (data, image.width, image.height)
        }.value
    }
    func start(source: RTCVideoSource, failed: @escaping @Sendable (String) -> Void) async throws {
        if stream != nil { return }
        let display = try await display()
        let output = CaptureFrames(source: source, failed: failed)
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration(display), delegate: output)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "com.heveta.capture", qos: .userInteractive))
        let current = generation
        self.frames = output; self.stream = stream
        do {
            try await stream.startCapture()
            if generation != current { try? await stream.stopCapture(); throw CancellationError() }
        } catch { if generation == current { stop() }; throw error }
    }
    func stop() {
        generation = UUID()
        let previous = stream; stream = nil; frames = nil
        Task { try? await previous?.stopCapture() }
    }
}
