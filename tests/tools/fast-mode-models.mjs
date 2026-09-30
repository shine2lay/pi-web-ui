/* fast-mode: which ChatGPT (openai-codex) models can this account use, and which offer the fast tier?
 *
 * Asks ChatGPT's own Codex model list (the one the Codex app reads) with your openai-codex sign-in and
 * prints only each model's id and its speed tiers. Use it to keep FAST_MODE_MODELS in
 * server/fast-mode.ts in step when OpenAI adds models. Prints no tokens, prompts or instructions.
 *
 *   node tests/tools/fast-mode-models.mjs [--client-version 0.200.0]
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const args = process.argv.slice(2);
const i = args.indexOf("--client-version");
const clientVersion = i >= 0 ? args[i + 1] : "0.200.0";

const r = spawnSync(process.execPath, [cli, "auth", "print-bearer-token", "--provider", "openai-codex"], {
	encoding: "utf8",
	timeout: 60_000,
});
const token = (r.stdout ?? "").trim().split("\n").at(-1) ?? "";
if (r.status !== 0 || token.split(".").length !== 3) {
	console.error("No openai-codex sign-in (pi auth print-bearer-token failed).");
	process.exit(1);
}
let accountId;
try {
	accountId = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))["https://api.openai.com/auth"]
		?.chatgpt_account_id;
} catch {
	// handled below
}
if (!accountId) {
	console.error("The sign-in token names no ChatGPT account.");
	process.exit(1);
}
const res = await fetch(
	`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}`,
	{
		headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": accountId, originator: "pi" },
	},
);
if (!res.ok) {
	console.error(`ChatGPT answered HTTP ${res.status}.`);
	process.exit(1);
}
const { models = [] } = await res.json();
const ids = (xs) => (Array.isArray(xs) ? xs.map((x) => (typeof x === "string" ? x : (x?.id ?? x?.name ?? "?"))) : []);
console.log("model".padEnd(22), "visibility".padEnd(10), "service tiers / speed tiers / default");
for (const m of models) {
	console.log(
		String(m.slug).padEnd(22),
		String(m.visibility ?? "").padEnd(10),
		`[${ids(m.service_tiers).join(",")}] / [${ids(m.additional_speed_tiers).join(",")}] / ${m.default_service_tier ?? "-"}`,
	);
}
