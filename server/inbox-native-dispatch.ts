/** Native dispatch metadata lives in the existing SDK journal, never in message payloads. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { userEntryIdOf, userMessageText, type MarkSessionManager } from "./admitted-texts.js";
import { ownerInputMarksIn } from "./owner-input-mark.js";
import type { RoleMessages } from "./role-messages.js";
import type { InboxFence, InboxLine } from "./shared/inbox-wire.js";

const TYPE = "pi-web-ui/inbox-dispatch";
export interface NativeRoot {
	sourceRef: string;
	rootRef: string;
	sourceKind: "owner" | "role" | "continuation";
}
export interface NativeDispatch {
	sm: MarkSessionManager;
	provenance: NativeRoot;
}
interface DispatchMark extends NativeRoot, InboxFence {
	v: 1;
	key: string;
	session: string;
	phase: "intent" | "receipt";
}
const descendants = new WeakMap<object, NativeRoot>();
export function inheritInboxRoot(message: AgentMessage, root: NativeRoot | undefined): void {
	if (root) descendants.set(message, root);
}
/** Single reader for host-authored dispatch marks; malformed marks fail closed. */
function marks(sm: MarkSessionManager): DispatchMark[] {
	return sm.getEntries().flatMap((entry) => {
		const e = entry as { type?: string; customType?: string; data?: DispatchMark };
		if (e.type !== "custom" || e.customType !== TYPE) return [];
		const d = e.data;
		if (
			!d ||
			d.v !== 1 ||
			!["intent", "receipt"].includes(d.phase) ||
			!["owner", "role", "continuation"].includes(d.sourceKind) ||
			![d.key, d.session, d.sourceRef, d.rootRef, d.leaseId].every((s) => typeof s === "string" && s.length > 0) ||
			!Number.isSafeInteger(d.epoch) ||
			d.epoch < 1
		)
			throw new Error("E_RPI_UNKNOWN");
		return [d];
	});
}
export function nativeInboxRoot(
	sm: MarkSessionManager,
	file: string,
	message: AgentMessage,
	messages: RoleMessages,
): NativeRoot | undefined {
	const entries = sm.getEntries();
	const id = userEntryIdOf(entries, message);
	if (!id) return;
	const sourceRef = `${file}#${id}`;
	const existing = marks(sm).find((m) => m.sourceRef === sourceRef);
	if (existing) return { sourceRef, rootRef: existing.rootRef, sourceKind: existing.sourceKind };
	const inherited = descendants.get(message);
	if (inherited) return { sourceRef, rootRef: inherited.rootRef, sourceKind: "continuation" };
	if (ownerInputMarksIn(entries).has(id)) return { sourceRef, rootRef: sourceRef, sourceKind: "owner" };
	const text = userMessageText(message);
	if (text === undefined) return;
	// Canonical exact-content/target causality reader, NOT header or timestamp authority.
	const cause = messages.causalityOf(file, text);
	if (cause.kind !== "record" || !cause.exactTarget) return;
	const record = messages.byId(cause.record.id);
	if (!record || record.peer) return;
	return { sourceRef, rootRef: `rm:${record.root ?? record.id}`, sourceKind: "role" };
}

/** Called inside the runtime's per-key coordinator. Intent -> ledger -> receipt is NOT atomic.
 * Reconcile an intent against its exact random nonce/epoch, never synthesize a new lease on replay.
 */
export function prepareNativeDispatch(
	dispatch: NativeDispatch,
	key: string,
	session: string,
	lines: InboxLine[],
	fresh: InboxFence,
	failed: number,
	claimable: boolean,
): { fence: InboxFence; replay: boolean } | undefined {
	const all = marks(dispatch.sm).filter((m) => m.key === key && m.session === session);
	const p = dispatch.provenance;
	const previous = all.find((m) => m.sourceRef === p.sourceRef);
	if (previous) {
		if (previous.rootRef !== p.rootRef || previous.sourceKind !== p.sourceKind) throw new Error("E_RPI_UNKNOWN");
		const claim = lines.find((l) => l.op === "claim" && l.leaseId === previous.leaseId && l.epoch === previous.epoch);
		if (claim) return { fence: previous, replay: true };
		// Receipt without ledger or a competing newer epoch is ambiguous, not permission to retry.
		if (all.some((m) => m.sourceRef === p.sourceRef && m.phase === "receipt") || previous.epoch !== fresh.epoch) return;
		return { fence: previous, replay: false };
	}
	if (!claimable) return;
	if (failed >= 3 && (p.sourceKind === "continuation" || all.some((m) => m.rootRef === p.rootRef))) return;
	dispatch.sm.appendCustomEntry(TYPE, { v: 1, key, session, ...p, ...fresh, phase: "intent" } satisfies DispatchMark);
	return { fence: fresh, replay: false };
}
export function receiptNativeDispatch(dispatch: NativeDispatch, key: string, session: string, fence: InboxFence): void {
	if (
		marks(dispatch.sm).some(
			(m) => m.key === key && m.sourceRef === dispatch.provenance.sourceRef && m.phase === "receipt",
		)
	)
		return;
	dispatch.sm.appendCustomEntry(TYPE, {
		v: 1,
		key,
		session,
		...dispatch.provenance,
		leaseId: fence.leaseId,
		epoch: fence.epoch,
		phase: "receipt",
	} satisfies DispatchMark);
}
