import Foundation
import Security

nonisolated enum DeviceKeychain {
    private static let service = "com.heveta.macos.device"
    static func load(account: String = "binding") throws -> DeviceBinding? {
        var value: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword, kSecAttrService: service,
            kSecAttrAccount: account, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne,
        ] as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else { throw DeviceError.message("Keychain: \(status)") }
        return try JSONDecoder().decode(DeviceBinding.self, from: data)
    }
    static func save(_ binding: DeviceBinding?, account: String = "binding") throws {
        let query = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account] as CFDictionary
        guard let binding else {
            let status = SecItemDelete(query)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw DeviceError.message("Keychain: \(status)") }
            return
        }
        let data = try JSONEncoder().encode(binding)
        let status = SecItemUpdate(query, [kSecValueData: data] as CFDictionary)
        if status == errSecItemNotFound {
            let created = SecItemAdd([
                kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
                kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            ] as CFDictionary, nil)
            guard created == errSecSuccess else { throw DeviceError.message("Keychain: \(created)") }
        } else if status != errSecSuccess { throw DeviceError.message("Keychain: \(status)") }
    }
}
