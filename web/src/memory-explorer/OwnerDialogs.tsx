/**
 * The owner's boxes on the Memory page (spec-explorer-owner.md, Ops #1080): his passkeys for this
 * address (add one with the 7-word code sent to his Telegram, remove one after a confirm and its own
 * passkey prompt), and "Add a passkey" when a change finds none here. Both are `ModalBox`es.
 */

import { useState } from "react";
import { ModalBox } from "./ModalBox.js";
import { OwnerSessionError } from "./owner-session.js";
import type { OwnerAccess } from "./use-owner-access.js";

const failureOf = (error: unknown) => (error instanceof OwnerSessionError ? error.code : "FAILED");

const ADD_FAILED = {
	CANCELLED: "Adding the passkey was cancelled. Your code still works until it runs out.",
	REFUSED: "That code didn't work. A code works once, for 10 minutes. Send a new one if it's used up.",
	FAILED: "Couldn't add the passkey: the server didn't answer. Try again.",
} as const;

function Busy({ busy, children }: { busy: boolean; children: string }) {
	return busy ? <span aria-hidden="true">Waiting for your passkey…</span> : <>{children}</>;
}

function Said({ said }: { said: string | null }) {
	return said ? (
		<p className="mx-error" role="alert">
			{said}
		</p>
	) : null;
}

interface AddPasskeyProps {
	readonly access: OwnerAccess;
	/** Why the box is open, shown under the heading. */
	readonly lead: string;
	readonly backLabel: string;
	onBack(): void;
	onAdded?(): void;
}

function AddPasskey({ access, lead, backLabel, onBack, onAdded }: AddPasskeyProps) {
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
			onAdded?.();
		} catch (error) {
			setSaid(ADD_FAILED[failureOf(error)]);
			setBusy(false);
		}
	};
	const back = (
		<button type="button" className="mx-btn" onClick={onBack}>
			{backLabel}
		</button>
	);

	return (
		<>
			<h2 id="mx-owner-title">Add a passkey</h2>
			<p id="mx-owner-body">
				{lead} We send a 7-word code to your Telegram. Type it here, then this device asks to make a passkey for this
				address. You get a Telegram message whenever a passkey is added.
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
						{back}
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
					{back}
					<button type="button" className="mx-btn mx-btn-solid" onClick={() => void send()}>
						Send code
					</button>
				</div>
			)}
			<Said said={said} />
		</>
	);
}

/** A change found no passkey on this address: add one, and the change goes on. */
export function AddForWriteBox({ access }: { access: OwnerAccess }) {
	return (
		<ModalBox
			labelledBy="mx-owner-title"
			describedBy="mx-owner-body"
			className="mx-confirm mx-owner"
			onClose={access.closeBox}
		>
			<AddPasskey
				access={access}
				lead="Changes need your passkey, and this address has none yet. Once it's added, your change goes on."
				backLabel="Cancel"
				onBack={access.closeBox}
			/>
		</ModalBox>
	);
}

const addedOn = (iso: string) =>
	`Added ${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

function PasskeyList({ access, onAdd, onRemove }: { access: OwnerAccess; onAdd(): void; onRemove(id: string): void }) {
	const known = access.passkeys;
	let list;
	if (known.status === "loading") list = <p className="mx-dim">Loading your passkeys…</p>;
	else if (known.status === "failed") {
		list = (
			<p className="mx-dim">
				Couldn't read your passkeys.{" "}
				<button type="button" className="mx-link" onClick={() => void access.loadPasskeys()}>
					Try again
				</button>
			</p>
		);
	} else if (known.list.passkeys.length === 0) {
		list = <p className="mx-dim">No passkeys on this address yet.</p>;
	} else {
		list = (
			<ul className="mx-passkeys">
				{known.list.passkeys.map((p) => (
					<li key={p.id}>
						<span>{addedOn(p.created_at)}</span>
						<button
							type="button"
							className="mx-btn mx-btn-danger"
							aria-label={`Remove passkey, ${addedOn(p.created_at).toLowerCase()}`}
							onClick={() => onRemove(p.id)}
						>
							Remove
						</button>
					</li>
				))}
			</ul>
		);
	}
	return (
		<>
			<h2 id="mx-owner-title">Your passkeys</h2>
			<p id="mx-owner-body">
				The passkeys that confirm your changes to memory on this address. Reading memory needs none.
			</p>
			{list}
			<div className="mx-actions">
				<button type="button" className="mx-btn" onClick={onAdd}>
					Add a passkey
				</button>
				<button type="button" className="mx-btn mx-btn-solid" onClick={access.closeBox}>
					Close
				</button>
			</div>
		</>
	);
}

export function PasskeysBox({ access, opener }: { access: OwnerAccess; opener: HTMLElement | null }) {
	const [view, setView] = useState<"list" | "add" | { remove: string }>("list");
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<string | null>(null);
	const known = access.passkeys;
	const removing = typeof view === "object" ? view.remove : null;
	const doomed = known.status === "loaded" ? (known.list.passkeys.find((p) => p.id === removing) ?? null) : null;

	const remove = async (id: string) => {
		setSaid(null);
		setBusy(true);
		try {
			await access.removePasskey(id);
			setView("list");
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
	if (view === "add") {
		body = (
			<AddPasskey
				access={access}
				lead="Add one for each device you change memory from."
				backLabel="Back"
				onBack={() => setView("list")}
				onAdded={() => setView("list")}
			/>
		);
	} else if (doomed) {
		const last = known.status === "loaded" && known.list.passkeys.length === 1;
		body = (
			<>
				<h2 id="mx-owner-title">Remove this passkey?</h2>
				<p id="mx-owner-body">
					{addedOn(doomed.created_at)}, for {doomed.rp_id}. It stops working here at once
					{last ? ", and changes here need a new passkey" : ""}. Your passkey confirms the removal.
				</p>
				<div className="mx-actions">
					<button type="button" className="mx-btn" onClick={() => setView("list")}>
						Cancel
					</button>
					<button type="button" className="mx-btn mx-btn-danger" disabled={busy} onClick={() => void remove(doomed.id)}>
						<Busy busy={busy}>Remove passkey</Busy>
					</button>
				</div>
				<Said said={said} />
			</>
		);
	} else {
		body = (
			<PasskeyList
				access={access}
				onAdd={() => setView("add")}
				onRemove={(id) => {
					setSaid(null);
					setView({ remove: id });
				}}
			/>
		);
	}

	return (
		<ModalBox
			key={typeof view === "object" ? "confirm" : view}
			labelledBy="mx-owner-title"
			describedBy="mx-owner-body"
			className="mx-confirm mx-owner"
			returnFocus={opener}
			onClose={access.closeBox}
		>
			{body}
		</ModalBox>
	);
}
