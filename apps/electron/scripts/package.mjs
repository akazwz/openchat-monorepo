import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import { sign } from "@electron/osx-sign";
import { packager } from "@electron/packager";

import {
	findSigningIdentity,
	signingIdentity,
	verifyApplication,
} from "./signing.mjs";

const run = promisify(execFile);
const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const arch = process.argv[2] || process.arch;
if (process.platform !== "darwin" || !["arm64", "x64"].includes(arch)) {
	throw new Error(
		"Package on macOS; the optional architecture is arm64 or x64.",
	);
}

const identity = await findSigningIdentity();
await run(process.execPath, [join(root, "scripts/build.mjs")], {
	env: { ...process.env, HEVETA_BUILD_ARCH: arch },
});
const build = join(root, ".build");
await mkdir(build, { recursive: true });
const temporary = await mkdtemp(join(build, "icon-"));
const icon = join(build, "AppIcon.icns");
try {
	const iconset = join(temporary, "Heveta.iconset");
	await mkdir(iconset);
	// Reuse the existing macOS app icon's source assets, without requiring an
	// Xcode build or maintaining another set of generated macOS images.
	const original = join(
		root,
		"../macos/Resources/Assets.xcassets/AppIcon.appiconset",
	);
	for (const [name, size] of [
		["icon_16x16.png", 16],
		["icon_16x16@2x.png", 32],
		["icon_32x32.png", 32],
		["icon_32x32@2x.png", 64],
		["icon_128x128.png", 128],
		["icon_128x128@2x.png", 256],
		["icon_256x256.png", 256],
		["icon_256x256@2x.png", 512],
		["icon_512x512.png", 512],
		["icon_512x512@2x.png", 1024],
	]) {
		await copyFile(join(original, `icon_${size}.png`), join(iconset, name));
	}
	await run("iconutil", ["-c", "icns", "-o", icon, iconset]);
} finally {
	await rm(temporary, { recursive: true, force: true });
}

const outputs = await packager({
	dir: root,
	name: manifest.productName,
	appBundleId: "com.heveta.electron",
	appCategoryType: "public.app-category.productivity",
	appVersion: manifest.version,
	platform: "darwin",
	arch,
	electronVersion: manifest.devDependencies.electron,
	out: join(build, "packages"),
	icon,
	asar: { unpack: "**/*.node" },
	overwrite: true,
	// Runtime dependencies are bundled by esbuild; keep pnpm symlinks out.
	prune: false,
	ignore: [
		/^\/(?:node_modules|native|src|scripts|\.build)(?:\/|$)/,
		/^\/(?:tsconfig\.json|README\.md|review\.md|\.gitignore)$/,
		/\.map$/,
	],
	extendInfo: {
		LSMinimumSystemVersion: "14.0.0",
		NSHighResolutionCapable: true,
		NSHumanReadableCopyright: "Heveta",
	},
});

for (const output of outputs) {
	const application = join(output, `${manifest.productName}.app`);
	await flipFuses(application, {
		version: FuseVersion.V1,
		strictlyRequireAllFuses: true,
		[FuseV1Options.RunAsNode]: false,
		[FuseV1Options.EnableCookieEncryption]: true,
		[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
		[FuseV1Options.EnableNodeCliInspectArguments]: false,
		[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
		[FuseV1Options.OnlyLoadAppFromAsar]: true,
		// Official macOS binaries ship the ordinary context snapshot only.
		[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
		[FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
		[FuseV1Options.WasmTrapHandlers]: true,
	});
	// Sign nested code (including the unpacked Node-API module) from the inside
	// out after fuses are finalized. No notarization is needed for this install.
	console.log(`Signing with ${signingIdentity}`);
	await sign({
		app: application,
		identity,
		platform: "darwin",
		type: "distribution",
		preAutoEntitlements: false,
		preEmbedProvisioningProfile: false,
		optionsForFile: () => ({
			entitlements: join(root, "resources/entitlements.plist"),
			hardenedRuntime: true,
		}),
	});
	await verifyApplication(application);
	console.log(application);
}
