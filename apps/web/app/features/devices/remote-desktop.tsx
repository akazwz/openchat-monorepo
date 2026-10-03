import { AspectRatio } from "@astryxdesign/core/AspectRatio";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import {
	HStack,
	Layout,
	LayoutContent,
	StackItem,
	VStack,
} from "@astryxdesign/core/Layout";
import {
	SegmentedControl,
	SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { TextInput } from "@astryxdesign/core/TextInput";
import { pageTitle } from "@heveta/brand";
import { useQuery } from "@tanstack/react-query";
import { MonitorOff, SendHorizontal } from "lucide-react";
import {
	type KeyboardEvent,
	type PointerEvent,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { useParams } from "react-router";

import { AppPageHeader } from "~/components/app-page-header";
import { useAuthStore } from "~/features/auth/store";
import { ConnectionStatus } from "~/features/computer/connection-status";
import { useReconnect } from "~/features/computer/reconnect";
import type { MessageKey } from "~/i18n/messages";
import { useT } from "~/i18n/use-t";
import { usePageVisible } from "~/lib/use-page-visible";

import { DesktopClient, type DesktopFailure } from "./desktop-client";
import { devicesQuery } from "./queries";

type DesktopState =
	| { status: "connecting" | "connected" | "reconnecting" }
	| { status: "failed"; failure: DesktopFailure };

const textLimit = 8000;
const defaultRatio = 16 / 10;

const failures: Record<
	DesktopFailure,
	{ title: MessageKey; detail: MessageKey }
> = {
	offline: {
		title: "devices.failureOffline",
		detail: "devices.failureOfflineDetail",
	},
	screenPermission: {
		title: "devices.failureScreenPermission",
		detail: "devices.failureScreenPermissionDetail",
	},
	inputPermission: {
		title: "devices.failureInputPermission",
		detail: "devices.failureInputPermissionDetail",
	},
	controlled: {
		title: "devices.failureControlled",
		detail: "devices.failureControlledDetail",
	},
	busy: { title: "devices.failureBusy", detail: "devices.failureBusyDetail" },
	capture: {
		title: "devices.failureCapture",
		detail: "devices.failureCaptureDetail",
	},
	connection: {
		title: "devices.failureConnection",
		detail: "devices.failureConnectionDetail",
	},
	ended: {
		title: "devices.failureEnded",
		detail: "devices.failureEndedDetail",
	},
};

// A Mac's screen, watched by default and controlled on request, like the
// cloud computer's (computer-screen.tsx). The session ends when the page is
// left or hidden, and a new one starts when it shows again.
export default function RemoteDesktop() {
	const { deviceId = "" } = useParams();
	const t = useT();
	const visible = usePageVisible();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const { data: devices } = useQuery(devicesQuery(userId));
	const device = devices?.find((item) => item.id === deviceId);
	const [state, setState] = useState<DesktopState>({ status: "connecting" });
	const [control, setControl] = useState(false);
	const { attempt, connected, dropped, retry } = useReconnect();
	const video = useRef<HTMLVideoElement>(null);
	const client = useRef<DesktopClient>(undefined);
	const failed = state.status === "failed";
	// The picture's element is on the page again before the session that
	// needs it starts.
	function reconnect(mode = control) {
		setState({ status: "connecting" });
		setControl(mode);
		retry();
	}

	// `attempt` opens the session again (reconnect.ts); so does a change of
	// mode, which the Mac must agree to anew.
	useEffect(() => {
		if (!video.current || !visible || !userId) return;
		setState((current) =>
			current.status === "reconnecting" ? current : { status: "connecting" },
		);
		const session = new DesktopClient(
			deviceId,
			control,
			video.current,
			(event) => {
				if (event.type === "connected") {
					connected();
					setState({ status: "connected" });
				} else if (event.dropped && dropped())
					setState({ status: "reconnecting" });
				else setState({ status: "failed", failure: event.failure });
			},
		);
		client.current = session;
		void session.start();
		// Keys held when the window loses focus would stay down on the Mac.
		const release = () => session.release();
		window.addEventListener("blur", release);
		return () => {
			window.removeEventListener("blur", release);
			session.stop();
			client.current = undefined;
		};
	}, [deviceId, userId, control, attempt, visible, connected, dropped]);

	const title = device?.name ?? t("devices.title");
	return (
		<>
			<title>{pageTitle(t("devices.screenTitle", { name: title }))}</title>
			<Layout
				header={
					<AppPageHeader
						title={device?.name}
						back={{ href: "/settings/devices", label: t("devices.title") }}
						end={
							<>
								<ConnectionStatus
									status={failed ? "disconnected" : state.status}
								/>
								<SegmentedControl
									label={t("computer.controlMode")}
									size="sm"
									value={control ? "control" : "watch"}
									onChange={(value) => setControl(value === "control")}
									isDisabled={state.status !== "connected"}
								>
									<SegmentedControlItem
										value="watch"
										label={t("computer.viewOnly")}
									/>
									<SegmentedControlItem
										value="control"
										label={t("computer.control")}
										isDisabled={!device?.inputAllowed}
									/>
								</SegmentedControl>
							</>
						}
					/>
				}
				content={
					<LayoutContent padding={0} isScrollable={false}>
						{failed ? (
							<Center axis="both" height="100%" padding={6}>
								<EmptyState
									icon={<Icon icon={MonitorOff} size="lg" color="secondary" />}
									title={t(failures[state.failure].title)}
									description={t(failures[state.failure].detail)}
									actions={
										<>
											{/* Someone else has the controls: the screen can
											still be watched. */}
											{state.failure === "controlled" && (
												<Button
													label={t("devices.watchInstead")}
													onClick={() => reconnect(false)}
												/>
											)}
											<Button
												label={t("computer.reconnect")}
												variant={
													state.failure === "controlled"
														? "secondary"
														: "primary"
												}
												onClick={() => reconnect()}
											/>
										</>
									}
								/>
							</Center>
						) : (
							<DesktopScreen
								video={video}
								client={client}
								control={control && state.status === "connected"}
								label={t("devices.screenTitle", { name: title })}
							/>
						)}
					</LayoutContent>
				}
			/>
		</>
	);
}

// The picture, scaled to fit, and what a person does on it while controlling.
// Positions go to the Mac as fractions of the picture; keys by their
// physical code, so the Mac's own keyboard layout applies.
function DesktopScreen({
	video,
	client,
	control,
	label,
}: {
	video: RefObject<HTMLVideoElement | null>;
	client: RefObject<DesktopClient | undefined>;
	control: boolean;
	label: string;
}) {
	const t = useT();
	// A phone has no keyboard to hold over the picture: its text goes through
	// a field.
	const touch = useMediaQuery("(pointer: coarse)");
	const frame = useRef<HTMLDivElement>(null);
	const [ratio, setRatio] = useState(defaultRatio);
	const [width, setWidth] = useState<number>();
	const [text, setText] = useState("");

	// The widest box of the picture's shape that fits the frame.
	useEffect(() => {
		const element = frame.current;
		if (!element) return;
		const fit = () =>
			setWidth(
				Math.max(
					1,
					Math.min(element.clientWidth, element.clientHeight * ratio),
				),
			);
		const observer = new ResizeObserver(fit);
		observer.observe(element);
		fit();
		return () => observer.disconnect();
	}, [ratio]);

	const modifiers = (event: {
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
	}) => ({
		meta: event.metaKey,
		ctrl: event.ctrlKey,
		alt: event.altKey,
		shift: event.shiftKey,
	});
	function pointer(event: PointerEvent<HTMLVideoElement>, action: string) {
		if (!control) return;
		const box = event.currentTarget.getBoundingClientRect();
		const within = (value: number) => Math.min(1, Math.max(0, value));
		client.current?.input({
			action,
			x: within((event.clientX - box.left) / box.width),
			y: within((event.clientY - box.top) / box.height),
			button: event.button,
			...modifiers(event),
		});
	}
	function key(event: KeyboardEvent<HTMLVideoElement>, down: boolean) {
		if (!control || event.nativeEvent.isComposing) return;
		// Paste goes as text (onPaste): the shortcut itself would paste the
		// Mac's own clipboard, which is not what was copied here.
		if ((event.metaKey || event.ctrlKey) && event.code === "KeyV") return;
		event.preventDefault();
		client.current?.input({
			action: "key",
			code: event.code,
			down,
			...modifiers(event),
		});
	}
	function type(value: string) {
		if (value)
			client.current?.input({
				action: "type",
				text: value.slice(0, textLimit),
			});
	}

	return (
		<VStack height="100%" width="100%">
			<StackItem size="fill">
				<Center height="100%" width="100%" ref={frame}>
					<VStack width={width ?? "100%"}>
						<AspectRatio ratio={ratio} fit="contain">
							<video
								ref={video}
								autoPlay
								muted
								playsInline
								aria-label={label}
								tabIndex={control ? 0 : -1}
								onLoadedMetadata={({ currentTarget: picture }) => {
									if (picture.videoHeight)
										setRatio(picture.videoWidth / picture.videoHeight);
								}}
								onPointerMove={(event) => pointer(event, "move")}
								onPointerDown={(event) => {
									if (!control) return;
									event.preventDefault();
									event.currentTarget.focus();
									// A drag that leaves the picture still ends on it.
									event.currentTarget.setPointerCapture(event.pointerId);
									pointer(event, "down");
								}}
								onPointerUp={(event) => pointer(event, "up")}
								onPointerCancel={() => client.current?.release()}
								onBlur={() => client.current?.release()}
								onContextMenu={(event) => {
									if (control) event.preventDefault();
								}}
								onKeyDown={(event) => key(event, true)}
								onKeyUp={(event) => key(event, false)}
								onWheel={(event) => {
									if (control)
										client.current?.input({
											action: "scroll",
											dx: event.deltaX,
											dy: event.deltaY,
											...modifiers(event),
										});
								}}
								onPaste={(event) => {
									if (!control) return;
									event.preventDefault();
									type(event.clipboardData.getData("text"));
								}}
							/>
						</AspectRatio>
					</VStack>
				</Center>
			</StackItem>
			{control && touch && (
				<HStack gap={2} padding={3} vAlign="center">
					<StackItem size="fill">
						<TextInput
							label={t("devices.typeText")}
							isLabelHidden
							placeholder={t("devices.typeText")}
							value={text}
							onChange={(value) => setText(value.slice(0, textLimit))}
							width="100%"
						/>
					</StackItem>
					<IconButton
						label={t("devices.sendText")}
						tooltip={t("devices.sendText")}
						icon={<Icon icon={SendHorizontal} size="sm" />}
						isDisabled={!text}
						onClick={() => {
							type(text);
							setText("");
						}}
					/>
				</HStack>
			)}
		</VStack>
	);
}

export function ErrorBoundary() {
	const t = useT();
	return (
		<Layout
			header={
				<AppPageHeader
					title={t("devices.title")}
					back={{ href: "/settings/devices", label: t("devices.title") }}
				/>
			}
			content={
				<Center axis="both" height="100%" padding={6}>
					<EmptyState
						title={t("common.errorTitle")}
						actions={
							<Button label={t("devices.title")} href="/settings/devices" />
						}
					/>
				</Center>
			}
		/>
	);
}
