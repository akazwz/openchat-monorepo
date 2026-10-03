import {
	type BrowserWindow,
	clipboard,
	type ContextMenuParams,
	Menu,
	type MenuItemConstructorOptions,
	type WebContents,
} from "electron";

import { isExternalUrl } from "../config";
import { text } from "../messages";

// Chromium shows no context menu of its own in Electron. This one has what a
// Mac app's text and links are expected to offer: spelling, editing, links.
export function showContextMenu(
	window: BrowserWindow,
	contents: WebContents,
	params: ContextMenuParams,
	openExternal: (url: string) => void,
) {
	const groups: MenuItemConstructorOptions[][] = [];

	if (params.isEditable && params.misspelledWord)
		groups.push([
			...params.dictionarySuggestions.slice(0, 5).map((suggestion) => ({
				label: suggestion,
				click: () => contents.replaceMisspelling(suggestion),
			})),
			{
				label: text("addToDictionary"),
				click: () =>
					contents.session.addWordToSpellCheckerDictionary(
						params.misspelledWord,
					),
			},
		]);

	if (isExternalUrl(params.linkURL))
		groups.push([
			{ label: text("openLink"), click: () => openExternal(params.linkURL) },
			{
				label: text("copyLink"),
				click: () => clipboard.writeText(params.linkURL),
			},
		]);

	if (params.isEditable) {
		const can = params.editFlags;
		groups.push(
			[
				{ role: "undo", enabled: can.canUndo },
				{ role: "redo", enabled: can.canRedo },
			],
			[
				{ role: "cut", enabled: can.canCut },
				{ role: "copy", enabled: can.canCopy },
				{ role: "paste", enabled: can.canPaste },
				{ role: "pasteAndMatchStyle", enabled: can.canPaste },
				{ role: "selectAll", enabled: can.canSelectAll },
			],
		);
	} else if (params.selectionText) groups.push([{ role: "copy" }]);

	if (!groups.length) return;
	const items = groups.flatMap((group, index) =>
		index ? [{ type: "separator" as const }, ...group] : group,
	);
	Menu.buildFromTemplate(items).popup({ window });
}
