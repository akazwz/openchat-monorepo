import { and, eq, sql } from "drizzle-orm";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { defaultModel } from "@/config";
import type { Database } from "@/db/client";
import { threads } from "@/db/schema/threads";
import { gatewayMetadata, openai } from "@/lib/openai";
import { announce, userEvents } from "@/modules/events/publish";

import { getThread } from "./service";

const instructions = `You name conversations for a chat app's sidebar. You receive the first message a user sent in a new conversation and return a short title that says what the conversation is about.
- You are not replying to the message. Never answer it, greet back, or do what it asks; only name its topic.
- Name the topic or task as a noun phrase, not a sentence.
- Write the title in the language the message is written in: an English message gets an English title, a Chinese message a Chinese title. Never translate it.
- At most 6 English words or 12 Chinese characters. No quotes, no trailing punctuation.

Examples:
"hello" → Greeting
"你好" → 问候
"How do I center a div in CSS?" → Centering a div in CSS
"帮我写一封请假邮件，明天家里有事" → 请假邮件
"What's the weather like in Tokyo this weekend?" → Tokyo weekend weather
"周末带孩子去杭州玩两天，怎么安排" → 杭州亲子周末行程`;

const ThreadTitle = z.object({
	title: z
		.string()
		.describe(
			"A short title naming the conversation's topic, in the language of the message. Not a reply to the message.",
		),
});

// The message is material to name, not a turn to answer.
const titleInput = (text: string) =>
	`First message of the conversation:\n<message>\n${text}\n</message>`;

// A readable title in place of the first message's opening words, as ChatGPT
// and Claude do. It uses the fast default model, never blocks the reply, and
// only replaces a title still taken from the first message: a rename wins.
export async function generateThreadTitle(
	db: Database,
	thread: { id: string; userId: string },
	firstMessage: string,
	signal: AbortSignal,
) {
	const text = firstMessage.trim().slice(0, 2000);
	if (!text) return;
	const model = defaultModel();
	const response = await openai().responses.parse(
		{
			model: model.id,
			instructions,
			input: [{ role: "user", content: titleInput(text) }],
			text: { format: zodTextFormat(ThreadTitle, "thread_title") },
			// A title needs little thought: the least the model allows.
			...(model.reasoningEfforts[0]
				? { reasoning: { effort: model.reasoningEfforts[0] } }
				: {}),
			max_output_tokens: 300,
			store: false,
			safety_identifier: thread.userId,
		},
		{
			signal,
			headers: gatewayMetadata({ thread_id: thread.id, purpose: "title" }),
		},
	);
	const title = Array.from(response.output_parsed?.title.trim() ?? "")
		.slice(0, 40)
		.join("");
	if (!title) return;
	const [row] = await db
		.update(threads)
		.set({
			title,
			titleSource: "generated",
			revision: sql`${threads.revision} + 1`,
		})
		.where(and(eq(threads.id, thread.id), eq(threads.titleSource, "input")))
		.returning({ id: threads.id });
	// Read after it (threadColumns in ./service).
	if (row)
		await announce(thread.userId, [
			userEvents.thread(await getThread(db, thread.userId, thread.id)),
		]);
}
