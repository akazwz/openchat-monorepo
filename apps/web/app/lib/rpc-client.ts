import { fromJson } from "@bufbuild/protobuf";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { createAuthInterceptor } from "~/features/auth/interceptor";
import { confirmSession } from "~/features/auth/session";
import { createUploader, type UploadOptions } from "~/features/files/upload";
import { AuthService } from "~/gen/heveta/v1/auth_pb";
import { ComputerService } from "~/gen/heveta/v1/computer_pb";
import { DeviceService } from "~/gen/heveta/v1/device_pb";
import { FileSchema, FileService } from "~/gen/heveta/v1/file_pb";
import { MailService } from "~/gen/heveta/v1/mail_pb";
import { MemoryService } from "~/gen/heveta/v1/memory_pb";
import { ModelService } from "~/gen/heveta/v1/model_pb";
import { RunService } from "~/gen/heveta/v1/run_pb";
import { ScheduleService } from "~/gen/heveta/v1/schedule_pb";
import { ThreadService } from "~/gen/heveta/v1/thread_pb";
import { TurnService } from "~/gen/heveta/v1/turn_pb";
import { currentLocale } from "~/i18n/language";

// The API is served from this app's origin (connect-web accepts "/" for it),
// so the browser sends the session cookie with every call.
const baseUrl = "/";
// A request refused as unauthenticated: the session ended, or this browser
// signed in to another account since. The app asks which.
const refused = () => void confirmSession();
// Every call says which language the page speaks, so what the server writes
// for people (a sign-in code's email, the models' descriptions) is in it.
const language: Interceptor = (next) => (request) => {
	request.header.set("Accept-Language", currentLocale());
	return next(request);
};
const interceptors = [language, createAuthInterceptor(refused)];
// A call the Worker answers from the database takes seconds; one that hangs
// (a stalled connection) fails after this instead of holding its dialog or
// the event channel's reconnection. The deadline reaches the server too.
const transport = createConnectTransport({
	baseUrl,
	interceptors,
	defaultTimeoutMs: 30_000,
});
// Calls that wake the computer wait for it: restoring its workspace can take
// minutes, and a deadline would stop the server midway.
const computerTransport = createConnectTransport({ baseUrl, interceptors });
export const deviceClient = createClient(DeviceService, transport);
export const threadClient = createClient(ThreadService, transport);
export const turnClient = createClient(TurnService, transport);
export const runClient = createClient(RunService, transport);
export const authClient = createClient(AuthService, transport);
export const fileClient = createClient(FileService, transport);
export const modelClient = createClient(ModelService, transport);
export const memoryClient = createClient(MemoryService, transport);
export const scheduleClient = createClient(ScheduleService, transport);
export const mailClient = createClient(MailService, transport);
export const computerClient = createClient(ComputerService, computerTransport);
const upload = createUploader(refused);
// An attachment, stored as one of the user's files.
export const uploadFile = async (file: File, options: UploadOptions) =>
	fromJson(
		FileSchema,
		await upload(
			`/upload?name=${encodeURIComponent(file.name)}`,
			file,
			options,
		),
	);
// A file put into a folder of the user's computer's workspace.
export async function uploadToComputer(
	folder: string,
	file: File,
	options: UploadOptions,
) {
	await upload(
		`/computer-file?${new URLSearchParams({ path: folder, name: file.name })}`,
		file,
		options,
	);
}
