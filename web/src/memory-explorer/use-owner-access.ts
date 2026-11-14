/**
 * The owner's access to the Memory page (spec-explorer-owner.md): who is signed in, the sign-in and
 * passkeys boxes, and the two hooks the HTTP seam calls.
 *
 * - `onOwnerOnly`: a read was refused for want of a session. The first one opens the sign-in; every
 *   read refused meanwhile waits on the same answer, and each is asked again once he signed in, so
 *   an ended session costs nothing: the open note and its scroll stay. "Not now" refuses them all,
 *   and later reads are refused quietly until he presses Sign in.
 * - `ownerAssertion`: one write's passkey confirm. If his session ended first, he signs in, then
 *   confirms the write.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { OwnerPasskeyInfo, OwnerWriteOp } from "../../../server/openviking/owner-session-types.js";
import { ExplorerApiError } from "./explorer-api.js";
import { type OwnerSessionClient, OwnerSessionError } from "./owner-session.js";

const KEPT_KEY = "memory-explorer-passkeys";

export type OwnerState = "unknown" | "signed-in" | "signed-out";
export type OwnerBox =
	{ kind: "sign-in"; opener: HTMLElement | null } | { kind: "passkeys"; opener: HTMLElement | null };

/** The passkeys of this address as of his last sign-in in this tab (the server lists them only then). */
export interface KnownPasskeys {
	readonly current: string;
	readonly list: readonly OwnerPasskeyInfo[];
}

function keptPasskeys(): KnownPasskeys | null {
	try {
		const kept = sessionStorage.getItem(KEPT_KEY);
		return kept ? (JSON.parse(kept) as KnownPasskeys) : null;
	} catch {
		return null;
	}
}

function keepPasskeys(known: KnownPasskeys | null): void {
	try {
		if (known) sessionStorage.setItem(KEPT_KEY, JSON.stringify(known));
		else sessionStorage.removeItem(KEPT_KEY);
	} catch {
		/* private mode: the list shows after the next sign-in */
	}
}

interface Waiter {
	resolve(): void;
	reject(error: unknown): void;
}

export interface OwnerAccess {
	readonly state: OwnerState;
	readonly box: OwnerBox | null;
	readonly passkeys: KnownPasskeys | null;
	/** Changes when the page should load again from the start (signed in or out by hand). */
	readonly generation: number;
	readonly onReadAccepted: () => void;
	readonly onOwnerOnly: () => Promise<void>;
	readonly ownerAssertion: (op: OwnerWriteOp) => Promise<string>;
	openSignIn(opener: HTMLElement | null): void;
	openPasskeys(opener: HTMLElement | null): void;
	/** Runs the passkey sign-in; on success the box closes and waiting reads go on. */
	signIn(): Promise<void>;
	sendCode(): Promise<void>;
	/** Adds a passkey with the Telegram code, then signs in with it. */
	addPasskey(code: string): Promise<void>;
	removePasskey(id: string): Promise<void>;
	signOut(): Promise<void>;
	/** "Not now" or Escape on the open box. */
	closeBox(): void;
}

export function useOwnerAccess(session: OwnerSessionClient): OwnerAccess {
	const [state, setState] = useState<OwnerState>("unknown");
	const [box, setBox] = useState<OwnerBox | null>(null);
	const [passkeys, setPasskeys] = useState<KnownPasskeys | null>(keptPasskeys);
	const [generation, setGeneration] = useState(0);
	const waiters = useRef<Waiter[]>([]);
	const quiet = useRef(false);

	const knowPasskeys = useCallback((known: KnownPasskeys | null) => {
		keepPasskeys(known);
		setPasskeys(known);
	}, []);

	const signedOut = useCallback(() => {
		quiet.current = true;
		knowPasskeys(null);
		setState("signed-out");
		setBox(null);
		setGeneration((g) => g + 1);
	}, [knowPasskeys]);

	const onReadAccepted = useCallback(() => setState("signed-in"), []);

	const askToSignIn = useCallback((): Promise<void> => {
		setState("signed-out");
		if (quiet.current) return Promise.reject(new ExplorerApiError("OWNER_ONLY", "Signed out."));
		return new Promise<void>((resolve, reject) => {
			if (waiters.current.length === 0) setBox({ kind: "sign-in", opener: null });
			waiters.current.push({ resolve, reject });
		});
	}, []);

	const ownerAssertion = useCallback(
		async (op: OwnerWriteOp): Promise<string> => {
			try {
				return await session.confirmWrite(op);
			} catch (error) {
				if (!(error instanceof OwnerSessionError) || error.code !== "REFUSED") throw error;
				await askToSignIn();
				return session.confirmWrite(op);
			}
		},
		[session, askToSignIn],
	);

	const signIn = useCallback(async () => {
		const opened = await session.signIn();
		quiet.current = false;
		knowPasskeys({ current: opened.passkey_id, list: opened.passkeys });
		setState("signed-in");
		setBox(null);
		const waiting = waiters.current.splice(0);
		// Signed in by hand with nothing waiting: load the page again from the start.
		if (waiting.length === 0) setGeneration((g) => g + 1);
		for (const w of waiting) w.resolve();
	}, [session, knowPasskeys]);

	const closeBox = useCallback(() => {
		setBox(null);
		const waiting = waiters.current.splice(0);
		if (waiting.length === 0) return;
		quiet.current = true;
		setState("signed-out");
		for (const w of waiting) w.reject(new ExplorerApiError("OWNER_ONLY", "Not signed in."));
	}, []);

	return useMemo(
		() => ({
			state,
			box,
			passkeys,
			generation,
			onReadAccepted,
			onOwnerOnly: askToSignIn,
			ownerAssertion,
			openSignIn: (opener) => setBox({ kind: "sign-in", opener }),
			openPasskeys: (opener) => setBox({ kind: "passkeys", opener }),
			signIn,
			sendCode: async () => {
				await session.sendCode();
			},
			async addPasskey(code) {
				await session.addPasskey(code);
				await signIn();
			},
			async removePasskey(id) {
				await session.removePasskey(id);
				// The server ends the session signed in with the removed passkey.
				if (!passkeys || passkeys.current === id) signedOut();
				else knowPasskeys({ ...passkeys, list: passkeys.list.filter((p) => p.id !== id) });
			},
			async signOut() {
				await session.signOut().catch(() => undefined);
				signedOut();
			},
			closeBox,
		}),
		[
			state,
			box,
			passkeys,
			generation,
			onReadAccepted,
			askToSignIn,
			ownerAssertion,
			signIn,
			session,
			signedOut,
			knowPasskeys,
			closeBox,
		],
	);
}
