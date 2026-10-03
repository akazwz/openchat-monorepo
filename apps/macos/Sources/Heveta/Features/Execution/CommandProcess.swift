import Darwin
import Foundation

// A separate process group contains the shell and its descendants. Cancelling
// a task must also stop the command's children, rather than just its shell.
nonisolated final class CommandProcess: @unchecked Sendable {
    private let lock = NSLock()
    private var pid: pid_t = 0
    private var stopped = false
    func cancel() {
        let target = lock.withLock { stopped = true; return pid }
        if target > 0 {
            kill(-target, SIGTERM)
            DispatchQueue.global().asyncAfter(deadline: .now() + 1) { [self] in
                lock.withLock { if pid == target { kill(-target, SIGKILL) } }
            }
        }
    }
    func run(command: String, directory: URL, timeout: Double) async throws -> [String: JSONValue] {
        let limit = Task { try await Task.sleep(for: .seconds(min(max(timeout, 1), 1800))); cancel() }
        defer { limit.cancel() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    do { continuation.resume(returning: try self.launch(command: command, directory: directory)) }
                    catch { continuation.resume(throwing: error) }
                }
            }
        } onCancel: { self.cancel() }
    }
    private func launch(command: String, directory: URL) throws -> [String: JSONValue] {
        var output: [Int32] = [0, 0], errors: [Int32] = [0, 0]
        guard pipe(&output) == 0 else { throw DeviceError.message("Cannot create command output pipe") }
        guard pipe(&errors) == 0 else { close(output[0]); close(output[1]); throw DeviceError.message("Cannot create command error pipe") }
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        posix_spawn_file_actions_init(&actions)
        posix_spawnattr_init(&attributes)
        defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes) }
        posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, output[1], STDOUT_FILENO)
        posix_spawn_file_actions_adddup2(&actions, errors[1], STDERR_FILENO)
        for fd in output + errors { posix_spawn_file_actions_addclose(&actions, fd) }
        posix_spawn_file_actions_addchdir_np(&actions, directory.path)
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attributes, 0)
        let arguments = ["/bin/zsh", "-l", "-c", command].map { strdup($0) } + [nil]
        let environment = ProcessInfo.processInfo.environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { for pointer in arguments + environment { free(pointer) } }
        var child: pid_t = 0
        let code = arguments.withUnsafeBufferPointer { argv in environment.withUnsafeBufferPointer { env in
            posix_spawn(&child, "/bin/zsh", &actions, &attributes, argv.baseAddress!, env.baseAddress!)
        } }
        close(output[1]); close(errors[1])
        guard code == 0 else { close(output[0]); close(errors[0]); throw DeviceError.message("Cannot start shell: \(String(cString: strerror(code)))") }
        lock.withLock { pid = child; if stopped { kill(-child, SIGTERM) } }
        let group = DispatchGroup()
        let stdout = PipeResult(), stderr = PipeResult()
        let finished = PipeDeadline()
        for (fd, result) in [(output[0], stdout), (errors[0], stderr)] {
            _ = fcntl(fd, F_SETFL, O_NONBLOCK)
            group.enter()
            DispatchQueue.global().async {
                defer { close(fd); group.leave() }
                var bytes = [UInt8](repeating: 0, count: 8192), data = Data()
                while true {
                    let count = read(fd, &bytes, bytes.count)
                    if count < 0 && errno == EINTR { continue }
                    if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                        if finished.expired { break }
                        var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                        _ = poll(&descriptor, 1, 50)
                        continue
                    }
                    if count <= 0 { break }
                    let remaining = max(0, 96 * 1024 - data.count)
                    data.append(contentsOf: bytes.prefix(min(count, remaining)))
                    if count > remaining { result.truncated = true }
                    if finished.expired { result.truncated = true; break }
                }
                result.data = data
            }
        }
        var status: Int32 = 0
        while waitpid(child, &status, 0) < 0 { if errno != EINTR { break } }
        // Background processes from this task are not detached host services.
        kill(-child, SIGKILL)
        let cancelled = lock.withLock { pid = 0; return stopped }
        // An application launched by a command may inherit a pipe after the
        // shell exits. It must not keep the tool result waiting indefinitely.
        finished.closeSoon()
        group.wait()
        let exit = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
        var text = String(decoding: stdout.data, as: UTF8.self)
        if !stderr.data.isEmpty { text += "\n[stderr]\n" + String(decoding: stderr.data, as: UTF8.self) }
        if stdout.truncated || stderr.truncated { text += "\n[Output truncated]" }
        if cancelled { text += "\n[Command cancelled or timed out]" }
        return ["output": .string(String(text.prefix(48_000))), "exitCode": .number(Double(exit)), "isError": .bool(exit != 0 || cancelled)]
    }
}
nonisolated private final class PipeDeadline: @unchecked Sendable {
    private let lock = NSLock()
    private var deadline: Date?
    func closeSoon() { lock.withLock { deadline = Date().addingTimeInterval(1) } }
    var expired: Bool { lock.withLock { deadline.map { $0 <= Date() } ?? false } }
}
nonisolated private final class PipeResult: @unchecked Sendable {
    // Written by one reader; accessed only after DispatchGroup.wait().
    var data = Data()
    var truncated = false
}
