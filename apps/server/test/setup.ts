// Workers globals the code under test uses, for Node. Storage is faked, so
// a stream's declared length is not checked here.
if (!("FixedLengthStream" in globalThis))
	Object.assign(globalThis, {
		FixedLengthStream: class<T> extends TransformStream<T, T> {
			constructor(_length: number | bigint) {
				super();
			}
		},
	});
