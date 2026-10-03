import type { Header } from "postal-mime";
import { describe, expect, test } from "vitest";

import { dmarcResult } from "@/modules/mail/authentication";

const header = (value: string): Header => ({
	key: "authentication-results",
	originalKey: "Authentication-Results",
	value,
});
// As Cloudflare's mail server wrote it on a delivered message (2026-09-29),
// tabs and comments included.
const cloudflare = (from: string, dmarc: string) =>
	header(
		`mx.cloudflare.net;\tdkim=pass header.d=${from} header.s=cf-bounce header.b=gQmpt99i;\tdmarc=${dmarc} header.from=${from} policy.dmarc=reject;\tspf=none (mx.cloudflare.net: no SPF records found for postmaster@bg-jj.cloudflare-smtp.net; see policy) smtp.helo=bg-jj.cloudflare-smtp.net;\tarc=none smtp.remote-ip=104.30.16.99`,
	);

describe("a received email's From address", () => {
	test("is verified by Cloudflare's own DMARC result for its domain", () => {
		expect(
			dmarcResult([cloudflare("heveta.com", "pass")], "noreply@heveta.com"),
		).toBe("pass");
		expect(
			dmarcResult([cloudflare("example.com", "fail")], "boss@example.com"),
		).toBe("fail");
	});
	test("cannot be vouched for by a header the sender wrote", () => {
		// Cloudflare's is on top; a forged pass below it counts for nothing.
		expect(
			dmarcResult(
				[cloudflare("example.com", "none"), cloudflare("example.com", "pass")],
				"boss@example.com",
			),
		).toBe("none");
		// Another server's results, or none at all: unverified.
		expect(
			dmarcResult(
				[header("mx.evil.test; dmarc=pass header.from=example.com")],
				"boss@example.com",
			),
		).toBeNull();
		expect(dmarcResult([], "boss@example.com")).toBeNull();
		// A pass for another domain than the From address's, or for none named.
		expect(
			dmarcResult([cloudflare("evil.test", "pass")], "boss@example.com"),
		).toBeNull();
		expect(
			dmarcResult(
				[header("mx.cloudflare.net; dmarc=pass policy.dmarc=reject")],
				"boss@example.com",
			),
		).toBeNull();
	});
});
