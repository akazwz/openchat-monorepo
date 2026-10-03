import { create } from "@bufbuild/protobuf";
import { afterEach, expect, it } from "vitest";

import { adoptUser, useAuthStore } from "~/features/auth/store";
import { UserSchema } from "~/gen/heveta/v1/auth_pb";

afterEach(() => useAuthStore.getState().signOut());

it("late profile events and RPC responses cannot roll back a newer profile", () => {
	const user = create(UserSchema, {
		id: "owner",
		username: "Original",
		revision: 1,
	});
	useAuthStore.getState().signIn(user);
	const current = create(UserSchema, {
		...user,
		username: "Renamed",
		avatarUrl: "/avatars/new",
		revision: 3,
	});
	useAuthStore.getState().updateUser(current);
	useAuthStore
		.getState()
		.updateUser(create(UserSchema, { ...user, revision: 2 }));
	adoptUser(user);
	expect(useAuthStore.getState().user).toMatchObject({
		username: "Renamed",
		avatarUrl: "/avatars/new",
		revision: 3,
	});
});

it("a fresh server profile replaces persisted data from before revisions existed", () => {
	useAuthStore
		.getState()
		.signIn(create(UserSchema, { id: "owner", username: "Cached" }));
	adoptUser(
		create(UserSchema, { id: "owner", username: "Current", revision: 1 }),
	);
	expect(useAuthStore.getState().user).toMatchObject({
		username: "Current",
		revision: 1,
	});
});
