import { useEffect, useState } from "react";
export interface NativeDeviceInfo {
	clientId: string;
	name: string;
	osVersion: string;
	workspacePath: string;
	deviceId: string;
	userId: string;
	enabled: boolean;
	online: boolean;
	screenAllowed: boolean;
	inputAllowed: boolean;
	error: string | null;
}
interface NativeBridge {
	version: number;
	onInfo?(callback: (info: NativeDeviceInfo) => void): () => void;
	info(): Promise<NativeDeviceInfo>;
	bind(input: {
		deviceId: string;
		userId: string;
		credential: string;
	}): Promise<NativeDeviceInfo>;
	setEnabled(enabled: boolean): Promise<NativeDeviceInfo>;
	unbind(): Promise<NativeDeviceInfo>;
	syncUser(userId: string): Promise<NativeDeviceInfo>;
	screenPermission(): Promise<NativeDeviceInfo>;
	inputPermission(): Promise<NativeDeviceInfo>;
}
declare global {
	interface Window {
		hevetaNative?: NativeBridge;
	}
}
export const nativeBridge = () =>
	typeof window === "undefined" ? undefined : window.hevetaNative;
export function useNativeDevice() {
	const [info, setInfo] = useState<NativeDeviceInfo>();
	useEffect(() => {
		let active = true;
		void nativeBridge()
			?.info()
			.then((value) => {
				if (active) setInfo(value);
			})
			.catch(() => {});
		const unsubscribe = nativeBridge()?.onInfo?.((value) => {
			if (active) setInfo(value);
		});
		const changed = (event: Event) => {
			if (active) setInfo((event as CustomEvent<NativeDeviceInfo>).detail);
		};
		window.addEventListener("heveta:device", changed);
		return () => {
			active = false;
			unsubscribe?.();
			window.removeEventListener("heveta:device", changed);
		};
	}, []);
	return { info, update: setInfo };
}
