import { upgradeRequest } from "@/lib/websocket";
import { admitWebSocket } from "@/modules/auth/session";

import { hubHeaders } from "./hub";
import { userHub } from "./publish";

// GET /events?user=…: upgrades to the user's event channel, which the
// user's hub then owns.
export async function openEventChannel(request: Request) {
	const admission = await admitWebSocket(request);
	if (admission instanceof Response) return admission;
	return userHub(admission.userId).fetch(
		upgradeRequest(request, { [hubHeaders.session]: admission.sessionId }),
	);
}
