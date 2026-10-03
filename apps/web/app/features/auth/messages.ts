import { defineMessages } from "~/i18n/catalog";

export default defineMessages("auth", {
	en: {
		signIn: "Sign in",
		signInTitle: "Sign in to {brand}",
		signInDescription:
			"Heveta is invite-only for now. Use the email you were invited with.",
		email: "Email",
		emailPlaceholder: "Email address",
		sendCode: "Send code",
		sendCodeFailed: "Couldn’t send it. Check the email and try again.",
		enterCodeTitle: "Check your email",
		enterCodeDescription:
			"Enter the code sent to {email}. It’s valid for 10 minutes.",
		code: "Code",
		codePlaceholder: "6-digit code",
		signInFailed: "Couldn’t sign in. Try again later.",
		resendCode: "Resend code",
		resendCodeCountdown:
			"{seconds, plural, one {Resend in # second} other {Resend in # seconds}}",
		changeEmail: "Change email",
		codeResent: "A new code was sent. Check your email.",
		resendFailed: "Couldn’t send it. Try again later.",
		account: "Account",
		settings: "Settings",
		signOut: "Sign out",
		signOutFailed: "Couldn’t sign out. Try again later.",
		emailInvalid: "Enter a valid email address.",
		usernameInvalid:
			"Username must be 2–40 characters: letters, numbers, underscores, or hyphens.",
		codeFormatInvalid: "Enter the 6-digit code.",
		codeSendFailed: "Couldn’t send the code email. Request a new one.",
		codeInvalidOrExpired:
			"That code is incorrect or has expired. Re-enter it or request a new one.",
		codesExhausted:
			"You’ve reached today’s limit for codes. Try again tomorrow.",
		codesPaused:
			"Sign-in codes are paused for today because too many were requested. Try again tomorrow.",
		notInvited:
			"Heveta is invite-only for now. Ask the person who shared it with you to invite this email.",
		tooManyRequests: "Too many requests. Wait a minute and try again.",
		serviceUnavailable: "Couldn’t connect to the service. Try again later.",
		requestTimedOut: "The request timed out. Try again later.",
		serviceFailure:
			"The service couldn’t process the request. Try again later.",
	},
	"zh-CN": {
		signIn: "登录",
		signInTitle: "登录 {brand}",
		signInDescription: "Heveta 目前仅限受邀使用，请用受邀的邮箱登录。",
		email: "邮箱",
		emailPlaceholder: "邮箱地址",
		sendCode: "发送验证码",
		sendCodeFailed: "发送失败，请检查邮箱后重试。",
		enterCodeTitle: "查收邮件",
		enterCodeDescription: "输入发送至 {email} 的验证码，10 分钟内有效。",
		code: "验证码",
		codePlaceholder: "6 位验证码",
		signInFailed: "登录失败，请稍后重试。",
		resendCode: "重新发送验证码",
		resendCodeCountdown: "{seconds, plural, other {# 秒后可重发}}",
		changeEmail: "更换邮箱",
		codeResent: "验证码已重新发送，请查收邮件。",
		resendFailed: "发送失败，请稍后重试。",
		account: "账号",
		settings: "设置",
		signOut: "退出登录",
		signOutFailed: "退出登录失败，请稍后重试。",
		emailInvalid: "请输入有效的邮箱地址",
		usernameInvalid:
			"用户名需为 2–40 个字符，只能包含文字、数字、下划线或连字符",
		codeFormatInvalid: "请输入 6 位数字验证码",
		codeSendFailed: "验证码邮件发送失败，请重新获取验证码。",
		codeInvalidOrExpired: "验证码不正确或已过期，请重新输入或获取验证码。",
		codesExhausted: "今天获取验证码的次数已达上限，请明天再试。",
		codesPaused: "今天请求验证码的人过多，已暂停发送，请明天再试。",
		notInvited: "Heveta 目前仅限受邀使用。请让分享给你的人邀请这个邮箱。",
		tooManyRequests: "请求过于频繁，请等待一分钟后重试。",
		serviceUnavailable: "暂时无法连接服务，请稍后重试。",
		requestTimedOut: "请求超时，请稍后重试。",
		serviceFailure: "服务暂时无法处理请求，请稍后重试。",
	},
});
