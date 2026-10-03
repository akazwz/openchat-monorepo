import Foundation
import UniformTypeIdentifiers

nonisolated struct DeviceFiles: Sendable {
    let workspace: URL
    let binding: DeviceBinding
    func path(_ value: String) throws -> URL {
        guard !value.contains("\0") else { throw DeviceError.message("Invalid path") }
        if value.hasPrefix("/") { return URL(fileURLWithPath: value).standardizedFileURL }
        if value == "~" { return FileManager.default.homeDirectoryForCurrentUser }
        if value.hasPrefix("~/") { return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(String(value.dropFirst(2))).standardizedFileURL }
        return workspace.appendingPathComponent(value).standardizedFileURL
    }
    func request(jobId: String, name: String? = nil, fileId: String? = nil) -> URLRequest {
        var components = URLComponents(url: binding.origin.appendingPathComponent("device/file"), resolvingAgainstBaseURL: false)!
        components.queryItems = [.init(name: "job", value: jobId)]
        if let name { components.queryItems!.append(.init(name: "name", value: name)) }
        if let fileId { components.queryItems!.append(.init(name: "file", value: fileId)) }
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(binding.credential)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 120
        return request
    }
    func upload(_ url: URL, jobId: String, mimeType: String? = nil) async throws -> [String: JSONValue] {
        let size = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard size.isRegularFile == true, let bytes = size.fileSize, (1...100 * 1024 * 1024).contains(bytes) else { throw DeviceError.message("File must be between 1 byte and 100 MB") }
        var request = request(jobId: jobId, name: url.lastPathComponent)
        request.httpMethod = "POST"
        request.setValue(String(bytes), forHTTPHeaderField: "Content-Length")
        request.setValue(mimeType ?? UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await URLSession.shared.upload(for: request, fromFile: url)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { throw DeviceError.message("File upload failed") }
        return try JSONDecoder().decode([String: JSONValue].self, from: data)
    }
    func receive(_ command: DeviceCommand) async throws -> [String: JSONValue] {
        let target = try path(command.arguments.text("path"))
        // An attachment already placed is never overwritten during a retry.
        if FileManager.default.fileExists(atPath: target.path) { return ["output": .string("Already present: \(target.path)")] }
        let (temporary, response) = try await URLSession.shared.download(for: request(jobId: command.id, fileId: command.arguments.text("fileId")))
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { throw DeviceError.message("File download failed") }
        try Task.checkCancellation()
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: temporary, to: target)
        return ["output": .string("Placed: \(target.path)")]
    }
}
