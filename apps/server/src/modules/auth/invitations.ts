import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { users } from "@/db/schema/users";
import { ErrorReason } from "@/gen/heveta/v1/error_pb";
import { AppError, ErrorCode } from "@/lib/errors";

// Accounts are by invitation: an address may sign in when it has an account
// or was invited to create one. Invitations are keys of the INVITES KV
// namespace, the address in lowercase as sign-in reads it, added with
// `pnpm invite <email>`; kept there rather than in the repository or the
// database, so adding one is a command that takes effect at once, with no
// deploy. A new key can take up to a minute to be seen where the address
// was looked up just before (KV caches a miss too).
export async function requireInvitation(db: Database, email: string) {
	const [account] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, email));
	if (account || (await env.INVITES.get(email)) !== null) return;
	throw new AppError(
		"This address was not invited.",
		ErrorCode.PermissionDenied,
		ErrorReason.NOT_INVITED,
	);
}
