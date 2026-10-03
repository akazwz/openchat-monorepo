import type { Config } from "@react-router/dev/config";

// The site is static: its pages are rendered at build time, so they arrive
// whole, for people and for search engines alike, and a Worker serves the
// files (cloudflare.config.ts).
export default {
	ssr: false,
	prerender: ["/", "/zh"],
} satisfies Config;
