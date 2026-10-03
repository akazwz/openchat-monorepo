import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Keep the same certificate class, team, and bundle ID across local updates.
// These are public signing identifiers; the private key stays in Keychain.
export const signingIdentity =
	"Developer ID Application: WENZHUO ZHAO (W6728BZU67)";
export const signingRequirement =
	'anchor apple generic and identifier "com.heveta.electron" and certificate leaf[subject.OU] = "W6728BZU67" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';

export async function findSigningIdentity() {
	const { stdout } = await run("security", [
		"find-identity",
		"-v",
		"-p",
		"codesigning",
	]);
	const matches = [
		...stdout.matchAll(/^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"]+)"\s*$/gm),
	].filter((match) => match[2] === signingIdentity);
	if (matches.length !== 1)
		throw new Error(
			`Expected exactly one valid signing identity: ${signingIdentity}. Found ${matches.length}. Install/select the intended certificate before packaging.`,
		);
	return matches[0][1];
}

export async function verifyApplication(application) {
	await run("codesign", ["--verify", "--deep", "--strict", application]);
	// Reject an accidental ad hoc build or a different identity before install.
	await run("codesign", [
		"--verify",
		"--strict",
		"-R",
		`=${signingRequirement}`,
		application,
	]);
	const { stdout, stderr } = await run("codesign", [
		"--display",
		"-r-",
		application,
	]);
	const requirement = `${stdout}\n${stderr}`;
	if (!requirement.includes("designated =>") || /\bcdhash\b/.test(requirement))
		throw new Error(
			"The application must have a stable certificate-based signing requirement.",
		);
}
