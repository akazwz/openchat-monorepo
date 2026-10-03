import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";

import { useT } from "~/i18n/use-t";

export function QueryError({
	title,
	pending,
	onRetry,
}: {
	title: string;
	pending: boolean;
	onRetry: () => void;
}) {
	const t = useT();
	return (
		<Banner
			status="error"
			title={title}
			endContent={
				<Button
					label={t("common.retry")}
					isLoading={pending}
					onClick={onRetry}
				/>
			}
		/>
	);
}
