// Part of a long text, by the UTF-16 offsets JavaScript indexes strings with.
// Offsets by characters (code points) would walk the whole text, or copy it
// into an array of characters, on every read of it. A window never splits a
// character: a boundary inside a surrogate pair moves to the pair's start,
// and the next window starts where this one ended.
export function textWindow(text: string, start: number, length: number) {
	const from = characterStart(text, Math.min(Math.max(start, 0), text.length));
	let to = characterStart(text, Math.min(text.length, from + length));
	// A window always moves on, even one shorter than the pair it starts at.
	if (to <= from && from < text.length)
		to = from + ((text.codePointAt(from) ?? 0) > 0xffff ? 2 : 1);
	return { text: text.slice(from, to), start: from, end: to };
}

// The offset itself, or the start of the surrogate pair it falls inside.
function characterStart(text: string, offset: number) {
	const low = text.charCodeAt(offset);
	const high = text.charCodeAt(offset - 1);
	return offset > 0 &&
		low >= 0xdc00 &&
		low <= 0xdfff &&
		high >= 0xd800 &&
		high <= 0xdbff
		? offset - 1
		: offset;
}
