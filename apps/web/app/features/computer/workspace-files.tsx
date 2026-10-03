import { useToast } from "@astryxdesign/core/Toast";
import {
	createContext,
	type ReactNode,
	use,
	useEffect,
	useRef,
	useState,
} from "react";

import { fileSize, maxFileBytes } from "~/features/files/kinds";
import { useT } from "~/i18n/use-t";
import { useDesktopPendingWork } from "~/lib/desktop";
import { uploadToComputer } from "~/lib/rpc-client";

export const workspace = "/workspace";

function useWorkspaceFilesState() {
	const [path, setPath] = useState(workspace);
	const [uploading, setUploading] = useState<{
		name: string;
		progress: number;
	}>();
	const toast = useToast();
	const t = useT();
	const uploads = useRef<AbortController>(null);
	useDesktopPendingWork("upload", Boolean(uploading));
	useEffect(() => () => uploads.current?.abort(), []);
	async function upload(files: File[]) {
		const controller = new AbortController();
		uploads.current = controller;
		const { signal } = controller;
		const folder = path;
		for (const file of files) {
			if (signal.aborted) return;
			if (file.size > maxFileBytes) {
				toast({
					type: "error",
					body: t("computer.fileTooLarge", {
						name: file.name,
						size: fileSize(maxFileBytes),
					}),
				});
				continue;
			}
			setUploading({ name: file.name, progress: 0 });
			try {
				await uploadToComputer(folder, file, {
					signal,
					onProgress: (progress) => setUploading({ name: file.name, progress }),
				});
			} catch {
				if (signal.aborted) return;
				toast({
					type: "error",
					body: t("computer.uploadFailed", { name: file.name }),
				});
			}
		}
		if (signal.aborted) return;
		// The computer event makes the folder read its new contents.
		setUploading(undefined);
	}
	return { path, setPath, uploading, upload };
}

const WorkspaceFilesContext = createContext<
	ReturnType<typeof useWorkspaceFilesState> | undefined
>(undefined);

// The folder and upload belong to the current login, above page navigation.
// Leaving the computer keeps an upload; ending the login aborts it.
export function WorkspaceFilesProvider({ children }: { children: ReactNode }) {
	const files = useWorkspaceFilesState();
	return (
		<WorkspaceFilesContext value={files}>{children}</WorkspaceFilesContext>
	);
}

export function useWorkspaceFiles() {
	const files = use(WorkspaceFilesContext);
	if (!files) throw new Error("WorkspaceFilesProvider missing");
	return files;
}
