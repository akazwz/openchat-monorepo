import { Banner } from "@astryxdesign/core/Banner";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { BrandMark, pageTitle } from "@heveta/brand";
import type { FormEventHandler, ReactNode } from "react";

import { StandalonePage } from "~/components/standalone-page";

// As ChatGPT's and Claude's: the mark, one heading, and the form under it in
// one centered column, on the page itself rather than in a card. The heading
// is set as the landing greeting is: `display-3`, at its regular weight.
export function AuthPage({
	title,
	description,
	children,
}: {
	title: string;
	// Only for instructions the form needs; omit rather than add filler.
	description?: string;
	children: ReactNode;
}) {
	return (
		<StandalonePage>
			<title>{pageTitle(title)}</title>
			<VStack gap={8} hAlign="stretch" width="100%" maxWidth={360}>
				<VStack gap={5} hAlign="center">
					<BrandMark size={40} />
					<VStack gap={2} hAlign="center">
						<Text type="display-3" as="h1" justify="center">
							{title}
						</Text>
						{description && (
							<Text color="secondary" justify="center" textWrap="balance">
								{description}
							</Text>
						)}
					</VStack>
				</VStack>
				{children}
			</VStack>
		</StandalonePage>
	);
}

export function AuthForm({
	pending,
	onSubmit,
	children,
}: {
	pending: boolean;
	onSubmit: FormEventHandler<HTMLFormElement>;
	children: ReactNode;
}) {
	// While it is sent, its input and button are disabled, so it cannot be
	// sent again.
	return (
		<form noValidate aria-busy={pending} onSubmit={onSubmit}>
			<FormLayout defaultOptionality="required">{children}</FormLayout>
		</form>
	);
}

export function FormNotice({
	message,
	status = "error",
}: {
	message?: string;
	status?: "error" | "success" | "info";
}) {
	return message ? <Banner status={status} title={message} /> : null;
}
