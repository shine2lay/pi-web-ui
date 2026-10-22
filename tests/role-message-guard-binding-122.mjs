// #122 binding of V's acceptance corpus to the registered native build (dist/server).
//
// Each supported case runs on a fresh sandbox: real RoleMessages + the real approval ladder host (E core and
// store, A adapters) from the built server, fake chat files, a fixed clock. The fixture's history (the chat's
// incoming message, older traffic) is seeded as native role-message records; grants are made through the native
// approval path (A request, the COO's or the owner's answer), never written into the store.
//
// Honest scope: only the ladder cases this binding can drive natively are supported. Every other case (all
// protected/urgent cases among them: #125 found no qualified native producer, so urgent is NOT DELIVERED) is
// reported NOT RUN by the harness, never green.
//
// Dispatch barrier: during a step every chat reports "working". Since role-mail-busy (5fd24a3f, Ops #156) the native
// busy path has two halves: RoleMessages admits a working chat's mail to the host at once, and the host holds it in
// that chat's boundary FIFO (server/role-mail-boundary.ts) until the running turn completes; only then does it land
// (and, unless it is an FYI, start the next turn). The fake host keeps that second half: on a working chat deliver
// and note only queue the mail, and settle() is the turn boundary where it lands, oldest first. An admission is
// not a dispatch (role-messages.ts step()), so dispatches and wakes count landings, as deltas over the step (Ops #425).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { corpusBinding, repository } from "./role-message-guard-acceptance/harness.mjs";
import { zeroEffects } from "./role-message-guard-acceptance/cases.mjs";

const dist = resolve(repository, "dist/server");
const load = (name) => import(pathToFileURL(join(dist, name)).href);
const { RoleMessages, roleMessageIdOf } = await load("role-messages.js");
const { RoleMessageGuardHost } = await load("role-message-guard-host.js");
const { AskHub } = await load("asks.js");

const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
const candidateCommit = git("rev-parse", "HEAD");
// The build must be of this commit: no uncommitted server source.
const dirty = git("status", "--porcelain", "--", "server");
const buildSha = sha256(
	[
		"role-messages.js",
		"role-message-guard-host.js",
		"role-message-guard-core.js",
		"role-message-guard-store.js",
		"role-message-guard-approvals.js",
	]
		.map((f) => readFileSync(join(dist, f), "utf8"))
		.join("\n") + candidateCommit,
);

const SUPPORTED = new Set([
	"ordinary-hop-1",
	"ordinary-hop-6",
	"no-grant-hop-7",
	"no-grant-hop-11",
	"owner-required-hop-12",
	"owner-required-hop-17",
	"lower-hop-7",
	"lower-hop-11",
	"lower-cannot-hop12",
	"owner-hop-12",
	"owner-hop-16",
	"owner-upperhop17",
	"lower-at11-rejects-five",
	...[0, 6, -1, 1.5, "5", "unlimited"].map((q) => `invalid-quantity-${String(q).replace(".", "_")}`),
	// grant-denied is NOT RUN: a native deny issues no grant to present; a later send is approval_required (stage-tested).
	"grant-exhausted",
	"grant-expired",
	"grant-wrong-root",
	"grant-wrong-parent",
	"grant-wrong-role",
	"grant-wrong-recipient",
	"grant-one-ms-before-expiry",
	"grant-not-sliding",
	"ordinary-20th-business",
	"ordinary-21st-business",
	"normal-window-exact-expiry",
	"normal-window-one-ms-short",
	"no-daily-or-root-message-cap",
	...[
		"auto_approved_queue_plan",
		"claimed_owner_prose",
		"standing_delegation",
		"timeout",
		"tool_result",
		"fyi_permission",
		"model_judgment",
	].map((c) => `no-permission-${c}`),
	...["fyi", "replyTo_omitted", "kind_changed", "text_changed", "control_roundtrip", "restart"].map(
		(v) => `preserved-causal-${v}`,
	),
	"causal-missing",
	"causal-pruned",
	"causal-contradictory",
	"legacy-marked-anchor",
	"legacy-anchor-without-grant",
	"rejected-send-does-not-use-grant",
	"counterfactual-new-synthetic-FE32-containment-terminal",
	"counterfactual-new-synthetic-H7-task-id-terminal",
]);
const AREAS = new Set(["ordinary", "counterfactual"]);
const ROLES = ["role-a", "role-b", "role-c", "coo", "unapproved-role"];
const CONTEXT = {
	goal: "finish the sealed hand-off",
	progressAndChanges: "fixture",
	priorDecisions: ["owner chose the ladder"],
	whyNeeded: "one more exchange",
	nextStepAndOutcome: "send and stop",
	outstandingQuestions: ["accepted?"],
	optionsAndTradeoffs: ["grant", "deny"],
	timeCostRisk: "none",
	exactCommunicationAuthority: "named roles only",
	declaredClaims: [],
	safetyScopeAndHolds: ["no hold changes"],
};

let idSeq = 0;
const newId = (seed) => `rm-${sha256(`${seed}-${++idSeq}-${process.pid}`).slice(0, 8)}`;

async function makeWorld(input, prev) {
	const w = prev ?? {
		dir: mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "v122-")),
		files: {},
		got: [],
		counts: { deliver: 0, note: 0 },
		boundary: [],
		barrier: false,
		now: input.clock.nowMs,
		names: new Map(),
	};
	if (!prev) {
		for (const r of ROLES) {
			w.files[r] = join(w.dir, `${r}.jsonl`);
			writeFileSync(w.files[r], `${JSON.stringify({ type: "session", version: 3, id: r, cwd: w.dir })}\n`);
		}
		w.roles = ROLES.map((id) => ({
			id,
			title: id.toUpperCase(),
			homeChat: w.files[id],
			pastHomeChats: [],
			raw: {},
			dir: join(w.dir, id),
		}));
		w.hub = new AskHub();
	}
	const clock = () => w.now;
	const host = {
		roles: () => w.roles,
		chatState: () => (w.barrier ? "working" : "idle"),
		deliver: async (file, text) => {
			if (w.barrier) atBoundary(w, { file, text, via: "deliver" });
			else land(w, { file, text, via: "deliver" });
			return { ok: true };
		},
		note: async (file, text) => {
			if (w.barrier) atBoundary(w, { file, text, via: "note" });
			else land(w, { file, text, via: "note" });
			return { ok: true };
		},
		log: () => {},
	};
	w.rm = new RoleMessages(join(w.dir, "data", "role-messages.json"), host, clock);
	w.host = new RoleMessageGuardHost({
		dir: join(w.dir, "data", "role-message-guard"),
		roleMessages: () => w.rm,
		identities: () => w.roles,
		askHub: w.hub,
		questionsChanged: () => {},
		log: () => {},
		now: clock,
	});
	return w;
}
/** Mail reaches the chat: a delivery as a user message (it starts a turn: a wake), an FYI as a no-turn note. */
function land(w, { file, text, via }) {
	if (via === "deliver") {
		w.counts.deliver++;
		w.got.push({ file, text });
		appendFileSync(
			file,
			`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
		);
		return;
	}
	w.counts.note++;
	appendFileSync(
		file,
		`${JSON.stringify({ type: "custom_message", customType: "role-message", content: [{ type: "text", text }], display: true })}\n`,
	);
}
/** A working chat's boundary FIFO, as server/role-mail-boundary.ts keeps it: one entry per role message and chat
 *  (a later note for the same message replaces it: a paused task's retry), landed in order at the boundary. */
function atBoundary(w, row) {
	const id = roleMessageIdOf(row.text);
	const at = id ? w.boundary.findIndex((p) => p.file === row.file && p.id === id) : -1;
	if (at < 0) w.boundary.push({ ...row, id });
	else if (row.via === "note") w.boundary[at] = { ...row, id };
}
const lastIn = (w, role) => [...w.got].reverse().find((g) => g.file === w.files[role])?.text ?? "";
const sender = (w, role, last) => ({
	role,
	title: role.toUpperCase(),
	chat: "home chat",
	file: w.files[role],
	handling: 0,
	guard: { bindingId: w.files[role], isHome: true, lastUserText: last },
});

/** A native record from `from` to `to` (history before the case), delivered unless it is an FYI. */
function seed(w, from, to, chain, extra = {}) {
	const id = extra.id ?? newId(`${from}-${to}-${chain}`);
	const s = sender(w, from, "");
	const draft = {
		kind: extra.kind ?? "request",
		text: extra.text ?? `history ${chain}`,
		to: { role: to, title: to.toUpperCase() },
		initiative: "",
	};
	const rec = w.rm.recordOf(s, draft, id, extra.at ?? w.now - 1000, chain, {
		target: w.files[to],
		...(extra.root ? { root: extra.root } : {}),
		...(extra.parent ? { parent: extra.parent } : {}),
	});
	w.rm.admit(rec);
	return id;
}
async function settle(w) {
	w.barrier = false;
	// The running turn completed: its boundary lands the mail admitted meanwhile, oldest first.
	const batch = w.boundary;
	w.boundary = [];
	for (const row of batch) land(w, row);
	await w.rm.tick();
	await w.rm.tick();
}
/** The text that landed for record `id` in `role`'s chat (what its next turn handles). */
const landed = (w, role, id) =>
	[...w.got].reverse().find((g) => g.file === w.files[role] && g.text.startsWith(`[Role message ${id} `))?.text;

/** Run `work` with the agent-facing approval notices switched off (V models the grant itself as effect-free;
 *  control notices are their own op in the corpus). */
async function quietly(w, work) {
	const agent = w.host.adapters.agent;
	const notify = agent.notify;
	agent.notify = async (ref, requestId, generation, phase) => {
		// The owner's question is not an agent message (question-only path): keep it.
		const r = (await w.host.state_())?.requests.find(
			(x) => x.binding.requestId === requestId && x.binding.generation === generation,
		);
		if (phase === "initial" && r?.binding.tier === "owner")
			return notify.call(agent, ref, requestId, generation, phase);
		return { state: "blocked", reason: "fixture_without_notice" };
	};
	try {
		return await work();
	} finally {
		agent.notify = notify;
	}
}
let tcSeq = 0;
const tc = (label) => `tc-${label}-${++tcSeq}`;

/** A grant through the native path: A request by `role` at `last`, then the selected approver answers. */
async function grantVia(w, role, last, recipients, { choice = "requested_quantity", quantity, notices = false } = {}) {
	const ask = () =>
		w.host.approval(
			sender(w, role, last),
			{ action: "request", recipients, context: CONTEXT, ...(quantity !== undefined ? { quantity } : {}) },
			tc("ask"),
		);
	const req = notices ? await ask() : await quietly(w, ask);
	if (!req.ok) throw new Error(`fixture request refused: ${req.text}`);
	const { requestId, tier } = req.details;
	if (tier === "owner") {
		const [q] = (await w.host.openQuestions()).filter(
			(x) => x.requestId === requestId || JSON.stringify(x).includes(requestId),
		);
		if (!q) throw new Error("fixture: owner question missing");
		const answer = () => w.host.ownerAnswer(q.questionId, q.generation, choice, "browser");
		const a = notices ? await answer() : await quietly(w, answer);
		if (!a.ok) throw new Error(`fixture owner answer refused: ${JSON.stringify(a)}`);
	} else {
		const decide = () =>
			w.host.approval(
				sender(w, "coo", lastIn(w, "coo")),
				{ action: "decide", requestId, generation: "1", choice, reason: "fixture" },
				tc("decide"),
			);
		const d = notices ? await decide() : await quietly(w, decide);
		if (!d.ok) throw new Error(`fixture decision refused: ${d.text}`);
	}
	await settle(w);
	const state = await w.host.state_();
	const r = state.requests.find((x) => x.binding.requestId === requestId);
	return { requestId, request: r, grantId: r?.grantId ?? null };
}

async function snapshot(w) {
	const state = await w.host.state_();
	return {
		records: w.rm.recent(0).length,
		ordinary: w.rm.recent(0).filter((m) => m.kind !== "report").length,
		grantUses: (state?.grants ?? []).reduce((n, g) => n + g.acceptedUses, 0),
		deliver: w.counts.deliver,
		note: w.counts.note,
		questions: (await w.host.openQuestions()).length,
		paused: w.rm.paused,
		transcripts: Object.fromEntries(ROLES.map((r) => [r, readFileSync(w.files[r], "utf8")])),
	};
}
function effectsOf(a, b) {
	return {
		...zeroEffects,
		legacyAppends: b.records - a.records,
		ordinaryUses: b.ordinary - a.ordinary,
		grantUses: b.grantUses - a.grantUses,
		dispatches: b.deliver + b.note - a.deliver - a.note,
		wakes: b.deliver - a.deliver,
		questionClears: Math.max(0, a.questions - b.questions),
		holdChanges: a.paused === b.paused ? 0 : 1,
	};
}

async function open(input, caseId) {
	if (!SUPPORTED.has(caseId)) throw new Error("unsupported");
	const w = await makeWorld(input);
	const actor = input.actor.role;
	const causal = input.causal;
	const variant = input.incomingVariant;
	// Older traffic: the hourly window and the "no daily or root cap" history.
	for (let i = 0; i < (input.ordinaryCount ?? 0); i++)
		seed(w, actor, "role-c", 1, { kind: "fyi", at: w.now - (input.usageAgeMs ?? 1000) });
	for (let i = 0; i < (input.priorDayAccepted ?? 0); i++)
		seed(w, actor, "role-c", 1, { kind: "fyi", at: w.now - 25 * 3600000 });
	for (let i = 0; i < (input.rootAccepted ?? 0); i++)
		seed(w, "role-b", "role-c", 1, { kind: "fyi", root: causal.rootId ?? "root-A", at: w.now - 2 * 3600000 });
	// The case's incoming message (where the actor's chat stands in its chain).
	let incoming = null;
	let caseLast = "";
	const hop = causal.kind === "legacy_boundary" ? causal.nextHop : causal.kind === "unknown" ? 7 : causal.nextHop;
	if (causal.kind === "legacy_boundary")
		incoming = seed(w, "role-b", actor, causal.depth); // legacy: no root
	else if (hop > 1)
		incoming = seed(w, "role-b", actor, hop - 1, { root: causal.rootId ?? "root-A", parent: "before-parent" });
	if (incoming) w.names.set(incoming, causal.parentId ?? "parent-A");
	await settle(w);
	await w.host.start();
	if (w.host.state.status !== "ready") throw new Error(`host not ready: ${JSON.stringify(w.host.state)}`);
	if (incoming) caseLast = landed(w, actor, incoming) ?? "";
	if (incoming && !caseLast) throw new Error("fixture: incoming not delivered");

	// The fixture grant, made natively.
	let grantId = null;
	const g = input.grant;
	if (g) {
		const recipients = g.recipients ?? input.scope.recipients;
		let at = caseLast;
		let by = actor;
		const inRange = g.tier === "lower" ? hop >= 7 && hop <= 11 : hop >= 12 && hop <= 16;
		if (g.root || g.parent) {
			// A separate anchor: another root, or another parent on the same root.
			const chain = g.tier === "lower" ? 6 : 11;
			const id = seed(w, "role-b", actor, chain, { root: g.root ?? causal.rootId ?? "root-A", parent: "other-parent" });
			await settle(w);
			at = landed(w, actor, id);
		} else if (!inRange) {
			// The case's hop is past what this tier can grant: the grant was made earlier on the same line (an
			// ancestor), and the case's incoming message descends from it.
			const chain = g.tier === "lower" ? 6 : 11;
			const anchor = seed(w, "role-b", actor, chain, { root: causal.rootId ?? "root-A", parent: "before-parent" });
			await settle(w);
			at = landed(w, actor, anchor);
			incoming = seed(w, "role-b", actor, hop - 1, { root: causal.rootId ?? "root-A", parent: anchor });
			w.names.set(incoming, causal.parentId ?? "parent-A");
			await settle(w);
			caseLast = landed(w, actor, incoming);
		}
		if (g.requester) {
			by = g.requester;
			const id = seed(w, "role-b", by, 6, { root: "root-C" });
			await settle(w);
			at = landed(w, by, id);
		}
		const made = await grantVia(w, by, at, recipients, {
			choice: g.state === "denied" ? "deny" : "requested_quantity",
			notices: variant === "control_roundtrip",
		});
		grantId = made.grantId ?? (g.state === "denied" ? `denied:${made.requestId}` : null);
		if (g.state === "denied") {
			const state = await w.host.state_();
			grantId = state.grants.find((x) => x.binding.requestId === made.requestId)?.id ?? null;
		}
		if (g.uses)
			for (let i = 0; i < g.uses; i++) {
				const r = await w.host.send(
					sender(w, actor, at),
					{ to: recipients[0], kind: "fyi", text: `use ${i + 1}` },
					tc("use"),
				);
				if (!r.ok) throw new Error(`fixture use refused: ${r.error}`);
			}
		if (variant === "control_roundtrip") caseLast = lastIn(w, actor); // the decision notice is the chat's last message
		if (g.ageMs) w.now += g.ageMs;
		if (variant === "restart") {
			w.rm.stop();
			w.host.stop();
			await makeWorld(input, w);
			await w.host.start();
		}
		await settle(w);
	}
	if (causal.kind === "unknown") {
		if (causal.source === "contradictory") caseLast = `${caseLast} (edited)`;
		else caseLast = caseLast.replace(incoming, newId("gone")); // missing / pruned: no such record
	}

	let observed = null;
	const session = {
		async act(command) {
			const before = await snapshot(w);
			w.barrier = true;
			let facts;
			const kind = variant === "kind_changed" ? "question" : variant === "fyi" ? "fyi" : input.businessKind;
			const text = `${command.operation ?? input.operationId}${input.permissionClaim ? ` (permission: ${input.permissionClaim})` : ""}${variant === "text_changed" ? " changed" : ""}`;
			const send = async (explicit) => {
				const who = command.actor ?? actor;
				const res = await w.host.send(
					sender(w, who, caseLast),
					{ to: command.to ?? input.destination, kind, text, ...(explicit ? { grant: explicit } : {}) },
					tc(command.operation ?? "send"),
				);
				return res;
			};
			if (command.op === "advance_then_send") w.now += command.advanceMs;
			if (command.op === "send" || command.op === "advance_then_send" || command.op === "fresh_explicit_send") {
				const res = await send(grantId);
				const state = await w.host.state_();
				const grant = grantId ? state.grants.find((x) => x.id === grantId) : null;
				const remainingUses = grant ? grant.maximumUses - grant.acceptedUses : undefined;
				const storedOrdinaryCount = w.rm.hourlyCount(command.actor ?? actor);
				if (res.ok) {
					const r = res.record;
					facts = {
						state: "accepted",
						class: r.guard ? "control" : "business",
						preservedHop: r.chain,
						rootId: r.root,
						parentId: w.names.get(r.parent) ?? r.parent,
						remainingUses,
						storedOrdinaryCount,
						...(r.root?.startsWith("legacy-")
							? { historicalRoot: "unknown", anchorStable: r.root === `legacy-${incoming}` }
							: {}),
					};
				} else {
					facts = {
						state: "blocked",
						reason: res.reason,
						requiredTier: res.approvalRequired?.tier,
						remainingUses,
						storedOrdinaryCount,
						pendingVisible: false,
					};
				}
			} else if (command.op === "proper_explicit_grant") {
				w.barrier = false;
				const made = await grantVia(w, actor, caseLast, input.scope.recipients, { choice: command.choice });
				w.barrier = true;
				grantId = made.grantId;
				facts = { state: "recorded", requestState: made.request?.state };
			} else if (command.op === "complete_request") {
				const res = await quietly(w, () =>
					w.host.approval(
						sender(w, actor, caseLast),
						{ action: "request", recipients: input.scope.recipients, context: CONTEXT, quantity: command.quantity },
						tc("ask"),
					),
				);
				const state = await w.host.state_();
				const r = res.ok ? state.requests.find((x) => x.binding.requestId === res.details.requestId) : null;
				facts = res.ok
					? { state: "recorded", requestState: r?.state, upperHop: r?.binding.upperHop }
					: { state: "blocked", reason: res.details?.reason ?? "not_asked" };
			} else {
				throw new Error(`unsupported op ${command.op}`);
			}
			const after = await snapshot(w);
			const rewritten = ROLES.filter((r) => !after.transcripts[r].startsWith(before.transcripts[r])).length;
			facts.effects = effectsOf(before, after);
			if (facts.historicalRoot) facts.transcriptsRewritten = rewritten;
			observed = facts;
		},
		async observe() {
			return {
				facts: observed,
				evidence: {
					nativePath: true,
					sourceCommit: candidateCommit,
					sha256: sha256(JSON.stringify(observed) + buildSha),
				},
			};
		},
		async close() {
			w.rm.stop();
			w.host.stop();
		},
	};
	return session;
}

export default {
	mode: "sealed_registered_native",
	candidateCommit,
	binding: corpusBinding(),
	supports: (id) => !dirty && SUPPORTED.has(id),
	evidenceFor: (area) =>
		AREAS.has(area) && !dirty ? { registered: true, fixtureOnly: false, sha256: buildSha } : null,
	open,
};
