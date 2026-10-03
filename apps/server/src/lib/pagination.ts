import { AppError, ErrorCode } from "@/lib/errors";

export function pageOptions(size = 0, token = "", scope = "") {
	if (!Number.isInteger(size) || size < 0 || size > 100)
		throw new AppError(
			"page_size must be between 0 and 100",
			ErrorCode.InvalidArgument,
		);
	let cursor: string | undefined;
	if (token) {
		try {
			const parsed: unknown = JSON.parse(
				new TextDecoder().decode(Uint8Array.fromBase64(token)),
			);
			if (
				!Array.isArray(parsed) ||
				parsed.length !== 2 ||
				parsed[0] !== scope ||
				typeof parsed[1] !== "string" ||
				!parsed[1]
			)
				throw new Error();
			cursor = parsed[1];
		} catch {
			throw new AppError("invalid page_token", ErrorCode.InvalidArgument);
		}
	}
	return { limit: size || 50, cursor };
}
// A page's token names its scope and where the next page starts: by default
// the last item's ID, for a list in ID order.
export function pageResult<T extends { id: string }>(
	rows: T[],
	limit: number,
	scope: string,
	cursorOf: (item: T) => string = (item) => item.id,
) {
	const more = rows.length > limit;
	const items = rows.slice(0, limit);
	return {
		items,
		nextPageToken: more
			? new TextEncoder()
					.encode(JSON.stringify([scope, cursorOf(items[items.length - 1])]))
					.toBase64()
			: "",
	};
}
