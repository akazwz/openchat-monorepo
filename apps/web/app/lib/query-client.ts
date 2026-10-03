import { Code, ConnectError } from "@connectrpc/connect";
import { QueryClient } from "@tanstack/react-query";

// A failure that may pass by itself (the service unreachable or failing, a
// timeout) is tried again; a refusal (not found, invalid, not allowed) shows
// at once instead of after a spinner of retries.
const transient = new Set([
	Code.Unavailable,
	Code.DeadlineExceeded,
	Code.Internal,
	Code.Unknown,
]);

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			// The event channel keeps what is on screen current, and it reads
			// everything again when it opens after an outage (thread-controller.tsx):
			// a window regaining focus or the network coming back reads nothing more.
			refetchOnWindowFocus: false,
			refetchOnReconnect: false,
			staleTime: 5 * 60 * 1000,
			gcTime: 30 * 60 * 1000,
			retry: (failures, error) =>
				failures < 3 && transient.has(ConnectError.from(error).code),
		},
	},
});
