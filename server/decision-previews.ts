/**
 * decision-previews (task #84): the options' preview text for answer records kept before #84, read
 * from the dialog's own chat line that the record cites (read-only), and cached in
 * <decisions dir>/previews.json so each chat line is read once.
 *
 * A backfilled answer cites "<ask line>-><answer line>" in its chat file: the ask line holds the
 * ask_user_question call with the options' previews. A live answer from before #84 has no line; its
 * call is found by its id. Only the live chat files (~/.pi/agent/sessions) are read, never backups.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DecisionRecord } from "./decision-records.js";

export const PREVIEWS_FILE = "previews.json";

/** question id -> option label -> preview; null = looked, nothing found. */
type Previews = Record<string, Record<string, string>> | null;

export class AnswerPreviews {
	private cache: Record<string, Previews> | undefined;

	constructor(
		private readonly dir: string,
		private readonly sessionsRoot: string,
	) {}

	private load(): Record<string, Previews> {
		if (this.cache) return this.cache;
		try {
			this.cache = JSON.parse(readFileSync(join(this.dir, PREVIEWS_FILE), "utf8")) as Record<string, Previews>;
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	private save(): void {
		mkdirSync(this.dir, { recursive: true });
		const file = join(this.dir, PREVIEWS_FILE);
		writeFileSync(`${file}.tmp`, JSON.stringify(this.cache ?? {}) + "\n");
		renameSync(`${file}.tmp`, file);
	}

	/** The record with its options' previews, when the chat line has them. */
	async withPreviews(rec: DecisionRecord): Promise<DecisionRecord> {
		if (rec.source !== "answer" || !rec.questions?.length || !rec.file) return rec;
		if (rec.questions.some((q) => q.options.some((o) => o.preview))) return rec;
		const cache = this.load();
		let found = cache[rec.id];
		if (found === undefined) {
			found = await this.lookup(rec).catch(() => null);
			cache[rec.id] = found;
			this.save();
		}
		return applyPreviews(rec, found);
	}

	private chatPath(file: string): string | undefined {
		if (!/^[\w.:-]+\.jsonl$/.test(file)) return undefined;
		let subs: string[] = [];
		try {
			subs = readdirSync(this.sessionsRoot);
		} catch {
			return undefined;
		}
		for (const sub of subs) {
			const p = join(this.sessionsRoot, sub, file);
			if (existsSync(p)) return p;
		}
		return undefined;
	}

	private async lookup(rec: DecisionRecord): Promise<Previews> {
		const path = this.chatPath(rec.file!);
		if (!path) return null;
		const callId = rec.ref.startsWith("ask:") ? rec.ref.slice(4) : "";
		const want = rec.lines ? Number(rec.lines.split("->")[0]) : NaN;
		const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
		let n = 0;
		try {
			for await (const line of rl) {
				n++;
				if (
					Number.isFinite(want) ? n !== want : !(callId && line.includes(callId) && line.includes("ask_user_question"))
				)
					continue;
				const got = previewsOfLine(line, callId);
				if (got || Number.isFinite(want)) return got;
			}
		} finally {
			rl.close();
		}
		return null;
	}
}

/** The previews in one transcript line holding an ask_user_question call (by id when given). */
export function previewsOfLine(line: string, callId?: string): Previews {
	let entry: { message?: { content?: unknown[] } };
	try {
		entry = JSON.parse(line);
	} catch {
		return null;
	}
	for (const c of entry.message?.content ?? []) {
		const call = c as { type?: string; name?: string; id?: string; arguments?: { questions?: unknown[] } };
		if (call?.type !== "toolCall" || call.name !== "ask_user_question") continue;
		if (callId && call.id && call.id !== callId) continue;
		const out: Record<string, Record<string, string>> = {};
		for (const [i, q] of (call.arguments?.questions ?? []).entries()) {
			const qq = q as { id?: string; options?: { label?: string; preview?: string }[] };
			const id = typeof qq?.id === "string" ? qq.id : String(i);
			for (const o of qq?.options ?? []) {
				if (typeof o?.label === "string" && typeof o.preview === "string" && o.preview.trim()) {
					(out[id] ??= {})[o.label] = o.preview;
				}
			}
		}
		return Object.keys(out).length ? out : null;
	}
	return null;
}

export function applyPreviews(rec: DecisionRecord, previews: Previews): DecisionRecord {
	if (!previews || !rec.questions) return rec;
	return {
		...rec,
		questions: rec.questions.map((q) => ({
			...q,
			options: q.options.map((o) => (previews[q.id]?.[o.label] ? { ...o, preview: previews[q.id][o.label] } : o)),
		})),
	};
}
