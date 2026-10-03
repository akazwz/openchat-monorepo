import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";

import type { MessageKey } from "~/i18n/messages";
import { useT } from "~/i18n/use-t";

export function ConnectionStatus({
	status,
	error,
}: {
	status: "connecting" | "connected" | "reconnecting" | "disconnected";
	error?: MessageKey;
}) {
	const t = useT();
	const label = (
		<Text type="supporting" color="secondary" maxLines={1} role="status">
			{t(`computer.${status}`)}
		</Text>
	);
	return error ? <Tooltip content={t(error)}>{label}</Tooltip> : label;
}
