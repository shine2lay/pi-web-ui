/**
 * identities: the "Identity" choices (pi-identity) as menu entries — pure helpers.
 *
 * The chat menu's "Identity" submenu and the chat header tag's menu both offer the same list:
 * None first, then each identity by title; the chat's own one gets a ✓. A child's id says what
 * it picks (`host:conv-identity:<identity id>` / `host:conv-identity:none`), so the one handler
 * that sends `set_chat_identity` can read the choice back with identityChoiceOf.
 *
 * Kept out of the components so the unit tests can check them without a DOM.
 */
import type { UiIdentityInfo } from "./types";
import { CONV_IDENTITY_ENTRY_ID, type UiSlotEntry } from "./ui-slots";

/** The child id that stands for "no identity" (pi-identity's own `/identity none`). */
export const IDENTITY_NONE = "none";

const CHILD_PREFIX = `${CONV_IDENTITY_ENTRY_ID}:`;

/** The child entries of the identity submenu: None + each identity, the current one ticked. */
export function identityMenuChildren(
	parent: Pick<UiSlotEntry, "slot" | "align">,
	identities: readonly UiIdentityInfo[],
	current: string | undefined,
	noneLabel: string,
): UiSlotEntry[] {
	const base = {
		source: "host" as const,
		slot: parent.slot,
		kind: "action" as const,
		align: parent.align,
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	};
	const none: UiSlotEntry = {
		...base,
		id: `${CHILD_PREFIX}${IDENTITY_NONE}`,
		label: noneLabel,
		order: 0,
		...(current ? {} : { badge: "✓" }),
	};
	return [
		none,
		...identities.map((identity, i): UiSlotEntry => ({
			...base,
			id: `${CHILD_PREFIX}${identity.id}`,
			label: identity.title || identity.id,
			...(identity.title && identity.title !== identity.id ? { hint: identity.id } : {}),
			order: i + 1,
			...(current === identity.id ? { badge: "✓" } : {}),
		})),
	];
}

/** The submenu entry with its children filled in; hidden when there's nothing to pick from. */
export function withIdentityChildren(
	entry: UiSlotEntry,
	identities: readonly UiIdentityInfo[],
	current: string | undefined,
	noneLabel: string,
): UiSlotEntry {
	if (identities.length === 0 && !current) return { ...entry, hidden: true };
	const children = identityMenuChildren(entry, identities, current, noneLabel);
	const title = current ? identities.find((i) => i.id === current)?.title || current : undefined;
	return { ...entry, children, ...(title ? { badge: title } : {}) };
}

/**
 * Which identity a submenu child picks: the identity id, null = None (clear it),
 * undefined = the entry isn't an identity choice.
 */
export function identityChoiceOf(entryId: string): string | null | undefined {
	if (!entryId.startsWith(CHILD_PREFIX)) return undefined;
	const rest = entryId.slice(CHILD_PREFIX.length);
	if (rest === IDENTITY_NONE) return null;
	return rest.length > 0 ? rest : undefined;
}
