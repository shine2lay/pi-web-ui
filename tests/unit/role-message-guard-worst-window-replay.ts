// Ops #233 (H-GUARD-STORE-PERF-1, docs/guard-store-perf.md): the sends of test (a)
// (role-message-guard-host-worst-window.test.ts) as a reusable replay, for the guard store's golden test and its
// benchmark. Same world, same order, same words as test (a); `stride` keeps every n-th send for a shorter run
// that still spans the whole window (retention and pruning included). Test (a) itself keeps its own copy.
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { ask, chainTo, chat, now, role, send, setNow, type World } from "./role-message-guard-host-harness.js";

export interface WorstWindowSend {
	n: number;
	from: string;
	to: string;
	kind: string;
	at: number;
}

/** Plays test (a)'s sends into a fresh world from the harness; `each` runs around every send (it times it). */
export async function replayWorstWindow(
	w: World,
	options: { stride?: number; each?: (send: WorstWindowSend, run: () => Promise<void>) => Promise<void> } = {},
): Promise<number> {
	const stride = options.stride ?? 1;
	const fixture = JSON.parse(
		readFileSync(new URL("../fixtures/role-message-worst-window.json", import.meta.url), "utf8"),
	) as { rows: [number, number, number, string, number][] };
	const names = [...Array.from({ length: 10 }, (_, i) => `r${i}`), "runaway"];
	const home: Record<string, string> = {};
	for (const name of names) {
		home[name] = chat(name);
		w.roles.push(role(name, home[name]));
	}
	// One approval request stays open the whole time, as in test (a).
	const at = await chainTo(w, 7);
	expect(await ask(w, at.from, at.file, [at.to])).toMatchObject({ ok: true });
	const start = now;
	const second = 6 * 3_600_000;
	const events: { at: number; from: string; to: string; kind: string; bytes: number }[] = [];
	for (const offset of [0, second])
		for (const [t, from, to, kind, bytes] of fixture.rows)
			if (from !== to) events.push({ at: offset + t, from: `r${from}`, to: `r${to}`, kind, bytes });
	for (let k = 0; k < 100; k++)
		events.push({ at: second + k * 180_000, from: "runaway", to: "r4", kind: "request", bytes: 4000 });
	events.sort((a, b) => a.at - b.at);
	let sent = 0;
	for (const [i, e] of events.entries()) {
		if (i % stride !== 0) continue;
		setNow(Math.max(now, start + e.at));
		const kind = e.kind === "reply" ? "request" : e.kind;
		const text = `${e.from} to ${e.to}, send ${sent + 1}: `.padEnd(Math.min(e.bytes, 4000), "x");
		const run = async () => {
			const r = await send(w, e.from, home[e.from], e.to, { kind, text }, "");
			expect(r, `send ${sent + 1} (${e.from} at +${Math.round(e.at / 60_000)} min)`).toMatchObject({ ok: true });
		};
		const one = { n: sent + 1, from: e.from, to: e.to, kind, at: e.at };
		if (options.each) await options.each(one, run);
		else await run();
		sent++;
	}
	return sent;
}
