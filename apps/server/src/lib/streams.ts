// Reads the first `bytes` of a stream (fewer if it is shorter) without losing
// them: the returned stream still yields the whole content.
export async function peek(stream: ReadableStream<Uint8Array>, bytes: number) {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (length < bytes) {
		const { value, done } = await reader.read();
		if (done) break;
		chunks.push(value);
		length += value.length;
	}
	const head = new Uint8Array(Math.min(length, bytes));
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= head.length) break;
		const part = chunk.subarray(0, head.length - offset);
		head.set(part, offset);
		offset += part.length;
	}
	const whole = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
		},
		async pull(controller) {
			const { value, done } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return { head, stream: whole };
}

// A stream of bytes already in memory, as one chunk, without copying them.
export const streamOf = (bytes: Uint8Array) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
