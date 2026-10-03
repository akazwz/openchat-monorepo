import { and, asc, eq, gt } from "drizzle-orm";

import type { Database } from "@/db/client";
import { messagePartChunks, messageParts } from "@/db/schema/message-content";
import { AppError, ErrorCode } from "@/lib/errors";

import { joinPart, omitPartBody, type PartDescriptor } from "./content";
import type { MessagePart } from "./types";

export async function archivedPartDescriptors(db: Database, messageId: string) {
	const result: PartDescriptor[] = [];
	let after = -1;
	while (true) {
		const rows = await db
			.select()
			.from(messageParts)
			.where(
				and(
					eq(messageParts.messageId, messageId),
					gt(messageParts.ordinal, after),
				),
			)
			.orderBy(asc(messageParts.ordinal))
			.limit(128);
		if (!rows.length) return result;
		result.push(
			...rows.map((row): PartDescriptor => ({ ...row, generation: "" })),
		);
		after = rows.at(-1)!.ordinal;
	}
}

export async function archivedPartBody(
	db: Database,
	messageId: string,
	part: PartDescriptor,
) {
	const data: string[] = [];
	let after = -1;
	while (data.length < part.chunks) {
		const rows = await db
			.select()
			.from(messagePartChunks)
			.where(
				and(
					eq(messagePartChunks.messageId, messageId),
					eq(messagePartChunks.partId, part.id),
					gt(messagePartChunks.index, after),
				),
			)
			.orderBy(asc(messagePartChunks.index))
			.limit(32);
		if (!rows.length)
			throw new AppError(
				"Archived content is incomplete",
				ErrorCode.Unavailable,
			);
		for (const row of rows) {
			if (row.index !== data.length)
				throw new AppError(
					"Archived content is incomplete",
					ErrorCode.Unavailable,
				);
			data.push(row.data);
		}
		after = rows.at(-1)!.index;
	}
	return data.join("");
}

export async function archivedParts(
	db: Database,
	messageId: string,
	options: { omitLongOutputs?: boolean; toolCallId?: string } = {},
): Promise<MessagePart[]> {
	const parts = await archivedPartDescriptors(db, messageId);
	const result: MessagePart[] = [];
	for (const part of parts) {
		if (
			options.toolCallId &&
			(part.meta.content.case !== "toolResult" ||
				part.meta.content.value.toolCallId !== options.toolCallId)
		)
			continue;
		const omitted = omitPartBody(part, options.omitLongOutputs === true);
		result.push(
			joinPart(
				part,
				omitted ? "" : await archivedPartBody(db, messageId, part),
				omitted,
			),
		);
	}
	return result;
}
