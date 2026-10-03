import { toJson } from "@bufbuild/protobuf";

import { createDatabase } from "@/db/client";
import { FileSchema } from "@/gen/heveta/v1/file_pb";
import { errorResponse, failureResponse } from "@/lib/http-errors";
import { declaredBody } from "@/lib/request-body";
import { actingUserHeader, authenticate } from "@/modules/auth/session";

import { fileResource } from "./rpc-codec";
import { storeFile } from "./service";
import { fileReference } from "./types";

// POST /upload?name=<file name>, with the session like an RPC: the body
// is the file, streamed into storage as one of the user's files (temporary
// until a message references it). Files are too large for an RPC, which
// holds the whole message in memory. Answers with the stored File as JSON.
export async function uploadFile(request: Request) {
	const database = createDatabase();
	try {
		const { userId } = await authenticate(
			database.db,
			request.headers,
			request.headers.get(actingUserHeader),
		);
		const upload = declaredBody(request);
		if (!upload)
			return errorResponse("invalid_argument", "The file's length is required");
		const file = await storeFile(database.db, userId, {
			content: upload.body,
			size: upload.length,
			fileName: new URL(request.url).searchParams.get("name") ?? "",
			mimeType: request.headers.get("content-type") ?? "",
		});
		return Response.json(toJson(FileSchema, fileResource(fileReference(file))));
	} catch (error) {
		return failureResponse(error, "Upload");
	} finally {
		await database.close();
	}
}
