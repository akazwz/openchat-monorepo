// Header rules that received and sent mail share.

// A header line's limit (RFC 5322), which bounds a subject and an ID.
export const maxLineChars = 998;
// Email Service's limit on a header's value.
export const maxHeaderBytes = 2048;
export const byteLength = (text: string) =>
	new TextEncoder().encode(text).length;

// Within `max` characters, not between the two halves of one outside the BMP.
export function clip(text: string, max: number) {
	if (text.length <= max) return text;
	const last = text.charCodeAt(max - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

// Control characters, line and paragraph separators, bidirectional controls
// (which can show an address backwards), and invisible spaces. Joiners stay:
// emoji and several scripts are written with them.
const unsafe =
	/[\p{Cc}\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]+/gu;

// A received header's value as one line of plain text, within `max`
// characters. A decoded subject or name can hold line breaks, which would
// fake a header of their own ("From: …") wherever it is shown.
export const headerText = (value: string, max: number) =>
	clip(value.replace(unsafe, " ").replace(/\s+/g, " ").trim(), max);

// A thread's References (its message IDs, oldest first) within one header.
// Too long, it keeps the first and the latest that fit (RFC 5322's advice),
// so the thread's root and its recent part are both still known.
export function threadReferences(ids: string[]) {
	const kept = ids.filter((id) => id && byteLength(id) <= maxHeaderBytes);
	while (kept.length > 2 && byteLength(kept.join(" ")) > maxHeaderBytes)
		kept.splice(1, 1);
	const references = kept.join(" ");
	return byteLength(references) <= maxHeaderBytes
		? references
		: (kept.at(-1) ?? "");
}
