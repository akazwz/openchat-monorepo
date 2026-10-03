// What the window tells its own page to show.
export interface ShellState {
	language: string;
	bandHeight: number;
	status: "loading" | "ready" | "failed" | "crashed";
	title?: string;
	detail?: string;
	retry: string;
}

export interface ShellApi {
	onState(callback: (state: ShellState) => void): void;
	retry(): void;
}
