import Foundation

nonisolated enum JSONValue: Codable, Sendable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
    var string: String? { if case .string(let v) = self { return v }; return nil }
    var bool: Bool? { if case .bool(let v) = self { return v }; return nil }
    var number: Double? { if case .number(let v) = self { return v }; return nil }
    var object: [String: JSONValue]? { if case .object(let v) = self { return v }; return nil }
    var array: [JSONValue]? { if case .array(let v) = self { return v }; return nil }
}

nonisolated struct DeviceBinding: Codable, Equatable, Sendable {
    let deviceId: String
    let userId: String
    let credential: String
    let origin: URL
}
nonisolated struct DeviceCommand: Codable, Sendable, Equatable {
    let id: String
    let method: String
    let arguments: [String: JSONValue]
}
nonisolated struct DeviceResult: Codable, Sendable {
    let ok: Bool
    let value: [String: JSONValue]?
    let error: String?
    let unknown: Bool?
    static func success(_ value: [String: JSONValue]) -> Self { .init(ok: true, value: value, error: nil, unknown: nil) }
    static func failure(_ error: String, unknown: Bool = false) -> Self { .init(ok: false, value: nil, error: error, unknown: unknown) }
}
nonisolated enum DeviceError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let value): value } }
}
nonisolated extension Dictionary where Key == String, Value == JSONValue {
    func text(_ key: String, default fallback: String = "") -> String { self[key]?.string ?? fallback }
    func number(_ key: String, default fallback: Double = 0) -> Double { self[key]?.number ?? fallback }
    func flag(_ key: String) -> Bool { self[key]?.bool ?? false }
}
