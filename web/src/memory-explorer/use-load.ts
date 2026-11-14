/**
 * Load one thing from memory for a key, abortable: a new key or a reload cancels the call in flight,
 * and only the newest answer is kept. Used for every read the Memory explorer makes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { errorCode, type ExplorerErrorCode } from "./explorer-api.js";

export type Load<T> =
	| { readonly status: "loading"; readonly data: T | null }
	| { readonly status: "ready"; readonly data: T }
	| { readonly status: "failed"; readonly data: T | null; readonly code: ExplorerErrorCode };

export interface Loaded<T> {
	readonly load: Load<T>;
	reload(): void;
	/** Replace the kept answer (after an edit, delete or undo) without asking memory again. */
	set(update: (data: T) => T): void;
}

/** `key` null = nothing to load. */
export function useLoad<T>(key: string | null, fetch: (signal: AbortSignal) => Promise<T>): Loaded<T> {
	const [load, setLoad] = useState<Load<T>>({ status: "loading", data: null });
	const [round, setRound] = useState(0);
	const fetchRef = useRef(fetch);
	fetchRef.current = fetch;
	const keyRef = useRef(key);

	useEffect(() => {
		if (key === null) return;
		const controller = new AbortController();
		// A reload keeps the last answer on screen (memory down: the last copy); a new key starts clean.
		const sameKey = keyRef.current === key;
		keyRef.current = key;
		setLoad((prev) => ({ status: "loading", data: sameKey ? prev.data : null }));
		fetchRef.current(controller.signal).then(
			(data) => {
				if (!controller.signal.aborted) setLoad({ status: "ready", data });
			},
			(error: unknown) => {
				if (!controller.signal.aborted)
					setLoad((prev) => ({ status: "failed", data: prev.data, code: errorCode(error) }));
			},
		);
		return () => controller.abort();
	}, [key, round]);

	const reload = useCallback(() => setRound((r) => r + 1), []);
	const set = useCallback(
		(update: (data: T) => T) =>
			setLoad((prev) => (prev.status === "ready" ? { status: "ready", data: update(prev.data) } : prev)),
		[],
	);
	return { load, reload, set };
}
