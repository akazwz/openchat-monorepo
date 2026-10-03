import type { ReasoningEffort } from "@/config";
import { ReasoningEffort as Effort } from "@/gen/heveta/v1/model_pb";

const byName: Record<ReasoningEffort, Effort> = {
	none: Effort.NONE,
	low: Effort.LOW,
	medium: Effort.MEDIUM,
	high: Effort.HIGH,
	xhigh: Effort.XHIGH,
	max: Effort.MAX,
};

export const effortToProto = (effort: ReasoningEffort | null | undefined) =>
	effort ? byName[effort] : Effort.UNSPECIFIED;

export const effortFromProto = (value: Effort): ReasoningEffort | undefined =>
	(Object.keys(byName) as ReasoningEffort[]).find(
		(name) => byName[name] === value,
	);
