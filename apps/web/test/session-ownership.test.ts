import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";

import { confirmSession, signOut } from "~/features/auth/session";
import { currentSession, useAuthStore } from "~/features/auth/store";
import { setAvatar } from "~/features/settings/avatar";
import { avatarImage } from "~/features/settings/avatar-image";
import { UserSchema } from "~/gen/heveta/v1/auth_pb";
import { authClient } from "~/lib/rpc-client";

import { deferred } from "./deferred";

vi.mock("~/lib/rpc-client", () => ({
	authClient: {
		getCurrentUser: vi.fn(),
		signOut: vi.fn(),
		setAvatar: vi.fn(),
	},
}));
vi.mock("~/features/settings/avatar-image", () => ({ avatarImage: vi.fn() }));
const user = (id: string) =>
	create(UserSchema, { id, username: id, revision: 1 });
afterEach(() => {
	useAuthStore.getState().signOut();
	vi.resetAllMocks();
});

it.each(["user", "empty", "unauthenticated"])(
	"ignores stale session confirmation: %s",
	async (result) => {
		useAuthStore.getState().signIn(user("a"));
		const pending =
			deferred<Awaited<ReturnType<typeof authClient.getCurrentUser>>>();
		vi.mocked(authClient.getCurrentUser).mockReturnValueOnce(pending.promise);
		const old = confirmSession();
		expect(confirmSession()).toBe(old);
		useAuthStore.getState().signIn(user("b"));
		if (result === "unauthenticated")
			pending.reject(new ConnectError("expired", Code.Unauthenticated));
		else
			pending.resolve({
				$typeName: "heveta.v1.GetCurrentUserResponse",
				user: result === "user" ? user("a") : undefined,
			});
		await old;
		expect(useAuthStore.getState().user?.id).toBe("b");
	},
);

it("new login gets its own confirmation while an old one is pending", async () => {
	useAuthStore.getState().signIn(user("a"));
	const first =
		deferred<Awaited<ReturnType<typeof authClient.getCurrentUser>>>();
	const second =
		deferred<Awaited<ReturnType<typeof authClient.getCurrentUser>>>();
	vi.mocked(authClient.getCurrentUser)
		.mockReturnValueOnce(first.promise)
		.mockReturnValueOnce(second.promise);
	const old = confirmSession();
	useAuthStore.getState().signIn(user("b"));
	const current = confirmSession();
	expect(current).not.toBe(old);
	first.resolve({
		$typeName: "heveta.v1.GetCurrentUserResponse",
		user: user("a"),
	});
	await old;
	expect(confirmSession()).toBe(current);
	second.resolve({
		$typeName: "heveta.v1.GetCurrentUserResponse",
		user: user("b"),
	});
	await current;
	expect(useAuthStore.getState().user?.id).toBe("b");
});

it("a late sign-out cannot clear a new login to the same account", async () => {
	useAuthStore.getState().signIn(user("a"));
	const pending = deferred<Awaited<ReturnType<typeof authClient.signOut>>>();
	vi.mocked(authClient.signOut).mockReturnValueOnce(pending.promise);
	const old = signOut();
	useAuthStore.getState().signIn(user("a"));
	pending.resolve({ $typeName: "heveta.v1.SignOutResponse" });
	await old;
	expect(useAuthStore.getState().user?.id).toBe("a");
});

it("signed-out confirmation can adopt the current server session", async () => {
	vi.mocked(authClient.getCurrentUser).mockResolvedValueOnce({
		$typeName: "heveta.v1.GetCurrentUserResponse",
		user: user("a"),
	});
	await confirmSession();
	expect(useAuthStore.getState().user?.id).toBe("a");
});

it.each(["b", "a"])(
	"avatar preprocessing cannot act for a later login (%s)",
	async (id) => {
		useAuthStore.getState().signIn(user("a"));
		const decoded = deferred<Blob>();
		vi.mocked(avatarImage).mockReturnValueOnce(decoded.promise);
		const pending = setAvatar({
			file: new File(["image"], "photo.png"),
			owner: currentSession(),
		});
		const rejected = expect(pending).rejects.toMatchObject({
			code: Code.Canceled,
		});
		useAuthStore.getState().signIn(user(id));
		decoded.resolve(new Blob(["decoded"]));
		await rejected;
		expect(authClient.setAvatar).not.toHaveBeenCalled();
	},
);

it("a current avatar operation uploads its processed bytes", async () => {
	useAuthStore.getState().signIn(user("a"));
	vi.mocked(avatarImage).mockResolvedValueOnce(new Blob(["decoded"]));
	vi.mocked(authClient.setAvatar).mockResolvedValueOnce({
		$typeName: "heveta.v1.SetAvatarResponse",
		user: user("a"),
	});
	await setAvatar({
		file: new File(["image"], "photo.png"),
		owner: currentSession(),
	});
	expect(authClient.setAvatar).toHaveBeenCalledWith({
		image: new TextEncoder().encode("decoded"),
	});
});
