// Invites addresses to create an account (modules/auth/invitations.ts):
// `pnpm invite someone@example.com [more@example.com …]`, in production;
// with `--local`, in local development's storage. Each takes effect at once.
import { execFileSync } from "node:child_process";

import { z } from "zod";

import { invitesNamespaceId } from "../cloudflare-resources.ts";

const args = process.argv.slice(2);
const local = args.includes("--local");
// As sign-in reads an address (auth/service.ts emailAddress).
const emails = args
	.filter((arg) => arg !== "--local")
	.map((arg) => arg.trim().toLowerCase());
const invalid = emails.filter((email) => !z.email().safeParse(email).success);
if (!emails.length || invalid.length) {
	console.error(
		invalid.length
			? `Not an email address: ${invalid.join(", ")}`
			: "Usage: pnpm invite <email> [<email> …] [--local]",
	);
	process.exit(1);
}
for (const email of emails)
	execFileSync(
		"pnpm",
		[
			"exec",
			"cf",
			"kv",
			"keys",
			"put",
			email,
			"--namespace-id",
			invitesNamespaceId,
			...(local ? ["--local", "--persist-to", ".wrangler/state"] : []),
			"--body",
			// When it was invited, for whoever looks at the list.
			new Date().toISOString(),
		],
		{ stdio: "inherit" },
	);
