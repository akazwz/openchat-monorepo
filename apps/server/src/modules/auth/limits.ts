import { env } from "cloudflare:workers";

import { AppError, ErrorCode } from "@/lib/errors";

// The network a client address belongs to, as limits count it: an IPv4
// address itself, and for IPv6 its /64, the block one subscriber is given.
// Counting each IPv6 address apart let one host pass every limit with a new
// address from its own block. Anything that is not an IPv6 address is
// returned as it is.
export function clientNetwork(address: string) {
	if (!address.includes(":")) return address;
	const halves = address.toLowerCase().split("::");
	if (halves.length > 2) return address;
	const [head, tail] = halves.map((half) => (half ? half.split(":") : []));
	// An embedded IPv4 tail (::ffff:1.2.3.4) is two groups.
	const groups = [...head, ...(tail ?? [])].flatMap((group) =>
		group.includes(".") ? ["", ""] : [group],
	).length;
	const missing = halves.length === 2 ? 8 - groups : 0;
	const expanded = [
		...head,
		...Array.from({ length: missing }, () => "0"),
		...(tail ?? []),
	];
	if (expanded.length < 4) return address;
	return `${expanded
		.slice(0, 4)
		.map((group) => group.padStart(4, "0"))
		.join(":")}::/64`;
}

// Public authentication methods are rate limited per client network.
// Verification codes additionally carry their own limits (see service.ts).
export async function limitRequest(clientAddress: string) {
	// Outside Cloudflare no address is reported, and nothing is limited by it.
	if (!clientAddress) return;
	const { success } = await env.AUTH_ADDRESS_LIMITER.limit({
		key: clientNetwork(clientAddress),
	});
	if (!success)
		throw new AppError(
			"Too many requests. Try again in a minute.",
			ErrorCode.ResourceExhausted,
		);
}
