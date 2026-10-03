import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";

import { EmailFolder, MailService } from "@/gen/heveta/v1/mail_pb";
import { pageOptions, pageResult } from "@/lib/pagination";
import { getAuthInfo } from "@/rpc/context";
import { getDB } from "@/rpc/database";

import { mailAddress } from "./mailbox";
import { emailResource, emailSummaryResource } from "./rpc-codec";
import * as service from "./service";

export function registerMail(router: ConnectRouter) {
	router.service(MailService, {
		async getMailbox(_req, ctx) {
			const { mailbox, used, limit, unread } = await service.mailboxUsage(
				getDB(ctx),
				getAuthInfo(ctx).userId,
			);
			return {
				mailbox: {
					address: mailAddress(mailbox),
					recipientLimit: limit,
					recipientsUsed: used,
					unreadCount: unread,
				},
			};
		},
		async listEmails(req, ctx) {
			if (req.folder !== EmailFolder.INBOX && req.folder !== EmailFolder.SENT)
				throw new ConnectError("folder is required", Code.InvalidArgument);
			const folder = req.folder === EmailFolder.INBOX ? "inbox" : "sent";
			// A page token is for its folder alone.
			const scope = `emails:${folder}`;
			const { limit, cursor } = pageOptions(req.pageSize, req.pageToken, scope);
			const rows = await service.listEmails(
				getDB(ctx),
				getAuthInfo(ctx).userId,
				folder,
				{ limit: limit + 1, before: cursor },
			);
			const page = pageResult(rows, limit, scope);
			return {
				emails: page.items.map(emailSummaryResource),
				nextPageToken: page.nextPageToken,
			};
		},
		async getEmail(req, ctx) {
			const { email, attachments } = await service.getEmail(
				getDB(ctx),
				getAuthInfo(ctx).userId,
				req.emailId,
			);
			return { email: emailResource(email, attachments) };
		},
		async markEmailRead(req, ctx) {
			await service.markEmailRead(
				getDB(ctx),
				getAuthInfo(ctx).userId,
				req.emailId,
			);
			return {};
		},
		async deleteEmail(req, ctx) {
			await service.deleteEmail(
				getDB(ctx),
				getAuthInfo(ctx).userId,
				req.emailId,
			);
			return {};
		},
	});
}
