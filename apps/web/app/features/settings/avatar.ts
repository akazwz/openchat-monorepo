import { Code, ConnectError } from "@connectrpc/connect";

import { isCurrentSession } from "~/features/auth/store";
import type { SessionOwner } from "~/features/auth/types";
import { authClient } from "~/lib/rpc-client";

import { avatarImage } from "./avatar-image";

export class UnreadableImage extends Error {}

// Ownership starts at file selection, before decoding or reading its bytes.
export async function setAvatar({
	file,
	owner,
}: {
	file: File;
	owner: SessionOwner;
}) {
	const check = () => {
		if (!isCurrentSession(owner))
			throw new ConnectError("Session changed", Code.Canceled);
	};
	check();
	let image: Blob;
	try {
		image = await avatarImage(file);
	} catch {
		check();
		throw new UnreadableImage();
	}
	const bytes = new Uint8Array(await image.arrayBuffer());
	check();
	return (await authClient.setAvatar({ image: bytes })).user;
}
