/**
 * The owner's passkeys on the Memory page (spec-explorer-owner.md, Ops #1080): reading needs no sign-in,
 * so this only serves changes and the header's Passkeys box.
 *
 * - `ownerAssertion`: one write's passkey confirm. Refused because this address has no passkey yet,
 *   it opens "Add a passkey"; once he added one, the same write is confirmed and goes on (his draft is
 *   never lost). Closing the box is a write not confirmed.
 * - The Passkeys box lists this address's passkeys from the server, adds one with the Telegram code
 *   and removes one with its own passkey confirm.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { OwnerPasskeyList, OwnerWriteOp } from "../../../server/openviking/owner-session-types.js";
import { type OwnerSessionClient, OwnerSessionError } from "./owner-session.js";

export type OwnerBox = { kind: "passkeys"; opener: HTMLElement | null } | { kind: "add-for-write" };

/** This address's passkeys: loading, loaded, or the list couldn't be read. */
export type KnownPasskeys = { status: "loading" } | { status: "loaded"; list: OwnerPasskeyList } | { status: "failed" };

interface Waiter {
	resolve(): void;
	reject(error: unknown): void;
}

export interface OwnerAccess {
	readonly box: OwnerBox | null;
	readonly passkeys: KnownPasskeys;
	readonly ownerAssertion: (op: OwnerWriteOp) => Promise<string>;
	openPasskeys(opener: HTMLElement | null): void;
	/** Reads this address's passkeys again. */
	loadPasskeys(): Promise<void>;
	sendCode(): Promise<void>;
	/** Adds a passkey with the Telegram code; a write waiting for it goes on. */
	addPasskey(code: string): Promise<void>;
	removePasskey(id: string): Promise<void>;
	/** Cancel, Close or Escape on the open box. */
	closeBox(): void;
}

const NOT_CONFIRMED = () => new OwnerSessionError("CANCELLED", "No passkey was added.");

export function useOwnerAccess(session: OwnerSessionClient): OwnerAccess {
	const [box, setBox] = useState<OwnerBox | null>(null);
	const [passkeys, setPasskeys] = useState<KnownPasskeys>({ status: "loading" });
	const waiters = useRef<Waiter[]>([]);

	const loadPasskeys = useCallback(async (): Promise<OwnerPasskeyList | null> => {
		try {
			const list = await session.passkeys();
			setPasskeys({ status: "loaded", list });
			return list;
		} catch {
			setPasskeys({ status: "failed" });
			return null;
		}
	}, [session]);

	/** Opens "Add a passkey" for a waiting write; resolves once one is added, rejects when closed. */
	const addForWrite = useCallback(
		() =>
			new Promise<void>((resolve, reject) => {
				if (waiters.current.length === 0) setBox({ kind: "add-for-write" });
				waiters.current.push({ resolve, reject });
			}),
		[],
	);

	const ownerAssertion = useCallback(
		async (op: OwnerWriteOp): Promise<string> => {
			try {
				return await session.confirmWrite(op);
			} catch (error) {
				if (!(error instanceof OwnerSessionError) || error.code !== "REFUSED") throw error;
				// Every refusal looks the same; only the passkey list says this address has none.
				const list = await loadPasskeys();
				if (!list || list.passkeys.length > 0) throw error;
				await addForWrite();
				return session.confirmWrite(op);
			}
		},
		[session, loadPasskeys, addForWrite],
	);

	const closeBox = useCallback(() => {
		setBox(null);
		for (const w of waiters.current.splice(0)) w.reject(NOT_CONFIRMED());
	}, []);

	const addPasskey = useCallback(
		async (code: string) => {
			await session.addPasskey(code);
			await loadPasskeys();
			const waiting = waiters.current.splice(0);
			if (waiting.length === 0) return;
			setBox(null);
			for (const w of waiting) w.resolve();
		},
		[session, loadPasskeys],
	);

	return useMemo(
		() => ({
			box,
			passkeys,
			ownerAssertion,
			openPasskeys(opener) {
				setPasskeys({ status: "loading" });
				setBox({ kind: "passkeys", opener });
				void loadPasskeys();
			},
			loadPasskeys: async () => {
				await loadPasskeys();
			},
			sendCode: async () => {
				await session.sendCode();
			},
			addPasskey,
			async removePasskey(id) {
				await session.removePasskey(id);
				await loadPasskeys();
			},
			closeBox,
		}),
		[box, passkeys, ownerAssertion, loadPasskeys, session, addPasskey, closeBox],
	);
}
