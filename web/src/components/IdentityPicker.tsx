/**
 * identities: the identity picker in a blank chat (the chat.empty slot entry host:identity-picker).
 *
 * A new chat starts with None; the picker offers None and each identity (pi-identity) as chips,
 * the chat's own one pressed. A pick sends `set_chat_identity` for this chat, and the server runs
 * pi-identity's own `/identity <id>` / `/identity none` in it — so the chat starts with it.
 * Nothing is remembered between new chats: the next new chat is None again.
 *
 * Shown the same way on desktop and phone (the empty chat is the same after the desktop
 * "New chat" and the phone "+").
 */
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { useIdentityList } from "../identity-state";
import type { UiChatIdentity } from "../types";

/** How long a pick shows as pressed while the server hasn't confirmed it (then the chip falls back). */
const PENDING_MS = 5000;

export function IdentityPicker({
	current,
	onPick,
}: {
	/** The chat's identity now (undefined = None). */
	current: UiChatIdentity | undefined;
	/** A chip clicked: the identity id, or null for None. */
	onPick: (identity: string | null) => void;
}) {
	const t = useT();
	const { identities, loaded } = useIdentityList();
	const serverId = current?.id ?? null;
	// The pick on its way (undefined = none): pressed at once, until the chat list says what the
	// chat has now (or PENDING_MS passes, e.g. pi-identity isn't installed and the server said so).
	const [pending, setPending] = useState<string | null | undefined>(undefined);
	useEffect(() => {
		setPending(undefined);
	}, [serverId]);
	useEffect(() => {
		if (pending === undefined) return;
		const timer = setTimeout(() => setPending(undefined), PENDING_MS);
		return () => clearTimeout(timer);
	}, [pending]);
	if (!loaded || identities.length === 0) return null;
	const chips: { id: string | null; label: string; hint?: string }[] = [
		{ id: null, label: t("identityNone") },
		...identities.map((i) => ({ id: i.id, label: i.title || i.id, ...(i.title !== i.id ? { hint: i.id } : {}) })),
	];
	const currentId = pending !== undefined ? pending : serverId;
	return (
		<div className="identity-picker" role="radiogroup" aria-label={t("identityPicker")}>
			<span className="identity-picker-label">{t("identityPickerLabel")}</span>
			<span className="identity-picker-chips">
				{chips.map((chip) => {
					const on = chip.id === currentId;
					return (
						<button
							key={chip.id ?? "\u0000none"}
							type="button"
							role="radio"
							aria-checked={on}
							className={`identity-chip${on ? " on" : ""}`}
							data-identity={chip.id ?? "none"}
							title={chip.hint}
							onClick={() => {
								if (on) return;
								setPending(chip.id);
								onPick(chip.id);
							}}
						>
							{chip.label}
						</button>
					);
				})}
			</span>
		</div>
	);
}
