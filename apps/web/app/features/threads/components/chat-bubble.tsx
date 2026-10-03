import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import {
	ChatMessage,
	ChatMessageBubble,
	ChatMessageMetadata,
	type ChatToolCallItem,
	ChatToolCalls,
	useChatStreamScroll,
} from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Markdown } from "@astryxdesign/core/Markdown";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useToast } from "@astryxdesign/core/Toast";
import { toJson } from "@bufbuild/protobuf";
import { timestampDate, ValueSchema } from "@bufbuild/protobuf/wkt";
import { useQuery } from "@tanstack/react-query";
import {
	AppWindow,
	Brain,
	Check,
	ChevronDown,
	ChevronUp,
	CircleAlert,
	CircleStop,
	Copy,
	FilePen,
	FilePlus,
	FileText,
	Globe,
	ImageIcon,
	Lightbulb,
	type LucideIcon,
	Mail,
	MessagesSquare,
	Monitor,
	MousePointerClick,
	RotateCcw,
	Search,
	SquareTerminal,
	Wrench,
} from "lucide-react";
import {
	type ComponentType,
	lazy,
	memo,
	type SVGProps,
	Suspense,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";

import { useAuthStore } from "~/features/auth/store";
import { FileCard } from "~/features/files/file-card";
import { isImage } from "~/features/files/kinds";
import { toolResultQuery } from "~/features/threads/queries";
import type { Message } from "~/features/threads/types";
import type { File } from "~/gen/heveta/v1/file_pb";
import { RunStatus } from "~/gen/heveta/v1/run_status_pb";
import {
	type MessagePart,
	MessageRole,
	type ToolCall,
	type ToolResult,
	ToolSurface,
} from "~/gen/heveta/v1/thread_pb";
import type { MessageKey } from "~/i18n/messages";
import { type Translate, useT } from "~/i18n/use-t";

import MessageImage from "./message-image";

// KaTeX (~260 KB, and its stylesheet) is most of a reply's code, and few
// replies have math: it loads with the first formula shown, not with the page.
const MathExpression = lazy(() => import("./math-expression"));

// Until KaTeX is in, a formula shows as its source, as MathExpression shows
// one it cannot parse. Its props are strings, so a streaming reply's every
// new word does not render its formulas again.
const Formula = memo(function Formula({
	value,
	display,
}: {
	value: string;
	display: "inline" | "block";
}) {
	const t = useT();
	return (
		<Suspense
			fallback={
				display === "inline" ? (
					value
				) : (
					<ScrollableArea axis="inline" label={t("threads.formula")}>
						{value}
					</ScrollableArea>
				)
			}
		>
			<MathExpression value={value} display={display} />
		</Suspense>
	);
});

// An image the model wrote into its text, as a link to it rather than the
// image: loading it would send a request to whatever address the model chose,
// with no click, so text an injected page or email steered the model to write
// (an address carrying the user's data) would leak on sight. Files the agent
// shows are file parts of their own (send_file), never Markdown images.
function ImageLink({ src, alt }: { src: string; alt: string }) {
	return (
		<Link href={src} isExternalLink>
			{alt || src}
		</Link>
	);
}

// Replies and thinking render math and images the same way.
const markdownComponents = { math: Formula, image: ImageLink };

interface BubbleProps {
	message: Message;
	pending?: boolean;
	// Its run is being stopped, or its progress is not arriving.
	isInterrupted?: boolean;
	// Whether this reply offers to be made again, and the command that does.
	canRegenerate?: boolean;
	onRegenerate?: (message: Message) => void;
}

// OpenAI models trained on their own search tool sometimes still write its
// citation markers (U+E200 "cite" U+E202 id … U+E201) around our search
// results. They are not ours to render; the instructions ask for Markdown
// links instead. An unterminated one is a marker still streaming in.
const citationMarkers = /\uE200[^\uE201]*(?:\uE201|$)/g;
const displayText = (text: string) => text.replace(citationMarkers, "");

function textContent(message: Message) {
	return message.parts
		.flatMap((part) =>
			part.content.case === "text" ? [displayText(part.content.value)] : [],
		)
		.join("\n");
}

// One entry per tool call; a result whose call is missing still gets a row.
interface ToolEntry {
	key: string;
	// The message it is in.
	messageId: string;
	call?: ToolCall;
	result?: ToolResult;
}

// What the tool acted on, as a person would recognize it: a search query, a
// URL, a path, a command, or the page element a browser tool acted on;
// otherwise the first text argument that is not an id (an id means nothing to
// a person). A browser tool's other arguments are settings (a screenshot's
// scale, a tab action) or element refs, so it names only these.
const targetKeys = [
	"query",
	"url",
	"path",
	"filename",
	"command",
	"file",
	"q",
	"element",
	"text",
	"key",
	"content",
];

// Our own tools as people see them: a name in place of the identifier, and
// an icon for what the tool works on (memory as in Settings, the terminal as
// in the computer panel). A tool not listed here shows its identifier and the
// generic tool icon.
const tools: Record<string, { label: MessageKey; icon: LucideIcon }> = {
	web_search: { label: "threads.toolWebSearch", icon: Search },
	web_fetch: { label: "threads.toolWebFetch", icon: Globe },
	memory_search: { label: "threads.toolMemorySearch", icon: Brain },
	memory_add: { label: "threads.toolMemoryAdd", icon: Brain },
	memory_update: { label: "threads.toolMemoryUpdate", icon: Brain },
	memory_delete: { label: "threads.toolMemoryDelete", icon: Brain },
	conversation_search: {
		label: "threads.toolConversationSearch",
		icon: MessagesSquare,
	},
	conversation_read: {
		label: "threads.toolConversationRead",
		icon: MessagesSquare,
	},
	shell: { label: "threads.toolShell", icon: SquareTerminal },
	read_file: { label: "threads.toolReadFile", icon: FileText },
	write_file: { label: "threads.toolWriteFile", icon: FilePlus },
	edit_file: { label: "threads.toolEditFile", icon: FilePen },
	view_image: { label: "threads.toolViewImage", icon: ImageIcon },
	// A Mac's own screen and pointer (docs/macos.md).
	screenshot: { label: "threads.toolScreenshot", icon: Monitor },
	computer: { label: "threads.toolComputer", icon: MousePointerClick },
	browser_navigate: { label: "threads.toolBrowserNavigate", icon: AppWindow },
	browser_navigate_back: {
		label: "threads.toolBrowserNavigateBack",
		icon: AppWindow,
	},
	browser_tabs: { label: "threads.toolBrowserTabs", icon: AppWindow },
	browser_snapshot: { label: "threads.toolBrowserSnapshot", icon: AppWindow },
	browser_find: { label: "threads.toolBrowserFind", icon: AppWindow },
	browser_take_screenshot: {
		label: "threads.toolBrowserTakeScreenshot",
		icon: AppWindow,
	},
	browser_wait_for: { label: "threads.toolBrowserWaitFor", icon: AppWindow },
	browser_click: { label: "threads.toolBrowserClick", icon: AppWindow },
	browser_hover: { label: "threads.toolBrowserHover", icon: AppWindow },
	browser_type: { label: "threads.toolBrowserType", icon: AppWindow },
	browser_fill_form: { label: "threads.toolBrowserFillForm", icon: AppWindow },
	browser_select_option: {
		label: "threads.toolBrowserSelectOption",
		icon: AppWindow,
	},
	browser_press_key: { label: "threads.toolBrowserPressKey", icon: AppWindow },
	browser_handle_dialog: {
		label: "threads.toolBrowserHandleDialog",
		icon: AppWindow,
	},
	browser_file_upload: {
		label: "threads.toolBrowserFileUpload",
		icon: AppWindow,
	},
	email_list: { label: "threads.toolEmailList", icon: Mail },
	email_read: { label: "threads.toolEmailRead", icon: Mail },
	email_save_attachments: {
		label: "threads.toolEmailSaveAttachments",
		icon: Mail,
	},
	email_send: { label: "threads.toolEmailSend", icon: Mail },
};
function callTarget(call?: ToolCall) {
	const args = call?.arguments ?? {};
	const text = (value: unknown) =>
		typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	for (const key of targetKeys) if (text(args[key])) return text(args[key]);
	if (call?.surface === ToolSurface.BROWSER) return undefined;
	return Object.entries(args)
		.filter(([key]) => !/(^|_)id$/i.test(key))
		.map(([, value]) => text(value))
		.find(Boolean);
}

// Details can be long and have long lines: wrap them, fill the row, and
// scroll within a bounded height instead of stretching the transcript. Tool
// results are text; JSON text is shown formatted, anything else as is.
function DetailBlock({ label, value }: { label: string; value: unknown }) {
	let shown = value;
	if (typeof value === "string")
		try {
			shown = JSON.parse(value);
		} catch {}
	const code =
		typeof shown === "string" ? shown : JSON.stringify(shown, null, 2);
	const isText = typeof shown === "string";
	return (
		<VStack gap={1}>
			<Text type="supporting">{label}</Text>
			<CodeBlock
				code={code}
				language={isText ? "text" : "json"}
				width="100%"
				maxHeight={320}
				isWrapped
			/>
		</VStack>
	);
}

// The name people read for a tool call: its own label, or its raw
// identifier when the tool is not one of ours yet.
function toolName(name: string | undefined, t: Translate) {
	if (!name) return t("threads.toolFallback");
	const tool = tools[name];
	return tool ? t(tool.label) : name;
}

// A call's arguments and result, rendered only while its row is open: the
// result is converted for display then, not on every render of a folded row.
function ToolDetail({ messageId, call, result }: Omit<ToolEntry, "key">) {
	const t = useT();
	return (
		<VStack gap={3}>
			{call && (
				<DetailBlock
					label={t("threads.toolCallArguments")}
					value={call.arguments ?? {}}
				/>
			)}
			{result &&
				(result.outputOmitted ? (
					<OmittedOutput messageId={messageId} result={result} />
				) : (
					<DetailBlock
						label={t("threads.toolCallResult")}
						value={result.output ? toJson(ValueSchema, result.output) : null}
					/>
				))}
			{/* Images the model read as the result (view_image). */}
			{result && result.images.length > 0 && (
				<HStack gap={2} wrap="wrap">
					{result.images.map((image) => (
						<MessageImage key={image.id} file={image} />
					))}
				</HStack>
			)}
		</VStack>
	);
}

// A long output its listed message left out, fetched when its row opens.
function OmittedOutput({
	messageId,
	result,
}: {
	messageId: string;
	result: ToolResult;
}) {
	const t = useT();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const whole = useQuery(toolResultQuery(userId, messageId, result.toolCallId));
	if (whole.data)
		return (
			<DetailBlock
				label={t("threads.toolCallResult")}
				value={
					whole.data.output ? toJson(ValueSchema, whole.data.output) : null
				}
			/>
		);
	return (
		<VStack gap={1}>
			<Text type="supporting">{t("threads.toolCallResult")}</Text>
			{whole.isError ? (
				<Text color="secondary">{t("threads.toolResultLoadFailed")}</Text>
			) : (
				<Spinner size="sm" aria-label={t("threads.toolResultLoading")} />
			)}
		</VStack>
	);
}

// One tool call as a row: what it did, and its arguments and result.
function toolRow(
	{ key, messageId, call, result }: ToolEntry,
	pending: boolean | undefined,
	t: Translate,
): ChatToolCallItem {
	return {
		key,
		name: toolName(call?.name ?? result?.name, t),
		target: callTarget(call),
		status: result
			? result.isError
				? "error"
				: "complete"
			: pending
				? "running"
				: "error",
		errorMessage: result?.isError
			? t("threads.toolResultError")
			: !result && !pending
				? t("threads.toolResultMissing")
				: undefined,
		resultDetail: (
			<ToolDetail messageId={messageId} call={call} result={result} />
		),
	};
}

// The step's name, as its row and the activity's title show it.
function stepName(step: ActivityStep, t: Translate) {
	if (step.kind === "thinking") return t("threads.thinking");
	return toolName(step.entry.call?.name ?? step.entry.result?.name, t);
}

// The step's icon. Thinking is a light bulb, since the brain is memory's.
function stepIcon(step: ActivityStep): LucideIcon {
	if (step.kind === "thinking") return Lightbulb;
	const name = step.entry.call?.name ?? step.entry.result?.name;
	return (name && tools[name]?.icon) || Wrench;
}

// The work before and between what the reply says, as in Claude: the model's
// thinking and its tool calls, in order, under one title. Open while it is
// being written, following the newest step in a box of a few lines' height
// (the theme's "activity" Card); folded once the model answers, its title
// counting the steps. Opened again, it is the same: the thinking as text, each
// call a row that opens to its details.
function Activity({
	steps,
	pending,
	active,
}: {
	steps: ActivityStep[];
	pending?: boolean;
	// This is the reply's latest block, still being written.
	active: boolean;
}) {
	const t = useT();
	// Closed unless opened: while the reply is made, its title line says what
	// is happening, once; the details are there to open. A finished activity
	// closes again, as the answer follows it.
	const [isOpen, setIsOpen] = useState(false);
	useEffect(() => {
		if (!active) setIsOpen(false);
	}, [active]);
	const box = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const { scrollIfLocked } = useChatStreamScroll({
		scrollRef: box,
		enabled: active,
	});
	// Thinking streams in and results arrive: whatever grows the timeline
	// brings its end into view, unless its reader scrolled up.
	useEffect(() => {
		const element = content.current;
		if (!element || !active || !isOpen) return;
		const observer = new ResizeObserver(() => scrollIfLocked());
		observer.observe(element);
		return () => observer.disconnect();
	}, [active, isOpen, scrollIfLocked]);
	const contentId = useId();
	const latest = steps.at(-1);
	// The icon of what the title names: the one step, or steps that all
	// share one icon (a run of browser actions); mixed work is generic.
	const icons = new Set(steps.map(stepIcon));
	const titleIcon = icons.size === 1 ? [...icons][0] : Wrench;
	// While it is made: the call under way, with what it acts on, or else the
	// model at work (thinking, or reading what the last call returned). Done:
	// the one step, or how many there were.
	const running =
		active && latest?.kind === "tool" && !latest.entry.result
			? latest.entry
			: undefined;
	const title = active
		? running
			? toolName(running.call?.name ?? running.result?.name, t)
			: t("threads.thinkingNow")
		: steps.length === 1 && latest
			? stepName(latest, t)
			: t("threads.activitySteps", { count: steps.length });
	const target = running && callTarget(running.call);
	// Its title row as ChatToolCalls draws one: what it is doing (or did),
	// then the chevron right after it. The reply's width, not its content's:
	// a long command or URL is cut to fit, not widening the page on a phone.
	return (
		<VStack gap={1} width="100%">
			<HStack>
				<Button
					variant="disclosure"
					size="sm"
					label={title}
					endContent={
						<Icon
							icon={isOpen ? ChevronUp : ChevronDown}
							size="xsm"
							color="secondary"
						/>
					}
					aria-expanded={isOpen}
					aria-controls={contentId}
					onClick={() => setIsOpen((open) => !open)}
				>
					{/* Its icon goes with the text rather than in Button's icon slot,
					which is a 16px box: the text's own 12px icon sat inset in it,
					out of line with the reply's text. */}
					<HStack as="span" gap={1} vAlign="center">
						{active ? (
							<Spinner size="sm" aria-label={t("threads.activityInProgress")} />
						) : (
							<Icon icon={titleIcon} size="xsm" color="secondary" />
						)}
						{title}
						{target && (
							<Text type="supporting" color="disabled" maxLines={1}>
								{target}
							</Text>
						)}
					</HStack>
				</Button>
			</HStack>
			{isOpen && (
				// The width of the reply, so it does not grow as steps arrive.
				<Card
					id={contentId}
					ref={box}
					variant={active ? "activity-live" : "activity"}
					padding={3}
					width="100%"
				>
					<VStack ref={content} gap={2}>
						{steps.map((step, index) =>
							step.kind === "thinking" ? (
								<ThinkingText
									key={step.key}
									texts={step.texts}
									active={active && index === steps.length - 1}
								/>
							) : (
								<ChatToolCalls
									key={step.entry.key}
									calls={[toolRow(step.entry, pending, t)]}
								/>
							),
						)}
					</VStack>
				</Card>
			)}
		</VStack>
	);
}

// A thinking step's summary, one level below the reply (the theme's compact
// Markdown).
function ThinkingText({ texts, active }: { texts: string[]; active: boolean }) {
	return (
		<Markdown
			isStreaming={active}
			density="compact"
			headingLevelStart={3}
			contentWidth="100%"
			components={markdownComponents}
		>
			{texts.filter((text) => text.trim()).join("\n\n")}
		</Markdown>
	);
}

type ActivityStep =
	| { kind: "thinking"; key: string; texts: string[] }
	| { kind: "tool"; entry: ToolEntry };
type Block =
	| { kind: "part"; part: MessagePart }
	| { kind: "activity"; key: string; steps: ActivityStep[] };

// How the agent hands the person something: the file a delivery call sends
// (send_file) is its own part in the reply, right after the call, and is all
// the person sees of it. The call gets no tool row; if it fails, the model
// reads why and says so. The IDs of a message's delivery calls.
function deliveries(message: Message) {
	return new Set(
		message.parts.flatMap((part) =>
			part.content.case === "toolCall" &&
			part.content.value.surface === ToolSurface.DELIVERY
				? [part.content.value.id]
				: [],
		),
	);
}

// Groups each stretch of thinking and tool calls into one activity block. A
// result renders in its call's row, so it neither adds a row nor breaks the
// stretch. A model may reason in several items in a row; they read as one
// thinking step.
function messageBlocks(message: Message): Block[] {
	const blocks: Block[] = [];
	const delivered = deliveries(message);
	for (const part of message.parts) {
		const content = part.content;
		if (
			(content.case === "toolCall" && delivered.has(content.value.id)) ||
			(content.case === "toolResult" && delivered.has(content.value.toolCallId))
		)
			continue;
		const activity = () => {
			const last = blocks.at(-1);
			if (last?.kind === "activity") return last.steps;
			const block: Block = { kind: "activity", key: part.id, steps: [] };
			blocks.push(block);
			return block.steps;
		};
		if (content.case === "reasoning") {
			const steps = activity();
			const last = steps.at(-1);
			if (last?.kind === "thinking") last.texts.push(content.value.text);
			else
				steps.push({
					kind: "thinking",
					key: part.id,
					texts: [content.value.text],
				});
			continue;
		}
		if (content.case !== "toolCall" && content.case !== "toolResult") {
			blocks.push({ kind: "part", part });
			continue;
		}
		let entry: ToolEntry | undefined;
		if (content.case === "toolCall")
			entry = {
				key: part.id,
				messageId: message.id,
				call: content.value,
				result: message.parts.flatMap((other) =>
					other.content.case === "toolResult" &&
					other.content.value.toolCallId === content.value.id
						? [other.content.value]
						: [],
				)[0],
			};
		else if (
			!message.parts.some(
				(other) =>
					other.content.case === "toolCall" &&
					other.content.value.id === content.value.toolCallId,
			)
		)
			entry = { key: part.id, messageId: message.id, result: content.value };
		if (entry) activity().push({ kind: "tool", entry });
	}
	return blocks;
}

function AssistantPart({
	part,
	pending,
}: {
	part: MessagePart;
	pending?: boolean;
}) {
	const content = part.content;
	switch (content.case) {
		case "text":
			// Astryx smooths bursty streamed text and holds back incomplete syntax.
			// With no avatar or bubble, the reply sits flush with the message edge,
			// aligned with its action row (a ghost bubble would keep its padding).
			// Prose fills the 800px column (the default caps it at 680px).
			return (
				<Markdown
					isStreaming={pending}
					headingLevelStart={2}
					autolink="gfm"
					contentWidth="100%"
					components={markdownComponents}
				>
					{displayText(content.value)}
				</Markdown>
			);
		case "file":
			return <AttachedFile file={content.value} />;
		default:
			return null;
	}
}

interface RunStatusLabel {
	text: string;
	icon: ComponentType<SVGProps<SVGSVGElement>>;
	// Failures read as errors; a stop or limit is an ordinary outcome.
	isError: boolean;
}

function runStatusLabel(
	status: RunStatus,
	t: Translate,
): RunStatusLabel | undefined {
	switch (status) {
		case RunStatus.CANCELLED:
			return {
				text: t("threads.runCancelled"),
				icon: CircleStop,
				isError: false,
			};
		case RunStatus.FAILED:
			return { text: t("threads.runFailed"), icon: CircleAlert, isError: true };
		default:
			return undefined;
	}
}

// A file in a message: an image shows in place, any other file is a card
// that downloads it.
function AttachedFile({ file }: { file: File }) {
	return isImage(file.mimeType) ? (
		<MessageImage file={file} />
	) : (
		<FileCard url={file.url} fileName={file.fileName} size={file.size} />
	);
}

function UserBubble({ message }: { message: Message }) {
	const files = message.parts.flatMap((part) =>
		part.content.case === "file"
			? [{ id: part.id, file: part.content.value }]
			: [],
	);
	const images = files.filter(({ file }) => isImage(file.mimeType));
	const others = files.filter(({ file }) => !isImage(file.mimeType));
	const text = textContent(message);
	return (
		<ChatMessage sender="user">
			{/* Images, then other files, each row as tall as its own items (as
			in the composer). */}
			{[images, others].map(
				(row) =>
					row.length > 0 && (
						<HStack key={row[0].id} gap={2} wrap="wrap" hAlign="end">
							{row.map(({ id, file }) => (
								<AttachedFile key={id} file={file} />
							))}
						</HStack>
					),
			)}
			{text && (
				// The theme keeps a user bubble's line breaks and spaces.
				<ChatMessageBubble>
					<Text>{text}</Text>
				</ChatMessageBubble>
			)}
		</ChatMessage>
	);
}

export function ChatBubble({ message, ...props }: BubbleProps) {
	if (message.role === MessageRole.USER)
		return <UserBubble message={message} />;
	return <AssistantBubble message={message} {...props} />;
}

// When a reply was made, to the minute: the time alone today, the date as
// well before that. Fixed text, so nothing re-renders as time passes.
function ReplyTime({ at }: { at: Date }) {
	const today = at.toDateString() === new Date().toDateString();
	return (
		<Timestamp value={at.toISOString()} format={today ? "time" : "date_time"} />
	);
}

function CopyAnswer({ text }: { text: string }) {
	const t = useT();
	const { copy, isCopied } = useClipboard({
		announce: t("threads.answerCopiedAnnounce"),
	});
	const toast = useToast();
	return (
		<IconButton
			label={isCopied ? t("threads.copied") : t("threads.copyAnswer")}
			tooltip={t("threads.copy")}
			icon={<Icon icon={isCopied ? Check : Copy} size="sm" color="secondary" />}
			variant="ghost"
			size="sm"
			onClick={async () => {
				if (!(await copy(text)))
					toast({ type: "error", body: t("threads.copyFailed") });
			}}
		/>
	);
}

export function AssistantBubble({
	message,
	pending,
	isInterrupted = false,
	canRegenerate = false,
	onRegenerate,
}: BubbleProps) {
	const t = useT();
	// The reply carries where its run stands.
	const statusLabel = !isInterrupted
		? runStatusLabel(message.runStatus, t)
		: undefined;
	// A delivery call has no row to show its progress; the reply loader does.
	const pendingCall = message.parts.find(
		(part) =>
			part.content.case === "toolCall" &&
			part.content.value.surface !== ToolSurface.DELIVERY &&
			!message.parts.some(
				(result) =>
					result.content.case === "toolResult" &&
					part.content.case === "toolCall" &&
					result.content.value.toolCallId === part.content.value.id,
			),
	);
	const lastContent = message.parts.at(-1)?.content;
	const blocks = messageBlocks(message);
	// Streaming text shows its own progress, and an activity at the end its
	// own (its title line): one loader at a time.
	const waitingForReply =
		pending &&
		!isInterrupted &&
		!pendingCall &&
		blocks.at(-1)?.kind !== "activity" &&
		(lastContent?.case !== "text" || !lastContent.value.trim());
	return (
		<ChatMessage
			sender="assistant"
			// The actions get their own row below the reply, as in ChatGPT and
			// Claude, followed by when the reply was made: answers built on live
			// web data (weather, prices) read differently a week later. The time
			// goes after the buttons (not in the timestamp slot, which comes
			// first) so the buttons keep their place whatever the time's length.
			// Every finished reply keeps its copy button and time; only the
			// reply still being made has none yet.
			metadata={
				!pending && (
					<ChatMessageMetadata
						footer={
							<HStack gap={1} vAlign="center">
								{/* A reply stopped before any text has nothing to copy. */}
								{textContent(message) && (
									<CopyAnswer text={textContent(message)} />
								)}
								{canRegenerate && onRegenerate && (
									<IconButton
										label={t("threads.regenerate")}
										tooltip={t("threads.regenerate")}
										icon={<Icon icon={RotateCcw} size="sm" color="secondary" />}
										variant="ghost"
										size="sm"
										onClick={() => onRegenerate(message)}
									/>
								)}
								{message.createTime && (
									<ReplyTime at={timestampDate(message.createTime)} />
								)}
							</HStack>
						}
					/>
				)
			}
		>
			{blocks.map((block, index) =>
				block.kind === "activity" ? (
					<Activity
						key={block.key}
						steps={block.steps}
						pending={pending}
						active={Boolean(pending) && index === blocks.length - 1}
					/>
				) : (
					<AssistantPart
						key={block.part.id}
						part={block.part}
						// Only the reply's last part can still be streaming.
						pending={Boolean(pending) && index === blocks.length - 1}
					/>
				),
			)}
			{waitingForReply && (
				<Spinner size="sm" aria-label={t("threads.waitingForReply")} />
			)}
			{statusLabel && (
				<HStack gap={1} vAlign="center">
					<Icon
						icon={statusLabel.icon}
						size="sm"
						color={statusLabel.isError ? "error" : "secondary"}
					/>
					{/* The run's error is written for logs and the model, in English;
					the retry button below is the way forward. */}
					<Text type="supporting">{statusLabel.text}</Text>
				</HStack>
			)}
		</ChatMessage>
	);
}

export const ChatBubbleMemoized = memo(ChatBubble);
