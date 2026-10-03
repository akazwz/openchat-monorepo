import { AppShell } from "@astryxdesign/core/AppShell";
import { Center } from "@astryxdesign/core/Center";
import type { ReactNode } from "react";

// A page with no navigation of its own: signing in, the app's loading mark,
// an error that replaced everything. Its content is centered on the app's
// frame color (the shell paints it), the one the desktop window's band and
// the side nav have, so the page continues them.
export function StandalonePage({ children }: { children: ReactNode }) {
	return (
		<AppShell mobileNav={false}>
			<Center axis="both" padding={6} height="100%">
				{children}
			</Center>
		</AppShell>
	);
}
