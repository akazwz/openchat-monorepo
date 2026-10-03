import { expect, test } from "vitest";

import { clientNetwork } from "@/modules/auth/limits";

test("an IPv6 client counts as its /64; IPv4 as its address", () => {
	expect(clientNetwork("203.0.113.9")).toBe("203.0.113.9");
	for (const address of [
		"2001:db8:5:7::1",
		"2001:0DB8:0005:0007:ffff:ffff:ffff:ffff",
		"2001:db8:5:7:a::b",
	])
		expect(clientNetwork(address)).toBe("2001:0db8:0005:0007::/64");
	expect(clientNetwork("::1")).toBe("0000:0000:0000:0000::/64");
	expect(clientNetwork("2001:db8::")).toBe("2001:0db8:0000:0000::/64");
	expect(clientNetwork("::ffff:192.0.2.1")).toBe("0000:0000:0000:0000::/64");
	expect(clientNetwork("")).toBe("");
});
