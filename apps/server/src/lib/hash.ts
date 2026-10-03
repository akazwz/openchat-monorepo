// Hex SHA-256 of a string: how secrets are stored (refresh tokens) and
// requests are fingerprinted (run commands).
export async function sha256(value: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
