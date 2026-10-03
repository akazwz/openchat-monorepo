import Foundation
import Testing
@testable import Heveta

struct KeychainTests {
    @Test func deviceCredentialPersistsRotatesAndCanBeRemoved() throws {
        let account = "qa-" + UUID().uuidString
        defer { try? DeviceKeychain.save(nil, account: account) }
        let first = DeviceBinding(deviceId: UUID().uuidString, userId: "qa", credential: "test-only", origin: URL(string: "https://localhost")!)
        try DeviceKeychain.save(first, account: account)
        #expect(try DeviceKeychain.load(account: account)?.deviceId == first.deviceId)
        let next = DeviceBinding(deviceId: first.deviceId, userId: "qa", credential: "rotated-test-only", origin: first.origin)
        try DeviceKeychain.save(next, account: account)
        #expect(try DeviceKeychain.load(account: account)?.credential == next.credential)
        try DeviceKeychain.save(nil, account: account)
        #expect(try DeviceKeychain.load(account: account) == nil)
    }
}
