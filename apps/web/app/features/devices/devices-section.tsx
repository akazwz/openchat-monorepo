import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	FolderOpen,
	Laptop,
	MonitorUp,
	MousePointerClick,
	Power,
	Unplug,
} from "lucide-react";
import { useState } from "react";

import { QueryError } from "~/components/query-error";
import {
	currentSession,
	isCurrentSession,
	useAuthStore,
} from "~/features/auth/store";
import { SettingsCard, SettingsRow } from "~/features/settings/settings-rows";
import type { Device } from "~/gen/heveta/v1/device_pb";
import { useT } from "~/i18n/use-t";
import { deviceClient } from "~/lib/rpc-client";

import { nativeBridge, type NativeDeviceInfo, useNativeDevice } from "./native";
import { devicesQuery } from "./queries";

// The Macs connected to the account (docs/macos.md). In the desktop client,
// this Mac comes first: connecting it, whether it may be reached now, and the
// two macOS permissions its screen needs. Everywhere, the account's other
// Macs: their screens, and removing them.
export function DevicesSection() {
	const t = useT();
	const toast = useToast();
	const cache = useQueryClient();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const devices = useQuery(devicesQuery(userId));
	const { info, update } = useNativeDevice();
	const [removing, setRemoving] = useState<Device>();
	const [removeOpen, setRemoveOpen] = useState(false);

	// A change to a device: what the list shows is read again after it, and
	// only a failure is said.
	async function change(work: () => Promise<unknown>) {
		const owner = currentSession();
		try {
			await work();
		} catch {
			if (isCurrentSession(owner))
				toast({ type: "error", body: t("devices.failed") });
		}
		if (isCurrentSession(owner))
			await cache.invalidateQueries({
				queryKey: devicesQuery(userId).queryKey,
			});
	}
	// One request to the desktop client, which answers with its new state.
	const native = (
		request: (
			bridge: NonNullable<ReturnType<typeof nativeBridge>>,
		) => Promise<NativeDeviceInfo>,
	) =>
		change(async () => {
			const bridge = nativeBridge();
			if (bridge) update(await request(bridge));
		});

	async function connect(client: NativeDeviceInfo) {
		const owner = currentSession();
		const { device, credential } = await deviceClient.registerDevice({
			clientId: client.clientId,
			name: client.name,
			osVersion: client.osVersion,
			workspacePath: client.workspacePath,
		});
		if (!device) throw new Error("The server returned no device");
		// Signed out, or in as someone else, meanwhile: the registration is
		// not this account's to keep.
		if (!isCurrentSession(owner)) {
			await deviceClient.revokeDevice({ deviceId: device.id });
			return;
		}
		const bridge = nativeBridge();
		if (bridge)
			update(
				await bridge.bind({
					deviceId: device.id,
					userId: owner.userId,
					credential,
				}),
			);
	}
	async function remove(device: Device) {
		await deviceClient.revokeDevice({ deviceId: device.id });
		const bridge = nativeBridge();
		if (bridge && info?.deviceId === device.id) update(await bridge.unbind());
	}

	// This Mac is the account's while its binding is, and the server still
	// lists it.
	const thisDevice =
		info && info.userId === userId && info.deviceId
			? devices.data
				? devices.data.find((device) => device.id === info.deviceId)
				: undefined
			: undefined;
	const bound = Boolean(
		info &&
		info.userId === userId &&
		info.deviceId &&
		(!devices.data || thisDevice),
	);
	const others = devices.data?.filter(
		(device) => !bound || device.id !== info?.deviceId,
	);

	return (
		<VStack gap={6}>
			{info?.error && <Banner status="warning" title={info.error} />}
			{info && (
				<SettingsCard title={t("devices.thisMac")}>
					<SettingsRow
						title={info.name}
						icon={Laptop}
						description={bound ? undefined : t("devices.connectDescription")}
						control={
							bound ? (
								<DeviceStatus info={info} />
							) : (
								<Button
									label={t("devices.connect")}
									clickAction={() => change(() => connect(info))}
								/>
							)
						}
					/>
					{bound && (
						<SettingsRow
							title={t("devices.access")}
							icon={Power}
							description={t("devices.accessDescription")}
							control={
								<Switch
									label={t("devices.access")}
									isLabelHidden
									value={info.enabled}
									changeAction={(enabled) =>
										native((bridge) => bridge.setEnabled(enabled))
									}
								/>
							}
						/>
					)}
					{bound && (
						<SettingsRow
							title={t("devices.screen")}
							icon={MonitorUp}
							description={t("devices.screenDescription")}
							control={
								<Permission
									allowed={info.screenAllowed}
									request={() => native((bridge) => bridge.screenPermission())}
								/>
							}
						/>
					)}
					{bound && (
						<SettingsRow
							title={t("devices.input")}
							icon={MousePointerClick}
							description={t("devices.inputDescription")}
							control={
								<Permission
									allowed={info.inputAllowed}
									request={() => native((bridge) => bridge.inputPermission())}
								/>
							}
						/>
					)}
					{bound && (
						<SettingsRow
							title={t("devices.workspace")}
							icon={FolderOpen}
							control={<Text color="secondary">{info.workspacePath}</Text>}
						/>
					)}
					{bound && thisDevice && (
						<SettingsRow
							title={t("devices.disconnectTitle")}
							icon={Unplug}
							description={t("devices.disconnectDescription")}
							control={
								// Rare and destructive: quiet here; the dialog's action
								// carries the destructive style.
								<Button
									label={t("devices.disconnect")}
									size="sm"
									variant="secondary"
									onClick={() => {
										setRemoving(thisDevice);
										setRemoveOpen(true);
									}}
								/>
							}
						/>
					)}
				</SettingsCard>
			)}
			{devices.isLoading ? (
				<HStack justify="center" padding={4}>
					<Spinner aria-label={t("devices.title")} />
				</HStack>
			) : devices.isError ? (
				<QueryError
					title={t("devices.loadFailed")}
					pending={devices.isFetching}
					onRetry={() => void devices.refetch()}
				/>
			) : others?.length ? (
				<VStack gap={1.5}>
					<Text type="supporting" weight="semibold" color="secondary">
						{t(info ? "devices.otherMacs" : "devices.macs")}
					</Text>
					{/* The rows' own inset plus this one line their text up with
					the settings rows above. */}
					<Card variant="muted" width="100%" padding={2}>
						<List>
							{others.map((device) => (
								<ListItem
									key={device.id}
									label={device.name}
									description={t(
										device.online ? "devices.online" : "devices.offline",
									)}
									startContent={<Icon icon={Laptop} color="secondary" />}
									endContent={
										<HStack gap={1}>
											<Button
												size="sm"
												variant="ghost"
												label={t("devices.viewScreen")}
												href={`/devices/${device.id}`}
												isDisabled={!device.online || !device.screenAllowed}
											/>
											<Button
												size="sm"
												variant="ghost"
												label={t("devices.remove")}
												onClick={() => {
													setRemoving(device);
													setRemoveOpen(true);
												}}
											/>
										</HStack>
									}
								/>
							))}
						</List>
					</Card>
				</VStack>
			) : (
				// The desktop client's own card already says how to begin.
				!info && (
					<EmptyState
						icon={<Icon icon={Laptop} size="lg" color="secondary" />}
						title={t("devices.empty")}
						description={t("devices.emptyDescription")}
					/>
				)
			)}
			<AlertDialog
				isOpen={removeOpen}
				onOpenChange={setRemoveOpen}
				title={t("devices.removeTitle", { name: removing?.name ?? "" })}
				description={t("devices.removeDescription")}
				actionLabel={t("devices.remove")}
				cancelLabel={t("devices.cancel")}
				onAction={() => {
					setRemoveOpen(false);
					if (removing) void change(() => remove(removing));
				}}
			/>
		</VStack>
	);
}

// Whether this Mac can be reached now.
function DeviceStatus({ info }: { info: NativeDeviceInfo }) {
	const t = useT();
	const label = t(
		info.online
			? "devices.statusOnline"
			: info.enabled
				? "devices.statusConnecting"
				: "devices.statusOff",
	);
	return (
		<HStack gap={2} vAlign="center">
			<StatusDot
				variant={info.online ? "success" : "neutral"}
				label={label}
				isPulsing={info.enabled && !info.online}
			/>
			<Text color="secondary">{label}</Text>
		</HStack>
	);
}

// A macOS permission: granted, or a way to the system's own prompt.
function Permission({
	allowed,
	request,
}: {
	allowed: boolean;
	request: () => Promise<void>;
}) {
	const t = useT();
	return allowed ? (
		<Text color="secondary">{t("devices.allowed")}</Text>
	) : (
		<Button
			label={t("devices.allow")}
			size="sm"
			variant="secondary"
			clickAction={request}
		/>
	);
}
