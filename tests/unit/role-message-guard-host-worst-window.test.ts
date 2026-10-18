// role-message-ladder (#122): the approval ladder wired over the native role messages, stage by stage on fixed
// cases (rule 16): storage cap (a), the worst real 5 hours replayed through the real guard store. It is the slowest
// test of the suite (minutes), so it has a file of its own that vitest starts first (vitest.config.ts sequencer).
// Shared world: role-message-guard-host-harness.ts (Ops #230 split the one host test file so vitest runs its parts
// side by side; docs/test-speed.md).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GuardStoreState } from "../../server/role-message-guard-contract.js";
import {
	ask,
	chainTo,
	chat,
	now,
	role,
	send,
	setNow,
	useGuardWorld,
	world,
	type World,
} from "./role-message-guard-host-harness.js";

useGuardWorld();

// Ops cap decision rm-efd6df89, fixed cases (a)-(f) (hypothesis H-ROLE-LADDER-CAPS-1).
describe("ladder: storage caps", () => {
	const stateOf = (w: World) =>
		(w.host as unknown as { state_(): Promise<GuardStoreState | null> }).state_().then((s) => s!);

	// Ops rm-fc4b9788 (option C): settled entries leave after 5 h whatever is open, so a store holds about 5 hours of
	// sends (about 4 transactions each, PRUNE-1). Measured peak: 1188 transactions and audit receipts (caps 3000),
	// 256 outbox entries, 724 tombstones, a 5.1 MB guard file (half of 16 MiB is the bar).
	it("(a) Ops rm-fc4b9788: the worst real 5 hours twice plus 100 runaway sends, with a request open throughout, stay under half", async () => {
		// tests/fixtures/role-message-worst-window.json: the busiest 5 hours of live role messages (metadata only).
		const fixture = JSON.parse(
			readFileSync(new URL("../fixtures/role-message-worst-window.json", import.meta.url), "utf8"),
		) as { rows: [number, number, number, string, number][] };
		const w = await world();
		const names = [...Array.from({ length: 10 }, (_, i) => `r${i}`), "runaway"];
		const home: Record<string, string> = {};
		for (const name of names) {
			home[name] = chat(name);
			w.roles.push(role(name, home[name]));
		}
		// One approval request stays open the whole time (no rotation can run): only the 5 h retention bounds the stores.
		const at = await chainTo(w, 7);
		expect(await ask(w, at.from, at.file, [at.to])).toMatchObject({ ok: true });
		const start = now;
		const second = 6 * 3_600_000; // the second copy starts an hour after the first ends (keeps every role within 20 an hour)
		const events: { at: number; from: string; to: string; kind: string; bytes: number }[] = [];
		for (const offset of [0, second])
			for (const [t, from, to, kind, bytes] of fixture.rows)
				if (from !== to) events.push({ at: offset + t, from: `r${from}`, to: `r${to}`, kind, bytes });
		for (let k = 0; k < 100; k++)
			events.push({ at: second + k * 180_000, from: "runaway", to: "r4", kind: "request", bytes: 4000 });
		events.sort((a, b) => a.at - b.at);
		const worst: Record<string, number> = {};
		let sent = 0;
		for (const e of events) {
			setNow(Math.max(now, start + e.at));
			// A reply wakes the asker like a request does; the words are as long as the real ones.
			const kind = e.kind === "reply" ? "request" : e.kind;
			const text = `${e.from} to ${e.to}, send ${sent + 1}: `.padEnd(Math.min(e.bytes, 4000), "x");
			const r = await send(w, e.from, home[e.from], e.to, { kind, text }, "");
			expect(r, `send ${sent + 1} (${e.from} at +${Math.round(e.at / 60_000)} min)`).toMatchObject({ ok: true });
			sent++;
			for (const f of w.host.fills(await stateOf(w))) worst[f.name] = Math.max(worst[f.name] ?? 0, f.used / f.max);
		}
		console.log(`(a) ${sent} sends; worst fill per store: ${JSON.stringify(worst)}`);
		expect(sent).toBe(2 * 164 + 100);
		const s = await stateOf(w);
		expect(s.requests.some((r) => r.state === "awaiting_approver")).toBe(true); // still open at the end
		for (const [name, ratio] of Object.entries(worst)) expect(ratio, name).toBeLessThanOrEqual(0.5);
		expect(w.logs.filter((l) => l.includes("guard store generation"))).toHaveLength(0);
	}, 3_600_000);
});
