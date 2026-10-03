import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import katex from "katex";
import { memo, useMemo } from "react";

import { useT } from "~/i18n/use-t";

import "katex/dist/katex.min.css";

// Typesets the `$…$` and `$$…$$` math Markdown hands over as raw text (the
// only delimiters Astryx's Markdown parses, so the agent's instructions ask
// for them). KaTeX builds the markup from the expression and never passes
// its HTML through (`trust` is off); an
// expression it cannot parse, such as one still streaming, shows as source.
// A display formula wider than the column scrolls sideways instead of
// stretching the page. Loaded on demand (chat-bubble.tsx).
function MathExpression({
	value,
	display,
}: {
	value: string;
	display: "inline" | "block";
}) {
	const t = useT();
	// Typesetting is the costly part; a streaming reply renders again for
	// every delta while its finished formulas stay the same.
	const html = useMemo(
		() =>
			katex.renderToString(value, {
				displayMode: display === "block",
				throwOnError: false,
			}),
		[value, display],
	);
	if (display === "inline")
		// The HTML KaTeX rendered from the formula.
		return <span dangerouslySetInnerHTML={{ __html: html }} />;
	return (
		<ScrollableArea axis="inline" label={t("threads.formula")}>
			{/* The HTML KaTeX rendered from the formula. */}
			<div dangerouslySetInnerHTML={{ __html: html }} />
		</ScrollableArea>
	);
}

// Its props are plain strings, the same for a finished formula on every
// delta, so it does not even render again.
export default memo(MathExpression);
