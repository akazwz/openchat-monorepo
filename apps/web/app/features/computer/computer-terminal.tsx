import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { RefreshCw } from "lucide-react";

import "@xterm/xterm/css/xterm.css";
import { useEffect, useState } from "react";

import { AppPageHeader } from "~/components/app-page-header";
import { useAuthStore } from "~/features/auth/store";
import { socketUrl } from "~/features/events/event-channel";
import { useT } from "~/i18n/use-t";
import { usePageVisible } from "~/lib/use-page-visible";

import { ComputerTabs } from "./computer-tabs";
import { ConnectionStatus } from "./connection-status";
import { useReconnect } from "./reconnect";

// xterm takes a concrete font family and a size in pixels, not CSS variables,
// so it reads the theme's code tokens from the element it draws in. The type
// scale's sizes are rem (parsing "0.875rem" as a number gave 0.875px), so a
// rem size is scaled by the root font size.
function codeFont(element: HTMLElement) {
	const style = getComputedStyle(element);
	const size = style.getPropertyValue("--text-code-size").trim();
	const rem = Number.parseFloat(
		getComputedStyle(document.documentElement).fontSize,
	);
	return {
		fontFamily: style.getPropertyValue("--font-family-code").trim(),
		fontSize: Number.parseFloat(size) * (size.endsWith("rem") ? rem : 1),
	};
}

type TerminalState =
	| "connecting"
	| "connected"
	// Dropped, and opening again by itself (reconnect.ts).
	| "reconnecting"
	| "closed"
	| "failed";

// A shell on the computer (docs/sandbox.md), xterm.js over a binary WebSocket
// to a native PTY attached to tmux. The shell stays between connections and
// tmux redraws on return. As for the
// screen, the connection is closed while the page is not on screen and opened
// again when it is, after it drops (reconnect.ts), or when asked.
export default function ComputerTerminal() {
	const t = useT();
	const visible = usePageVisible();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const [element, setElement] = useState<HTMLElement | null>(null);
	const [state, setState] = useState<TerminalState>("connecting");
	const { attempt, connected, dropped, retry } = useReconnect();

	// `attempt` opens the connection again (reconnect.ts).
	useEffect(() => {
		if (!element || !visible || !userId) return;
		let closed = false;
		const terminal = new Terminal({ cursorBlink: true, ...codeFont(element) });
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(element);
		fit.fit();
		const socket = new WebSocket(
			socketUrl("/terminal", userId, {
				cols: String(terminal.cols),
				rows: String(terminal.rows),
			}),
		);
		socket.binaryType = "arraybuffer";
		const encoder = new TextEncoder();
		let ready = false;
		const send = (data: string | Uint8Array<ArrayBuffer>) => {
			if (ready && socket.readyState === WebSocket.OPEN) socket.send(data);
		};
		const input = terminal.onData((data) => send(encoder.encode(data)));
		const binary = terminal.onBinary((data) =>
			send(Uint8Array.from(data, (char) => char.charCodeAt(0))),
		);
		const resize = terminal.onResize(({ cols, rows }) =>
			send(JSON.stringify({ cols, rows })),
		);
		socket.addEventListener("message", (event) => {
			if (closed) return;
			if (typeof event.data === "string") {
				try {
					if (JSON.parse(event.data).type === "ready") {
						ready = true;
						connected();
						terminal.reset();
						setState("connected");
						send(JSON.stringify({ cols: terminal.cols, rows: terminal.rows }));
					}
				} catch {
					/* Unknown control messages do not reach the shell. */
				}
			} else terminal.write(new Uint8Array(event.data));
		});
		socket.addEventListener("close", (event) => {
			if (closed) return;
			if (event.code !== 1000 && dropped()) setState("reconnecting");
			else setState(ready ? "closed" : "failed");
		});
		const resized = new ResizeObserver(() => fit.fit());
		resized.observe(element);
		setState("connecting");
		return () => {
			closed = true;
			resized.disconnect();
			socket.close();
			input.dispose();
			binary.dispose();
			resize.dispose();
			terminal.dispose();
		};
	}, [element, visible, userId, attempt, connected, dropped]);

	const disconnected = state === "closed" || state === "failed";
	return (
		<Layout
			header={
				<AppPageHeader
					title={t("computer.title")}
					tabs={<ComputerTabs view="terminal" />}
					end={
						<>
							<ConnectionStatus
								status={disconnected ? "disconnected" : state}
								error={
									state === "failed"
										? "computer.terminalConnectFailed"
										: state === "closed"
											? "computer.terminalClosed"
											: undefined
								}
							/>
							{disconnected && (
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
					<VStack height="100%" ref={setElement} />
				</LayoutContent>
			}
		/>
	);
}
