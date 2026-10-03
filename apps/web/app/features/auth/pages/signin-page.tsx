import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Code, ConnectError } from "@connectrpc/connect";
import { brandName } from "@heveta/brand";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { PrefetchPageLinks, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";

import { FormInput } from "~/components/form-input";
import {
	AuthForm,
	AuthPage,
	FormNotice,
} from "~/features/auth/components/auth-page";
import { authErrorMessage } from "~/features/auth/errors";
import { afterSignIn } from "~/features/auth/require-session";
import { useAuthStore } from "~/features/auth/store";
import { useCodeCooldown } from "~/features/auth/use-code-cooldown";
import { codeField, emailField } from "~/features/auth/validation";
import { nativeBridge } from "~/features/devices/native";
import { useT } from "~/i18n/use-t";
import { authClient } from "~/lib/rpc-client";

const emailSchema = z.object({ email: emailField });
const codeSchema = z.object({ code: codeField });

// A code sent: the email it went to, and the challenge that signs in with it.
interface SentCode {
	email: string;
	challenge: string;
}

// Sign-in is by email code only, and the first sign-in creates the account:
// one page, email first, then the code sent to it.
export default function SigninPage() {
	const [sent, setSent] = useState<SentCode>();
	const [searchParams] = useSearchParams();
	return (
		<>
			{/* The page sign-in leads to loads its modules one import after
			another; they are fetched ahead, all at once, while the person
			types, so it opens at once (as settings, thread-shell.tsx). */}
			<PrefetchPageLinks page={afterSignIn(searchParams.get("next"))} />
			{sent ? (
				<CodeStep
					key={sent.email}
					sent={sent}
					onResent={setSent}
					onChangeEmail={() => setSent(undefined)}
				/>
			) : (
				<EmailStep onSent={setSent} />
			)}
		</>
	);
}

function EmailStep({ onSent }: { onSent: (sent: SentCode) => void }) {
	const t = useT();
	const { control, handleSubmit } = useForm<z.infer<typeof emailSchema>>({
		resolver: zodResolver(emailSchema),
		defaultValues: { email: "" },
	});
	const send = useMutation({
		mutationFn: async (input: z.infer<typeof emailSchema>) =>
			authClient.sendSignInCode(input),
		onSuccess: ({ challenge }, { email }) => onSent({ email, challenge }),
	});
	return (
		<AuthPage
			title={t("auth.signInTitle", { brand: brandName })}
			description={t("auth.signInDescription")}
		>
			<AuthForm
				pending={send.isPending}
				onSubmit={handleSubmit((input) => send.mutate(input))}
			>
				<FormInput
					control={control}
					name="email"
					isDisabled={send.isPending}
					label={t("auth.email")}
					isLabelHidden
					size="lg"
					type="email"
					inputMode="email"
					autoComplete="email"
					placeholder={t("auth.emailPlaceholder")}
				/>
				<FormNotice
					message={
						send.error
							? t(authErrorMessage(send.error, "auth.sendCodeFailed"))
							: undefined
					}
				/>

				<Button
					type="submit"
					label={t("auth.sendCode")}
					variant="primary"
					size="lg"
					width="100%"
					isLoading={send.isPending}
				/>
			</AuthForm>
		</AuthPage>
	);
}

function CodeStep({
	sent: { email, challenge },
	onResent,
	onChangeEmail,
}: {
	sent: SentCode;
	onResent: (sent: SentCode) => void;
	onChangeEmail: () => void;
}) {
	const t = useT();
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	// The code was just sent; resending waits out the server's cooldown.
	const cooldown = useCodeCooldown();
	const { control, handleSubmit } = useForm<z.infer<typeof codeSchema>>({
		resolver: zodResolver(codeSchema),
		defaultValues: { code: "" },
	});
	const resend = useMutation({
		mutationFn: async () => authClient.sendSignInCode({ email }),
		onSuccess: (response) => {
			onResent({ email, challenge: response.challenge });
			cooldown.start();
		},
		onError: (error) => {
			if (
				error instanceof ConnectError &&
				error.code === Code.ResourceExhausted
			)
				cooldown.start();
		},
	});
	const signIn = useMutation({
		mutationFn: async (input: z.infer<typeof codeSchema>) => {
			const { user } = await authClient.signInWithEmailCode({
				challenge,
				code: input.code,
			});
			if (!user) throw new ConnectError("Missing account", Code.Internal);
			return user;
		},
		// The response set the session cookie; the app is now this account's.
		onSuccess: (user) => {
			useAuthStore.getState().signIn(user);
			void nativeBridge()
				?.syncUser(user.id)
				.catch(() => {});
			void navigate(afterSignIn(searchParams.get("next")), { replace: true });
		},
	});
	const busy = resend.isPending || signIn.isPending;
	return (
		<AuthPage
			title={t("auth.enterCodeTitle")}
			description={t("auth.enterCodeDescription", { email })}
		>
			<VStack gap={5} hAlign="stretch">
				<AuthForm
					pending={busy}
					onSubmit={handleSubmit((input) => {
						resend.reset();
						signIn.mutate(input);
					})}
				>
					<FormInput
						control={control}
						name="code"
						isDisabled={busy}
						label={t("auth.code")}
						isLabelHidden
						size="lg"
						placeholder={t("auth.codePlaceholder")}
						inputMode="numeric"
						autoComplete="one-time-code"
						maxLength={6}
					/>
					<FormNotice
						message={
							signIn.error
								? t(authErrorMessage(signIn.error, "auth.signInFailed"))
								: undefined
						}
					/>
					<Button
						type="submit"
						label={t("auth.signIn")}
						variant="primary"
						size="lg"
						width="100%"
						isLoading={signIn.isPending}
						isDisabled={resend.isPending}
					/>
				</AuthForm>
				<FormNotice
					status="success"
					message={resend.isSuccess ? t("auth.codeResent") : undefined}
				/>
				<FormNotice
					message={
						resend.error
							? t(authErrorMessage(resend.error, "auth.resendFailed"))
							: undefined
					}
				/>

				<HStack justify="center" wrap="wrap" gap={2}>
					<Button
						label={
							cooldown.remaining
								? t("auth.resendCodeCountdown", {
										seconds: cooldown.remaining,
									})
								: t("auth.resendCode")
						}
						variant="ghost"
						size="sm"
						isDisabled={busy || cooldown.remaining > 0}
						isLoading={resend.isPending}
						onClick={() => {
							signIn.reset();
							resend.mutate();
						}}
					/>
					<Button
						label={t("auth.changeEmail")}
						variant="ghost"
						size="sm"
						isDisabled={busy}
						onClick={onChangeEmail}
					/>
				</HStack>
			</VStack>
		</AuthPage>
	);
}
