/**
 * The owner's boxes on the Memory page (spec-explorer-owner.md): sign in with his passkey, add a
 * passkey with the 7-word code sent to his Telegram, and his passkeys for this address (remove one
 * after a confirm and its own passkey prompt). Both are `ModalBox`es.
 */

import { useRef, useState } from "react";
import { ModalBox } from "./ModalBox.js";
import { OwnerSessionError } from "./owner-session.js";
import type { OwnerAccess } from "./use-owner-access.js";

const failureOf = (error: unknown) => (error instanceof OwnerSessionError ? error.code : "FAILED");

const SIGN_IN_FAILED = {
	CANCELLED: "Sign-in was cancelled. Try again when you're ready.",
	REFUSED: "Couldn't sign in. If this device has no passkey for this address yet, add one first.",
	FAILED: "Couldn't sign in: the server didn't answer. Try again.",
} as const;

const ADD_FAILED = {
	CANCELLED: "Adding the passkey was cancelled. Your code still works until it runs out.",
	REFUSED: "That code didn't work. A code works once, for 10 minutes. Send a new one if it's used up.",
	FAILED: "Couldn't add the passkey: the server didn't answer. Try again.",
} as const;

function Busy({ busy, children }: { busy: boolean; children: string }) {
	return busy ? <span aria-hidden="true">Waiting for your passkey…</span> : <>{children}</>;
}

function AddPasskey({ access, onBack }: { access: OwnerAccess; onBack(): void }) {
	const [sent, setSent] = useState(false);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<string | null>(null);

	const send = async () => {
		setSaid(null);
		try {
			await access.sendCode();
			setSent(true);
		} catch {
			setSaid("Couldn't send a code just now. Wait a few minutes and try again.");
		}
	};
	const add = async () => {
		setSaid(null);
		setBusy(true);
		try {
			await access.addPasskey(code);
		} catch (error) {
			setSaid(ADD_FAILED[failureOf(error)]);
			setBusy(false);
		}
	};

	return (
		<>
			<h2 id="mx-owner-title">Add a passkey</h2>
			<p id="mx-owner-body">
				We send a 7-word code to your Telegram. Type it here, then this device asks to make a passkey for this address.
				You get a Telegram message whenever a passkey is added.
			</p>
			{sent ? (
				<form
					className="mx-owner-form"
					onSubmit={(event) => {
						event.preventDefault();
						void add();
					}}
				>
					<label htmlFor="mx-owner-code">7-word code from Telegram</label>
					<input
						id="mx-owner-code"
						type="text"
						autoComplete="one-time-code"
						spellCheck={false}
						value={code}
						onChange={(event) => setCode(event.target.value)}
					/>
					<div className="mx-actions">
						<button type="button" className="mx-btn" onClick={onBack}>
							Back
						</button>
						<button type="button" className="mx-btn" onClick={() => void send()}>
							Send a new code
						</button>
						<button type="submit" className="mx-btn mx-btn-solid" disabled={busy || code.trim() === ""}>
							<Busy busy={busy}>Add passkey</Busy>
						</button>
					</div>
				</form>
			) : (
				<div className="mx-actions">
					<button type="button" className="mx-btn" onClick={onBack}>
						Back
					</button>
					<button type="button" className="mx-btn mx-btn-solid" onClick={() => void send()}>
						Send code
					</button>
				</div>
			)}
			{said ? (
				<p className="mx-error" role="alert">
					{said}
				</p>
			) : null}
		</>
	);
}

export function SignInBox({ access, opener }: { access: OwnerAccess; opener: HTMLElement | null }) {
	const [adding, setAdding] = useState(false);
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<string | null>(null);
	const signInRef = useRef<HTMLButtonElement>(null);

	const signIn = async () => {
		setSaid(null);
		setBusy(true);
		try {
			await access.signIn();
		} catch (error) {
			setSaid(SIGN_IN_FAILED[failureOf(error)]);
			setBusy(false);
		}
	};

	return (
		<ModalBox
			labelledBy="mx-owner-title"
			describedBy="mx-owner-body"
			className="mx-confirm mx-owner"
			initialFocus={signInRef}
			returnFocus={opener}
			onClose={access.closeBox}
		>
			{adding ? (
				<AddPasskey access={access} onBack={() => setAdding(false)} />
			) : (
				<>
					<h2 id="mx-owner-title">Sign in to see memory</h2>
					<p id="mx-owner-body">
						Memory holds every department's notes, so only you can open it, with your passkey. Each change you make asks
						for your passkey again.
					</p>
					{said ? (
						<p className="mx-error" role="alert">
							{said}
						</p>
					) : null}
					<div className="mx-actions">
						<button type="button" className="mx-btn" onClick={access.closeBox}>
							Not now
						</button>
						<button
							ref={signInRef}
							type="button"
							className="mx-btn mx-btn-solid"
							disabled={busy}
							onClick={() => void signIn()}
						>
							<Busy busy={busy}>Sign in with passkey</Busy>
						</button>
					</div>
					<p className="mx-dim mx-owner-alt">
						No passkey on this device yet?{" "}
						<button type="button" className="mx-link" onClick={() => setAdding(true)}>
							Add a passkey
						</button>
					</p>
				</>
			)}
		</ModalBox>
	);
}

const addedOn = (iso: string) =>
	`Added ${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

export function PasskeysBox({ access, opener }: { access: OwnerAccess; opener: HTMLElement | null }) {
	const [removing, setRemoving] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<string | null>(null);
	const known = access.passkeys;
	const doomed = known?.list.find((p) => p.id === removing) ?? null;

	const remove = async (id: string) => {
		setSaid(null);
		setBusy(true);
		try {
			await access.removePasskey(id);
			setRemoving(null);
		} catch (error) {
			setSaid(
				failureOf(error) === "CANCELLED"
					? "Not removed: you didn't confirm with your passkey."
					: "Couldn't remove this passkey. Try again.",
			);
		}
		setBusy(false);
	};

	let body;
	if (doomed) {
		const signsOut = doomed.id === known?.current;
		body = (
			<>
				<h2 id="mx-owner-title">Remove this passkey?</h2>
				<p id="mx-owner-body">
					{addedOn(doomed.created_at)}, for {doomed.rp_id}. It stops working here at once
					{signsOut ? ", and you're signed out, because you signed in with it" : ""}. Your passkey confirms the removal.
				</p>
				<div className="mx-actions">
					<button type="button" className="mx-btn" onClick={() => setRemoving(null)}>
						Cancel
					</button>
					<button type="button" className="mx-btn mx-btn-danger" disabled={busy} onClick={() => void remove(doomed.id)}>
						<Busy busy={busy}>Remove passkey</Busy>
					</button>
				</div>
			</>
		);
	} else {
		body = (
			<>
				<h2 id="mx-owner-title">Your passkeys</h2>
				<p id="mx-owner-body">The passkeys that open memory on this address.</p>
				{known ? (
					<ul className="mx-passkeys">
						{known.list.map((p) => (
							<li key={p.id}>
								<span>
									{addedOn(p.created_at)}
									{p.id === known.current ? " · this one" : ""}
								</span>
								<button
									type="button"
									className="mx-btn mx-btn-danger"
									aria-label={`Remove passkey, ${addedOn(p.created_at).toLowerCase()}`}
									onClick={() => setRemoving(p.id)}
								>
									Remove
								</button>
							</li>
						))}
					</ul>
				) : (
					<p className="mx-dim">Sign in again on this page to see them.</p>
				)}
				<div className="mx-actions">
					{known ? null : (
						<button type="button" className="mx-btn" onClick={() => access.openSignIn(opener)}>
							Sign in again
						</button>
					)}
					<button type="button" className="mx-btn mx-btn-solid" onClick={access.closeBox}>
						Close
					</button>
				</div>
			</>
		);
	}

	return (
		<ModalBox
			key={doomed ? "confirm" : "list"}
			labelledBy="mx-owner-title"
			describedBy="mx-owner-body"
			className="mx-confirm mx-owner"
			returnFocus={opener}
			onClose={access.closeBox}
		>
			{body}
			{said ? (
				<p className="mx-error" role="alert">
					{said}
				</p>
			) : null}
		</ModalBox>
	);
}
