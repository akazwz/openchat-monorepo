import { snakeCase, text, unique } from "drizzle-orm/pg-core";

import { createdAt, timestamptz } from "./columns";
import { users } from "./users";

// A native execution device has its own credential, independently revocable
// from browser sessions. Plain credentials never enter the database.
export const devices = snakeCase.table(
	"devices",
	{
		id: text().primaryKey(),
		userId: text()
			.notNull()
			.references(() => users.id),
		clientId: text().notNull(),
		name: text().notNull(),
		platform: text().notNull().default("macos"),
		osVersion: text().notNull(),
		workspacePath: text().notNull(),
		tokenHash: text().notNull(),
		createdAt: createdAt(),
		revokedAt: timestamptz(),
	},
	(t) => [unique("devices_user_client_unique").on(t.userId, t.clientId)],
);
export type DeviceRecord = typeof devices.$inferSelect;
