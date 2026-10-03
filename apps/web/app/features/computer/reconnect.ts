import { useCallback, useEffect, useRef, useState } from "react";

// Waits before each try again: at once almost, then longer.
const delaysMs = [1000, 2000, 4000, 8000, 15000];

// Reopening a connection to the computer (its screen, its terminal) that
// dropped. A restart or a restored snapshot replaces the computer's container,
// and the network comes and goes; each ends the connection, so it is opened
// again by itself, a few times, waiting longer each time. After those, a
// person can try again (`retry`). `attempt` changes for each try, and the
// connection's effect depends on it.
export function useReconnect() {
	const [attempt, setAttempt] = useState(0);
	const tries = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	// The connection opened: the next drop starts over.
	const connected = useCallback(() => {
		tries.current = 0;
	}, []);
	// The connection dropped; whether it will be opened again by itself.
	const dropped = useCallback(() => {
		const delay = delaysMs[tries.current];
		if (delay === undefined) return false;
		tries.current++;
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setAttempt((value) => value + 1), delay);
		return true;
	}, []);
	const retry = useCallback(() => {
		tries.current = 0;
		clearTimeout(timer.current);
		setAttempt((value) => value + 1);
	}, []);
	return { attempt, connected, dropped, retry };
}
