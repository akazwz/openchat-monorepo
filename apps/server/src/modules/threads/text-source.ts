import { textWindow } from "@/lib/text";

// Scan immutable chunks with bounded look-behind, including matches crossing
// chunk boundaries. Only a small snippet leaves the Run actor.
export function scanText(chunks: Iterable<string>, terms: string[]) {
	const lowered = terms.map((term) => term.toLowerCase());
	const carrySize = Math.max(0, ...lowered.map((term) => term.length)) + 60;
	const matched = new Set<number>();
	let carry = "";
	let position = 0;
	let sample = "";
	let sampleStart = -1;
	let sampleComplete = false;
	let length = 0;
	let nonEmpty = false;
	for (const chunk of chunks) {
		nonEmpty ||= Boolean(chunk.trim());
		const text = carry + chunk;
		const lower = text.toLowerCase();
		let at = Infinity;
		lowered.forEach((term, index) => {
			const found = lower.indexOf(term);
			if (found >= 0) {
				matched.add(index);
				at = Math.min(at, found);
			}
		});
		if (sampleStart < 0 && Number.isFinite(at)) {
			const start = Math.max(0, at - 60);
			const window = textWindow(text, start, 220);
			sampleStart = position - carry.length + window.start;
			sample = window.text;
			sampleComplete = window.end < text.length || sample.length >= 220;
		} else if (sampleStart >= 0 && !sampleComplete) {
			const combined = sample + chunk;
			const window = textWindow(combined, 0, 220);
			sample = window.text;
			sampleComplete = window.end < combined.length || sample.length >= 220;
		}
		length += chunk.length;
		position += chunk.length;
		carry = textWindow(
			text,
			Math.max(0, text.length - carrySize),
			carrySize + 1,
		).text;
	}
	return {
		score: matched.size,
		length,
		nonEmpty,
		snippet:
			sampleStart < 0
				? ""
				: `${sampleStart > 0 ? "…" : ""}${sample.replace(/\s+/g, " ").trim()}${sampleStart + sample.length < length ? "…" : ""}`,
	};
}

// UTF-16 offsets match the existing conversation_read contract. The extra
// character on either side lets textWindow preserve a surrogate pair.
export function sliceText(
	chunks: Iterable<string>,
	offset: number,
	limit: number,
) {
	const wanted = Math.max(0, offset);
	const from = Math.max(0, wanted - 1);
	const to = wanted + limit + 2;
	let length = 0;
	let text = "";
	let nonEmpty = false;
	for (const chunk of chunks) {
		nonEmpty ||= Boolean(chunk.trim());
		const end = length + chunk.length;
		if (end > from && length < to)
			text += chunk.slice(
				Math.max(0, from - length),
				Math.min(chunk.length, to - length),
			);
		length = end;
	}
	const base = Math.min(from, length);
	const part = textWindow(text, Math.min(wanted, length) - base, limit);
	return {
		text: part.text,
		start: base + part.start,
		end: base + part.end,
		length,
		nonEmpty,
	};
}
