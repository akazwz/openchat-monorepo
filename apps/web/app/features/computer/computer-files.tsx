import { BreadcrumbItem, Breadcrumbs } from "@astryxdesign/core/Breadcrumbs";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import {
	HStack,
	Layout,
	LayoutContent,
	VStack,
} from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useToast } from "@astryxdesign/core/Toast";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { useQuery } from "@tanstack/react-query";
import { Download, Folder, RefreshCw, Upload } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { AppPageHeader } from "~/components/app-page-header";
import { QueryError } from "~/components/query-error";
import { useAuthStore } from "~/features/auth/store";
import { computerFilesQuery } from "~/features/computer/queries";
import { fileIcon } from "~/features/files/file-card";
import { fileSize } from "~/features/files/kinds";
import { saveFile } from "~/features/files/save-file";
import { useT } from "~/i18n/use-t";

import { ComputerTabs } from "./computer-tabs";
import type { FilePreviewContent } from "./file-preview";
import {
	previewKind,
	readFilePreview,
	type PreviewFile,
} from "./file-preview-data";
import { type useWorkspaceFiles, workspace } from "./workspace-files";

const FilePreview = lazy(() => import("./file-preview"));

// The computer's workspace as a file manager (docs/sandbox.md): open folders,
// download files, and add files to the folder shown. It is what outlives a
// restart; the terminal reaches everything else.
export function ComputerFiles({
	files: { path, setPath, uploading, upload },
}: {
	files: ReturnType<typeof useWorkspaceFiles>;
}) {
	const input = useRef<HTMLInputElement>(null);
	const previewRequest = useRef<AbortController>(null);
	const previewUrl = useRef<string>(undefined);
	const [loadingPreview, setLoadingPreview] = useState<string>();
	const [preview, setPreview] = useState<FilePreviewContent>();
	const [previewOpen, setPreviewOpen] = useState(false);
	useEffect(
		() => () => {
			previewRequest.current?.abort();
			if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
		},
		[],
	);
	const toast = useToast();
	const t = useT();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const { data, error, isLoading, isError, isFetching, refetch } = useQuery(
		computerFilesQuery(userId, path),
	);
	// The folder shown is gone (deleted in the terminal or by the agent, or
	// with a restored or cleared workspace): back to the workspace, which
	// always is there, rather than an error trying again cannot fix.
	const gone =
		path !== workspace &&
		error !== null &&
		ConnectError.from(error).code === Code.NotFound;
	useEffect(() => {
		if (gone) setPath(workspace);
	}, [gone, setPath]);
	// /workspace/a/b → [/workspace, /workspace/a, /workspace/a/b]
	const parts = path.slice(workspace.length).split("/").filter(Boolean);
	const trail = [
		workspace,
		...parts.map(
			(_, index) => `${workspace}/${parts.slice(0, index + 1).join("/")}`,
		),
	];

	async function download(file: { path: string; name: string }) {
		try {
			await saveFile(
				`/computer-file?${new URLSearchParams({ path: file.path })}`,
				file.name,
			);
		} catch {
			toast({
				type: "error",
				body: t("computer.downloadFailed", { name: file.name }),
			});
		}
	}
	async function openPreview(file: PreviewFile) {
		previewRequest.current?.abort();
		if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
		previewUrl.current = undefined;
		const controller = new AbortController();
		previewRequest.current = controller;
		setLoadingPreview(file.path);
		try {
			const data = await readFilePreview(file, controller.signal);
			let content: FilePreviewContent;
			if (data.kind === "image") {
				const url = URL.createObjectURL(data.blob);
				previewUrl.current = url;
				const image = new Image();
				image.src = url;
				await image.decode();
				content = { name: file.name, path: file.path, kind: "image", url };
			} else content = { name: file.name, path: file.path, ...data };
			if (controller.signal.aborted) return;
			setPreview(content);
			setPreviewOpen(true);
		} catch {
			if (controller.signal.aborted) return;
			if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
			previewUrl.current = undefined;
			toast({
				type: "error",
				body: t("computer.previewFailed", { name: file.name }),
			});
		} finally {
			if (previewRequest.current === controller) setLoadingPreview(undefined);
		}
	}
	function changePreviewOpen(open: boolean) {
		setPreviewOpen(open);
		if (!open && previewUrl.current) {
			URL.revokeObjectURL(previewUrl.current);
			previewUrl.current = undefined;
		}
	}

	return (
		<>
			<Layout
				header={
					<AppPageHeader
						title={t("computer.title")}
						tabs={<ComputerTabs view="files" />}
						detail={
							<ScrollableArea axis="inline" label={t("computer.folder")}>
								<Breadcrumbs label={t("computer.folder")} variant="supporting">
									{trail.map((folder, index) => (
										<BreadcrumbItem
											key={folder}
											isCurrent={index === trail.length - 1}
											onClick={() => setPath(folder)}
										>
											{index === 0
												? t("computer.workspace")
												: folder.slice(folder.lastIndexOf("/") + 1)}
										</BreadcrumbItem>
									))}
								</Breadcrumbs>
							</ScrollableArea>
						}
						end={
							<>
								<IconButton
									label={t("computer.refresh")}
									tooltip={t("computer.refresh")}
									variant="ghost"
									size="sm"
									icon={<Icon icon={RefreshCw} size="sm" color="secondary" />}
									isDisabled={isFetching}
									onClick={() => void refetch()}
								/>

								{uploading && (
									<VStack width={80}>
										<ProgressBar
											label={t("computer.uploading", { name: uploading.name })}
											value={uploading.progress * 100}
											isLabelHidden
											hasValueLabel
										/>
									</VStack>
								)}
								<IconButton
									label={t("computer.uploadFile")}
									tooltip={t("computer.uploadFile")}
									icon={<Icon icon={Upload} size="sm" />}
									variant="ghost"
									size="sm"
									isDisabled={Boolean(uploading)}
									onClick={() => input.current?.click()}
								/>
							</>
						}
					/>
				}
				content={
					<LayoutContent padding={3}>
						<VStack gap={3}>
							<input
								ref={input}
								type="file"
								hidden
								multiple
								onChange={(event) => {
									const files = event.target.files
										? [...event.target.files]
										: [];
									event.target.value = "";
									void upload(files);
								}}
							/>
							{isLoading ? (
								<HStack justify="center" padding={4}>
									<Spinner aria-label={t("computer.loadingFiles")} />
								</HStack>
							) : isError ? (
								<QueryError
									title={t("computer.fileListFailed")}
									pending={isFetching}
									onRetry={() => void refetch()}
								/>
							) : data?.files.length ? (
								<List hasDividers density="compact">
									{data.files.map((file) => (
										<ListItem
											key={file.path}
											label={file.name}
											startContent={
												loadingPreview === file.path ? (
													<Spinner
														size="sm"
														aria-label={t("computer.loadingPreview", {
															name: file.name,
														})}
													/>
												) : (
													<Icon
														icon={
															file.isDirectory ? Folder : fileIcon(file.name)
														}
														color="secondary"
													/>
												)
											}
											description={
												<HStack gap={1}>
													{!file.isDirectory && (
														<Text type="supporting" color="secondary">
															{`${fileSize(file.size)} ·`}
														</Text>
													)}
													{file.modifyTime && (
														<Timestamp
															value={timestampDate(
																file.modifyTime,
															).toISOString()}
															format="date_time"
														/>
													)}
												</HStack>
											}
											onClick={
												file.isDirectory
													? () => setPath(file.path)
													: previewKind(file)
														? () => void openPreview(file)
														: undefined
											}
											endContent={
												file.isDirectory ? undefined : (
													<IconButton
														label={t("computer.downloadFile", {
															name: file.name,
														})}
														tooltip={t("computer.download")}
														variant="ghost"
														size="sm"
														icon={
															<Icon
																icon={Download}
																size="sm"
																color="secondary"
															/>
														}
														clickAction={() => download(file)}
													/>
												)
											}
										/>
									))}
								</List>
							) : (
								<EmptyState title={t("computer.emptyFolder")} />
							)}
						</VStack>
					</LayoutContent>
				}
			/>
			{preview && (
				<Suspense fallback={null}>
					<FilePreview
						preview={preview}
						isOpen={previewOpen}
						onOpenChange={changePreviewOpen}
						onDownload={() => download(preview)}
					/>
				</Suspense>
			)}
		</>
	);
}
