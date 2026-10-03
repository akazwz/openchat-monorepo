import { create } from "@bufbuild/protobuf";
import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { afterEach, expect, it, vi } from "vitest";

import { createAuthInterceptor } from "~/features/auth/interceptor";
import { useAuthStore } from "~/features/auth/store";
import { AuthService, UserSchema } from "~/gen/heveta/v1/auth_pb";

import { deferred } from "./deferred";
afterEach(() => useAuthStore.getState().signOut());

it.each([true, false])(
	"session ownership covers a late RPC response, rejected=%s",
	async (rejected) => {
		useAuthStore.getState().signIn(create(UserSchema, { id: "a" }));
		const pending = deferred<Response>();
		const refused = vi.fn();
		const fetch = vi.fn(() => pending.promise);
		const client = createClient(
			AuthService,
			createConnectTransport({
				baseUrl: "https://test.invalid",
				fetch,
				interceptors: [createAuthInterceptor(refused)],
			}),
		);
		const request = client.updateCurrentUser({ username: "NewName" });
		const assertion = expect(request).rejects.toMatchObject({
			code: Code.Canceled,
		});
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		useAuthStore.getState().signIn(create(UserSchema, { id: "b" }));
		pending.resolve(
			Response.json(
				rejected
					? { code: "unauthenticated", message: "Old session" }
					: { user: { id: "a", username: "NewName" } },
				{ status: rejected ? 401 : 200 },
			),
		);
		await assertion;
		expect(refused).not.toHaveBeenCalled();
		expect(useAuthStore.getState().user?.id).toBe("b");
	},
);
