/** Canonical HOME coordinator. Helper entry points remain unavailable until their later integration. */
import type { InboxCoordination } from "./inbox-coordination.js";
import { createHash, randomUUID } from "node:crypto";
import { InboxLedger, inboxCoordinator, inboxPendingIntents, type InboxIntent } from "./inbox-ledger.js";
import { homeView, inboxDigest, readHomeMessages } from "./inbox-home-reader.js";
import { inboxClaimable } from "./shared/inbox-wire.js";
import type { ownTaskOf } from "./own-task.js";
import type { taskQueueAll } from "./task-queue.js";
import type { RoleMessageGuardHost } from "./role-message-guard-host.js";
import type { RoleMessages, RoleMessageSender, RoleMessageSendInput } from "./role-messages.js";
import type { InboxFence, InboxLine, InboxOutcome, InboxView } from "./shared/inbox-wire.js";

export interface InboxRuntimePorts {
	ledgerFile: string;
	roleMessagesFile: string;
	messages: RoleMessages;
	guard: RoleMessageGuardHost;
	now: () => number;
	/** Verified existing sender-task metadata, refreshed by the host from canonical transcript readers.
	 * undefined = positively not a worker; throw = unreadable/unknown. No caller-supplied priority.
	 * ownTaskOf binds the worker to its parent queue; taskQueueAll supplies that queue's task state.
	 */
	senderTask?: (file: string) =>
		| {
				own: NonNullable<ReturnType<typeof ownTaskOf>>;
				queue: ReturnType<typeof taskQueueAll>;
		  }
		| undefined;
	/** HOME queue's canonical command/journal boundary, not a second task store. */
	queue?: InboxQueuePort;
}
export interface InboxTaskIntent {
	homeSession: string;
	effectId: string;
	opKey: string;
	payloadSha256: string;
	params: Record<string, unknown>;
	requester: {
		kind: "role";
		role: string;
		id: string;
		message: "question" | "request" | "reply";
		via: "inbox-helper";
		opKey: string;
		payloadSha256: string;
	};
}
export type InboxTaskResult =
	| { status: "accepted"; queuedTask: number; replyOwed: true; semanticReceipt: null }
	| { status: "refused"; code: string; need?: "plan"; queuedTask?: number };
export interface InboxQueuePort {
	homeSession: string;
	accept(intent: InboxTaskIntent, opRef?: string): Promise<InboxTaskResult>;
	/** Reads actual HOME journal receipts; undefined means a qualified absence. */
	find(opKey: string): Promise<{ queuedTask: number; payloadSha256: string } | undefined>;
}
export interface InboxAlarmProjection {
	count: number;
	oldestAt: number | null;
	items: Array<{ key: string; sender: string; attempts: number; checkpoint: string; cause: string }>;
}
export type InboxRead = { status: "ok"; items: InboxView[] } | { status: "unknown"; source: string; reason: string };
export type InboxClaim = { key: string; session: string } & InboxFence;
export type InboxClaimResult = InboxClaim | { code: string } | { skipped: true };

const unbuilt = (): never => {
	throw new Error("E_RPI_UNBUILT: Task 1 inert seam; runtime implementation is not installed");
};

/** Constructor captures ports only. Helpers and native task effects are not activated here. */
export class InboxRuntime {
	private readonly ledger: InboxLedger;
	private readonly locks: Map<string, Promise<unknown>>;
	private readonly accepted = new Map<string, { opRef: string; resultRef: string }>();
	constructor(readonly ports: InboxRuntimePorts) {
		this.ledger = new InboxLedger(ports.ledgerFile);
		this.locks = inboxCoordinator(ports.ledgerFile);
		ports.guard.registerInboxIntentHold(() => inboxPendingIntents(this.ledger.read()).length > 0);
	}
	read(role: string): InboxRead {
		let lines: InboxLine[];
		try {
			lines = this.ledger.read();
		} catch {
			return { status: "unknown", source: "ledger", reason: "E_RPI_UNKNOWN" };
		}
		try {
			const records = readHomeMessages(this.ports.roleMessagesFile);
			const pending = inboxPendingIntents(lines);
			const items = records
				.filter((r) => r.to.role === role)
				.map((r) => {
					const item = homeView(r, records, lines, this.ports);
					const accepted = this.accepted.get(item.key);
					if (
						item.lifecycle.effect &&
						accepted &&
						pending.some((p) => p.key === item.key && p.opRef === accepted.opRef)
					)
						item.lifecycle.effect = { ...item.lifecycle.effect, status: "accepted", resultRef: accepted.resultRef };
					return item;
				});
			items.sort(
				(a, b) => a.effectivePriority.localeCompare(b.effectivePriority) || a.at - b.at || a.key.localeCompare(b.key),
			);
			return { status: "ok", items };
		} catch (error) {
			return { status: "unknown", source: "role-messages", reason: (error as Error).message };
		}
	}
	/** Shared trusted integration seam: one key, one coordinator, one writer and fence reader. */
	coordinate<T>(key: string, action: (context: InboxCoordination) => Promise<T>): Promise<T> {
		return this.run(key, () =>
			action({
				item: () => this.item(key),
				current: (claim, ending) => {
					if (claim.key !== key) throw new Error("E_RPI_TARGET");
					return this.current(claim, ending);
				},
				lines: () => this.ledger.read().filter((line) => line.key === key),
				append: (fields) => {
					const item = this.item(key);
					if (!item) throw new Error("E_RPI_UNKNOWN");
					this.append(item, fields);
				},
			}),
		);
	}
	private item(key: string): InboxView | undefined {
		const records = readHomeMessages(this.ports.roleMessagesFile);
		const r = records.find((r) => `rm:${r.id}` === key);
		if (!r) return undefined;
		const read = this.read(r.to.role);
		if (read.status !== "ok") throw new Error("E_RPI_UNKNOWN");
		return read.items.find((i) => i.key === key);
	}
	private append(item: InboxView, fields: Record<string, unknown>): void {
		this.ledger.append({
			...fields,
			v: "rpi/1",
			seq: this.ledger.read().length + 1,
			at: this.ports.now(),
			key: item.key,
			contentHash: item.contentHash,
		} as InboxLine);
	}
	async claim(
		key: string,
		holder: { kind: "home" | "helper"; role: string; session: string },
	): Promise<InboxClaimResult> {
		if (this.locks.has(key)) return { skipped: true };
		return this.run(key, async () => {
			try {
				const item = this.item(key);
				if (!item) return { code: "E_RPI_UNKNOWN" };
				if (holder.role !== item.role) return { code: "E_RPI_ROLE" };
				if (holder.kind === "helper") {
					this.append(item, { op: "refusal", code: "E_RPI_HOME_ONLY" });
					return { code: "E_RPI_HOME_ONLY" };
				}
				if (!inboxClaimable(item))
					return { code: item.lifecycle.state === "replied" ? "E_RPI_ALREADY_REPLIED" : "E_RPI_BUSY" };
				const epochs = this.ledger
					.read()
					.filter((l) => l.key === key && l.op === "claim")
					.map((l) => ("epoch" in l ? l.epoch! : 0));
				const fence = { leaseId: randomUUID(), epoch: Math.max(0, ...epochs) + 1 };
				this.append(item, { op: "claim", holder, ...fence });
				return { key, session: holder.session, ...fence };
			} catch {
				return { code: "E_RPI_UNKNOWN" };
			}
		});
	}
	/** Read-only query, never an authority token: effects must recheck inside coordinate. */
	requireCurrent(claim: InboxClaim): void {
		try {
			this.current(claim);
		} catch (error) {
			const message = error instanceof Error ? error.message : "E_RPI_UNKNOWN";
			const code = ["E_RPI_STALE_LEASE", "E_RPI_ALREADY_REPLIED", "E_RPI_UNKNOWN"].includes(message)
				? message
				: "E_RPI_UNKNOWN";
			throw Object.assign(new Error(code), { code });
		}
	}
	private current(claim: InboxClaim, ending = false): InboxView {
		const item = this.item(claim.key);
		if (!item) throw new Error("E_RPI_UNKNOWN");
		if (item.lifecycle.state === "replied" && !ending) throw new Error("E_RPI_ALREADY_REPLIED");
		const last = this.ledger
			.read()
			.filter((l) => l.key === claim.key && l.op === "claim")
			.at(-1);
		if (
			!last ||
			last.op !== "claim" ||
			last.leaseId !== claim.leaseId ||
			last.epoch !== claim.epoch ||
			last.holder.session !== claim.session ||
			(item.lifecycle.lease !== claim.leaseId && !(ending && item.lifecycle.state === "replied"))
		)
			throw new Error("E_RPI_STALE_LEASE");
		return item;
	}
	failedAttempts(key: string): number {
		return this.ledger
			.read()
			.filter(
				(line) =>
					line.key === key &&
					line.op === "attempt" &&
					["turn_ended_unanswered", "aborted", "crashed"].includes(line.outcome),
			).length;
	}
	async end(claim: InboxClaim, outcome: InboxOutcome): Promise<void> {
		await this.run(claim.key, async () => {
			if (
				this.ledger
					.read()
					.some(
						(l) => l.key === claim.key && l.op === "attempt" && l.leaseId === claim.leaseId && l.epoch === claim.epoch,
					)
			)
				return;
			const item = this.current(claim, true);
			this.append(item, {
				op: "attempt",
				leaseId: claim.leaseId,
				epoch: claim.epoch,
				n: item.lifecycle.attempts + 1,
				outcome,
			});
			if (
				item.class === "reply_required" &&
				item.lifecycle.state !== "replied" &&
				this.failedAttempts(item.key) >= 3 &&
				!this.ledger.read().some((l) => l.key === item.key && l.op === "alarm")
			)
				this.append(item, { op: "alarm", attempts: this.failedAttempts(item.key), cause: "unanswered" });
		});
	}
	private async reconcile(intent: InboxIntent): Promise<"done" | "open" | "pending" | "unknown"> {
		const item = this.item(intent.key);
		if (!item) throw new Error("E_RPI_UNKNOWN");
		const receipt = item.lifecycle.receipt.semantic;
		if (receipt) {
			this.append(item, {
				op: "effect_done",
				leaseId: intent.leaseId,
				epoch: intent.epoch,
				effect: intent.effect,
				opKey: intent.opKey,
				resultRef: receipt,
			});
			this.accepted.delete(item.key);
			return "done";
		}
		const status = await this.ports.guard.lookupInboxOperation(intent.opRef);
		if (status.state === "accepted") {
			this.accepted.set(item.key, { opRef: intent.opRef, resultRef: status.resultRef });
			return "pending";
		}
		if (status.state === "refused" || status.state === "unaccepted") {
			this.append(item, { op: "refusal", leaseId: intent.leaseId, epoch: intent.epoch, code: "E_RPI_NOT_ACCEPTED" });
			if (
				!this.ledger
					.read()
					.some(
						(l) => l.key === item.key && l.op === "attempt" && l.leaseId === intent.leaseId && l.epoch === intent.epoch,
					)
			)
				this.append(item, {
					op: "attempt",
					leaseId: intent.leaseId,
					epoch: intent.epoch,
					n: item.lifecycle.attempts + 1,
					outcome: "turn_ended_unanswered",
					cause: "no_effect",
				});
			this.accepted.delete(item.key);
			return "open";
		}
		if (!this.ledger.read().some((l) => l.key === item.key && l.op === "alarm" && l.cause === "unknown"))
			this.append(item, { op: "alarm", attempts: item.lifecycle.attempts, cause: "unknown" });
		return "unknown";
	}
	/** Startup ends orphaned leases; live handoff reconciliation touches pending effects only. */
	async recover(orphaned = true): Promise<void> {
		for (const intent of inboxPendingIntents(this.ledger.read())) {
			if (this.locks.has(intent.key)) continue;
			await this.run(intent.key, () => this.reconcile(intent));
		}
		if (!orphaned) return;
		const records = readHomeMessages(this.ports.roleMessagesFile);
		for (const r of records) {
			if (this.locks.has(`rm:${r.id}`)) continue;
			const item = this.item(`rm:${r.id}`);
			if (!item || item.lifecycle.state !== "claimed" || item.lifecycle.effect) continue;
			const line = this.ledger
				.read()
				.filter((l) => l.key === item.key && l.op === "claim")
				.at(-1);
			if (line?.op === "claim")
				await this.end(
					{ key: item.key, session: line.holder.session, leaseId: line.leaseId, epoch: line.epoch },
					"crashed",
				);
		}
	}
	async reply(
		claim: InboxClaim,
		sender: RoleMessageSender,
		input: RoleMessageSendInput,
		toolCallId: string,
	): Promise<{ code?: string; resultRef?: string }> {
		return this.run(claim.key, async () => {
			try {
				const item = this.current(claim, true);
				const source = this.ports.messages.byId(item.source.ref);
				if (!source) return { code: "E_RPI_UNKNOWN" };
				if (
					sender.role !== item.role ||
					sender.file !== claim.session ||
					input.kind !== "reply" ||
					input.replyTo !== source.id ||
					input.to !== source.from.role
				)
					return { code: "E_RPI_TARGET" };
				if (item.lifecycle.receipt.semantic)
					return { code: "E_RPI_ALREADY_REPLIED", resultRef: item.lifecycle.receipt.semantic };
				if (item.lifecycle.effect) return { code: "E_RPI_EFFECT_PENDING" };
				if (!this.ports.messages.prepare(sender, input).ok) return { code: "E_RPI_TARGET" };
				const opKey = createHash("sha256").update(`${claim.key}:reply`).digest("hex");
				const payloadSha256 = inboxDigest({ kind: input.kind, to: input.to, replyTo: input.replyTo, text: input.text });
				if (
					this.ledger
						.read()
						.some(
							(l) =>
								l.key === claim.key &&
								l.op === "effect_intent" &&
								l.opKey === opKey &&
								l.payloadSha256 !== payloadSha256,
						)
				)
					return { code: "E_RPI_CONFLICT" };
				const opRef = this.ports.guard.inboxOperationRef(sender.file, toolCallId);
				if (!opRef) return { code: "E_RPI_UNKNOWN" };
				this.append(item, {
					op: "effect_intent",
					leaseId: claim.leaseId,
					epoch: claim.epoch,
					effect: "reply",
					opKey,
					payloadSha256,
					opRef,
				});
				// The qualified guard path never falls back to an untracked native send.
				await this.ports.guard.send(sender, input, toolCallId, opRef);
				const intent = inboxPendingIntents(this.ledger.read()).find((i) => i.key === claim.key)!;
				const state = await this.reconcile(intent);
				if (state === "done") return { resultRef: this.item(claim.key)?.lifecycle.receipt.semantic ?? undefined };
				return {
					code: state === "unknown" ? "E_RPI_UNKNOWN" : state === "open" ? "E_RPI_NOT_OPEN" : "E_RPI_EFFECT_PENDING",
				};
			} catch (e) {
				return { code: (e as Error).message.startsWith("E_RPI_") ? (e as Error).message : "E_RPI_UNKNOWN" };
			}
		});
	}
	task(_claim: InboxClaim, _params: Record<string, unknown>, _opRef: string): Promise<InboxTaskResult> {
		return unbuilt();
	}
	alarm(role: string, requestingRole: string): InboxAlarmProjection {
		if (role !== requestingRole && requestingRole !== "owners") throw new Error("E_RPI_ROLE");
		const read = this.read(role);
		if (read.status !== "ok")
			return {
				count: 1,
				oldestAt: null,
				items: [{ key: "unknown", sender: "unknown", attempts: 0, checkpoint: "HOME", cause: "unknown" }],
			};
		const open = new Set(
			read.items.filter((i) => !["replied", "processed"].includes(i.lifecycle.state)).map((i) => i.key),
		);
		const lines = this.audit(role, role).filter((l) => l.op === "alarm" && open.has(l.key));
		return {
			count: lines.length,
			oldestAt: lines[0]?.at ?? null,
			items: lines.map((l) => ({
				key: l.key,
				sender: this.ports.messages.byId(l.key.slice(3))?.from.role ?? "unknown",
				attempts: l.op === "alarm" ? l.attempts : 0,
				checkpoint: "HOME",
				cause: l.op === "alarm" ? (l.cause ?? "unanswered") : "unknown",
			})),
		};
	}
	async run<T>(key: string, acceptance: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(key);
		const pending = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(acceptance);
		this.locks.set(key, pending);
		try {
			return await pending;
		} finally {
			if (this.locks.get(key) === pending) this.locks.delete(key);
		}
	}
	audit(role: string, requestingRole: string): InboxLine[] {
		if (role !== requestingRole) throw new Error("E_RPI_ROLE");
		const records = readHomeMessages(this.ports.roleMessagesFile);
		const keys = new Set(records.filter((r) => r.to.role === role).map((r) => `rm:${r.id}`));
		return this.ledger.read().filter((l) => keys.has(l.key));
	}
}
