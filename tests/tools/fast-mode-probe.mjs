/* fast-mode live probe: does ChatGPT run a model fast with pi-web-ui's fast-mode extension?
 *
 * Uses REAL ChatGPT requests (your openai-codex sign-in, a little of the plan's limits). Each run is a
 * one-off `pi -p` with no session file, no tools, no skills and no other extensions, and loads
 * `fast-mode-probe-ext.ts`, which runs pi-web-ui's own fast-mode extension and records numbers only.
 * This script prints numbers only: never the requests, prompts or replies.
 *
 *   node tests/tools/fast-mode-probe.mjs --model gpt-5.6-sol [--rounds 3] [--thinking low]
 *        [--force]        treat the model as a fast-mode model (tier forced on a model off the list)
 *        [--tier fast]    send this tier value instead of "priority"
 *        [--only on|off]  just one side
 *        [--sse]          use the SSE transport (pi's default is WebSocket): also shows the HTTP status
 *                         and the tier ChatGPT reports back for each reply ("reported=")
 *
 * Reading it: "x" is the price multiplier pi applied (it prices the tier ChatGPT reports back:
 * priority = 2x, 2.5x for gpt-5.5; 1x = normal speed). tok/s = output tokens per second of streaming.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const cli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const ext = join(here, "fast-mode-probe-ext.ts");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const model = opt("model", "gpt-5.6-sol");
const rounds = Number(opt("rounds", "3"));
const thinking = opt("thinking", "low");
const tier = opt("tier", "");
const only = opt("only", "");
const force = args.includes("--force");
const sse = args.includes("--sse");
const PROMPT = "Count from 1 to 120, separated by single spaces. Output only the numbers.";

const dir = mkdtempSync(join(tmpdir(), "fast-probe-"));
if (sse) {
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ transport: "sse" }));
}
let n = 0;
function run(fast) {
	const out = join(dir, `run-${++n}.jsonl`);
	const r = spawnSync(
		process.execPath,
		[
			cli,
			"-p",
			"--no-session",
			"-ne",
			"-ns",
			"-np",
			"-nc",
			"-nt",
			// --sse: the throwaway folder's own settings pick the transport (trusted for this run only).
			...(sse ? ["-a"] : []),
			"--model",
			`openai-codex/${model}:${thinking}`,
			"-e",
			ext,
			PROMPT,
		],
		{
			cwd: dir,
			encoding: "utf8",
			timeout: 180_000,
			env: {
				...process.env,
				FAST_PROBE_OUT: out,
				FAST_PROBE_FAST: fast ? "1" : "0",
				FAST_PROBE_FORCE: force ? "1" : "0",
				FAST_PROBE_TIER: tier,
				FAST_PROBE_SSE: sse ? "1" : "0",
			},
		},
	);
	let lines = [];
	try {
		lines = readFileSync(out, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		// no lines: the run failed before any request
	}
	return { exit: r.status, lines };
}

const rows = [];
function show(side, res) {
	const reqs = res.lines.filter((l) => l.kind === "request").map((l) => l.tier ?? "-");
	const statuses = res.lines.filter((l) => l.kind === "response").map((l) => l.status);
	const reported = res.lines.filter((l) => l.kind === "reported").map((l) => l.tier ?? "-");
	const replies = res.lines.filter((l) => l.kind === "reply");
	const settled = res.lines.filter((l) => l.kind === "settled").at(-1);
	const last = replies.at(-1);
	const tps = last?.output && last.streamMs ? Math.round((last.output / last.streamMs) * 1000) : null;
	rows.push({ side, tps, mult: last?.multiplier, ok: last?.stopReason === "stop" });
	console.log(
		[
			side.padEnd(4),
			`tiers=[${reqs.join(",")}]`,
			statuses.length ? `http=[${statuses.join(",")}]` : "http=[ws]",
			sse ? `reported=[${reported.join(",")}]` : "",
			`replies=[${replies.map((r) => r.stopReason).join(",")}]`,
			last
				? `out=${last.output} first=${last.firstMs}ms total=${last.totalMs}ms tok/s=${tps} x${last.multiplier}`
				: "no reply",
			res.exit ? `exit=${res.exit}` : "",
		].join("  "),
	);
	for (const r of replies) if (r.error) console.log(`       error: ${r.error}`);
	const v = settled?.view;
	if (v?.reason)
		console.log(`       button: on=${v.on} "${v.reason}" until ${new Date(v.coolingUntil).toLocaleTimeString()}`);
}

console.log(
	`model openai-codex/${model}:${thinking}${force ? " (tier forced)" : ""}${tier ? ` tier=${tier}` : ""}${sse ? " sse" : ""}, ${rounds} round(s)`,
);
for (let i = 0; i < rounds; i++) {
	if (only !== "on") show("off", run(false));
	if (only !== "off") show("on", run(true));
}
const median = (xs) => {
	const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : null;
};
for (const side of ["off", "on"]) {
	const r = rows.filter((x) => x.side === side && x.ok);
	if (r.length)
		console.log(
			`${side}: median tok/s ${median(r.map((x) => x.tps))}, price x${median(r.map((x) => x.mult))} (${r.length} ok)`,
		);
}
rmSync(dir, { recursive: true, force: true });
