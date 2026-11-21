/**
 * silence-watch, step 2 (Ops #1059; Q-STALL-1 B+, docs/silence-watch.md): the silence watch inside the stall
 * watch's round. Reads each role's home chat once (roles-transcripts.ts TranscriptScans: its queue records and its
 * last turn), turns the queue mirror (task-queue-replay.ts) into waits, asks silence-watch.ts which wakes are due,
 * and sends them through the stall watch's route and ledger (stall-wake.ts) inside its limits: paused role
 * messages hold it, pi-queue's wakeOnDone off stops it, the per-recipient day cap and the hourly cap count it.
 * No timer of its own, no owner alarm. Off switch: silence-watch.json {"wakes": false} finds and logs only.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { identityRegistry, type IdentityDef } from "./identities.js";
import { leadVerdict } from "./queue-blocks.js";
import type { TranscriptScan, TranscriptScans } from "./roles-transcripts.js";
import {
	SILENCE_WAIT_MINUTES,
	silenceRound,
	silenceStepNo,
	silenceStretch,
	type HomeChatTurns,
	type SilentWait,
	type SilentWaitInput,
} from "./silence-watch.js";
import { askWaitStart } from "./task-queue-ask.js";
import { replayState } from "./task-queue-replay.js";
import {
	localDay,
	sentCount,
	STALL_DAY_CAP,
	STALL_HOUR_CAP,
	type StallItemInfo,
	type StallLedgerLine,
	type StallLedgerState,
	type StallWake,
} from "./stall-wake.js";
import type { StallSettings } from "./stall-watch.js";
import { resolveDataDir } from "./uploads.js";
import type { RegistryRead } from "./work-registry-reader.js";

const HOUR = 3_600_000;

// ---------------------------------------------------------------------------------------------------------------
// The off switch
// ---------------------------------------------------------------------------------------------------------------

export const SILENCE_FILE = "silence-watch.json";

/** wakes false: the watch finds and logs, and wakes nobody. `problem`: the file couldn't be read (log only). */
export interface SilenceSettings {
	wakes: boolean;
	problem?: string;
}

/** ~/.pi-web-ui/silence-watch.json (PI_WEB_SILENCE_FILE in tests), read every round. Missing: wakes on. */
export function silenceSettings(env: NodeJS.ProcessEnv = process.env): SilenceSettings {
	const file = env.PI_WEB_SILENCE_FILE || join(resolveDataDir(), SILENCE_FILE);
	if (!existsSync(file)) return { wakes: true };
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { wakes?: unknown };
		if (!raw || typeof raw !== "object" || (raw.wakes !== undefined && typeof raw.wakes !== "boolean"))
			return { wakes: false, problem: `${file}: "wakes" must be true or false` };
		return { wakes: raw.wakes !== false };
	} catch (err) {
		return { wakes: false, problem: `${file}: ${(err as Error)?.message ?? err}` };
	}
}

// ---------------------------------------------------------------------------------------------------------------
// The inputs: each role's home chat (its queue and its last turn)
// ---------------------------------------------------------------------------------------------------------------

/** A role's home chat as the watch reads it. */
export interface SilenceHome {
	role: string;
	scan: Pick<TranscriptScan, "queue" | "sessionId" | "lastTurnAt">;
}

/** Every role's home chat, read through the Roles page's scans. Throws when one can't be read: a round that
 *  misses a chat would miss its turns and wake its lead wrongly, so it finds nothing instead. */
export async function readSilenceHomes(
	defs: readonly Pick<IdentityDef, "id" | "homeChat">[],
	scans: Pick<TranscriptScans, "read"> | null | undefined,
): Promise<SilenceHome[]> {
	if (!scans) throw new Error("the Roles page's reader has not started yet");
	const read = (file: string) => scans.read(file);
	const homes: SilenceHome[] = [];
	for (const def of defs) {
		if (!def.homeChat) continue;
		if (!isAbsolute(def.homeChat)) throw new Error(`${def.id}: home chat is not an absolute path`);
		try {
			homes.push({ role: def.id, scan: await read(def.homeChat) });
		} catch (err) {
			throw new Error(`${def.id}: couldn't read its home chat: ${(err as Error)?.message ?? err}`);
		}
	}
	return homes;
}

/** A wait with what is owed, in plain words (no question text: only its number, or the block's own words). */
export interface SilenceWaitInfo extends SilentWaitInput {
	owed: string;
}

const short = (s: string, max: number) => {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}\u2026` : one;
};

/**
 * The open waits of every home chat's queue (the one queue mirror). Question: start = ask.from ?? ask.at, decided
 * by the queue's role, no pi-queue timer read. Block: start = block.start, decided by its owing lead (else the
 * queue's role); covered with no end while on another task or need-only, else until its rule-16 checkpoint.
 * A task or queue the owner paused is skipped.
 */
export function silenceWaitsOf(homes: readonly SilenceHome[]): SilenceWaitInfo[] {
	const out: SilenceWaitInfo[] = [];
	for (const h of homes) {
		const s = replayState(h.scan.queue, h.scan.sessionId);
		if (s.hold) continue;
		for (const t of s.tasks) {
			if (t.hold) continue;
			const task = { queue: h.role, id: t.id };
			if (t.status === "asking" && t.ask) {
				const start = askWaitStart(t.ask);
				const owed = `an answer to its question ${t.ask.n}`;
				out.push({ task, role: h.role, kind: "question", start, decidingRole: h.role, nextNudgeAt: null, owed });
			} else if (t.status === "blocked" && t.block) {
				const b = t.block;
				const covered = !!b.on?.length || !b.lead;
				// The owed lead's first reminder (its rule-16 checkpoint), as the queue's own block verdict times it.
				const first = covered ? undefined : leadVerdict({ ...b, reminders: [] });
				const nextNudgeAt = first?.kind === "due" ? first.at : Number.POSITIVE_INFINITY;
				const owed = b.lead
					? b.owes
						? `"${short(b.owes, 160)}" from ${b.lead}`
						: `what ${b.lead} owes it`
					: "its block";
				const decidingRole = b.lead ?? h.role;
				out.push({ task, role: h.role, kind: "block", start: b.start, decidingRole, nextNudgeAt, owed });
			}
		}
	}
	return out;
}

/** Each role's home-chat turns the watch needs: its last one. */
export const silenceTurnsOf = (homes: readonly SilenceHome[]): HomeChatTurns =>
	new Map(homes.map((h) => [h.role, h.scan.lastTurnAt === undefined ? [] : [h.scan.lastTurnAt]]));

// ---------------------------------------------------------------------------------------------------------------
// The ledger and the message
// ---------------------------------------------------------------------------------------------------------------

/** A step that is done for good: sent, or found with wakes off or no chat to wake (stall-wake.ts FINAL). */
const DONE: ReadonlySet<StallLedgerState> = new Set(["sent", "wakes-off", "no-chat"]);

/** The silence steps already done (`<stretch>#<step>` -> when), from the stall ledger. */
export function silenceSent(ledger: readonly StallLedgerLine[]): Map<string, number> {
	const sent = new Map<string, number>();
	for (const l of ledger) {
		const key = `${l.stretch}#${l.step}`;
		if (l.stretch.startsWith("task:") && DONE.has(l.state) && !sent.has(key)) sent.set(key, l.at);
	}
	return sent;
}

export function silenceItemText(f: SilentWait, owed: string): string {
	const what = `Task ${f.task.queue} #${f.task.id} has waited ${f.waitedMinutes} minutes on ${owed}`;
	return f.step === "lead"
		? `${what} and this chat has not had a turn since. Decide it, or say who should.`
		: `${what} and ${f.decidingRole}'s chat has not had a turn since: its lead has not acted for ${f.waitedMinutes} minutes. Decide it, or say who should.`;
}

const itemOf = (f: SilentWait): StallItemInfo => ({
	kind: "task",
	id: `${f.task.queue}#${f.task.id}`,
	name: `${f.task.queue} #${f.task.id}`,
	rule: "silent",
	since: f.start,
	step: silenceStepNo(f.step),
});

// ---------------------------------------------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------------------------------------------

export interface SilenceWatchHost {
	/** Every role's home chat (readSilenceHomes); throws when one can't be read. */
	homes(): Promise<SilenceHome[]>;
	stall(): Pick<StallSettings, "mode">;
	settings(): SilenceSettings;
	log(line: string): void;
}

/** The server's silence watch (agent-service.ts startStallWatch): the identities' home chats through the Roles
 *  page's scans, the stall watch's mode, the off switch file, the server log. */
export function serverSilenceWatch(
	wake: StallWake,
	stall: () => Pick<StallSettings, "mode">,
	scans: () => Pick<TranscriptScans, "read"> | null | undefined,
): SilenceWatch {
	return new SilenceWatch(wake, {
		homes: () => readSilenceHomes(identityRegistry().identities, scans()),
		stall,
		settings: () => silenceSettings(),
		log: (line) => console.log(line),
	});
}

/** What a round did, for the log and the proofs. */
export interface SilenceRoundResult {
	examined: number;
	due: SilentWait[];
	/** Why it woke nobody this round ("" when it could). */
	logOnly: string;
}

export class SilenceWatch {
	/** Log-only findings already logged (one line per wake step, not every round). */
	private readonly told = new Set<string>();

	constructor(
		private readonly wake: StallWake,
		private readonly host: SilenceWatchHost,
		private readonly waitMinutes = SILENCE_WAIT_MINUTES,
	) {}

	/** The stall watch's read hook: one round over its inputs' registry read, then the inputs, unchanged. */
	async after<T extends { registry: RegistryRead }>(inputs: T): Promise<T> {
		await this.round(inputs.registry, Date.now());
		return inputs;
	}

	/** One round, inside the stall watch's: never throws (logged); undefined when it found nothing to look at. */
	async round(read: RegistryRead, now: number): Promise<SilenceRoundResult | undefined> {
		try {
			return await this.run(read, now);
		} catch (err) {
			this.host.log(`silence: round failed: ${(err as Error)?.message ?? err}`);
			return undefined;
		}
	}

	private async run(read: RegistryRead, now: number): Promise<SilenceRoundResult | undefined> {
		if (!read.complete) {
			this.host.log(`silence: round skipped: the registry read is incomplete (${read.reason})`);
			return undefined;
		}
		let homes: SilenceHome[];
		try {
			homes = await this.host.homes();
		} catch (err) {
			this.host.log(`silence: round skipped: ${(err as Error)?.message ?? err}`);
			return undefined;
		}
		const waits = silenceWaitsOf(homes);
		const owed = new Map(waits.map((w) => [silenceStretch(w), w.owed]));
		const sent = silenceSent(this.wake.ledger(now));
		const r = silenceRound(read, () => waits, silenceTurnsOf(homes), now, { waitMinutes: this.waitMinutes, sent });
		const due = r.complete ? r.findings : [];
		const settings = this.host.settings();
		const mode = this.host.stall().mode;
		const logOnly =
			mode !== "on"
				? `stall watch mode ${mode}`
				: settings.problem
					? `off switch unreadable, ${settings.problem}`
					: settings.wakes
						? ""
						: `${SILENCE_FILE} wakes false`;
		this.host.log(
			`silence: round: ${waits.length} waits examined, ${due.length} due${logOnly ? ` (log only: ${logOnly})` : ""}`,
		);
		if (logOnly) {
			for (const f of due) {
				const key = `${silenceStretch(f)}#${silenceStepNo(f.step)}`;
				if (this.told.has(key)) continue;
				this.told.add(key);
				this.host.log(
					`silence: would wake ${f.to} about ${f.task.queue} #${f.task.id} (${f.step}, ${f.waitedMinutes} min)`,
				);
			}
		} else this.deliver(due, owed, now);
		return { examined: waits.length, due, logOnly };
	}

	/** Through the stall watch's route, ledger and limits (stall-wake.ts planStallRound's rules). */
	private deliver(due: readonly SilentWait[], owed: ReadonlyMap<string, string>, now: number): void {
		const host = this.wake.host;
		const ledger = this.wake.ledger(now);
		const lineOf = (f: SilentWait, at: number, state: StallLedgerState, id?: string): StallLedgerLine => ({
			stretch: silenceStretch(f),
			step: silenceStepNo(f.step),
			to: f.to,
			at,
			...(id ? { id } : {}),
			state,
		});
		const notes: StallLedgerLine[] = [];
		// A held or capped step is written once while it stays so (it is tried again each round).
		const note = (f: SilentWait, state: StallLedgerState) => {
			const stretch = silenceStretch(f);
			const step = silenceStepNo(f.step);
			const last = ledger.filter((l) => l.stretch === stretch && l.step === step).at(-1);
			if (!DONE.has(state) && last?.state === state) return;
			notes.push(lineOf(f, now, state));
		};
		const byTo = new Map<string, SilentWait[]>();
		const paused = host.paused();
		const wakesOn = host.wakesOn();
		for (const f of due) {
			if (paused) note(f, "held");
			else if (!wakesOn) note(f, "wakes-off");
			else if (!host.hasHome(f.to)) note(f, "no-chat");
			else byTo.set(f.to, [...(byTo.get(f.to) ?? []), f]);
		}
		let hour = sentCount(ledger, (l) => l.at > now - HOUR);
		const day = localDay(now);
		const batches: [string, SilentWait[]][] = [];
		for (const [to, items] of byTo) {
			if (sentCount(ledger, (l) => l.to === to && localDay(l.at) === day) >= STALL_DAY_CAP || hour >= STALL_HOUR_CAP) {
				for (const f of items) note(f, "capped");
				continue;
			}
			hour++;
			batches.push([to, items]);
		}
		this.wake.record(notes);
		for (const l of notes) host.log(`silence: step ${l.step} of ${l.stretch} for ${l.to}: ${l.state}`);
		for (const [to, all] of batches) {
			// A send whose ledger line was lost (a crash between the two): record it, don't send again.
			const found: StallLedgerLine[] = [];
			const items = all.filter((f) => {
				const before = host.sentBefore?.(silenceStretch(f), silenceStepNo(f.step), to);
				if (before) found.push(lineOf(f, before.at, "sent", before.id));
				return !before;
			});
			this.wake.record(found);
			if (!items.length) continue;
			const text = items.map((f) => silenceItemText(f, owed.get(silenceStretch(f)) ?? "its wait")).join("\n\n");
			const res = host.send({ role: to, items: items.map(itemOf), text });
			if (!res.ok) {
				host.log(`silence: couldn't wake ${to}: ${res.error}`);
				continue;
			}
			this.wake.record(items.map((f) => lineOf(f, now, "sent", res.id)));
			const list = items.map((f) => `${f.task.queue} #${f.task.id} ${f.step} ${f.waitedMinutes} min`).join(", ");
			host.log(`silence: woke ${to} (${res.id}) about ${list}`);
		}
	}
}
