import { env } from "cloudflare:workers";

import { appConfig } from "@/config";
import type { Locale } from "@/lib/locale";

// The only mail the app sends: a sign-in code, in the language of the page
// that asked for it. The same code signs in an existing account or creates
// one, so the wording covers both.
const wording: Record<
	Locale,
	{ subject: string; intro: string; expiry: string }
> = {
	en: {
		subject: "{name} sign-in code: {code}",
		intro: "Your {name} sign-in code is:",
		expiry:
			"It expires in 10 minutes. If you didn’t request it, you can ignore this email.",
	},
	"zh-CN": {
		subject: "{name} 登录验证码：{code}",
		intro: "你的 {name} 登录验证码是：",
		expiry: "10 分钟内有效。如果不是你本人操作，请忽略这封邮件。",
	},
};

export async function sendSignInCodeEmail(
	email: string,
	code: string,
	locale: Locale,
) {
	if (!/^\d{6}$/.test(code)) throw new Error("Invalid sign-in code");
	const fill = (text: string) =>
		text.replaceAll("{name}", appConfig.name).replaceAll("{code}", code);
	const words = wording[locale];
	await env.EMAIL.send({
		from: { email: env.EMAIL_FROM, name: appConfig.name },
		to: email,
		subject: fill(words.subject),
		text: `${fill(words.intro)} ${code}\n\n${words.expiry}`,
		html: `
			<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333;">
				<p>${fill(words.intro)}</p>
				<p style="font-size: 28px; font-weight: bold; letter-spacing: 4px; margin: 16px 0;">${code}</p>
				<p>${words.expiry}</p>
			</div>
		`,
	});
}
