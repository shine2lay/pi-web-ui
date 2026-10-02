/* Bounded live check. Requires EXTERNALLY refreshed, positively verified included allowance and
 * eligibility; this switch is an attestation, not an entitlement/credit check. Never run on uncertain
 * allowance. No credit purchases, no real sessions. At most two one-shot no-tool requests. No retries.
 *
 * node tests/tools/fast-mode-probe.mjs --included-allowance-confirmed [--mode standard|fast|ultrafast]
 * Default: Standard + Ultrafast on Astra. SSE observes returned tier metadata (the SDK drops it).
 * Emits only tiers, timing and success. Never infer GPT-6 acceptance from price or claim a speedup.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
if (!args.includes("--included-allowance-confirmed")) {
	console.error(
		"SKIPPED: positively confirm refreshed included allowance and Astra eligibility first; never use purchased credits.",
	);
	process.exit(2);
}
const option = args.indexOf("--mode");
const modes = option < 0 ? ["standard", "ultrafast"] : [args[option + 1]];
if (modes.some((m) => !["standard", "fast", "ultrafast"].includes(m))) throw new Error("Invalid speed mode");
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const ext = join(here, "fast-mode-probe-ext.ts");
const dir = mkdtempSync(join(tmpdir(), "speed-probe-"));
try {
	mkdirSync(join(dir, ".pi"));
	writeFileSync(
		join(dir, ".pi/settings.json"),
		JSON.stringify({ transport: "sse", retry: { enabled: false }, compaction: { enabled: false } }),
	);
	for (const mode of modes) {
		const out = join(dir, `${mode}.jsonl`);
		const run = spawnSync(
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
				"-a",
				"--model",
				"openai-codex/gpt-6-astra:off",
				"-e",
				ext,
				"Reply OK only.",
			],
			{
				cwd: dir,
				encoding: "utf8",
				timeout: 60000,
				env: { ...process.env, FAST_PROBE_OUT: out, FAST_PROBE_MODE: mode, FAST_PROBE_SSE: "1" },
			},
		);
		let lines = [];
		try {
			lines = readFileSync(out, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		} catch {
			/* no request */
		}
		const requested = lines.filter((l) => l.kind === "request").map((l) => l.tier ?? "default");
		const returned = lines
			.filter((l) => l.kind === "reported")
			.map((l) => l.tier)
			.filter(Boolean);
		const reply = lines.filter((l) => l.kind === "reply").at(-1);
		console.log(
			JSON.stringify({
				mode,
				requested,
				returned: returned.length ? returned : "unconfirmed",
				firstMs: reply?.firstMs ?? null,
				totalMs: reply?.totalMs ?? null,
				ok: run.status === 0 && reply?.stopReason === "stop",
			}),
		);
		if (requested.length > 1) {
			console.error("Request budget exceeded; stopping.");
			break;
		}
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
