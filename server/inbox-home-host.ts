import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { InboxRuntime, type InboxClaim, type InboxRuntimePorts } from "./inbox-runtime.js";
import { installRoleMailBoundary } from "./role-mail-boundary.js";
import { ownTaskOf } from "./own-task.js";
import { taskQueueAll } from "./task-queue.js";
import {
	queueEntriesOf,
	roleMessageText,
	type RoleMessageRecord,
	type RoleMessageSender,
	type RoleMessageSendInput,
} from "./role-messages.js";
import { readHomeMessages } from "./inbox-home-reader.js";
import { samePath } from "./identities.js";
import type { RoleMessageGuardSendResult } from "./role-message-guard-host.js";

type Home = { id: string; homeChat?: string | null };
let service: InboxHomeHost | undefined;
export function configureInboxHome(host: InboxHomeHost | undefined): void {
	service = host;
}

/** Ordinary HOME integration only. No helper launch, native queue or owner-source admission. */
export class InboxHomeHost {
	readonly runtime: InboxRuntime;
	private metadata = new Map<string, ReturnType<NonNullable<InboxRuntimePorts["senderTask"]>> | Error>();
	private active = new Map<string, InboxClaim>();
	private ready = false;
	private landings = new Map<string, Promise<void>>();
	private replies = new Map<string, Promise<unknown>>();
	/** The guard must recover before inbox intents can be qualified. */
	async startWithGuard(changed: () => void): Promise<void> {
		try {
			await this.ports.guard.start();
			await this.start();
			changed();
		} catch (error) {
			console.error("HOME inbox recovery unavailable", error);
		}
	}
	async start(): Promise<void> {
		await this.refresh();
		await this.runtime.recover();
		this.ready = true;
	}
	constructor(
		readonly ports: InboxRuntimePorts,
		readonly homes: () => readonly Home[],
	) {
		this.runtime = new InboxRuntime({
			...ports,
			senderTask: (file) => {
				const value = this.metadata.get(file);
				if (!this.metadata.has(file) || value instanceof Error) throw new Error("E_RPI_UNKNOWN: sender metadata");
				return value;
			},
		});
	}
	role(file: string | undefined): string | undefined {
		return file ? this.homes().find((h) => h.homeChat && samePath(h.homeChat, file))?.id : undefined;
	}
	async refresh(): Promise<void> {
		const files = [...new Set(readHomeMessages(this.ports.roleMessagesFile).map((r) => r.from.file))];
		await Promise.all(
			files.map(async (file) => {
				try {
					if (!file) {
						this.metadata.set(file, undefined);
						return;
					}
					const own = ownTaskOf(await queueEntriesOf(file));
					if (!own) {
						this.metadata.set(file, undefined);
						return;
					}
					if (!own.queueChat) throw new Error("Unqualified sender queue");
					this.metadata.set(file, { own, queue: taskQueueAll(await queueEntriesOf(own.queueChat, true)) });
				} catch {
					this.metadata.set(file, new Error("E_RPI_UNKNOWN"));
				}
			}),
		);
	}
	async orderWaiting(records: readonly RoleMessageRecord[]): Promise<readonly RoleMessageRecord[]> {
		if (!this.ready) return records;
		await this.refresh();
		await this.runtime.recover(false);
		const result = [...records];
		for (const home of this.homes()) {
			if (!home.homeChat) continue;
			const slots = records
				.map((r, i) =>
					r.to.role === home.id && (!r.target || samePath(r.target, home.homeChat!)) && r.kind !== "reply" ? i : -1,
				)
				.filter((i) => i >= 0);
			const read = this.runtime.read(home.id);
			if (read.status !== "ok") continue;
			const ranks = new Map(read.items.map((item, i) => [item.source.ref, i]));
			const ordered = slots
				.map((i) => records[i])
				.sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
			slots.forEach((slot, i) => {
				result[slot] = ordered[i];
			});
		}
		return result;
	}
	retentionPins(): ReadonlySet<string> {
		const pins = new Set<string>();
		for (const home of this.homes()) {
			const read = this.runtime.read(home.id);
			if (read.status !== "ok") throw new Error("E_RPI_UNKNOWN");
			for (const item of read.items)
				if (item.lifecycle.lease || item.lifecycle.effect || item.lifecycle.state === "open") pins.add(item.source.ref);
		}
		return pins;
	}
	async select(file: string, rows: readonly { id: string; passive: boolean }[]): Promise<string[]> {
		const role = this.role(file);
		if (!role) return rows.map((r) => r.id);
		await this.refresh();
		const read = this.runtime.read(role);
		if (read.status !== "ok") return rows.map((r) => r.id); // legacy transport survives UNKNOWN; no claim/effect is admitted
		const ids = new Set(rows.map((r) => r.id));
		return read.items.filter((i) => ids.has(i.source.ref)).map((i) => i.source.ref);
	}
	async landed(file: string, id: string): Promise<void> {
		const pending = (this.landings.get(file) ?? Promise.resolve()).then(() => this.land(file, id));
		this.landings.set(file, pending);
		try {
			await pending;
		} finally {
			if (this.landings.get(file) === pending) this.landings.delete(file);
		}
	}
	private async land(file: string, id: string): Promise<void> {
		if (!this.ready) return;
		const role = this.role(file);
		if (!role) return;
		await this.refresh();
		const read = this.runtime.read(role);
		if (read.status !== "ok") return;
		const item = read.items.find((i) => i.source.ref === id);
		if (!item || item.class === "passive") return;
		const claim = await this.runtime.claim(item.key, { kind: "home", role, session: file });
		if ("leaseId" in claim) this.active.set(file, claim);
	}
	async ended(file: string, outcome: "turn_completed" | "aborted", session: AgentSession): Promise<void> {
		const claim = this.active.get(file);
		const role = this.role(file);
		if (!claim || !role) return;
		this.active.delete(file);
		const record = this.ports.messages.byId(claim.key.slice(3));
		const hadAlarm = this.runtime
			.audit(role, role)
			.some((line) => line.key === claim.key && line.op === "alarm" && line.cause === "unanswered");
		const replied = !!record?.replyId;
		await this.runtime.end(
			claim,
			replied
				? "replied"
				: outcome === "aborted"
					? outcome
					: record?.kind === "question" || record?.kind === "request"
						? "turn_ended_unanswered"
						: "turn_completed",
		);
		const read = this.runtime.read(role);
		if (!read || read.status !== "ok") return;
		const item = read.items.find((i) => i.key === claim.key);
		const failures = this.runtime.failedAttempts(claim.key);
		// Self-generated continuation is not an independent event (RETRY3).
		if (record && item?.lifecycle.state === "open" && !item.lifecycle.effect && failures < 3) {
			session.agent.followUp({
				role: "user",
				timestamp: this.ports.now(),
				content: [
					{
						type: "text",
						text: `[Unanswered from attempt ${item.lifecycle.attempts} — reply with message_role kind "reply", replyTo "${record.id}"]\n${roleMessageText(record)}`,
					},
				],
			});
		}
		if (item && !hadAlarm && failures >= 3 && item.lifecycle.state === "open")
			await session.sendCustomMessage(
				{
					customType: "role-inbox-alarm",
					display: true,
					content: `An unanswered role message needs attention: ${item.key}; attempts: ${item.lifecycle.attempts}. It remains open.`,
				},
				{ triggerTurn: false },
			);
	}
	async reply(
		sender: RoleMessageSender,
		input: RoleMessageSendInput,
		toolCallId: string,
	): Promise<RoleMessageGuardSendResult | undefined> {
		const pending = (this.replies.get(sender.file) ?? Promise.resolve())
			.catch(() => {})
			.then(() => this.replyInTurn(sender, input, toolCallId));
		this.replies.set(sender.file, pending);
		try {
			return await pending;
		} finally {
			if (this.replies.get(sender.file) === pending) this.replies.delete(sender.file);
		}
	}
	private async replyInTurn(
		sender: RoleMessageSender,
		input: RoleMessageSendInput,
		toolCallId: string,
	): Promise<RoleMessageGuardSendResult | undefined> {
		const role = this.role(sender.file);
		if (!role || role !== sender.role || input.kind !== "reply" || typeof input.replyTo !== "string") return undefined;
		if (!this.ready) return { ok: false, error: "Inbox reply held: E_RPI_UNKNOWN (recovery not ready)" };
		await this.landings.get(sender.file);
		const original = this.ports.messages.byId(input.replyTo);
		if (!original || original.to.role !== role) return undefined;
		if (input.to !== original.from.role) return { ok: false, error: "Inbox reply held: E_RPI_TARGET" };
		await this.refresh();
		let claim = this.active.get(sender.file);
		if (claim && claim.key !== `rm:${original.id}`) return { ok: false, error: "Inbox reply held: E_RPI_BUSY" };
		if (!claim) {
			const got = await this.runtime.claim(`rm:${original.id}`, { kind: "home", role, session: sender.file });
			if (!("leaseId" in got))
				return { ok: false, error: `Inbox reply held: ${"code" in got ? got.code : "E_RPI_BUSY"}` };
			claim = got;
			this.active.set(sender.file, claim);
		}
		const result = await this.runtime.reply(claim, sender, input, toolCallId);
		const record = result.resultRef ? this.ports.messages.byId(result.resultRef) : undefined;
		return record
			? { ok: true, record, paused: this.ports.messages.paused, targetChat: "the chat that asked" }
			: { ok: false, error: `Inbox reply held: ${result.code ?? "E_RPI_UNKNOWN"}` };
	}
}
export function initializeInboxHome(
	dataDir: string,
	messages: InboxRuntimePorts["messages"],
	guard: InboxRuntimePorts["guard"],
	homes: () => readonly Home[],
): InboxHomeHost {
	const host = new InboxHomeHost(
		{
			ledgerFile: join(dataDir, "role-inbox-ledger.jsonl"),
			roleMessagesFile: join(dataDir, "role-messages.json"),
			messages,
			guard,
			now: Date.now,
		},
		homes,
	);
	configureInboxHome(host);
	return host;
}

export function installHomeInboxBoundary(session: AgentSession): void {
	const file = () => session.sessionFile ?? undefined;
	installRoleMailBoundary(session, {
		legacy: () => !service?.role(file()),
		select: (rows) => (service && file() ? service.select(file()!, rows) : Promise.resolve(rows.map((r) => r.id))),
		landed: (id) => (service && file() ? service.landed(file()!, id) : Promise.resolve()),
		ended: (outcome) => (service && file() ? service.ended(file()!, outcome, session) : Promise.resolve()),
	});
}
export function homeInboxReply(
	sender: RoleMessageSender,
	input: RoleMessageSendInput,
	toolCallId: string,
): Promise<RoleMessageGuardSendResult | undefined> {
	return service ? service.reply(sender, input, toolCallId) : Promise.resolve(undefined);
}
