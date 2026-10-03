import { create } from "@bufbuild/protobuf";

import { FileSchema } from "@/gen/heveta/v1/file_pb";

import type { FileReference } from "./types";

// A file as clients read it: a stored file (fileReference) or one a message
// carries. Its address is its ID's, under this origin, for its owner's
// session alone (content.ts).
export const fileResource = (file: FileReference) =>
	create(FileSchema, {
		id: file.id,
		url: `/files/${file.id}`,
		mimeType: file.mimeType,
		fileName: file.fileName,
		size: file.size,
		width: file.width ?? 0,
		height: file.height ?? 0,
		workspacePath: file.workspacePath ?? "",
	});
