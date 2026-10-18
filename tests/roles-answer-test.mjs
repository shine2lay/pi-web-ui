/* roles-answer: sealed native question -> Roles -> AskHub -> owner record, native stuck task and plan
 * confirmation. Real pi-queue, fake model, Chrome and axe; no live data or paid model. The fake model
 * never inspects a request body. Output is fixed labels and counts, never model inputs or tool results.
 * Run after build: scripts/sealed.sh node tests/roles-answer-test.mjs
 * ROLES_ANSWER_SHOTS may name a directory for synthetic desktop/phone screenshots.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
if (!process.env.PI_SEALED) throw new Error("Run with scripts/sealed.sh");
const homeDir = userInfo().homedir;
const queuePackage = process.env.PI_QUEUE_PKG ?? join(homeDir, "projects/pi-queue");
const axe = process.env.PI_AXE_JS ?? join(homeDir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
if (!CHROME_PATH || !existsSync(axe) || !existsSync(queuePackage))
	throw new Error("Chrome, axe and pi-queue are required");
const { ownerAnswer, dialogCheck } = await tsImport(
	pathToFileURL(join(queuePackage, "owner-record.ts")).href,
	import.meta.url,
);
const { replay } = await tsImport(pathToFileURL(join(queuePackage, "queue.ts")).href, import.meta.url);
const shots = process.env.ROLES_ANSWER_SHOTS;
const onlyStuck = process.env.ROLES_ANSWER_CASE === "stuck";
const now = Date.now();
let home, task, identities, work;
let mode = "idle",
	called = false,
	completed = 0,
	failures = 0,
	pageErrors = 0;
const checks = [];
const check = (name, ok) => {
	checks.push({ name, ok: !!ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 30000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await sleep(100);
	}
	return false;
}
const plan = {
	title: "Fixture plan",
	goal: "Prove the page can approve this complete plan",
	done_when: "The plan exists after its owner approves it",
	decided: "Fixture only; lead ops; do not start the task",
	steps: "Read the complete plan and approve it in the fixture page",
	verify: "The fixture queue contains the approved plan",
	must_not: "Touch live files, use a real model or start any task",
	standalone: true,
	touches: [],
};
const body =
	"The whole package: goal, progress, prior decisions, cost $0, time one minute, risks none outside the fixture, and exactly what this answer authorises. <b>Not rendered as HTML</b>";
function seed({ root, agentDir, workdir }) {
	const settings = join(agentDir, "settings.json");
	writeFileSync(
		settings,
		JSON.stringify({
			...JSON.parse(readFileSync(settings, "utf8")),
			packages: [queuePackage],
			compaction: { enabled: false },
		}),
	);
	writeFileSync(join(agentDir, "pi-queue.json"), JSON.stringify({ stalledAfterMinutes: 0 }));
	const sessions = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessions, { recursive: true });
	home = join(sessions, "2026-10-17T00-00-00-000Z_01a0f000-0000-7000-8000-000000000001.jsonl");
	task = join(sessions, "2026-10-17T00-00-01-000Z_01a0f000-0000-7000-8000-000000000002.jsonl");
	const savedPlan = {
		title: "Fixture waiting task",
		goal: "Fixture",
		doneWhen: "Answered",
		decided: "Either word",
		steps: "Wait",
		verify: "Done",
		mustNot: "Touch live state",
	};
	function transcript(file, id, ops) {
		let parentId = null;
		const lines = [{ type: "session", version: 3, id, timestamp: new Date(now).toISOString(), cwd: workdir }];
		const append = (entry) => {
			const row = { id: `f${lines.length}`, parentId, timestamp: new Date(now).toISOString(), ...entry };
			lines.push(row);
			parentId = row.id;
		};
		append({ type: "model_change", provider: "mock", modelId: "mock-model" });
		for (const op of ops) append({ type: "custom", customType: "queue", data: { v: 1, ts: now, ...op } });
		writeFileSync(file, `${lines.map((row) => JSON.stringify(row)).join("\n")}\n`);
		return lines;
	}
	transcript(home, "01a0f000-0000-7000-8000-000000000001", [
		{ op: "add", id: 1, plan: savedPlan, standalone: true },
		{ op: "start", id: 1, lane: true },
		{ op: "chat", id: 1, file: task, title: "Fixture task chat" },
		{ op: "stuck", id: 1, question: "Fixture task: alpha or beta?", choices: ["alpha", "beta"], detail: body },
	]);
	const child = transcript(task, "01a0f000-0000-7000-8000-000000000002", [
		{ op: "assigned", id: 1, plan: savedPlan, standalone: true, from: { file: home, title: "Fixture home" } },
		{ op: "stuck", id: 1, question: "Fixture task: alpha or beta?", choices: ["alpha", "beta"], detail: body },
	]);
	const childQueue = replay(child);
	if (childQueue.from?.file !== home || childQueue.tasks[0]?.status !== "stuck")
		throw new Error("fixture child must be assigned to its parent and waiting");
	identities = join(root, "identities");
	work = join(agentDir, "work");
	mkdirSync(join(identities, "ops"), { recursive: true });
	writeFileSync(
		join(identities, "ops", "identity.json"),
		JSON.stringify({ id: "ops", title: "Fixture Ops", homeChat: home }),
	);
	writeFileSync(join(identities, "ops", "about.md"), "# Fixture Ops\n");
	writeFileSync(join(identities, "ops", "notebook.md"), "");
}
const srv = await ownServer({
	name: "roles-answer",
	prepare: seed,
	mock: ({ sideRequest, toolResult }) => {
		if (sideRequest) return "Fixture";
		if (toolResult) {
			completed++;
			return "Fixture operation finished.";
		}
		if (called) return "Fixture idle.";
		called = true;
		if (mode === "question")
			return {
				tool: "ask_user_question",
				args: {
					questions: [
						{
							id: "pick",
							header: "Fixture task #1",
							question: "Fixture question: alpha or beta?",
							detail: body,
							options: [
								{ label: "alpha", description: "Fixture choice costs $0", preview: "<em>Plain preview</em>" },
								{ label: "beta" },
							],
						},
					],
				},
			};
		if (mode === "finish")
			return { tool: "queue_done", args: { summary: "Fixture task recorded alpha from the owner." } };
		if (mode === "plan") return { tool: "queue_add", args: plan };
		return "Fixture idle.";
	},
	env: {
		PI_WEB_TOKEN: "",
		PI_QUEUE_TEST_FAST: "1",
		PI_IDENTITY_REINDEX: "0",
		get PI_IDENTITY_DIR() {
			return identities;
		},
		get PI_WORK_DIR() {
			return work;
		},
	},
});
let browser, socket;
const hardStop = setTimeout(() => {
	console.error("FAIL bounded fixture timeout");
	process.exitCode = 1;
	void srv.stop();
}, 240000);
hardStop.unref();
let state = {},
	roles = null;
const replies = new Map();
let seq = 0;
const send = (message) => socket.send(JSON.stringify(message));
async function request(message, type) {
	const reqId = `fixture-${++seq}`;
	send({ ...message, reqId });
	if (!(await until(() => replies.has(`${type}:${reqId}`)))) throw new Error("fixture request timeout");
	return replies.get(`${type}:${reqId}`);
}
const records = () => {
	const path = join(srv.dataDir, "decisions/records.jsonl");
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((s) => JSON.parse(s))
		: [];
};
try {
	socket = new WebSocket(srv.ws);
	socket.on("message", (data) => {
		const msg = JSON.parse(String(data));
		// Project app metadata only. Never keep any model request or chat content.
		if (msg.type === "snapshot" || msg.type === "snapshot_delta") {
			for (const key of ["sessionFile", "conversationId", "isStreaming", "taskQueue"])
				if (key in msg.state) state[key] = msg.state[key];
		}
		if (msg.type === "roles") roles = msg.overview;
		if (msg.type === "roles_ask" || msg.type === "roles_ask_result") replies.set(`${msg.type}:${msg.reqId}`, msg);
	});
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	send({ type: "hello", clientId: "roles-answer-fixture", locale: "en" });
	if (!(await until(() => state.conversationId))) throw new Error("fixture did not start");
	send({ type: "switch_session", path: home });
	if (!(await until(() => state.sessionFile === home))) throw new Error("fixture home did not open");
	send({ type: "roles_watch", full: true });
	if (!(await until(() => roles?.roles?.length === 1))) throw new Error("fixture roster unavailable");
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
	const page = await context.newPage();
	page.on("pageerror", () => {
		pageErrors++;
	});
	await page.goto(`${srv.http}/?view=roles`);
	const frame = page.frameLocator('iframe[title="Roles"]');
	await frame.locator('button[aria-haspopup="dialog"]').first().waitFor();
	check("the supplied Roles design remains mounted", (await frame.locator("[data-boxgrid]").count()) === 1);
	const panel = frame.locator('[role="region"]');
	const clickAnswer = async (text) => {
		if (typeof text !== "string") throw new Error("fixture ask label missing");
		if (!(await panel.count()))
			await frame.getByRole("button", { name: "You: open your decisions, questions and spending" }).click();
		// Observe settlement from the host: the frame intentionally cannot execute timers/scripts.
		await page.waitForFunction(() => {
			const region = document.querySelector('iframe[title="Roles"]')?.contentDocument?.querySelector('[role="region"]');
			return region?.style.overflowY === "auto";
		});
		await panel
			.locator("p")
			.filter({ hasText: text })
			.locator("..")
			.getByRole("button", { name: "Answer", exact: true })
			.click();
	};
	const dialog = page.locator("dialog.roles-answer");
	if (!onlyStuck) {
		mode = "question";
		called = false;
		const before = completed;
		send({ type: "prompt", text: "Fixture question" });
		if (!(await until(() => roles?.asks?.some((a) => a.kind === "question" && a.askId))))
			throw new Error("fixture question not listed");
		const question = roles.asks.find((a) => a.kind === "question" && a.askId);
		const opened = await request({ type: "roles_ask_open", key: question.key }, "roles_ask");
		check("native question opens completely", opened.ok && opened.ask.fields[0].detail === body);
		await clickAnswer(question.text);
		await dialog.getByText("Fixture question: alpha or beta?", { exact: true }).waitFor();
		check(
			"markup and previews stay plain text",
			(await dialog.locator("b,em,img").count()) === 0 &&
				(await dialog.textContent()).includes("<em>Plain preview</em>"),
		);
		check(
			"no answer is selected",
			(await dialog.locator("input:checked").count()) === 0 &&
				(await dialog.getByRole("button", { name: "Send answer", exact: true }).isDisabled()),
		);
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await dialog.waitFor({ state: "hidden" });
		check(
			"closing the page form sends no answer",
			completed === before && roles.asks.some((a) => a.key === question.key),
		);
		await clickAnswer(question.text);
		await dialog.getByText("Fixture question: alpha or beta?", { exact: true }).waitFor();
		for (const [label, width, height] of [
			["desktop", 1440, 1000],
			["phone", 390, 844],
		]) {
			await page.setViewportSize({ width, height });
			await page.addScriptTag({ path: axe });
			const counts = await page.evaluate(async () => {
				const r = await window.axe.run(document.querySelector("dialog.roles-answer"), {
					runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
				});
				return {
					violations: r.violations.length,
					overflow:
						document.querySelector("dialog.roles-answer").scrollWidth >
						document.querySelector("dialog.roles-answer").clientWidth + 1,
				};
			});
			check(
				`${label}: no accessibility violations or horizontal overflow`,
				counts.violations === 0 && !counts.overflow,
			);
			if (shots) {
				mkdirSync(shots, { recursive: true });
				await page.screenshot({ path: join(shots, `${label}.png`) });
			}
		}
		await dialog.locator("input[type=radio]").first().check();
		await dialog.getByRole("button", { name: "Send answer", exact: true }).click();
		await dialog.getByText("Answer sent.", { exact: false }).waitFor();
		check("native question resumes", await until(() => completed > before));
		// The native recorder resolves the chat's role asynchronously after AskHub settles.
		const recorded = await until(() => records().some((r) => r.source === "answer" && r.title === "Fixture task #1"));
		const record = records().find((r) => r.source === "answer" && r.title === "Fixture task #1");
		check(
			"owner answer recorded once in browser",
			recorded &&
				!!record &&
				record.answeredIn === "browser" &&
				record.from === "owner" &&
				records().filter((r) => r.id === record.id).length === 1,
		);
		const facts = { task: 1, stuck: now, chatFile: home };
		const receipt = record ? ownerAnswer(join(srv.dataDir, "decisions/records.jsonl"), record.id, facts) : null;
		const entries = readFileSync(home, "utf8")
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s));
		check(
			"real pi-queue accepts record and matching dialog receipt",
			!!receipt && "answer" in receipt && dialogCheck(receipt.answer, entries, facts) === undefined,
		);
		const again = await request(
			{
				type: "roles_ask_answer",
				key: question.key,
				askId: opened.ask.id,
				revision: opened.ask.revision,
				answers: [{ id: "pick", selected: ["beta"] }],
			},
			"roles_ask_result",
		);
		check("late second answer is refused", again.ok === false);
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
	}
	mode = "finish";
	called = false;
	await clickAnswer(roles.asks.find((a) => a.kind === "task")?.text);
	await dialog.locator("input[type=radio]").first().waitFor();
	check("stuck task shows full owner package", (await dialog.textContent()).includes(body));
	await dialog.locator("input[type=radio]").first().check();
	await dialog.getByRole("button", { name: "Send answer", exact: true }).click();
	await dialog.getByText("Answer sent.", { exact: false }).waitFor();
	check("native task finishes after the page answer", await until(() => roles?.roles?.[0]?.queue?.counts?.done >= 1));
	const childDone = replay(
		readFileSync(task, "utf8")
			.trim()
			.split("\n")
			.map((row) => JSON.parse(row)),
	);
	check("child queue records done", childDone.tasks[0]?.status === "done");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	if (!onlyStuck) {
		mode = "plan";
		called = false;
		send({ type: "prompt", text: "Fixture plan" });
		if (!(await until(() => roles?.asks?.some((a) => a.kind === "question" && a.askId))))
			throw new Error("fixture plan not listed");
		const planAsk = roles.asks.find((a) => a.kind === "question" && a.askId);
		const planView = await request({ type: "roles_ask_open", key: planAsk.key }, "roles_ask");
		check(
			"plan is a native confirmation with all seven fields",
			planView.ok &&
				planView.ask.kind === "dialog" &&
				Object.values(plan)
					.filter((v) => typeof v === "string")
					.every((v) => planView.ask.body?.includes(v)),
		);
		await clickAnswer(planAsk.text);
		await dialog.getByRole("radio", { name: "Yes", exact: true }).check();
		await dialog.getByRole("button", { name: "Send answer", exact: true }).click();
		await dialog.getByText("Answer sent.", { exact: false }).waitFor();
		check(
			"approved plan reaches native queue but does not start",
			await until(() => state.taskQueue?.tasks?.some((t) => t.plan.title === plan.title && t.status === "ready")),
		);
	}
	check("no page errors", pageErrors === 0);
} catch (err) {
	failures++;
	console.error(`FAIL fixture stopped: ${err instanceof Error ? err.message.split("\n")[0] : "unknown error"}`);
} finally {
	clearTimeout(hardStop);
	socket?.close();
	await browser?.close();
	await srv.stop();
	rmSync(srv.root, { recursive: true, force: true });
	console.log(
		`roles-answer: ${checks.length - checks.filter((c) => !c.ok).length}/${checks.length} checks; ${failures} failures`,
	);
	if (failures) process.exitCode = 1;
}
