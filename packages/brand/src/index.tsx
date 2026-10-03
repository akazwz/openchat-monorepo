import { brandMarkPath, brandMarkViewBox } from "./mark";

// The product name lives here only; every title and label reads it.
export const brandName = "Heveta";

export function pageTitle(title?: string) {
	return title ? `${title} · ${brandName}` : brandName;
}

// Decorative: it always sits beside the product name or a text alternative.
export function BrandMark({ size = "1.5em" }: { size?: number | string }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox={brandMarkViewBox}
			fill="currentColor"
			aria-hidden
			focusable="false"
		>
			<path fillRule="evenodd" d={brandMarkPath} />
		</svg>
	);
}
