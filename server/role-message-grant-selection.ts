import type { GuardActor, GuardKnownCausality } from "./role-message-guard-contract.js";
import type { GuardGrantAny, GuardPolicy } from "./role-message-guard-contract-v2.js";
import { guardDigest } from "./role-message-guard-store.js";
import { ROLE_MESSAGE_POLICY } from "./role-message-limits.js";

export function same(a: unknown, b: unknown): boolean {
	return guardDigest(a) === guardDigest(b);
}
export function rootOf(c: GuardKnownCausality): string {
	return c.kind === "rooted" ? c.rootId : c.anchorId;
}
export function parentOf(c: GuardKnownCausality): string | undefined {
	return c.incomingRecordId ?? undefined;
}
/** Which grant (if any) a business send uses. Pure, so the stage tests can pin it.
 *  - A grant belongs to one chain line: same root, and the record it was asked from is an ancestor of
 *    this send (branches after that point share its exact finite sends; a branch from before it can't use it).
 *  - Within the selected policy's free-hop band nothing is used unless the caller names a grant.
 *  - A relevant grant that is spent, expired, denied or revoked is still handed to E, so the sender hears
 *    the exact reason instead of a fresh "approval needed".
 *  - A relevant grant whose scope doesn't cover this sender, recipient, task or hop is a mismatch, and
 *    nothing is charged. */
export function chooseGrant(input: {
	grants: readonly GuardGrantAny[];
	policy?: GuardPolicy;
	causal: GuardKnownCausality;
	actor: GuardActor;
	to: string;
	now: number;
	wanted: string | null;
	ancestorAt: (recordId: string, hop: number) => string | undefined;
}): { kind: "none" } | { kind: "use"; grant: GuardGrantAny } | { kind: "mismatch"; grant: GuardGrantAny; why: string } {
	const { causal, actor, to, now, wanted } = input;
	const hop = causal.nextHop;
	const onLine = (g: GuardGrantAny) => {
		if (rootOf(g.binding.causal) !== rootOf(causal)) return false;
		const anchor = parentOf(g.binding.causal);
		const mine = parentOf(causal);
		if (!anchor) return true; // asked at the root: the whole root is the line
		return !!mine && input.ancestorAt(mine, g.binding.causal.nextHop - 1) === anchor;
	};
	const live = (g: GuardGrantAny) => g.state === "approved" && now < g.expiresAt && g.acceptedUses < g.maximumUses;
	let pick: GuardGrantAny | undefined;
	if (wanted) {
		pick = input.grants.find((g) => g.id === wanted);
		if (!pick) return { kind: "none" };
		if (!onLine(pick)) return { kind: "mismatch", grant: pick, why: "it belongs to another chain" };
	} else {
		if (hop <= (input.policy ?? ROLE_MESSAGE_POLICY).depth.unapprovedThrough) return { kind: "none" };
		const mine = input.grants.filter(onLine);
		if (!mine.length) return { kind: "none" };
		const inRange = (g: GuardGrantAny) => hop >= g.binding.causal.nextHop && hop <= g.binding.upperHop;
		const usable = mine
			.filter((g) => live(g) && inRange(g))
			.sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
		// Several live grants on one line: use the first whose scope fits this send.
		pick =
			usable.find((g) => !misfit(g, actor, to)) ??
			usable[0] ??
			[...mine].filter(inRange).sort((a, b) => b.expiresAt - a.expiresAt || a.id.localeCompare(b.id))[0];
		if (!pick) return { kind: "none" }; // nothing covers this hop: E asks for the right tier's approval
	}
	// Past the grant's last message: it is simply done; E asks for the next tier's approval.
	if (hop > pick.binding.upperHop) return { kind: "none" };
	if (hop < pick.binding.causal.nextHop)
		return {
			kind: "mismatch",
			grant: pick,
			why: `it covers messages ${pick.binding.causal.nextHop} to ${pick.binding.upperHop}, this is message ${hop}`,
		};
	const why = misfit(pick, actor, to);
	return why ? { kind: "mismatch", grant: pick, why } : { kind: "use", grant: pick };
}
function misfit(g: GuardGrantAny, actor: GuardActor, to: string): string | null {
	if (!g.binding.scope.participants.includes(actor.role)) return `${actor.role} isn't named in it`;
	if (!g.binding.scope.recipients.includes(to)) return `${to} isn't a recipient in it`;
	if (!same(g.binding.scope.task, actor.task)) return "it was given for another task";
	return null;
}
