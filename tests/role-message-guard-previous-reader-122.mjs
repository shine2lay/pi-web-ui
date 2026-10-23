// #122 rollback proof: the candidate build writes ladder records (root/parent, typed approval controls), the
// actual previous reader (V's git-pinned RoleMessages, run unmodified) opens and saves the same file, then the
// candidate opens it again.
//
// Run: PI_SEALED_MODEL=none scripts/sealed.sh node tests/role-message-guard-previous-reader-122.mjs
// Prints one JSON line of named checks; exit 0 only when every check holds.
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repository } from "./role-message-guard-acceptance/harness.mjs";
import { loadPreviousReader } from "./role-message-guard-acceptance/previous-reader.mjs";

const dist = resolve(repository, "dist/server");
const load = (name) => import(pathToFileURL(join(dist, name)).href);
const { RoleMessages } = await load("role-messages.js");
const { RoleMessageGuardHost } = await load("role-message-guard-host.js");
const { GUARD_POLICY_V1 } = await load("role-message-limits.js");
const { AskHub } = await load("asks.js");
const old = (await loadPreviousReader()).api;

const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "v122-old-"));
const ROLES = ["alpha", "beta", "coo"];
const files = Object.fromEntries(ROLES.map((r) => [r, join(dir, `${r}.jsonl`)]));
for (const f of Object.values(files)) writeFileSync(f, `${JSON.stringify({ type: "session", version: 3 })}\n`);
const roles = ROLES.map((id) => ({
	id,
	title: id.toUpperCase(),
	homeChat: files[id],
	pastHomeChats: [],
	raw: {},
	dir: join(dir, id),
}));
let now = Date.parse("2026-10-12T12:00:00Z");
const clock = () => now;
const got = [];
const chatHost = {
	roles: () => roles,
	chatState: () => "idle",
	deliver: async (file, text) => {
		got.push({ file, text });
		appendFileSync(
			file,
			`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
		);
		return { ok: true };
	},
	note: async () => ({ ok: true }),
	log: () => {},
};
const path = join(dir, "data", "role-messages.json");
const lastIn = (role) => [...got].reverse().find((g) => g.file === files[role])?.text ?? "";
const who = (role, last) => ({
	role,
	title: role.toUpperCase(),
	chat: "home chat",
	file: files[role],
	handling: 0,
	guard: { bindingId: files[role], isHome: true, lastUserText: last },
});
const context = {
	goal: "g",
	progressAndChanges: "p",
	priorDecisions: ["d"],
	whyNeeded: "w",
	nextStepAndOutcome: "n",
	outstandingQuestions: ["q"],
	optionsAndTradeoffs: ["a", "b"],
	timeCostRisk: "t",
	exactCommunicationAuthority: "e",
	declaredClaims: [],
	safetyScopeAndHolds: ["s"],
};
let n = 0;
async function candidate() {
	const rm = new RoleMessages(path, chatHost, clock, GUARD_POLICY_V1);
	const host = new RoleMessageGuardHost({
		policy: GUARD_POLICY_V1,
		dir: join(dir, "data", "role-message-guard"),
		roleMessages: () => rm,
		identities: () => roles,
		askHub: new AskHub(),
		questionsChanged: () => {},
		log: () => {},
		now: clock,
	});
	await host.start();
	return { rm, host };
}
const checks = {};

// 1. Candidate: a chain to hop 7, the COO's grant, the 7th message.
let c = await candidate();
checks.candidateReady = c.host.state.status === "ready";
let from = "alpha";
let to = "beta";
for (let h = 1; h <= 6; h++) {
	await c.host.send(who(from, lastIn(from)), { to, kind: "request", text: `step ${h}` }, `tc-${++n}`);
	await c.rm.tick();
	[from, to] = [to, from];
}
const last7 = lastIn(from);
const ask = await c.host.approval(who(from, last7), { action: "request", recipients: [to], context }, `tc-${++n}`);
await c.rm.tick();
await c.host.approval(
	who("coo", lastIn("coo")),
	{ action: "decide", requestId: ask.details.requestId, generation: "1", choice: "requested_quantity", reason: "ok" },
	`tc-${++n}`,
);
await c.rm.tick();
const seventh = await c.host.send(who(from, last7), { to, kind: "request", text: "step 7" }, `tc-${++n}`);
await c.rm.tick();
checks.seventhAccepted = seventh.ok === true;
const before = JSON.parse(readFileSync(path, "utf8"));
checks.candidateWroteLadderFields =
	before.messages.some((m) => m.root && m.parent) && before.messages.some((m) => m.guard);
c.rm.stop();
c.host.stop();

// 2. The previous reader opens the same file, keeps every word/id/state, counts controls in the 20/hour, refuses hop 8 (hard 6), saves.
const prev = new old.RoleMessages(path, chatHost, clock);
const oldView = prev.recent ? prev.recent(0) : JSON.parse(readFileSync(path, "utf8")).messages;
checks.oldReaderKeepsAll =
	oldView.length === before.messages.length &&
	before.messages.every((m) =>
		oldView.some((o) => o.id === m.id && o.text === m.text && o.state === m.state && o.chain === m.chain),
	);
const handling = before.messages.find((m) => m.text === "step 7").chain;
const refused = prev.send(
	{ role: to, title: to, file: files[to], chat: "home chat", handling },
	{ to: from, kind: "request", text: "old step 8" },
);
checks.oldReaderHard6 = refused.ok === false;
const alphaHour = before.messages.filter((m) => m.from.role === from && m.kind !== "report").length;
checks.controlsCountForOldHourly =
	before.messages.some((m) => m.guard && m.from.role === from && m.kind !== "report") && alphaHour >= 4;
prev.setPaused(true);
prev.setPaused(false);
prev.stop?.();
const after = JSON.parse(readFileSync(path, "utf8"));
checks.oldSaveKeepsWords = before.messages.every((m) => after.messages.some((o) => o.id === m.id && o.text === m.text));
const keptFields = after.messages.filter((m) => m.root || m.guard).length;

// 3. Candidate again (reinstall): the chain continues (never back to hop 1); no grant use outside its line.
now += 60_000;
c = await candidate();
checks.reinstallReady = c.host.state.status === "ready";
const back = lastIn(to);
const eighth = await c.host.send(who(to, back), { to: from, kind: "request", text: "step 8" }, `tc-${++n}`);
checks.chainContinues =
	eighth.ok === true
		? eighth.record.chain === 8
		: eighth.approvalRequired?.hop === 8 || /message 8/.test(eighth.error ?? "");
c.rm.stop();
c.host.stop();

const ok = Object.values(checks).every(Boolean);
console.log(
	JSON.stringify({
		ok,
		checks,
		ladderFieldsAfterOldSave: keptFields,
		eighth: eighth.ok ? { chain: eighth.record.chain } : { reason: eighth.reason },
	}),
);
process.exit(ok ? 0 : 1);
