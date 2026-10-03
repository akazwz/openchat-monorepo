import { index, integer, snakeCase, text } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { createdAt, timestamptz, updatedAt } from "./columns";

export const verificationCodes = snakeCase.table(
	"verification_codes",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => uuidv7()),
		// Sign-in codes; the only kind of code there is.
		code: text().notNull(),
		email: text().notNull(),
		// SHA-256 of the requesting client's address: an address's own daily
		// allowance for an email, so requests from elsewhere cannot use it up.
		requesterHash: text().notNull(),
		// Wrong guesses against this code; it is retired after a few.
		attempts: integer().notNull().default(0),
		expiresAt: timestamptz().notNull(),
		usedAt: timestamptz(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index("verification_codes_email_idx").on(t.email, t.id),
		index("verification_codes_expires_at_idx").on(t.expiresAt),
	],
);
