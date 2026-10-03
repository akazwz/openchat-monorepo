import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { type Mailbox, mailboxes } from "@/db/schema/mailboxes";

// A generated address's characters: lowercase letters and digits, without
// those read alike (0 and o, 1 and l and i).
const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
const nameLength = 8;
// The largest multiple of the alphabet's size a byte reaches: bytes past it
// are drawn again, so every character is equally likely.
const uniformBytes = 256 - (256 % alphabet.length);

function newName() {
	let name = "";
	while (name.length < nameLength)
		for (const byte of crypto.getRandomValues(new Uint8Array(nameLength)))
			if (byte < uniformBytes && name.length < nameLength)
				name += alphabet[byte % alphabet.length];
	return name;
}

export const mailAddress = (mailbox: Pick<Mailbox, "name">) =>
	`${mailbox.name}@${env.AGENT_MAIL_DOMAIN}`;

// The mailbox an address is for: its local part at the agents' domain,
// lowercase, without a subaddress ("name+anything" is name's). Undefined for
// any other domain.
export function mailboxName(address: string) {
	const at = address.lastIndexOf("@");
	if (at < 1) return undefined;
	if (address.slice(at + 1).toLowerCase() !== env.AGENT_MAIL_DOMAIN)
		return undefined;
	return address.slice(0, at).split("+")[0].toLowerCase() || undefined;
}

// The user's mailbox, given its address the first time it is asked for: an
// address nobody has seen cannot have been written to, so none is made
// before then. A name another mailbox has (or a mailbox made at the same
// time) is tried again.
export async function mailboxOf(db: Database, userId: string) {
	for (let attempt = 0; attempt < 5; attempt++) {
		const [existing] = await db
			.select()
			.from(mailboxes)
			.where(eq(mailboxes.userId, userId));
		if (existing) return existing;
		const [created] = await db
			.insert(mailboxes)
			.values({ userId, name: newName() })
			.onConflictDoNothing()
			.returning();
		if (created) return created;
	}
	throw new Error("No mailbox name was free");
}

export async function findMailbox(
	db: Database,
	name: string,
): Promise<Mailbox | undefined> {
	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.name, name));
	return mailbox;
}
