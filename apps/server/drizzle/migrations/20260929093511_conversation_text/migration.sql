ALTER TABLE "messages" ADD COLUMN "text" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Each message's text parts joined, as the conversation tools read them
-- (threads/history.ts messageText).
UPDATE "messages" SET "text" = (SELECT coalesce(string_agg(part->'content'->>'value', E'\n' ORDER BY position), '') FROM jsonb_array_elements("parts") WITH ORDINALITY AS parts(part, position) WHERE part->'content'->>'case' = 'text');--> statement-breakpoint
-- A tool call's arguments are kept as the model wrote them (JSON text);
-- those stored parsed become text again.
UPDATE "messages" SET "parts" = (SELECT jsonb_agg(CASE WHEN jsonb_typeof(part->'content'->'value'->'arguments') = 'object' THEN jsonb_set(part, '{content,value,arguments}', to_jsonb((part->'content'->'value'->'arguments')::text)) ELSE part END ORDER BY position) FROM jsonb_array_elements("parts") WITH ORDINALITY AS parts(part, position)) WHERE "parts" @> '[{"content":{"case":"toolCall"}}]';--> statement-breakpoint
CREATE INDEX "emails_sent_created_idx" ON "emails" ("created_at") WHERE "status" in ('sending', 'sent');--> statement-breakpoint
-- The operator class of the trigram index below.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "messages_text_trgm_idx" ON "messages" USING gin ("text" gin_trgm_ops);
