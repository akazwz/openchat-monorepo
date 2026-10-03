import { join } from "node:path";

import { isRecord } from "./protocol";

const actions = [
	"move",
	"down",
	"up",
	"click",
	"scroll",
	"key",
	"type",
	"release",
] as const;
const textLimit = 8000;
const scrollLimit = 10_000;

// One pointer or keyboard event on the main display, as the agent's
// `computer` tool and a person controlling the screen both describe it:
// positions from 0 to 1 across the display, keys by their physical code.
interface InputEvent {
	action: (typeof actions)[number];
	x: number;
	y: number;
	button: number;
	count: number;
	dx: number;
	dy: number;
	code: string;
	down: boolean;
	text: string;
	meta: boolean;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

function readEvent(value: unknown): InputEvent {
	if (!isRecord(value)) throw new Error("Invalid input event");
	const action = actions.find((name) => name === value.action);
	if (!action) throw new Error("Unknown input action");
	// A field left out takes its neutral value; one given must be a number.
	const number = (key: string, min: number, max: number, neutral: number) => {
		const field = value[key] ?? neutral;
		if (typeof field !== "number" || !Number.isFinite(field))
			throw new Error(`${key} must be a number`);
		return Math.max(min, Math.min(max, field));
	};
	const code = typeof value.code === "string" ? value.code : "";
	const text = typeof value.text === "string" ? value.text : "";
	if (
		action === "key" &&
		(!code || code.length > 64 || typeof value.down !== "boolean")
	)
		throw new Error("A key event needs a code and whether it is down");
	if (
		action === "type" &&
		(typeof value.text !== "string" || text.length > textLimit)
	)
		throw new Error(`text must be a string of at most ${textLimit} characters`);
	return {
		action,
		x: number("x", 0, 1, 0),
		y: number("y", 0, 1, 0),
		button: Math.round(number("button", 0, 2, 0)),
		count: Math.round(number("count", 1, 2, 1)),
		dx: number("dx", -scrollLimit, scrollLimit, 0),
		dy: number("dy", -scrollLimit, scrollLimit, 0),
		code,
		down: value.down === true,
		text,
		meta: value.meta === true,
		ctrl: value.ctrl === true,
		alt: value.alt === true,
		shift: value.shift === true,
	};
}

// The pointer and the keyboard, through the native module (native/input.mm),
// which posts the events and remembers what is held down. It refuses without
// the Accessibility permission.
export class DesktopInput {
	private native?: { perform(event: string): void };

	perform(value: unknown) {
		const event = readEvent(value);
		// Loaded on first use: most sessions never send input.
		this.native ??= require(join(__dirname, "input.node")) as {
			perform(event: string): void;
		};
		this.native.perform(JSON.stringify(event));
	}

	// Lets go of every held key and button.
	release() {
		try {
			this.native?.perform(JSON.stringify({ action: "release" }));
		} catch {
			// The permission was taken away: nothing more can be sent.
		}
	}
}
