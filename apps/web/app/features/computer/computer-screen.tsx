import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import {
	SegmentedControl,
	SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import RFB from "@novnc/novnc";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AppPageHeader } from "~/components/app-page-header";
import { useAuthStore } from "~/features/auth/store";
import { socketUrl } from "~/features/events/event-channel";
import type { MessageKey } from "~/i18n/messages";
import { useT } from "~/i18n/use-t";
import { usePageVisible } from "~/lib/use-page-visible";

import { ComputerTabs } from "./computer-tabs";
import { ConnectionStatus } from "./connection-status";
import { useReconnect } from "./reconnect";

type ScreenState =
	| { status: "connecting" }
	| { status: "connected" }
	// Dropped, and opening again by itself.
	| { status: "reconnecting" }
	| { status: "failed"; message: MessageKey };

// A computer's live screen over VNC (docs/sandbox.md), watched by default and
// operated on request, as when a person takes over from an agent. Opening it
// wakes the computer, so the first connection can take a while. An open
// connection keeps the computer awake, so it is closed while the page is not
// on screen and opened again when it is.
export default function ComputerScreen() {
	const t = useT();
	const visible = usePageVisible();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const [screen, setScreen] = useState<HTMLElement | null>(null);
	const [state, setState] = useState<ScreenState>({ status: "connecting" });
	const [operating, setOperating] = useState(false);
	const { attempt, connected, dropped, retry } = useReconnect();
	const client = useRef<RFB | undefined>(undefined);
	const operatingRef = useRef(operating);
	operatingRef.current = operating;

	// `attempt` opens the connection again (reconnect.ts).
	useEffect(() => {
		if (!screen || !visible || !userId) return;
		let rfb: RFB | undefined;
		let closed = false;
		const fail = (message: MessageKey) => {
			if (!closed) setState({ status: "failed", message });
		};
		setState({ status: "connecting" });
		rfb = new RFB(screen, socketUrl("/screen", userId));
		client.current = rfb;
		rfb.scaleViewport = true;
		rfb.viewOnly = !operatingRef.current;
		rfb.addEventListener("connect", () => {
			if (closed) return;
			connected();
			setState({ status: "connected" });
		});
		rfb.addEventListener("disconnect", (event) => {
			if (closed) return;
			if (dropped()) setState({ status: "reconnecting" });
			else
				fail(
					event.detail.clean
						? "computer.screenDisconnected"
						: "computer.screenConnectFailed",
				);
		});
		return () => {
			closed = true;
			rfb?.disconnect();
			client.current = undefined;
		};
	}, [screen, visible, userId, attempt, connected, dropped]);

	useEffect(() => {
		if (client.current) client.current.viewOnly = !operating;
	}, [operating]);

	return (
		<Layout
			header={
				<AppPageHeader
					title={t("computer.title")}
					tabs={<ComputerTabs view="screen" />}
					end={
						<>
							<ConnectionStatus
								status={
									state.status === "failed" ? "disconnected" : state.status
								}
								error={state.status === "failed" ? state.message : undefined}
							/>
							{/* Watching is the default; operating lets the person take over
				the mouse and keyboard. */}
							<SegmentedControl
								label={t("computer.controlMode")}
								size="sm"
								value={operating ? "operate" : "watch"}
								onChange={(value) => setOperating(value === "operate")}
								isDisabled={state.status !== "connected"}
							>
								<SegmentedControlItem
									value="watch"
									label={t("computer.viewOnly")}
								/>
								<SegmentedControlItem
									value="operate"
									label={t("computer.control")}
								/>
							</SegmentedControl>
							{state.status === "failed" && (
								<IconButton
									label={t("computer.reconnect")}
									icon={<Icon icon={RefreshCw} size="sm" />}
									variant="ghost"
									size="sm"
									onClick={retry}
								/>
							)}
						</>
					}
				/>
			}
			content={
				<LayoutContent padding={0} isScrollable={false}>
					<VStack height="100%" ref={setScreen} />
				</LayoutContent>
			}
		/>
	);
}
