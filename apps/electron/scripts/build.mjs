import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

import { build } from "esbuild";

// The brand's compiled theme and mark, shared with the web app and the site
// (packages/brand): the client's own pages take their colors and logo from
// them instead of keeping copies.
import {
	brandMarkPath,
	brandMarkViewBox,
} from "../../../packages/brand/src/mark.ts";
import { hevetaTheme } from "../../../packages/brand/src/theme/heveta.js";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");
const out = join(root, "build");
const arch = process.env.HEVETA_BUILD_ARCH || process.arch;
if (process.platform !== "darwin" || !["arm64", "x64"].includes(arch))
	throw new Error("Build on macOS, for arm64 or x64.");

// A token's two values, from the theme's `light-dark(light, dark)`.
function lightAndDark(token) {
	const value = hevetaTheme.tokens[token];
	const match = /^light-dark\((#[0-9a-f]+), (#[0-9a-f]+)\)$/i.exec(value ?? "");
	if (!match)
		throw new Error(`${token} is not a light and dark color: ${value}`);
	return { light: match[1], dark: match[2] };
}

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "pages"), { recursive: true });

// The main process, the command process, and the preloads run in Node.
// Everything they import is bundled in; only Electron itself is left out.
await build({
	absWorkingDir: root,
	entryPoints: {
		main: "src/main.ts",
		executor: "src/device/executor/main.ts",
		"preload/app": "src/preload/app.ts",
		"preload/shell": "src/preload/shell.ts",
		"preload/media": "src/preload/media.ts",
	},
	outdir: out,
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node24",
	external: ["electron"],
	sourcemap: true,
	define: {
		// The window's background before and around its pages (shell/window.ts).
		__CHROME_COLORS__: JSON.stringify(lightAndDark("--color-background-body")),
	},
});

// The scripts of the client's own pages run in Chromium.
await build({
	absWorkingDir: root,
	entryPoints: {
		"pages/shell": "src/pages/shell.ts",
		"pages/media": "src/pages/media.ts",
	},
	outdir: out,
	bundle: true,
	platform: "browser",
	format: "iife",
	target: "chrome140",
});

// The theme's tokens, as the custom properties shell.css reads.
const tokens = { ...hevetaTheme.tokens, ...hevetaTheme.localTokens };
await writeFile(
	join(out, "pages/theme.css"),
	`:root {\n${Object.entries(tokens)
		.map(([name, value]) => `\t${name}: ${value};`)
		.join("\n")}\n}\n`,
);
const shell = await readFile(join(root, "src/pages/shell.html"), "utf8");
await writeFile(
	join(out, "pages/shell.html"),
	shell
		.replace("{{brandMarkViewBox}}", brandMarkViewBox)
		.replace("{{brandMarkPath}}", brandMarkPath),
);
for (const file of ["shell.css", "media.html"])
	await copyFile(join(root, "src/pages", file), join(out, "pages", file));

// The module that posts pointer and keyboard events (native/input.mm).
await run("xcrun", [
	"clang++",
	"-std=c++17",
	"-shared",
	"-undefined",
	"dynamic_lookup",
	"-fobjc-arc",
	"-mmacosx-version-min=14.0",
	"-arch",
	arch === "x64" ? "x86_64" : "arm64",
	"-DNAPI_VERSION=8",
	`-I${require("node-api-headers").include_dir}`,
	"-framework",
	"ApplicationServices",
	"-framework",
	"AppKit",
	join(root, "native/input.mm"),
	"-o",
	join(out, "input.node"),
]);
