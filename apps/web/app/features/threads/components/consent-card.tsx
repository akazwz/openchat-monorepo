import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import {
	MetadataList,
	MetadataListItem,
} from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { useState } from "react";

import { currentSession, isCurrentSession } from "~/features/auth/store";
import { answerToolCall, getRun } from "~/features/runs/run-api";
import { showRun } from "~/features/threads/queries";
import type { ToolCall } from "~/gen/heveta/v1/thread_pb";
import { useT } from "~/i18n/use-t";

const texts = (value: unknown) =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && !!item)
		: [];
const text = (value: unknown) => (typeof value === "string" ? value : "");

// A call that takes effect outside and waits for the person's consent
// (docs/approvals.md): what it will do, exactly as it will be done, and the
// two answers. The run goes on from the answer, so the card stays until the
// server's state says the call was answered; a failed answer leaves it as it
// was. Any of the person's devices may answer; the first answer stands.
export function ConsentCard({
	runId,
	call,
	name,
}: {
	runId: string;
	call: ToolCall;
	// The call's name as people read it.
	name: string;
}) {
	const t = useT();
	const toast = useToast();
	const [answering, setAnswering] = useState<boolean>();
	async function answer(approved: boolean) {
		const owner = currentSession();
		setAnswering(approved);
		try {
			showRun(owner.userId, await answerToolCall(runId, call.id, approved));
		} catch {
			if (!isCurrentSession(owner)) return;
			toast({ type: "error", body: t("threads.consentFailed") });
			// Answered from another device, or the reply was stopped: show
			// where the run stands now.
			try {
				showRun(owner.userId, await getRun(runId));
			} catch {}
		} finally {
			setAnswering(undefined);
		}
	}
	const email = call.name === "email_send";
	const args = call.arguments ?? {};
	const recipients = texts(args.to);
	return (
		<Card width="100%">
			<VStack gap={3}>
				<Text weight="semibold">
					{email ? t("threads.consentEmailTitle") : name}
				</Text>
				{email ? (
					<>
						<MetadataList>
							<MetadataListItem label={t("threads.consentEmailTo")}>
								{recipients.length
									? recipients.join(", ")
									: t("threads.consentEmailReplyTo")}
							</MetadataListItem>
							{texts(args.cc).length > 0 && (
								<MetadataListItem label={t("threads.consentEmailCc")}>
									{texts(args.cc).join(", ")}
								</MetadataListItem>
							)}
							{texts(args.bcc).length > 0 && (
								<MetadataListItem label={t("threads.consentEmailBcc")}>
									{texts(args.bcc).join(", ")}
								</MetadataListItem>
							)}
							{text(args.subject) && (
								<MetadataListItem label={t("threads.consentEmailSubject")}>
									{text(args.subject)}
								</MetadataListItem>
							)}
							{texts(args.attachments).length > 0 && (
								<MetadataListItem label={t("threads.consentEmailAttachments")}>
									{texts(args.attachments).join(", ")}
								</MetadataListItem>
							)}
						</MetadataList>
						{/* The text as it will be sent, line for line. */}
						<CodeBlock
							code={text(args.text)}
							language="text"
							hasLanguageLabel={false}
							hasCopyButton={false}
							width="100%"
							maxHeight={320}
							isWrapped
						/>
					</>
				) : (
					<CodeBlock
						code={JSON.stringify(args, null, 2)}
						language="json"
						width="100%"
						maxHeight={320}
						isWrapped
					/>
				)}
				<HStack gap={2}>
					<Button
						label={t(
							email ? "threads.consentEmailSend" : "threads.consentAllow",
						)}
						variant="primary"
						isLoading={answering === true}
						isDisabled={answering === false}
						onClick={() => void answer(true)}
					/>
					<Button
						label={t(
							email ? "threads.consentEmailRefuse" : "threads.consentRefuse",
						)}
						isLoading={answering === false}
						isDisabled={answering === true}
						onClick={() => void answer(false)}
					/>
				</HStack>
			</VStack>
		</Card>
	);
}
