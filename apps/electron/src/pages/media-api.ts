import type { IceServer, Signal } from "../device/protocol";

// Between the main process and the page that shares the screen.
export type MediaCommand =
	| { type: "start"; sessionId: string; iceServers: IceServer[] }
	| { type: "signal"; sessionId: string; signal: Signal }
	| { type: "stop"; sessionId: string };

export type MediaEvent =
	| { type: "signal"; sessionId: string; signal: Signal }
	| {
			type: "failed";
			sessionId: string;
			code: "capture" | "connection";
			detail: string;
	  }
	// What the person watching sent on the data channel, unread.
	| { type: "input"; sessionId: string; input: unknown };

export interface MediaApi {
	onCommand(callback: (command: MediaCommand) => void): void;
	send(event: MediaEvent): void;
}
