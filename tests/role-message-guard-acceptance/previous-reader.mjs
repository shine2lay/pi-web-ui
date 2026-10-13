import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { pins } from "./pins.mjs";
import { git, repository, requireSealed, sha256, verifyPins } from "./harness.mjs";

// Execute the actual git-pinned previous reader AND its repository import closure.
// No reimplementation, method patching, fabricated old guard, or candidate-policy import.
export async function loadPreviousReader() {
	requireSealed();
	verifyPins();
	const closure = new Map();
	const result = await build({
		entryPoints: ["__prior_reader__"], bundle: true, platform: "node", format: "esm", write: false,
		logLevel: "silent", plugins: [{
			name: "git-pinned-previous-reader",
			setup(builder) {
				builder.onResolve({ filter: /.*/ }, (args) => {
					if (args.path === "__prior_reader__") return { path: pins.previousReaderPath, namespace: "git-pin" };
					if (!args.path.startsWith(".")) return { path: import.meta.resolve(args.path), external: true };
					const path = posix.normalize(posix.join(posix.dirname(args.importer), args.path));
					if (path.startsWith("../") || path.startsWith("/")) throw new Error("V_OLD_SOURCE_ESCAPE");
					const alternatives = path.endsWith(".js") ? [path.slice(0, -3) + ".ts", path] : [path, `${path}.ts`, `${path}/index.ts`];
					for (const possible of alternatives) {
						try { git(["cat-file", "-e", `${pins.previousCommit}:${possible}`]); return { path: possible, namespace: "git-pin" }; } catch { /* Try exact alternate suffix. */ }
					}
					throw new Error("V_OLD_IMPORT_UNAVAILABLE");
				});
				builder.onLoad({ filter: /.*/, namespace: "git-pin" }, (args) => {
					const contents = git(["show", `${pins.previousCommit}:${args.path}`]);
					closure.set(args.path, sha256(contents));
					return { contents, loader: args.path.endsWith(".ts") ? "ts" : "js", resolveDir: dirname(join(repository, args.path)) };
				});
			},
		}],
	});
	let api;
	try {
		api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
	} catch { throw new Error("V_OLD_MODULE_LOAD_FAILED_REDACTED"); } // Never print a data-URL/source stack.
	return { api, closure: Object.fromEntries([...closure].sort(([a], [b]) => a.localeCompare(b))) };
}
const NOW = 1800000000000;
function record(index, fields = {}) {
	return { id: `rm-${index.toString(16).padStart(8, "0")}`, at: NOW - 1000,
		from: { role: "role-a", title: "Synthetic A", chat: index % 2 ? "home chat" : "Queue #1", file: "$sandbox/a.jsonl" },
		to: { role: "role-b", title: "Synthetic B" }, kind: "fyi", chain: 7,
		text: `Sealed synthetic word ${index}`, state: "delivered", sends: 1, attempts: 0, ...fields };
}
// Callback assertions use codes only so a failure never renders actual fixture bodies.
function check(condition, code) { if (!condition) throw new Error(code); }
export async function runPreviousReaderCases() {
	const { api, closure } = await loadPreviousReader();
	const root = mkdtempSync(join(tmpdir(), "guard-v-old-"));
	const instances = [];
	const results = [];
	function fixture(label, messages, extra = {}) {
		const dir = join(root, label);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "role-messages.json");
		const sidecar = join(dir, "guard-audit.json");
		writeFileSync(file, JSON.stringify({ v: 1, paused: false, messages, ...extra }));
		writeFileSync(sidecar, JSON.stringify({ transactions: ["accepted-A"], audits: ["decision-A"], revokedGrants: ["grant-A"] }));
		const a = join(dir, "a.jsonl"), b = join(dir, "b.jsonl");
		writeFileSync(a, ""); writeFileSync(b, "");
		const calls = { deliver: 0, note: 0 };
		const host = { roles: () => [{ id: "role-a", title: "Synthetic A", homeChat: a }, { id: "role-b", title: "Synthetic B", homeChat: b }],
			chatState: () => "idle", log: () => {},
			deliver: async (target, text) => { calls.deliver++; writeFileSync(target, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } }) + "\n", { flag: "a" }); return { ok: true }; },
			note: async (target, text) => { calls.note++; writeFileSync(target, JSON.stringify({ type: "custom_message", customType: "role-message", content: [{ type: "text", text }], display: true }) + "\n", { flag: "a" }); return { ok: true }; },
		};
		const service = new api.RoleMessages(file, host, () => NOW);
		instances.push(service);
		const sender = { role: "role-a", title: "Synthetic A", file: a, chat: "home chat", handling: 0 };
		return { file, sidecar, service, sender, calls };
	}
	function row(id, needs, assertions, hazard = false) {
		results.push({ id, state: "PASS", needs, assertions, hazard, previousCommit: pins.previousCommit });
	}
	try {
		check(api.ROLE_MESSAGE_CHAIN_MAX === 6 && api.ROLE_MESSAGES_PER_HOUR === 20, "V_OLD_POLICY_CHANGED");
		row("old-constants-hard6-hour20", ["P01", "P04", "L02"], 2);
		const post = [
			record(1, { chain: 12, guard: { class: "business", causal: { rootId: "root-A", parentId: "parent-A", nextHop: 12 } }, initiative: "synthetic-initiative", targetChat: "home chat", scanFrom: 0, hash: "synthetic-hash", forOwner: true, ownerIds: ["owner-native-A"], ownerChannel: "browser" }),
			record(2, { guard: { class: "control", requestId: "request-A", generation: "generation-A" } }),
			record(3, { kind: "request", state: "waiting", chain: 17, sends: 0, guard: { class: "protected", receipt: "native-receipt-A", producer: "producer-A", renderedBytes: 1024 } }),
		];
		const round = fixture("roundtrip", post, { grants: ["unsafe-top-level-grant"], usage: ["unsafe-top-level-usage"], protectedIncidents: ["unsafe-top-level-incident"] });
		const beforeSidecar = readFileSync(round.sidecar);
		for (const item of post) check(JSON.stringify(round.service.byId(item.id)) === JSON.stringify(item), "V_OLD_RECORD_LOAD_LOSS");
		round.service.setPaused(true); // Actual old save/load path, NOT a manual compatibility copy.
		const after = JSON.parse(readFileSync(round.file, "utf8"));
		check(JSON.stringify(after.messages) === JSON.stringify(post), "V_OLD_RECORD_SAVE_LOSS");
		check(!("grants" in after) && !("usage" in after) && !("protectedIncidents" in after), "V_OLD_TOPLEVEL_HAZARD_CHANGED");
		check(readFileSync(round.sidecar).equals(beforeSidecar), "V_OLD_SIDECAR_CHANGED");
		row("old-compatible-accepted-record-roundtrip", ["L01", "L02", "C03", "I03"], 4);
		row("old-drops-new-top-level-fields-hazard", ["L01", "D01", "D04"], 3, true);
		row("old-separate-audit-file-not-touched", ["L01", "L02"], 1); // NOT proof of atomic candidate-sidecar commits.

		const metered = fixture("metered", Array.from({ length: 19 }, (_, i) => record(i + 1, { guard: { class: i % 3 === 0 ? "protected" : i % 3 === 1 ? "control" : "business" } })));
		const twentieth = metered.service.send(metered.sender, { to: "role-b", kind: "fyi", text: "Sealed twentieth word" });
		check(twentieth.ok === true && twentieth.record.chain === 1, "V_OLD_TWENTIETH_NOT_ACCEPTED");
		const twentyFirst = metered.service.send(metered.sender, { to: "role-b", kind: "fyi", text: "Sealed twenty-first word" });
		check(twentyFirst.ok === false && twentyFirst.error.includes("the limit is 20"), "V_OLD_HOURLY_NOT_BLOCKED");
		check(JSON.parse(readFileSync(metered.file, "utf8")).messages.length === 20, "V_OLD_REJECTION_APPENDED");
		row("old-compatible-classes-count20-home-task", ["P04", "U02", "L01", "L02"], 3);

		const unsafe = fixture("unsafe-report", Array.from({ length: 20 }, (_, i) => record(i + 1, { kind: "report", report: { date: "2027-01-14" }, guard: { class: "control" } })));
		const laundering = unsafe.service.send(unsafe.sender, { to: "role-b", kind: "fyi", text: "Sealed accounting near miss" });
		check(laundering.ok === true, "V_OLD_REPORT_ACCOUNTING_HAZARD_CHANGED");
		row("old-report-kind-launders-agent-accounting-hazard", ["P04", "L01", "L03"], 1, true);

		for (const [label, kind] of [["synthetic-FE32-containment-terminal", "fyi"], ["synthetic-H7-task-id-terminal", "request"]]) {
			const terminal = fixture(label, []);
			const denied = terminal.service.send({ ...terminal.sender, handling: 6 }, { to: "role-b", kind, text: `Sealed ${label}` });
			check(denied.ok === false && denied.error.includes("message 7") && denied.error.includes("the limit is 6"), "V_OLD_SEVENTH_NOT_REFUSED");
			check(terminal.service.rows().length === 0 && terminal.calls.deliver === 0 && terminal.calls.note === 0, "V_OLD_TERMINAL_REFUSAL_SIDE_EFFECT");
			row(`old-counterfactual-${label}`, ["L04", "W04"], 2);
		}
		const noWake = fixture("fyi-no-wake", []);
		const sent = noWake.service.send(noWake.sender, { to: "role-b", kind: "fyi", text: "Sealed FYI word" });
		check(sent.ok, "V_OLD_FYI_REFUSED");
		await noWake.service.tick();
		check(noWake.calls.note === 1 && noWake.calls.deliver === 0 && noWake.service.byId(sent.record.id).state === "delivered", "V_OLD_FYI_WAKE_OR_DUPLICATE");
		await noWake.service.tick();
		check(noWake.calls.note === 1, "V_OLD_FYI_REDELIVERED");
		row("old-fyi-note-no-turn-dedup", ["W02", "I03"], 3);
		return { state: "PASS", candidateCompatibility: "NOT RUN", results, closure,
			closureSha256: sha256(JSON.stringify(closure)), sourceCommit: pins.previousCommit,
			limits: ["Synthetic compatible records only; no candidate serializer tested", "Top-level loss and report-kind hourly bypass are real baseline hazards", "Untouched sidecar is not proof of atomic legacy publication"] };
	} finally {
		for (const instance of instances) instance.stop();
		rmSync(root, { recursive: true, force: true }); // Only this exact synthetic mkdtemp tree.
	}
}
