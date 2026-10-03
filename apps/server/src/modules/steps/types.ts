export enum StepKind {
	UNSPECIFIED = 0,
	MODEL = 1,
	TOOL = 2,
}
export enum StepStatus {
	UNSPECIFIED = 0,
	RUNNING = 1,
	COMPLETED = 2,
	FAILED = 3,
	CANCELLED = 4,
	INTERRUPTED = 5,
	// 6 is retired (formerly LIMIT_REACHED).
	PENDING = 7,
}
