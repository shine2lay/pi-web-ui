// role-reports: the app's 6 am report request (server/role-messages.ts kind "report", the control
// socket's role_report / role_reports, server/app-token.ts), with a fake host.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appTokenPath, ensureAppToken, isAppToken } from "../../server/app-token.js";
import { controlPath, startControlServer } from "../../server/control-socket.js";
import type { IdentityDef } from "../../server/identities.js";
import { CARRY_ON_PREFIX } from "../../server/running-chats.js";
import {
	ROLE_REPORT_HEADINGS,
	RoleMessages as RoleMessagesBase,
	reportDateProblem,
	reportHeadings,
	roleMessageIdOf,
	type RoleMessageHost,
	type RoleMessageSender,
} from "../../server/role-messages.js";

let dir = "";
let now = Date.parse("2026-10-04T12:00:00Z"); // tests run with TZ=UTC: today is 2026-10-04
const clock = () => now;
const MIN = 60_000;

const made: RoleMessagesBase[] = [];
class RoleMessages extends RoleMessagesBase {
	constructor(...args: ConstructorParameters<typeof RoleMessagesBase>) {
		super(...args);
		made.push(this);
	}
}

function chat(name: string): string {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: name, cwd: dir })}\n`);
	return file;
}
function say(file: string, role: "user" | "assistant", text: string): void {
	appendFileSync(
		file,
		`${JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } })}\n`,
	);
}
function toolCall(file: string): void {
	appendFileSync(
		file,
		`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] } })}\n`,
	);
	appendFileSync(
		file,
		`${JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "## Goal or hypothesis\n## Done yesterday\n## Learned\n## Next" }] } })}\n`,
	);
}
const role = (id: string, title: string, homeChat?: string): IdentityDef =>
	({
		id,
		title,
		homeChat,
		pastHomeChats: [],
		folder: undefined,
		raw: {},
		role: undefined,
		dir: join(dir, id),
	}) as unknown as IdentityDef;

interface Fake {
	host: RoleMessageHost;
	sent: Array<{ file: string; text: string }>;
	state: Map<string, "working" | "idle" | "closed">;
	roles: IdentityDef[];
	lines: string[];
}
function fake(roles: IdentityDef[]): Fake {
	const f: Fake = {
		sent: [],
		state: new Map(),
		roles,
		lines: [],
		host: {
			roles: () => f.roles,
			chatState: (file) => f.state.get(file) ?? "closed",
			deliver: async (file, text) => {
				f.sent.push({ file, text });
				say(file, "user", text);
				return { ok: true };
			},
			log: (line) => f.lines.push(line),
		},
	};
	return f;
}
const sender = (o: { role: string; file: string }): RoleMessageSender => ({
	title: o.role,
	chat: "home chat",
	handling: 0,
	...o,
});

const REPORT = [
	"## Goal or hypothesis",
	"Make the morning reports useful.",
	"## Done yesterday",
	"Built the job.",
	"## Learned",
	"Metadata is enough.",
	"## Next",
	"Watch the first run.",
].join("\n");

let A = "";
let B = "";
let store = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rolereport-unit-"));
	now = Date.parse("2026-10-04T12:00:00Z");
	A = chat("alpha-home");
	B = chat("beta-home");
	store = join(dir, "data", "role-messages.json");
});
afterEach(() => {
	for (const s of made.splice(0)) s.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("the request", () => {
	it("is asked once per role and day: asking again (a retry, a second run) returns the first", () => {
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B)]);
		const s = new RoleMessages(store, f.host, clock);
		const first = s.requestReport({
			role: "beta",
			date: "2026-10-03",
			activity: { messages: 12, chats: 2, queue: 3, log: 1 },
		});
		if (!first.ok) throw new Error(first.error);
		expect(first.existing).toBe(false);
		expect(first.record).toMatchObject({
			kind: "report",
			from: { role: "app", title: "the app" },
			to: { role: "beta" },
			state: "waiting",
		});
		expect(first.record.report).toEqual({ date: "2026-10-03", activity: { messages: 12, chats: 2, queue: 3, log: 1 } });
		const again = s.requestReport({ role: "BETA", date: "2026-10-03" });
		if (!again.ok) throw new Error(again.error);
		expect(again.existing).toBe(true);
		expect(again.record.id).toBe(first.record.id);
		// A restart reads the store: still the first.
		const restarted = new RoleMessages(store, f.host, clock);
		const third = restarted.requestReport({ role: "beta", date: "2026-10-03" });
		expect(third.ok && third.existing && third.record.id === first.record.id).toBe(true);
		expect(restarted.reportReceipts("2026-10-03")).toHaveLength(1);
		// Another day, another role: their own.
		const other = s.requestReport({ role: "alpha", date: "2026-10-03" });
		expect(other.ok && !other.existing).toBe(true);
		const dayBefore = s.requestReport({ role: "beta", date: "2026-10-02" });
		expect(dayBefore.ok && !dayBefore.existing).toBe(true);
	});

	it("refuses an unknown role, a role with no home chat, and a day that isn't over or too old or not a date", () => {
		const f = fake([role("alpha", "Alpha", A), role("nohome", "No home")]);
		const s = new RoleMessages(store, f.host, clock);
		const err = (input: Record<string, unknown>) => {
			const r = s.requestReport(input);
			return r.ok ? "ok" : r.error;
		};
		expect(err({ role: "nobody", date: "2026-10-03" })).toMatch(/no role "nobody"/);
		expect(err({ role: "nohome", date: "2026-10-03" })).toMatch(/no home chat/);
		expect(err({ role: "alpha", date: "2026-10-04" })).toMatch(/isn't over yet/);
		expect(err({ role: "alpha", date: "2026-10-05" })).toMatch(/isn't over yet/);
		expect(err({ role: "alpha", date: "2026-09-26" })).toMatch(/more than 7 days ago/);
		expect(err({ role: "alpha", date: "2026-02-30" })).toMatch(/not a date/);
		expect(err({ role: "alpha", date: "10/03/2026" })).toMatch(/YYYY-MM-DD/);
		expect(err({ role: "alpha" })).toMatch(/YYYY-MM-DD/);
		expect(err({ role: "alpha", date: "2026-09-27" })).toBe("ok");
		expect(s.reportReceipts()).toHaveLength(1);
	});

	it("checks days in local time (Pacific on the box): the day is over only at local midnight", () => {
		// TZ=UTC here; the rule itself is: date < today's local date, and today-7 or later.
		expect(reportDateProblem("2026-10-03", Date.parse("2026-10-04T00:00:00Z"))).toBeUndefined();
		expect(reportDateProblem("2026-10-03", Date.parse("2026-10-03T23:59:59Z"))).toMatch(/isn't over yet/);
		expect(reportDateProblem("2026-03-08", Date.parse("2026-03-09T13:00:00Z"))).toBeUndefined();
	});

	it("says what to read and the four headings; message_role can't send one or reply to one", () => {
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B)]);
		const s = new RoleMessages(store, f.host, clock);
		const r = s.requestReport({ role: "beta", date: "2026-10-03" });
		if (!r.ok) throw new Error(r.error);
		const text = r.record.text;
		expect(text).toContain("Saturday 2026-10-03");
		expect(text).toContain("~/.pi/agent/memory/daily/2026-10-03.md");
		expect(text).toContain("#beta");
		expect(text).toContain("queue_control");
		for (const h of ROLE_REPORT_HEADINGS) expect(text.split("\n")).toContain(h);
		const viaTool = s.send(sender({ role: "alpha", file: A }), { to: "beta", kind: "report", text: "do your report" });
		expect(viaTool.ok).toBe(false);
		const replyToIt = s.send(sender({ role: "beta", file: B }), {
			to: "alpha",
			kind: "reply",
			replyTo: r.record.id,
			text: "here",
		});
		expect(replyToIt.ok).toBe(false);
		if (!replyToIt.ok) expect(replyToIt.error).toMatch(/6 am report request/);
		// Report requests don't count against a role's hourly cap (they aren't the role's).
		expect(s.reportReceipts()).toHaveLength(1);
	});
});

describe("delivery", () => {
	it("a closed chat: opened and given the request once; the card is the app's", async () => {
		const f = fake([role("beta", "Beta", B)]);
		const s = new RoleMessages(store, f.host, clock);
		const r = s.requestReport({ role: "beta", date: "2026-10-03" });
		if (!r.ok) throw new Error(r.error);
		await s.tick(); // closed: deliver opens it (the fake lands it at once)
		expect(f.sent).toHaveLength(1);
		const text = f.sent[0].text;
		expect(text.startsWith(`[Role message ${r.record.id} from the app · 6 am report · 2026-10-03]`)).toBe(true);
		expect(roleMessageIdOf(text)).toBe(r.record.id);
		expect(s.byId(r.record.id)).toMatchObject({ state: "delivered", target: B, targetChat: "home chat" });
		expect(s.stampFor(B, text)).toMatchObject({
			id: r.record.id,
			kind: "report",
			from: "app",
			reportDate: "2026-10-03",
		});
		f.state.set(B, "working");
		await s.tick();
		await s.tick();
		expect(f.sent).toHaveLength(1);
	});

	it("a busy chat: the request waits for the running turn to end (never steered in)", async () => {
		const f = fake([role("beta", "Beta", B)]);
		f.state.set(B, "working");
		const s = new RoleMessages(store, f.host, clock);
		const r = s.requestReport({ role: "beta", date: "2026-10-03" });
		if (!r.ok) throw new Error(r.error);
		await s.tick();
		now += 10 * MIN;
		await s.tick();
		expect(f.sent).toHaveLength(0);
		expect(s.byId(r.record.id)?.state).toBe("waiting");
		f.state.set(B, "idle");
		await s.tick();
		expect(f.sent).toHaveLength(1);
		expect(s.byId(r.record.id)?.state).toBe("delivered");
	});

	it("a restart after the send landed but before the store said so: not sent again", async () => {
		const f = fake([role("beta", "Beta", B)]);
		f.state.set(B, "idle");
		const first = new RoleMessages(store, f.host, clock);
		const r = first.requestReport({ role: "beta", date: "2026-10-03" });
		if (!r.ok) throw new Error(r.error);
		await first.tick();
		expect(f.sent).toHaveLength(1);
		// The store as it was before the delivery was recorded (target fixed, sent once, not "delivered").
		const raw = JSON.parse(readFileSync(store, "utf8"));
		first.stop();
		raw.messages[0] = { ...raw.messages[0], state: "waiting", sends: 1 };
		delete raw.messages[0].deliveredAt;
		writeFileSync(store, JSON.stringify(raw));
		const again = new RoleMessages(store, f.host, clock);
		await again.tick();
		expect(f.sent).toHaveLength(1);
		expect(again.byId(r.record.id)?.state).toBe("delivered");
		// And the job's retry the same morning gets the same request back.
		const retry = again.requestReport({ role: "beta", date: "2026-10-03" });
		expect(retry.ok && retry.existing && retry.record.id === r.record.id).toBe(true);
		await again.tick();
		expect(f.sent).toHaveLength(1);
	});

	it("paused by the owner: held like any role message, sent after the resume", async () => {
		const f = fake([role("beta", "Beta", B)]);
		f.state.set(B, "idle");
		const s = new RoleMessages(store, f.host, clock);
		s.setPaused(true);
		const r = s.requestReport({ role: "beta", date: "2026-10-03" });
		expect(r.ok && r.paused).toBe(true);
		await s.tick();
		expect(f.sent).toHaveLength(0);
		s.setPaused(false);
		await s.tick();
		expect(f.sent).toHaveLength(1);
	});
});

describe("the receipt", () => {
	async function delivered(f: Fake, s: RoleMessages): Promise<string> {
		const r = s.requestReport({ role: "beta", date: "2026-10-03" });
		if (!r.ok) throw new Error(r.error);
		f.state.set(B, "idle");
		await s.tick();
		expect(s.byId(r.record.id)?.state).toBe("delivered");
		return r.record.id;
	}

	it("records the four headings once the chat's turn is over, and keeps no text", async () => {
		const f = fake([role("beta", "Beta", B)]);
		const s = new RoleMessages(store, f.host, clock);
		const id = await delivered(f, s);
		f.state.set(B, "working");
		toolCall(B); // a tool's result that happens to hold the headings doesn't count
		say(B, "assistant", "Reading yesterday's log first.");
		say(B, "assistant", REPORT);
		await s.tick();
		expect(s.reportReceipts()[0].reply).toBeUndefined(); // still working
		f.state.set(B, "idle");
		await s.tick();
		const [receipt] = s.reportReceipts("2026-10-03");
		expect(receipt).toMatchObject({ id, role: "beta", date: "2026-10-03", state: "replied", targetChat: "home chat" });
		expect(receipt.reply).toMatchObject({ answered: true, headings: true, missing: [], chars: REPORT.length });
		const saved = readFileSync(store, "utf8");
		expect(saved).not.toContain("Metadata is enough");
		expect(saved).not.toContain("Reading yesterday's log");
		expect(s.rows()[0]).toMatchObject({
			kind: "report",
			state: "replied",
			report: { date: "2026-10-03", headings: true },
		});
		expect(f.lines.some((l) => l.includes("answered with the four headings"))).toBe(true);
	});

	it("an answer without the four headings: final after the chat stayed idle a while, with what's missing", async () => {
		const f = fake([role("beta", "Beta", B)]);
		const s = new RoleMessages(store, f.host, clock);
		await delivered(f, s);
		say(B, "assistant", "## Goal or hypothesis\nx\n## Next\ny");
		await s.tick();
		expect(s.reportReceipts()[0].reply).toBeUndefined();
		now += 3 * MIN;
		await s.tick();
		expect(s.reportReceipts()[0].reply).toMatchObject({
			answered: true,
			headings: false,
			missing: ["## Done yesterday", "## Learned"],
		});
	});

	it("a restart's carry-on note doesn't end the answer; the owner's next message does", async () => {
		const f = fake([role("beta", "Beta", B)]);
		const s = new RoleMessages(store, f.host, clock);
		await delivered(f, s);
		f.state.set(B, "working");
		say(B, "assistant", "Starting.");
		say(B, "user", `${CARRY_ON_PREFIX} 06:03. Carry on.`);
		say(B, "assistant", REPORT);
		f.state.set(B, "idle");
		await s.tick();
		expect(s.reportReceipts()[0].reply).toMatchObject({ headings: true });

		const f2 = fake([role("beta", "Beta", A)]);
		const s2 = new RoleMessages(join(dir, "data2", "role-messages.json"), f2.host, clock);
		const r2 = s2.requestReport({ role: "beta", date: "2026-10-03" });
		if (!r2.ok) throw new Error(r2.error);
		f2.state.set(A, "idle");
		await s2.tick();
		say(A, "assistant", "No report today.");
		say(A, "user", "thanks");
		say(A, "assistant", REPORT); // after the owner's next message: not the answer
		await s2.tick();
		expect(s2.reportReceipts()[0].reply).toMatchObject({
			answered: true,
			headings: false,
			chars: "No report today.".length,
		});
	});

	it("no answer at all: recorded as not answered", async () => {
		const f = fake([role("beta", "Beta", B)]);
		const s = new RoleMessages(store, f.host, clock);
		const id = await delivered(f, s);
		now += 3 * MIN;
		await s.tick();
		await s.tick();
		const [receipt] = s.reportReceipts();
		expect(receipt).toMatchObject({ id, state: "delivered", reply: { answered: false, headings: false, chars: 0 } });
	});

	it("reads headings as their own lines, in order, any case", () => {
		expect(reportHeadings(REPORT)).toEqual({ headings: true, missing: [] });
		expect(reportHeadings(REPORT.toUpperCase())).toEqual({ headings: true, missing: [] });
		expect(reportHeadings("## Next\n## Learned\n## Done yesterday\n## Goal or hypothesis").headings).toBe(false);
		expect(reportHeadings("Goal or hypothesis: x. Done yesterday: y. Learned: z. Next: w.").missing).toHaveLength(4);
	});
});

describe("the control socket", () => {
	function ask(sock: string, req: Record<string, unknown>): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const c = createConnection(sock);
			let buf = "";
			c.on("connect", () => c.write(`${JSON.stringify(req)}\n`));
			c.on("data", (d) => {
				buf += d.toString();
				const nl = buf.indexOf("\n");
				if (nl >= 0) {
					c.destroy();
					resolve(JSON.parse(buf.slice(0, nl)));
				}
			});
			c.on("error", reject);
		});
	}
	async function listening(sock: string): Promise<void> {
		for (let i = 0; i < 100; i++) {
			try {
				statSync(sock);
				return;
			} catch {
				await new Promise((r) => setTimeout(r, 20));
			}
		}
		throw new Error("the control socket didn't start");
	}

	it("makes the app token once (0600) and checks it in constant time", () => {
		const data = join(dir, "tok");
		const t1 = ensureAppToken(data);
		expect(t1).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(appTokenPath(data)).mode & 0o777).toBe(0o600);
		expect(ensureAppToken(data)).toBe(t1);
		expect(isAppToken(t1, t1)).toBe(true);
		expect(
			isAppToken(
				t1.replace(/.$/, (c) => (c === "0" ? "1" : "0")),
				t1,
			),
		).toBe(false);
		expect(isAppToken(undefined, t1)).toBe(false);
		expect(isAppToken("", t1)).toBe(false);
	});

	it("takes role_report only with the app token; role_reports lists receipts without text", async () => {
		const data = mkdtempSync(join(tmpdir(), "rr-sock-"));
		try {
			const f = fake([role("beta", "Beta", B)]);
			const s = new RoleMessages(join(data, "role-messages.json"), f.host, clock);
			const token = ensureAppToken(data);
			const refused: string[] = [];
			const service = {
				serviceStatus: () => ({}) as never,
				quiesce: () => {},
				unquiesce: () => {},
				requestRoleReport: (input: { role?: unknown; date?: unknown; activity?: unknown }) => s.requestReport(input),
				roleReportReceipts: (date?: string) => s.reportReceipts(date),
				noteRoleReportRefused: (_r: unknown, _d: unknown, why: string) => void refused.push(why),
			};
			const stop = startControlServer({ service, dataDir: data, port: 0, appToken: token });
			try {
				const sock = controlPath(data, 0);
				await listening(sock);
				const none = await ask(sock, { cmd: "role_report", role: "beta", date: "2026-10-03" });
				expect(none).toMatchObject({ ok: false });
				expect(String(none.error)).toMatch(/only the app's report job/);
				const wrong = await ask(sock, { cmd: "role_report", token: "0".repeat(64), role: "beta", date: "2026-10-03" });
				expect(wrong.ok).toBe(false);
				expect(refused).toEqual(["no app token", "a wrong app token"]);
				expect(s.reportReceipts()).toHaveLength(0);
				const ok = await ask(sock, {
					cmd: "role_report",
					token,
					role: "beta",
					date: "2026-10-03",
					activity: { messages: 3 },
				});
				expect(ok).toMatchObject({
					ok: true,
					existing: false,
					receipt: { role: "beta", date: "2026-10-03", state: "waiting" },
				});
				const twice = await ask(sock, { cmd: "role_report", token, role: "beta", date: "2026-10-03" });
				expect(twice).toMatchObject({ ok: true, existing: true });
				expect((twice.receipt as { id: string }).id).toBe((ok.receipt as { id: string }).id);
				const bad = await ask(sock, { cmd: "role_report", token, role: "beta", date: "2026-10-04" });
				expect(bad).toMatchObject({ ok: false });
				const list = await ask(sock, { cmd: "role_reports", date: "2026-10-03" });
				expect(list.ok).toBe(true);
				expect(list.receipts).toHaveLength(1);
				expect(JSON.stringify(list)).not.toContain("daily log");
				expect(JSON.stringify(ok)).not.toContain(token);
			} finally {
				stop();
			}
		} finally {
			rmSync(data, { recursive: true, force: true });
		}
	});
});
