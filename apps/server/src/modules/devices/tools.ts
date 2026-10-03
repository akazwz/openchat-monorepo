import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { files } from "@/db/schema/files";
import { messageFiles } from "@/db/schema/message-files";
import { messages } from "@/db/schema/messages";
import { AppError, ErrorCode } from "@/lib/errors";
import { sha256 } from "@/lib/hash";
import type { JsonObject } from "@/lib/json";
import { getFile, openFile } from "@/modules/files/service";
import { fileReference, isImageMimeType } from "@/modules/files/types";
import { fileNameOnComputer } from "@/modules/files/workspace-paths";
import type { NativeMailFiles } from "@/modules/mail/tools";
import type { ToolCall, ToolOutcome, ToolSet, ToolSpec } from "@/runtime/tools";

import { ownedDevice } from "./credentials";
import { object, type DeviceJob } from "./protocol";
import { deviceConnection } from "./service";

const string = { type: "string" };
const number = { type: "number" };
function spec(
	name: string,
	description: string,
	properties: Record<string, unknown>,
	readOnly = false,
	surface: ToolSpec["surface"] = "computer",
): ToolSpec {
	return {
		name,
		description,
		parameters: {
			type: "object",
			properties,
			required: Object.keys(properties),
			additionalProperties: false,
		},
		readOnly,
		concurrent: false,
		surface,
	};
}
const specs: ToolSpec[] = [
	spec(
		"shell",
		"Run a zsh login shell command on the user's selected macOS computer. Tools and commands are macOS/BSD, not GNU/Linux. cwd is an absolute or workspace-relative directory; use '.' for the workspace. timeout_seconds is 1–1800. Processes in this command’s process group stop when this call finishes or is cancelled.",
		{ command: string, cwd: string, timeout_seconds: number },
	),
	spec(
		"read_file",
		"Read UTF-8 text on the selected Mac. offset and limit are bytes; use offset=0, limit=48000 initially.",
		{ path: string, offset: number, limit: number },
		true,
	),
	spec(
		"write_file",
		"Write UTF-8 text atomically on the selected Mac, creating parent directories.",
		{ path: string, content: string },
	),
	spec(
		"edit_file",
		"Replace exactly one matching old_text with new_text in a UTF-8 file on the selected Mac.",
		{ path: string, old_text: string, new_text: string },
	),
	spec(
		"send_file",
		"Send a file on the selected Mac to the user and save it with this conversation (up to 100 MB).",
		{ path: string },
		true,
		"delivery",
	),
	spec(
		"view_image",
		"Read an image file on the selected Mac as an image without sending it to the user.",
		{ path: string },
		true,
	),
	spec(
		"screenshot",
		"Take one screenshot of the Mac's main display. Requires Screen Recording permission. No ongoing video session is created. Coordinates for computer are normalized from 0 to 1 across this display.",
		{},
		true,
	),
	spec(
		"computer",
		"Operate the selected Mac's main display using Accessibility permission. Actions: move/down/up/click (normalized x,y, button 0=left,1=middle,2=right; count=1 or2); scroll (dx,dy pixels); key (DOM KeyboardEvent code e.g. KeyA, Enter, MetaLeft; down true/false); type (Unicode text); release (release held input). meta/ctrl/alt/shift set modifier flags. Use neutral defaults for unrelated fields. Observe with screenshot after an action. GUI input is rejected while a person controls this Mac.",
		{
			action: {
				type: "string",
				enum: [
					"move",
					"down",
					"up",
					"click",
					"scroll",
					"key",
					"type",
					"release",
				],
			},
			x: number,
			y: number,
			button: number,
			count: number,
			dx: number,
			dy: number,
			code: string,
			down: { type: "boolean" },
			text: string,
			meta: { type: "boolean" },
			ctrl: { type: "boolean" },
			alt: { type: "boolean" },
			shift: { type: "boolean" },
		},
	),
];

export function nativeRun(
	db: Database,
	run: { id: string; userId: string; threadId: string; deviceId: string },
) {
	const broker = deviceConnection(run.deviceId);
	const active = new Set<string>();
	let prepared: Promise<void> | undefined;
	const device = () => ownedDevice(db, run.userId, run.deviceId);
	async function command(
		id: string,
		method: string,
		args: JsonObject,
		signal: AbortSignal,
		resume = false,
	): Promise<JsonObject | undefined> {
		await device();
		signal.throwIfAborted();
		let job = JSON.parse(
			resume
				? await broker.collect(id)
				: await broker.dispatch(
						JSON.stringify({ id, method, arguments: args }),
					),
		) as DeviceJob | null;
		if (!job) return undefined;
		active.add(id);
		const cancel = () => {
			void broker.cancel(id).catch(() => {});
		};
		signal.addEventListener("abort", cancel, { once: true });
		try {
			while (!job.result) {
				signal.throwIfAborted();
				job = JSON.parse(await broker.waitJob(id)) as DeviceJob | null;
				if (!job) return undefined;
				// A sleeping or reconnecting Mac may still finish this task; wait for
				// its journal rather than reporting unknown while it runs.
			}
			if (!job.result.ok) {
				if (job.result.unknown) return undefined;
				throw new AppError(job.result.error, ErrorCode.FailedPrecondition);
			}
			return job.result.value;
		} finally {
			signal.removeEventListener("abort", cancel);
			active.delete(id);
		}
	}
	async function prepare(signal: AbortSignal) {
		prepared ??= (async () => {
			const host = await device();
			const uploads = await db
				.selectDistinct({ id: files.id, name: files.fileName })
				.from(files)
				.innerJoin(messageFiles, eq(messageFiles.fileId, files.id))
				.innerJoin(messages, eq(messages.id, messageFiles.messageId))
				.where(
					and(
						eq(files.userId, run.userId),
						eq(messages.threadId, run.threadId),
						eq(messages.userId, run.userId),
						eq(files.status, "stored"),
					),
				);
			for (const file of uploads) {
				const path = `${host.workspacePath}/uploads/${file.id}/${fileNameOnComputer(file.name)}`;
				const result = await command(
					`upload:${file.id}`,
					"receive_file",
					{ fileId: file.id, path },
					signal,
				);
				if (!result)
					throw new AppError(
						"Attachment placement is unknown; check the device",
						ErrorCode.Unavailable,
					);
			}
		})();
		try {
			await prepared;
		} catch (error) {
			prepared = undefined;
			throw error;
		}
	}
	async function outcome(
		call: ToolCall,
		signal: AbortSignal,
		resume: boolean,
	): Promise<ToolOutcome | undefined> {
		await prepare(signal);
		const value = await command(
			`${run.id}:${call.callId}`,
			call.name,
			call.arguments as JsonObject,
			signal,
			resume,
		);
		if (!value) return undefined;
		const output =
			typeof value.output === "string" ? value.output : "Completed";
		if (object(value.file) && typeof value.file.id === "string") {
			const file = fileReference(await getFile(db, run.userId, value.file.id));
			if (call.name === "send_file")
				return {
					output,
					shown: [file],
					...(isImageMimeType(file.mimeType) ? { images: [file] } : {}),
				};
			if (!isImageMimeType(file.mimeType))
				throw new AppError(
					"The returned file is not an image",
					ErrorCode.InvalidArgument,
				);
			return { output, images: [file] };
		}
		return { output, isError: value.isError === true };
	}
	const toolSet: ToolSet = {
		specs,
		executor: {
			execute: (call, signal) => outcome(call, signal, false),
			resume: (call, signal) => outcome(call, signal, true),
			async close(runEnded) {
				if (runEnded) {
					await broker.cancelRun(run.id);
					if ((await broker.status()).online)
						await broker.dispatch(
							JSON.stringify({
								id: `${run.id}:release_input`,
								method: "release_input",
								arguments: {},
							}),
						);
				}
			},
		},
	};
	const mailFiles: NativeMailFiles = {
		async workspace() {
			return (await device()).workspacePath;
		},
		async receive(fileId, path, callId, signal) {
			const hash = await sha256(JSON.stringify([fileId, path]));
			if (
				!(await command(
					`${run.id}:${callId}:${hash.slice(0, 16)}`,
					"receive_file",
					{ fileId, path },
					signal,
				))
			)
				throw new AppError(
					"Attachment placement is unknown",
					ErrorCode.Unavailable,
				);
		},
		async read(path, callId, signal) {
			const hash = await sha256(path);
			const value = await command(
				`${run.id}:${callId}:${hash.slice(0, 16)}`,
				"send_file",
				{ path },
				signal,
			);
			if (!value || !object(value.file) || typeof value.file.id !== "string")
				throw new AppError("File read is unknown", ErrorCode.Unavailable);
			const file = await getFile(db, run.userId, value.file.id);
			return {
				content: await openFile(db, run.userId, file.id),
				size: Number(file.size),
				mimeType: file.mimeType,
			};
		},
	};
	return { toolSet, mailFiles };
}
