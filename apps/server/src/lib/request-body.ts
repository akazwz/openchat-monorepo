// An upload's body and the length it declares. A missing or malformed
// Content-Length is refused rather than read as 0; an empty file may come
// with no body at all, and is an empty stream.
export function declaredBody(request: Request) {
	const declared = request.headers.get("content-length") ?? "";
	const length = /^\d+$/.test(declared) ? Number(declared) : Number.NaN;
	if (!Number.isSafeInteger(length)) return undefined;
	if (request.body) return { length, body: request.body };
	if (length !== 0) return undefined;
	return { length, body: new Blob([]).stream() };
}
