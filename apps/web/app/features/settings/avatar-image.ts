// A profile photo as the app sends it: the picture's centre square, turned
// as the camera held it, at 256 px, which covers the largest avatar shown on
// a 2x screen. WebP where the browser can write it; PNG, the one type every
// browser writes, otherwise. The server takes up to 512 KB.
const side = 256;

export async function avatarImage(file: Blob): Promise<Blob> {
	const bitmap = await createImageBitmap(file, {
		imageOrientation: "from-image",
	});
	try {
		const crop = Math.min(bitmap.width, bitmap.height);
		const canvas = document.createElement("canvas");
		canvas.width = side;
		canvas.height = side;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("No 2D canvas");
		context.drawImage(
			bitmap,
			(bitmap.width - crop) / 2,
			(bitmap.height - crop) / 2,
			crop,
			crop,
			0,
			0,
			side,
			side,
		);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, "image/webp", 0.9),
		);
		if (!blob) throw new Error("The image could not be encoded");
		return blob;
	} finally {
		bitmap.close();
	}
}
