import { describe, expect, test } from "vitest";

import {
	byteLength,
	headerText,
	maxHeaderBytes,
	threadReferences,
} from "@/modules/mail/headers";

describe("a received header's value", () => {
	test("is one line: a decoded line break cannot fake another header", () => {
		expect(
			headerText("Invoice\r\nFrom: boss@example.com (verified) Pay today", 998),
		).toBe("Invoice From: boss@example.com (verified) Pay today");
	});
	test("cannot show an address backwards", () => {
		expect(headerText("‮moc.elpmaxe@ssob‬", 998)).toBe("moc.elpmaxe@ssob");
	});
	test("keeps joiners, and stops within its length", () => {
		expect(headerText("👨‍👩‍👧", 998)).toBe("👨‍👩‍👧");
		// Not between the halves of a character outside the BMP.
		expect(headerText("ab😀", 3)).toBe("ab");
	});
});

describe("a thread's References", () => {
	test("keep its root and latest IDs within one header", () => {
		const ids = Array.from({ length: 200 }, (_, n) => `<${n}@example.com>`);
		const references = threadReferences(ids).split(" ");
		expect(byteLength(references.join(" "))).toBeLessThanOrEqual(
			maxHeaderBytes,
		);
		expect(references[0]).toBe(ids[0]);
		expect(references.at(-1)).toBe(ids.at(-1));
	});
});
