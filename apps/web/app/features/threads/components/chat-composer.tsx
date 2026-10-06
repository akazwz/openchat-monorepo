import { Button } from "@astryxdesign/core/Button";
import {
	ChatComposer as AstryxChatComposer,
	ChatComposerDrawer,
	ChatComposerInput,
	type ChatComposerInputHandle,
	ChatSendButton,
} from "@astryxdesign/core/Chat";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { isImeKeyEvent } from "@astryxdesign/core/utils";
import { FileText, ImagePlus, Paperclip, Plus } from "lucide-react";
import { useId, useRef } from "react";

import { DevicePicker } from "~/features/devices/device-picker";
import { fileIcon } from "~/features/files/file-card";
import {
	imageTypes,
	maxAttachments,
	maxMessageChars,
	pdfType,
} from "~/features/files/kinds";
import { readsImages } from "~/features/models/model-choice";
import {
	useComposerState,
	useConversationState,
	useThreadCommands,
} from "~/features/threads/thread-controller";
import type { MessageKey } from "~/i18n/messages";
import { translateMessage, useT } from "~/i18n/use-t";

import { ModelPicker } from "./model-picker";

// What the "+" menu adds, one entry per kind as in mainstream chat apps:
// images and PDFs the model reads itself, any other file for its computer.
type AttachmentKind = "image" | "pdf" | "file";
const attachmentKinds: {
	key: AttachmentKind;
	label: MessageKey;
	icon: typeof Paperclip;
	accept?: string;
	// Set on the kinds the model reads itself: why the chosen model cannot
	// take them.
	unreadable?: MessageKey;
}[] = [
	{
		key: "image",
		label: "threads.addImage",
		icon: ImagePlus,
		accept: imageTypes.join(","),
		unreadable: "threads.modelCannotReadImages",
	},
	{
		key: "pdf",
		label: "threads.addPdf",
		icon: FileText,
		// A model that does not read PDFs opens one on its computer.
		accept: `${pdfType},.pdf`,
	},
	{
		key: "file",
		label: "threads.addFile",
		icon: Paperclip,
	},
];

// The provider owns the draft and uploads. This component can safely remount when
// the shell changes its responsive structure or the selected thread changes.
export function ChatComposer({
	disabled,
	placeholder,
}: {
	disabled: boolean;
	// In place of the general one: the main conversation names the agent.
	placeholder?: string;
}) {
	const {
		setMessage,
		send,
		stop,
		upload,
		removeAttachment,
		chooseDevice,
		chooseModel,
		retryModels,
	} = useThreadCommands();
	const { canStop, isCancelling, isReconnecting, isDraftLocked } =
		useConversationState();
	const {
		draft,
		canSend,
		models,
		model,
		effort,
		effortFor,
		modelsFailed,
		modelsRetrying,
		imagesUnsupported,
	} = useComposerState();
	const t = useT();
	// One file picker per kind, so each opens showing only its files.
	const pickers = useRef<Partial<Record<AttachmentKind, HTMLInputElement>>>({});
	const { message, attachments, submission } = draft;
	// Sending the first message swaps the landing for the conversation layout,
	// which remounts this composer. It is not focused again: the composer
	// draws its keyboard focus ring when focus arrives after a key press (the
	// Enter that sent), so a lit ring flashed around the new one.
	const handleRef = useRef<ChatComposerInputHandle>(null);
	// On a touch keyboard Enter starts a new line, as in mainstream chat apps;
	// sending is the send button's job there.
	const isTouch = useMediaQuery("(pointer: coarse)");
	const statusId = useId();
	// The next message, files included, can be prepared while a reply runs,
	// as in ChatGPT; only a message on its way holds the composer.
	const canAddContext = !disabled && !isDraftLocked;
	const canAttach = canAddContext && attachments.length < maxAttachments;
	const toast = useToast();
	// Paste and drop take the same path as the file picker.
	function attach(files: Iterable<File>) {
		if (!canAttach) return;
		const chosen = [...files];
		const room = maxAttachments - attachments.length;
		for (const file of chosen.slice(0, room)) void upload(file);
		if (chosen.length > room)
			toast({
				type: "error",
				body: t("threads.maxAttachmentsPerMessage", { max: maxAttachments }),
			});
	}
	const images = attachments.filter((attachment) => attachment.previewUrl);
	const others = attachments.filter((attachment) => !attachment.previewUrl);
	function submit() {
		if (!disabled && canSend) send();
	}
	const status =
		message.length > maxMessageChars
			? {
					type: "error" as const,
					message: t("threads.messageTooLong", { max: maxMessageChars }),
				}
			: imagesUnsupported
				? {
						type: "warning" as const,
						message: t("threads.modelCannotReadFiles"),
					}
				: submission?.error
					? {
							// Still being sent, or back after a stop before it went (a
							// notice, not a failure; ChatComposer's statuses are error
							// and warning); or back with the reason it was refused.
							type:
								submission.phase === "sending" || submission.withdrawn
									? ("warning" as const)
									: ("error" as const),
							message: translateMessage(t, submission.error),
						}
					: undefined;
	return (
		<>
			{attachmentKinds.map((kind) => (
				<input
					key={kind.key}
					ref={(input) => {
						if (input) pickers.current[kind.key] = input;
					}}
					type="file"
					hidden
					multiple
					accept={kind.accept}
					onChange={(event) => {
						const files = event.target.files ? [...event.target.files] : [];
						event.target.value = "";
						attach(files);
					}}
				/>
			))}
			{/* The default "low" elevation: the composer is white like the page
			and set off from it by the theme's hairline and soft shadow, which
			deepen on hover and focus. "none" would draw an input's border
			instead, lit in the accent on focus. Keyboard focus in the editor
			still gets the shared focus ring. */}
			{/* The input and the send button are given their state directly, so
			the composer carries only what it lays out itself. */}
			<AstryxChatComposer
				onSubmit={submit}
				isDisabled={disabled && !canStop}
				status={status}
				input={
					<ChatComposerInput
						handleRef={handleRef}
						label={t("threads.messageLabel")}
						placeholder={placeholder ?? t("threads.messagePlaceholder")}
						value={message}
						onChange={setMessage}
						onFiles={attach}
						isDisabled={disabled}
						hasHistory={false}
						onKeyDown={(event) => {
							// Astryx's built-in Enter path clears the editable DOM immediately.
							// Submission is acknowledged asynchronously, so use its documented
							// key seam and leave all clearing to the provider's accepted state.
							if (
								event.key !== "Enter" ||
								event.shiftKey ||
								isImeKeyEvent(event.nativeEvent)
							)
								return;
							event.preventDefault();
							if (!isTouch) {
								submit();
								return;
							}
							// preventDefault also stops the browser's own line break. The
							// line-break command is what Shift+Enter runs, and its input
							// event updates the draft; the handle is the fallback.
							if (!document.execCommand("insertLineBreak")) {
								handleRef.current?.insertText("\n");
								setMessage(handleRef.current?.getValue() ?? message);
							}
						}}
					/>
				}
				sendButton={
					// ChatSendButton only disables sending; its stop state stays clickable.
					// While stopping, a disabled send state shows the stop glyph, named
					// by the "正在停止…" status beside it (its own label is fixed).
					isCancelling ? (
						<ChatSendButton
							sendIcon={<Icon icon="stop" size="sm" />}
							isStopShown={false}
							isDisabled
							aria-labelledby={statusId}
						/>
					) : (
						<ChatSendButton
							onSend={submit}
							onStop={stop}
							isStopShown={canStop}
							isDisabled={!canStop && (disabled || !canSend)}
						/>
					)
				}
				// The model belongs with sending, as in Claude and Gemini: the left
				// side adds content, the right side chooses how it is answered.
				sendActions={
					<HStack gap={1} vAlign="center">
						<DevicePicker
							value={draft.deviceId ?? ""}
							onChange={chooseDevice}
							disabled={isDraftLocked}
						/>
						{model && effort !== undefined && (
							<ModelPicker
								models={models}
								model={model}
								effort={effort}
								effortFor={effortFor}
								onChoose={chooseModel}
								isDisabled={isDraftLocked}
							/>
						)}
						{/* Without the catalog a message still goes with the choice
						this device remembers (model-choice.ts); what failed is said
						here, with a way to read it again. */}
						{modelsFailed && (
							<Button
								label={t("threads.modelsRetry")}
								tooltip={t("threads.modelsLoadFailed")}
								variant="ghost"
								size="sm"
								isLoading={modelsRetrying}
								onClick={retryModels}
							/>
						)}
					</HStack>
				}
				footerActions={
					<HStack gap={2} wrap="wrap" vAlign="center">
						{/* Everything that adds context to a message lives behind this one
						entry. The composer is docked at the bottom, so its menus open
						upward, as in ChatGPT. */}
						<DropdownMenu
							placement="above"
							button={{
								label: t("threads.add"),
								tooltip: t("threads.add"),
								variant: "ghost",
								size: "sm",
								icon: <Icon icon={Plus} size="sm" />,
								isIconOnly: true,
								isDisabled: !canAddContext,
							}}
							hasChevron={false}
							items={attachmentKinds.map((kind) => {
								const unreadable = readsImages(model)
									? undefined
									: kind.unreadable;
								return {
									label: t(kind.label),
									icon: kind.icon,
									description: unreadable
										? t(unreadable)
										: attachments.length >= maxAttachments
											? t("threads.maxAttachmentsReached", {
													max: maxAttachments,
												})
											: undefined,
									isDisabled: !canAttach || Boolean(unreadable),
									onClick: () => pickers.current[kind.key]?.click(),
								};
							})}
						/>
						{(isCancelling || isReconnecting) && (
							<Text type="supporting" role="status" id={statusId}>
								{isCancelling
									? t("threads.stopping")
									: t("threads.reconnecting")}
							</Text>
						)}
					</HStack>
				}
				drawer={
					attachments.length ? (
						// Images as thumbnails, other files as tokens, as in Astryx's
						// composer attachments. No `count`: its collapse toggle is not
						// worth it for ten files.
						<ChatComposerDrawer>
							<VStack gap={2} width="100%">
								{images.length > 0 && (
									<HStack gap={2} wrap="wrap">
										{images.map((attachment) => (
											<Thumbnail
												key={attachment.id}
												src={attachment.previewUrl}
												alt={attachment.name}
												label={attachment.name}
												isLoading={!attachment.file}
												onRemove={
													isDraftLocked
														? undefined
														: () => removeAttachment(attachment.id)
												}
												showRemoveOn="always"
											/>
										))}
									</HStack>
								)}
								{others.length > 0 && (
									<HStack gap={1} wrap="wrap">
										{others.map((attachment) => (
											<Token
												key={attachment.id}
												label={attachment.name}
												icon={
													<Icon icon={fileIcon(attachment.name)} size="sm" />
												}
												endContent={
													attachment.file ? undefined : (
														<Text type="supporting" color="secondary">
															{`${Math.round(attachment.progress * 100)}%`}
														</Text>
													)
												}
												onRemove={
													isDraftLocked
														? undefined
														: () => removeAttachment(attachment.id)
												}
											/>
										))}
									</HStack>
								)}
							</VStack>
						</ChatComposerDrawer>
					) : undefined
				}
			/>
		</>
	);
}
