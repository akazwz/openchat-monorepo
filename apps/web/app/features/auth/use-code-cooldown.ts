import { useEffect, useState } from "react";

// The server's rules for sign-in codes (apps/server/src/modules/auth/
// service.ts): a new one only this long after the last, which it replaces.
export const codeCooldownMs = 60_000;

// Seconds until another code can be requested, counted from a deadline: a
// phone pauses timers while its person reads the mail in another app.
export function useCodeCooldown() {
	const [until, setUntil] = useState(() => Date.now() + codeCooldownMs);
	const [now, setNow] = useState(Date.now);
	const remaining = Math.max(0, Math.ceil((until - now) / 1000));
	useEffect(() => {
		if (!remaining) return;
		const timer = setTimeout(() => setNow(Date.now()), 1000);
		return () => clearTimeout(timer);
	}, [remaining]);
	return {
		remaining,
		start: () => {
			setUntil(Date.now() + codeCooldownMs);
			setNow(Date.now());
		},
	};
}
