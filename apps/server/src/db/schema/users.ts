import { integer, snakeCase, text } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { createdAt, updatedAt } from "./columns";

export const users = snakeCase.table("users", {
	id: text()
		.primaryKey()
		.$defaultFn(() => uuidv7()),
	email: text().notNull().unique(),
	// Shown in the app, like a display name: starts as the email's local part
	// and can be changed. Not unique; nothing addresses a user by it.
	username: text().notNull(),
	// The profile photo's current version, null when there is none. Its image
	// is the R2 object avatars/<id>/<version> (modules/auth/avatar.ts): a new
	// photo is a new object, so its address changes with it.
	avatarVersion: text(),
	// Orders profile snapshots from RPC responses and event publishers.
	revision: integer().notNull().default(1),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

export type User = typeof users.$inferSelect;
