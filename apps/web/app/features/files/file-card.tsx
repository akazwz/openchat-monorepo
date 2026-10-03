import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import {
	File,
	FileArchive,
	FileAudio,
	FileCode,
	FileImage,
	FileSpreadsheet,
	FileText,
	FileVideo,
} from "lucide-react";
import { useState } from "react";

import { useT } from "~/i18n/use-t";

import { fileSize } from "./kinds";
import { saveFile } from "./save-file";

type IconType = typeof File;

// A file's kind as people know it: by its extension, which is what they see.
const kinds: [extensions: string[], icon: IconType][] = [
	[["pdf", "doc", "docx", "txt", "md", "rtf", "odt", "pages"], FileText],
	[["xls", "xlsx", "csv", "tsv", "ods", "numbers"], FileSpreadsheet],
	[["zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz"], FileArchive],
	[
		["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "tiff"],
		FileImage,
	],
	[["mp3", "wav", "m4a", "flac", "ogg", "aac"], FileAudio],
	[["mp4", "mov", "webm", "mkv", "avi"], FileVideo],
	[
		[
			"json",
			"js",
			"ts",
			"tsx",
			"py",
			"html",
			"css",
			"xml",
			"yaml",
			"yml",
			"sh",
			"sql",
		],
		FileCode,
	],
];
const extension = (name: string) => {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};
export const fileIcon = (name: string): IconType =>
	kinds.find(([extensions]) => extensions.includes(extension(name)))?.[1] ??
	File;

// A file in a message that is not shown in place (images are): its kind,
// name, and size; clicking saves it (saveFile).
export function FileCard({
	url,
	fileName,
	size,
}: {
	url: string;
	fileName: string;
	size: bigint | number;
}) {
	const toast = useToast();
	const t = useT();
	const [saving, setSaving] = useState(false);
	const kind = extension(fileName).toUpperCase() || t("files.file");
	return (
		<ClickableCard
			label={t("files.download", { name: fileName })}
			isDisabled={!url || saving}
			onClick={() => {
				setSaving(true);
				saveFile(url, fileName)
					.catch(() =>
						toast({
							type: "error",
							body: t("files.downloadFailed", { name: fileName }),
						}),
					)
					.finally(() => setSaving(false));
			}}
			variant="muted"
			padding={3}
			maxWidth={320}
		>
			<HStack gap={3} vAlign="center">
				<Icon icon={fileIcon(fileName)} color="secondary" />
				<StackItem size="fill">
					<VStack>
						<Text maxLines={1}>{fileName}</Text>
						<Text type="supporting" color="secondary">
							{`${kind} · ${fileSize(size)}`}
						</Text>
					</VStack>
				</StackItem>
			</HStack>
		</ClickableCard>
	);
}
