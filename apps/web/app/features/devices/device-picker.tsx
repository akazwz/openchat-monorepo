import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { useQuery } from "@tanstack/react-query";
import { Cloud, Laptop } from "lucide-react";

import { useAuthStore } from "~/features/auth/store";
import { useT } from "~/i18n/use-t";

import { devicesQuery } from "./queries";

// Where a message's tools run: the cloud computer, or one of the account's
// Macs (docs/macos.md). An account without a Mac has nothing to choose, and
// no picker. It sits by the model picker and reads like it: a quiet setting
// of the message, in secondary text.
export function DevicePicker({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (id: string) => void;
	disabled: boolean;
}) {
	const t = useT();
	const compact = useMediaQuery("(max-width: 640px)");
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const { data: devices = [] } = useQuery(devicesQuery(userId));
	if (!devices.length && !value) return null;
	const options = [
		{ value: "", label: t("devices.cloud") },
		...devices.map((device) => ({
			value: device.id,
			label: device.name,
			description: t(device.online ? "devices.online" : "devices.offline"),
			disabled: !device.online,
		})),
	];
	// A Mac chosen for this conversation and removed since.
	if (value && !devices.some((device) => device.id === value))
		options.push({ value, label: t("devices.unavailable") });
	const icon = (
		<Icon icon={value ? Laptop : Cloud} size="sm" color="secondary" />
	);
	return (
		<Selector
			label={t("devices.target")}
			isLabelHidden
			variant="ghost"
			size="sm"
			// The composer is docked at the bottom: the list opens upward.
			placement="above"
			value={value}
			options={options}
			onChange={onChange}
			isDisabled={disabled}
			presentation="adaptive"
			startIcon={compact ? undefined : icon}
			// A phone has room for the icon alone.
			renderValue={(option) =>
				compact ? icon : <Text color="secondary">{option.label}</Text>
			}
		/>
	);
}
