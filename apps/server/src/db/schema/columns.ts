import { customType, timestamp } from "drizzle-orm/pg-core";

// A moment in time, as Postgres's timestamptz, read and written as a Date.
export const timestamptz = () =>
	timestamp({ withTimezone: true, mode: "date" });
// When a row was created, and last changed (drizzle sets it on every update).
export const createdAt = () => timestamptz().notNull().defaultNow();
export const updatedAt = () =>
	timestamptz()
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date());

// JSON as Postgres's jsonb, which cannot hold U+0000 (it rejects the whole
// write). A model can produce it anywhere (a tool call's arguments, its
// text), so strings and keys keep U+FFFD in its place, as tool output does
// (runtime/tools.ts): a reply is never left unsavable by one character.
const withoutNul = (_key: string, value: unknown) =>
	typeof value === "string"
		? value.replaceAll("\0", "�")
		: value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value).map(([key, item]) => [
						key.replaceAll("\0", "�"),
						item,
					]),
				)
			: value;
export const storedJson = <T>() =>
	customType<{ data: T; driverData: T }>({
		dataType: () => "jsonb",
		codec: "jsonb",
		toDriver: (value) => JSON.parse(JSON.stringify(value, withoutNul)),
	})();
