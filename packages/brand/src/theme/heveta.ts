import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";

const systemFonts =
	'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// Text and anything drawn in its color: a soft black, and its counterpart on
// the dark page.
const ink: [string, string] = ["#1f1f1d", "#ecece9"];

// Heveta's theme: Astryx Neutral, re-toned, plus the few component rules the
// app needs. It is the only place the app and the site style anything; screens
// use props and components. `pnpm --filter @heveta/brand theme` compiles it
// into heveta.css and heveta.js beside it (committed; `theme:check` verifies
// they match): pages load its CSS as a stylesheet, so a prerendered page is
// themed from its first paint, and Theme injects nothing at runtime.
//
// The look is quiet and warm, as in Claude and ChatGPT. Ink is a soft black on
// white, never pure black; greys lean slightly warm. Two page steps: the
// frame (the side nav, the desktop window's band, a page that stands alone)
// is an off-white a shade under the content, which is white. Things in the
// page (cards, a person's message) are the frame's shade again, so they sit
// in the white without boxes drawn around them. Things over the page (the
// composer, menus, popovers, dialogs) are the content's white and are told
// apart by a hairline and a soft shadow, which grow with how far they float.
// Lines that carry structure keep the border color: a table's rows, a
// quote's bar, a rule, a code block's frame, a field's outline, a divider
// between rows, a tab bar's baseline. The focus ring (`--focus-outline-*`)
// and the inset rings (`--shadow-inset-*`) that mark hover, selection, and
// validation stay Neutral's: they show state, and keyboard use needs them.
export const hevetaTheme = defineTheme({
	name: "heveta",
	extends: neutralTheme,
	// The system's own typeface, as Neutral's stack falls back to. Neutral
	// names Figtree first (for body and headings), but nothing loads it, so it
	// only showed where someone happened to have it installed. No web font is
	// loaded.
	typography: {
		body: { family: "system-ui", fallbacks: systemFonts },
		heading: { family: "system-ui", fallbacks: systemFonts },
	},
	localTokens: {
		// The code typeface, kept under its own name for code shown inside a
		// part of the page that re-points the code token (chat-tool-calls).
		"--heveta-font-family-code": "var(--font-family-code)",
		// What people read and write in a conversation is a step larger than
		// the interface around it (15px to its 14px), with more air between
		// lines, as in ChatGPT and Claude.
		// Neutral's note banner is a saturated blue; in a page this quiet it
		// shouts. A pale tint of it, as the other statuses below.
		"--astryx-theme-neutral-color-status-muted-accent": [
			"#e9f1fd",
			"#88bcff3d",
		],
		"--heveta-text-reading-size": "0.9375rem",
		"--heveta-text-reading-leading": "1.6",
	},
	tokens: {
		// Each pair is [light, dark].
		"--color-background-body": ["#f7f7f5", "#171716"],
		"--color-background-surface": ["#ffffff", "#1f1f1e"],
		"--color-background-card": ["#f7f7f5", "#282827"],
		"--color-background-muted": ["#f4f4f1", "#282827"],
		"--color-background-popover": ["#ffffff", "#2a2a29"],
		"--color-skeleton": ["#efefec", "#333331"],
		"--color-text-primary": ink,
		"--color-text-secondary": ["#6b6b67", "#a3a39e"],
		"--color-text-disabled": ["#a9a9a4", "#5c5c58"],
		"--color-icon-primary": ink,
		"--color-icon-secondary": ["#7a7a75", "#9a9a95"],
		"--color-icon-disabled": ["#a9a9a4", "#5c5c58"],
		// The accent is the ink itself: a primary button is the darkest thing
		// on the page, not a color.
		"--color-accent": ink,
		"--color-on-accent": ["#ffffff", "#1a1a19"],
		"--color-text-accent": ink,
		"--color-icon-accent": ink,
		"--color-accent-muted": ["#f0f0ed", "#2c2c2b"],
		"--color-border": ["#1f1f1d14", "#ffffff14"],
		"--color-border-emphasized": ["#dcdcd7", "#3d3d3b"],
		"--color-neutral": ["#1f1f1d0f", "#ffffff14"],
		"--color-overlay-hover": ["#1f1f1d0a", "#ffffff0a"],
		"--color-overlay-pressed": ["#1f1f1d14", "#ffffff14"],
		"--color-shadow": ["#0000000f", "#00000066"],
		// What a dialog dims the page with: enough to set it apart, not a
		// blackout.
		"--color-overlay": ["#1f1f1d52", "#000000a6"],
		// A banner's ground: a pale tint of its status, under ink-dark text.
		"--color-success-muted": ["#e4f3e3", "#90ca903d"],
		"--color-warning-muted": ["#fbf1d0", "#e2b6233d"],
		"--color-error-muted": ["#fbdcd8", "#ff98903d"],
		// A hairline and a shadow that deepens with the layer: low for what
		// rests on the page (the composer), med for menus and popovers, high
		// for dialogs. In the dark the shadow is lost on the page and the
		// hairline does the work.
		"--shadow-low":
			"0 0 0 1px var(--color-border), 0 1px 3px var(--color-shadow)",
		"--shadow-med":
			"0 0 0 1px var(--color-border), 0 6px 20px var(--color-shadow)",
		"--shadow-high":
			"0 0 0 1px var(--color-border), 0 20px 56px var(--color-shadow)",
		// Headings are told from text by their size and a semibold, never a
		// bold; the large text of a greeting is medium.
		"--text-heading-3-weight": "var(--font-weight-semibold)",
		"--text-heading-4-weight": "var(--font-weight-semibold)",
		"--text-large-weight": "var(--font-weight-medium)",
	},
	components: {
		// User identifiers and other unbroken text must fit their container,
		// including account values and the sign-in confirmation email.
		// Plain text as someone wrote it (an email's) is body text that keeps its
		// line breaks and spaces, as a user's message does (chat-message-bubble
		// below). Text has no prop for it, so it is a type of its own.
		text: {
			base: { overflowWrap: "anywhere" },
			"type:plain": { whiteSpace: "pre-wrap" },
		},
		// Native scrollers (ChatLayout's, the side nav's, the nav drawer's) leave
		// the scrollbar unstyled: a 15px bar with a grey track wherever scrollbars
		// always show. `scrollbar-color` is inherited, so set on each AppShell it
		// gives every scroller inside, the drawer's <dialog> included, the look of
		// Astryx's own ScrollableArea (neutral thumb, no track; forced colors mode
		// resets it to `auto` by itself). No gutter is reserved: "stable" left an
		// empty strip beside short conversations. ChatLayout's rule that hides the
		// bar while it animates a scroll is untouched.
		"app-shell": {
			base: { scrollbarColor: "var(--color-neutral) transparent" },
		},
		button: {
			// The sidebar's account row, chosen by the user on 2026-09-25: a
			// full-width ghost button whose avatar, name, and chevron sit
			// start-aligned like the nav rows above it. Button centers its content
			// and no prop changes that, so the row is its own variant.
			// A disclosure's title row, as ChatToolCalls draws its own (a reply's
			// activity, chat-bubble.tsx): quiet small text whose icon and chevron
			// sit beside it, no taller than its line, and no inset, so its icon
			// lines up with the reply's text below.
			"variant:disclosure": {
				backgroundColor: "transparent",
				color: "var(--color-text-secondary)",
				height: "auto",
				paddingInline: "0",
				paddingBlock: "var(--spacing-1)",
				gap: "var(--spacing-1)",
				fontSize: "var(--text-supporting-size)",
				fontWeight: "var(--font-weight-medium)",
				// No hover or press tint, and no press shrink: like ChatToolCalls'
				// title, it answers a click with its chevron and what it opens.
				// Keyboard focus keeps the focus ring.
				"--color-overlay-hover": "transparent",
				"--color-overlay-pressed": "transparent",
				transform: "none",
			},
			"variant:account": {
				backgroundColor: "transparent",
				color: "var(--color-text-primary)",
				display: "grid",
				gridTemplateColumns: "auto minmax(0, 1fr) auto",
				textAlign: "start",
			},
		},
		// A reply's activity, its thinking and tool calls (chat-bubble.tsx),
		// opened. Done, it shows in full. While it is written (`activity-live`)
		// it grows up to a few lines' height, then scrolls, following the newest
		// (useChatStreamScroll); no Card prop caps a height without fixing it,
		// so the cap is the variant's.
		card: {
			"variant:activity": {
				backgroundColor: "var(--color-background-card)",
			},
			"variant:activity-live": {
				backgroundColor: "var(--color-background-card)",
				maxHeight: "240px",
				overflowY: "auto",
			},
			// The rounded frame of a picture drawn inside a SelectableCard (the
			// appearance choices, theme-choice-cards.tsx). The selected card's
			// ring reaches a Card nested in it through the shadow it inherits,
			// which drew a second ring around the picture's corners; a picture
			// has no ring of its own.
			"variant:preview": {
				backgroundColor: "transparent",
				borderRadius: "var(--radius-element)",
				overflow: "hidden",
				boxShadow: "none",
			},
		},
		// Without avatars, the transcript and the composer share one centered
		// 800px column (ChatLayout's balanced density adds no inset or cap of its
		// own), while the scroll area stays full width. The landing composer
		// takes the same column, so it keeps its width when it docks.
		"chat-message-list": {
			base: { width: "100%", maxWidth: "800px", marginInline: "auto" },
		},
		// The composer rests on the page: white like the content, set off by the
		// low shadow's hairline (its default elevation; hover and focus lift it
		// to the next). What is typed in it is reading text.
		"chat-composer": {
			base: {
				width: "100%",
				maxWidth: "800px",
				marginInline: "auto",
				"--text-body-size": "var(--heveta-text-reading-size)",
				"--text-body-leading": "var(--heveta-text-reading-leading)",
			},
		},
		// AppShell wraps its desktop side nav in LayoutPanel. Keep that surface
		// on the body's background step, apart from the main page. The computer
		// now has its own routes, but the side nav still uses this rule.
		"layout-panel": {
			base: { backgroundColor: "var(--color-background-body)" },
		},
		// The nav drawer is the side nav on a phone, the same surface, and it
		// holds only the nav's rows. MobileNav draws a line under its close
		// button's row and along its edge, which the side nav has neither of;
		// no prop turns them off and the row is no target of its own, so the
		// border token is re-pointed for the drawer.
		"mobile-nav": {
			base: {
				backgroundColor: "var(--color-background-body)",
				"--color-border": "transparent",
			},
		},
		// A message lays its blocks out at their content width, and a tool row's
		// target is one line: a long command widened the row past the column
		// before its ellipsis could apply. Bounded, the target is cut instead.
		"chat-tool-calls": {
			base: {
				maxWidth: "100%",
				// ChatToolCalls sets a call's name in the code face, as a function
				// name; the app names each call for people ("Run command"), which
				// read as body text. What a call acts on already is.
				"--font-family-code": "var(--font-family-body)",
			},
		},
		// Code is code wherever it shows, a call's arguments and result included.
		"code-block": {
			base: { "--font-family-code": "var(--heveta-font-family-code)" },
		},
		// Compact Markdown is the model's thinking (a "思考" step's detail), and
		// it reads one level below the reply, as in ChatGPT and Claude: Astryx's
		// supporting type (a smaller size in the secondary color). Markdown and
		// the List it renders lists with set the body type themselves, so the
		// body tokens are re-pointed for its subtree (as Neutral's banner does
		// for its text colors).
		markdown: {
			"density:compact": {
				"--text-body-size": "var(--text-supporting-size)",
				"--text-body-leading": "var(--text-supporting-leading)",
				"--color-text-primary": "var(--color-text-secondary)",
			},
		},
		// A long conversation's messages off screen are skipped when the page is
		// laid out and painted: a reply streaming at the end redrew the whole
		// transcript every frame, which dropped frames as it grew (at 100
		// messages, 4x throttled: p95 83 ms a frame; skipped, 33 ms). `auto`
		// keeps each message's last rendered height, so scrolling back does not
		// jump; one never rendered yet (an older page) takes the estimate.
		// Skipping contains the message's painting to its box, which cut the
		// focus ring of the buttons at its edge (copy, regenerate): the clip
		// reaches a spacing step out, past the ring (its offset and width, 5px).
		// Chrome takes no calc() here, so the sum cannot be written.
		// A message's text is reading text (see the local tokens).
		"chat-message": {
			base: {
				"--text-body-size": "var(--heveta-text-reading-size)",
				"--text-body-leading": "var(--heveta-text-reading-leading)",
				contentVisibility: "auto",
				containIntrinsicSize: "auto 320px",
				overflowClipMargin: "var(--spacing-2)",
			},
		},
		// What people send is plain text: keep its line breaks and spaces.
		"chat-message-bubble": {
			"sender:user": { whiteSpace: "pre-wrap" },
		},
	},
});
