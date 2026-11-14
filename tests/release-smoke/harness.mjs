/**
 * The release smoke tests' small runner (before.mjs, live.mjs; README.md beside this file).
 *
 * A flow file registers its check with test("@flow:<id> <what it proves>", async (ctx) => detail):
 * the check returns a short detail when it passes, throws (any error) when it fails, and throws
 * unsure(why) when it could not be checked for a reason outside pi-web-ui (model provider down,
 * public route down, Chrome or QA's fixture missing). run() prints one line per check, naming its
 * flow and status, and returns the exit code: 0 all passed, 1 any failed, 3 none failed but some
 * could not be checked.
 */
import { setTimeout as sleep } from "node:timers/promises";

const registered = [];

/** Register a check; the title starts with its flow tag, e.g. "@flow:F1 open the app". */
export function test(title, fn) {
	const m = /^@flow:([A-Za-z0-9_-]+)\s+(.*)$/.exec(title);
	if (!m) throw new Error(`smoke test title must start with @flow:<id>: ${title}`);
	registered.push({ flow: m[1], what: m[2], fn });
}

export class Unsure extends Error {}
/** The check could not be run for a reason outside pi-web-ui. */
export const unsure = (why) => new Unsure(why);

/** Wait until fn() is truthy (polling every `step` ms); returns its value, or throws "no <what> within N s". */
export async function waitFor(fn, ms, what, step = 200) {
	const end = Date.now() + ms;
	for (;;) {
		let v;
		try {
			v = await fn();
		} catch {
			v = null;
		}
		if (v) return v;
		if (Date.now() >= end) throw new Error(`no ${what} within ${Math.round(ms / 1000)} s`);
		await sleep(step);
	}
}

/** Like waitFor, but returns null instead of throwing. */
export const holds = (fn, ms, step = 200) => waitFor(fn, ms, "", step).catch(() => null);

export const clip = (text, n = 160) => {
	const s = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
export const messageOf = (err) => clip(err instanceof Error ? err.message : String(err), 300);

/**
 * Run every registered check in order with ctx. `blocked` (a reason) fails every check without
 * running it (e.g. the build is missing or the server did not start).
 */
export async function run(ctx, { label, blocked = null } = {}) {
	const counts = { PASS: 0, FAIL: 0, UNSURE: 0 };
	const started = Date.now();
	// A stop signal must not leave a throwaway chat or a big-chat copy behind: the check in progress
	// finishes and cleans up (its limits bound it), the rest are skipped. A second signal stops at once.
	let stopped = null;
	const onStop = (sig) => {
		if (stopped) process.exit(1);
		stopped = sig;
		console.log(`${sig}: finishing the check in progress and cleaning up; the rest are skipped`);
	};
	process.on("SIGINT", onStop).on("SIGTERM", onStop);
	for (const t of registered) {
		if (stopped) {
			counts.FAIL++;
			console.log(`${t.flow} FAIL ${t.what}: not checked: stopped by ${stopped} (0.0 s)`);
			continue;
		}
		const t0 = Date.now();
		let status = "PASS";
		let detail;
		if (blocked) {
			status = "FAIL";
			detail = `not checked: ${blocked}`;
		} else {
			try {
				detail = (await t.fn(ctx)) ?? "";
			} catch (err) {
				status = err instanceof Unsure ? "UNSURE" : "FAIL";
				detail = messageOf(err);
			}
		}
		counts[status]++;
		const secs = ((Date.now() - t0) / 1000).toFixed(1);
		console.log(`${t.flow} ${status} ${t.what}: ${detail} (${secs} s)`);
		for (const note of ctx.notes?.splice(0) ?? []) console.log(`   note: ${clip(note, 300)}`);
	}
	process.off("SIGINT", onStop).off("SIGTERM", onStop);
	const code = counts.FAIL ? 1 : counts.UNSURE ? 3 : 0;
	const total = ((Date.now() - started) / 1000).toFixed(1);
	console.log(
		`${label}: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.UNSURE} unsure in ${total} s; exit ${code}`,
	);
	return code;
}
