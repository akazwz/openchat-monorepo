import Foundation

actor DeviceExecutor {
    private struct Entry: Codable {
        let command: DeviceCommand
        let createdAt: Date
        var result: DeviceResult?
    }
    private let journal: URL
    private let files: DeviceFiles
    private var tasks: [String: Task<Void, Never>] = [:]
    private var cancelled = Set<String>()
    private let emit: @Sendable (String, DeviceResult) async -> Void
    private let desktop: @Sendable (DeviceCommand) async throws -> [String: JSONValue]
    init(binding: DeviceBinding, workspace: URL, emit: @escaping @Sendable (String, DeviceResult) async -> Void,
         desktop: @escaping @Sendable (DeviceCommand) async throws -> [String: JSONValue]) throws {
        files = DeviceFiles(workspace: workspace, binding: binding)
        self.emit = emit; self.desktop = desktop
        journal = workspace.deletingLastPathComponent().appendingPathComponent("Jobs/\(binding.deviceId)", isDirectory: true)
        try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    private func location(_ id: String) throws -> URL {
        guard id.range(of: "^[a-zA-Z0-9:_-]{1,200}$", options: .regularExpression) != nil else { throw DeviceError.message("Invalid task ID") }
        return journal.appendingPathComponent(id + ".json")
    }
    private func load(_ id: String) throws -> Entry? {
        let url = try location(id)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(Entry.self, from: Data(contentsOf: url))
    }
    private func store(_ entry: Entry) throws {
        let url = try location(entry.command.id)
        try JSONEncoder().encode(entry).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    func execute(_ command: DeviceCommand) async {
        do {
            if let entry = try load(command.id) {
                guard entry.command == command else { throw DeviceError.message("Task ID reused with different input") }
                await collect(command.id); return
            }
            guard tasks.count < 8 else { throw DeviceError.message("Too many active tasks") }
            var entry = Entry(command: command, createdAt: Date(), result: nil)
            if cancelled.contains(command.id) { entry.result = .failure("Task cancelled") }
            try store(entry) // Record the intent before any side effect.
            if let result = entry.result { await emit(command.id, result); return }
            tasks[command.id] = Task {
                let result: DeviceResult
                do { try Task.checkCancellation(); result = .success(try await self.perform(command)) }
                catch { result = .failure(error.localizedDescription) }
                await self.finish(command.id, result: result)
            }
        } catch { await emit(command.id, .failure(error.localizedDescription)) }
    }
    private func finish(_ id: String, result: DeviceResult) async {
        do {
            guard var entry = try load(id) else { throw DeviceError.message("Task journal missing") }
            entry.result = result
            try store(entry) // A result is acknowledged only after it is durable.
            tasks.removeValue(forKey: id)
            await emit(id, result)
        } catch { tasks.removeValue(forKey: id); await emit(id, .failure("Cannot save task result: \(error.localizedDescription)", unknown: true)) }
    }
    func collect(_ id: String) async {
        do {
            guard let entry = try load(id) else { await emit(id, .failure("Task was not received; outcome is unknown", unknown: true)); return }
            if let result = entry.result { await emit(id, result) }
            else if tasks[id] == nil { await finish(id, result: .failure("The client restarted during this task; outcome is unknown", unknown: true)) }
        } catch { await emit(id, .failure("Task journal unavailable", unknown: true)) }
    }
    func cancel(_ id: String) { cancelled.insert(id); tasks[id]?.cancel() }
    func stop() async {
        let running = Array(tasks.values)
        for task in running { task.cancel() }
        for task in running { await task.value }
    }
    private func perform(_ command: DeviceCommand) async throws -> [String: JSONValue] {
        let args = command.arguments
        switch command.method {
        case "shell":
            return try await CommandProcess().run(command: args.text("command"), directory: files.path(args.text("cwd", default: ".")), timeout: args.number("timeout_seconds", default: 120))
        case "read_file":
            let url = try files.path(args.text("path"))
            let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
            let offset = max(0, args.number("offset"))
            guard offset.isFinite, offset < Double(Int64.max) else { throw DeviceError.message("Invalid offset") }
            try handle.seek(toOffset: UInt64(offset))
            let limit = Int(min(max(args.number("limit", default: 48_000), 1), 96 * 1024))
            var data = try handle.read(upToCount: limit) ?? Data()
            if data.count == limit && String(data: data, encoding: .utf8) == nil {
                // Do not split a UTF-8 scalar at the bounded read's end.
                for trim in 1..<min(4, data.count) {
                    let prefix = data.dropLast(trim)
                    if String(data: prefix, encoding: .utf8) != nil { data = Data(prefix); break }
                }
            }
            guard let text = String(data: data, encoding: .utf8) else { throw DeviceError.message("This is not UTF-8 text; use send_file or view_image") }
            return ["output": .string(String(text.prefix(48_000))), "bytesRead": .number(Double(data.count))]
        case "write_file", "edit_file":
            let url = try files.path(args.text("path"))
            var text = args.text("content")
            if command.method == "edit_file" {
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 8 * 1024 * 1024 else { throw DeviceError.message("File is too large to edit; use shell") }
                text = try String(contentsOf: url, encoding: .utf8)
                let old = args.text("old_text")
                guard !old.isEmpty, text.components(separatedBy: old).count == 2 else { throw DeviceError.message("old_text must match exactly once") }
                text = text.replacingOccurrences(of: old, with: args.text("new_text"))
            }
            try Task.checkCancellation()
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: url, options: .atomic)
            return ["output": .string("Saved \(url.path)")]
        case "receive_file": return try await files.receive(command)
        case "send_file", "view_image":
            let file = try await files.upload(files.path(args.text("path")), jobId: command.id)
            return ["output": .string("File uploaded"), "file": .object(file)]
        case "computer", "screenshot", "release_input": return try await desktop(command)
        default: throw DeviceError.message("Unknown native method: \(command.method)")
        }
    }
}
