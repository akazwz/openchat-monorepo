import { expect, it } from "vitest";

import { latestPending } from "~/lib/optimistic-values";
const identity = (value: { id: string; title: string }) => value.id;
it.each(["success", "error"] as const)(
	"a newer %s cannot expose an older pending rename",
	(status) => {
		expect(
			latestPending(
				[
					{ variables: { id: "a", title: "First" }, status: "pending" },
					{ variables: { id: "b", title: "Other" }, status: "pending" },
					{ variables: { id: "a", title: "Second" }, status },
				],
				identity,
			),
		).toEqual([{ id: "b", title: "Other" }]);
	},
);
it("the latest pending edit overrides only its own resource", () => {
	expect(
		latestPending(
			[
				{ variables: { id: "a", title: "First" }, status: "pending" },
				{ variables: { id: "b", title: "Other" }, status: "pending" },
				{ variables: { id: "a", title: "Second" }, status: "pending" },
			],
			identity,
		),
	).toEqual([
		{ id: "a", title: "Second" },
		{ id: "b", title: "Other" },
	]);
});
