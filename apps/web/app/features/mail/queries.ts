import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { EmailFolder } from "~/gen/heveta/v1/mail_pb";
import { mailClient } from "~/lib/rpc-client";

// The agent's mailbox (docs/email.md). Its queries share a prefix, so the
// event that mail arrived, was sent, or was deleted marks them all stale.
export const mailKey = (userId: string) => ["users", userId, "mail"];

// The address, and how much the agent sent in the last 24 hours.
export const mailboxQuery = (userId: string) =>
	queryOptions({
		queryKey: [...mailKey(userId), "mailbox"],
		queryFn: async ({ signal }) =>
			(await mailClient.getMailbox({}, { signal })).mailbox,
		enabled: Boolean(userId),
	});

export const emailsQuery = (userId: string, folder: EmailFolder) =>
	infiniteQueryOptions({
		queryKey: [...mailKey(userId), "folder", folder],
		initialPageParam: "",
		queryFn: ({ signal, pageParam }) =>
			mailClient.listEmails(
				{ folder, pageSize: 50, pageToken: pageParam },
				{ signal },
			),
		getNextPageParam: (page) => page.nextPageToken || undefined,
		enabled: Boolean(userId),
	});

export const emailQuery = (userId: string, emailId: string) =>
	queryOptions({
		queryKey: [...mailKey(userId), "email", emailId],
		queryFn: async ({ signal }) =>
			(await mailClient.getEmail({ emailId }, { signal })).email,
		enabled: Boolean(userId && emailId),
	});
