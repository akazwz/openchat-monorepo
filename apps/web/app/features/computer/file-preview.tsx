import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Lightbox } from "@astryxdesign/core/Lightbox";
import { Text } from "@astryxdesign/core/Text";
import { Download } from "lucide-react";

import { useT } from "~/i18n/use-t";

export type FilePreviewContent = { name: string; path: string } & (
	| { kind: "text"; text: string }
	| { kind: "image"; url: string }
);

export default function FilePreview({
	preview,
	isOpen,
	onOpenChange,
	onDownload,
}: {
	preview: FilePreviewContent;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onDownload: () => Promise<void>;
}) {
	const t = useT();
	if (preview.kind === "image")
		return (
			<Lightbox
				isOpen={isOpen}
				onOpenChange={onOpenChange}
				hasZoom
				media={{ src: preview.url, alt: preview.name, caption: preview.name }}
			/>
		);
	return (
		<Dialog isOpen={isOpen} onOpenChange={onOpenChange} variant="fullscreen">
			<Layout
				header={
					<DialogHeader
						title={preview.name}
						onOpenChange={onOpenChange}
						endContent={
							<IconButton
								label={t("computer.downloadFile", { name: preview.name })}
								tooltip={t("computer.download")}
								icon={<Icon icon={Download} size="sm" />}
								variant="ghost"
								clickAction={onDownload}
							/>
						}
					/>
				}
				content={
					<LayoutContent padding={4}>
						<Text type="plain" as="div">
							{preview.text}
						</Text>
					</LayoutContent>
				}
			/>
		</Dialog>
	);
}
