// A command's output is cut to this, keeping its start and end; a file is
// read in windows of this size.
export const outputChars = 20_000;

// Keeps the start and end of a long text, where commands put what matters.
export function clip(text: string) {
	if (text.length <= outputChars) return text;
	const half = outputChars / 2;
	return `${text.slice(0, half)}\n… ${text.length - outputChars} characters omitted …\n${text.slice(-half)}`;
}
