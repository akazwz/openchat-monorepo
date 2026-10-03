import Foundation
import Testing
@testable import Heveta

actor Results {
    private var values: [String: DeviceResult] = [:]
    func put(_ id: String, _ result: DeviceResult) { values[id] = result }
    func wait(_ id: String) async throws -> DeviceResult {
        for _ in 0..<200 {
            if let value = values[id] { return value }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw DeviceError.message("No task result")
    }
}
struct ExecutionTests {
    @Test func shellUsesWorkingDirectoryAndHandlesUnicode() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let result = try await CommandProcess().run(command: "printf '你好'; pwd", directory: directory, timeout: 5)
        #expect(result["isError"] == .bool(false))
        #expect(result.text("output").contains("你好"))
        #expect(result.text("output").contains(directory.path))
    }
    @Test func cancellationStopsChildProcesses() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let process = CommandProcess()
        let task = Task { try await process.run(command: "(sleep 2; touch late) & wait", directory: directory, timeout: 5) }
        try await Task.sleep(for: .milliseconds(150)); task.cancel()
        let result = try await task.value
        #expect(result["isError"] == .bool(true))
        try await Task.sleep(for: .seconds(2.1))
        #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("late").path))
    }
    @Test func journalNeverReplaysAnExecutedCommand() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let directory = root.appendingPathComponent("Workspace")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let binding = DeviceBinding(deviceId: UUID().uuidString, userId: "test", credential: "unused", origin: URL(string: "https://localhost")!)
        let results = Results()
        let executor = try DeviceExecutor(binding: binding, workspace: directory, emit: { await results.put($0, $1) }, desktop: { _ in [:] })
        let command = DeviceCommand(id: "stable", method: "shell", arguments: ["command": .string("echo one >> count"), "cwd": .string("."), "timeout_seconds": .number(5)])
        await executor.execute(command); #expect(try await results.wait("stable").ok)
        await executor.execute(command); await executor.collect("stable")
        let recovered = try DeviceExecutor(binding: binding, workspace: directory, emit: { await results.put($0, $1) }, desktop: { _ in [:] })
        await recovered.execute(command)
        #expect(try String(contentsOf: directory.appendingPathComponent("count"), encoding: .utf8) == "one\n")
        await recovered.collect("missing"); #expect(try await results.wait("missing").unknown == true)
    }
    @Test func utf8FilesAreWrittenAndEditedAtomically() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let directory = root.appendingPathComponent("Workspace")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let binding = DeviceBinding(deviceId: UUID().uuidString, userId: "test", credential: "unused", origin: URL(string: "https://localhost")!)
        let results = Results()
        let executor = try DeviceExecutor(binding: binding, workspace: directory, emit: { await results.put($0, $1) }, desktop: { _ in [:] })
        await executor.execute(.init(id: "write", method: "write_file", arguments: ["path": .string("中文/file.txt"), "content": .string("hello 世界")]))
        #expect(try await results.wait("write").ok)
        await executor.execute(.init(id: "read", method: "read_file", arguments: ["path": .string("中文/file.txt"), "offset": .number(0), "limit": .number(7)]))
        let read = try await results.wait("read")
        #expect(read.ok)
        #expect(read.value?.text("output") == "hello ")
        #expect(read.value?["bytesRead"] == .number(6))
        await executor.execute(.init(id: "edit", method: "edit_file", arguments: ["path": .string("中文/file.txt"), "old_text": .string("世界"), "new_text": .string("Mac")]))
        #expect(try await results.wait("edit").ok)
        #expect(try String(contentsOf: directory.appendingPathComponent("中文/file.txt"), encoding: .utf8) == "hello Mac")
    }
}
