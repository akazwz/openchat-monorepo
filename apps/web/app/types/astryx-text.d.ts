// The theme's own Text type (packages/brand/src/theme/heveta.ts), declared as
// Astryx documents for custom types. `astryx theme build` augments only the
// components' own *VariantMap interfaces, and Text's custom types are the
// theme module's CustomTextTypes, so its generated declarations leave them out
// (CLI 0.6.2).
import "@astryxdesign/core/theme";

declare module "@astryxdesign/core/theme" {
	interface CustomTextTypes {
		// Plain text as someone wrote it, line breaks and spaces kept.
		plain: true;
	}
}
