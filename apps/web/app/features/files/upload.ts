import type { JsonValue } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";

import { actingHeaders } from "~/features/auth/interceptor";

// POSTs a file as the request body. XMLHttpRequest, because fetch reports no
// upload progress.
function send(
	url: string,
	file: File,
	signal: AbortSignal,
	onProgress?: (share: number) => void,
) {
	return new Promise<{ status: number; body: JsonValue }>((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("POST", url);
		for (const [name, value] of Object.entries(actingHeaders()))
			request.setRequestHeader(name, value);
		request.setRequestHeader(
			"Content-Type",
			file.type || "application/octet-stream",
		);
		request.responseType = "json";
		request.upload.onprogress = (event) => {
			if (event.lengthComputable) onProgress?.(event.loaded / event.total);
		};
		const abort = () => request.abort();
		request.onload = () =>
			resolve({ status: request.status, body: request.response });
		request.onerror = () =>
			reject(new ConnectError("Upload failed", Code.Unavailable));
		request.onabort = () => reject(signal.reason);
		request.onloadend = () => signal.removeEventListener("abort", abort);
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		request.send(file);
	});
}

export interface UploadOptions {
	signal: AbortSignal;
	onProgress?: (share: number) => void;
}

// Sends a file to one of the server's upload routes (POST /upload for an
// attachment, POST /computer-file into the computer), with the session as
// for RPCs (features/auth/interceptor.ts): one refused as unauthenticated
// makes the app ask which account is signed in (`refused`). The server
// answers errors as Connect does ({code, message}); success is the route's
// JSON.
export function createUploader(refused: () => void) {
	return async function upload(
		url: string,
		file: File,
		options: UploadOptions,
	) {
		const { status, body } = await send(
			url,
			file,
			options.signal,
			options.onProgress,
		);
		if (status === 401) {
			refused();
			throw new ConnectError("Not signed in", Code.Unauthenticated);
		}
		if (status < 200 || status >= 300)
			throw new ConnectError(
				typeof body === "object" &&
					body !== null &&
					"message" in body &&
					typeof body.message === "string"
					? body.message
					: "Upload failed",
			);
		return body;
	};
}
