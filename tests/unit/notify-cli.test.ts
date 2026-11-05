/**
 * notify-cli (Ops #783): `pi-web-ui notify telegram|role`. Option checks and exit codes against a fake
 * socket (nothing is sent on bad input), text from stdin, the token never printed, the role notice is
 * script_notice's own request; then the whole way through a real control socket and askControl.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAppToken, readAppToken } from "../../server/app-token.js";
import { askControl, controlPath, type ControlOutcome } from "../../server/control-client.js";
import { startControlServer } from "../../server/control-socket.js";
import { NOTIFY_EXIT, NOTIFY_TIMEOUT_MS, runNotify, type NotifyIo } from "../../server/notify-cli.js";
import type { OwnerTelegramResult } from "../../server/owner-telegram.js";

const TOKEN = "ab".repeat(32);
const TEXT = "Deployed rollcall 1a2b3c4 (health check passed)";

/** A fake world: the token file, the socket's answer and stdin; records what was asked and printed. */
function fakeIo(over: { answer?: ControlOutcome; token?: string | null; stdin?: string; env?: NotifyIo["env"] } = {}) {
	const asked: { path: string; request: Record<string, unknown>; timeoutMs: number }[] = [];
	const tokenDirs: string[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const io: NotifyIo = {
		env: over.env ?? { PI_WEB_DATA_DIR: "/data/pi" },
		readStdin: async () => over.stdin ?? "",
		readToken: (dir) => {
			tokenDirs.push(dir);
			return over.token === null ? undefined : (over.token ?? TOKEN);
		},
		socketPath: (dir, port) => `${dir}/sock:${port}`,
		ask: async (path, request, timeoutMs) => {
			asked.push({ path, request, timeoutMs });
			return over.answer ?? { state: "answered", answer: { ok: true, messageIds: [901] } };
		},
		out: (l) => out.push(l),
		err: (l) => err.push(l),
	};
	return { io, asked, tokenDirs, out, err };
}

const ROLE = [
	"role",
	"--to",
	"ops",
	"--kind",
	"fyi",
	"--text",
	TEXT,
	"--sender-id",
	"rollcall-cd",
	"--sender-title",
	"RollCall CD",
];

describe("pi-web-ui notify: input checks (exit 2, nothing sent)", () => {
	const cases: [string, string[], RegExp][] = [
		["no kind of notice", [], /say telegram or role/],
		["an unknown kind", ["email", "--text", "x"], /unknown kind of notice "email"/],
		["telegram without --text", ["telegram"], /telegram needs --text/],
		["an option the kind doesn't take", ["telegram", "--text", "x", "--to", "ops"], /telegram takes no option --to/],
		["a word without an option", ["telegram", "hello"], /unexpected "hello"/],
		["an option twice", ["telegram", "--text", "a", "--text=b"], /--text is given twice/],
		["an option with no value", ["telegram", "--text"], /--text needs a value/],
		["blank text", ["telegram", "--text", "   "], /^pi-web-ui notify: text is required/],
		[
			"role without its required options",
			["role", "--to", "ops", "--text", "x"],
			/role needs --kind, --sender-id, --sender-title/,
		],
		[
			"a role kind script notices don't take",
			ROLE.map((a) => (a === "fyi" ? "alert" : a)),
			/^pi-web-ui notify: --kind /,
		],
		["an empty role id", ROLE.map((a) => (a === "ops" ? "" : a)), /^pi-web-ui notify: --to must be a role id/],
		["a bad sender id", ROLE.map((a) => (a === "rollcall-cd" ? "Roll Call" : a)), /^pi-web-ui notify: --sender-id /],
		["a bad key", [...ROLE, "--key", "a\nb"], /^pi-web-ui notify: --key /],
	];
	for (const [name, argv, want] of cases)
		it(name, async () => {
			const f = fakeIo();
			expect(await runNotify(argv, f.io)).toBe(NOTIFY_EXIT.badInput);
			expect(f.err[0]).toMatch(want);
			expect(f.asked).toHaveLength(0);
			expect(f.tokenDirs).toHaveLength(0);
			expect(f.out).toHaveLength(0);
		});

	it("--help prints the usage with the exit codes and sends nothing", async () => {
		for (const argv of [["--help"], ["telegram", "--help"], ["role", "-h"]]) {
			const f = fakeIo();
			expect(await runNotify(argv, f.io)).toBe(NOTIFY_EXIT.sent);
			expect(f.out.join("\n")).toContain("Exit 0 sent · 2 bad input · 3 refused by the server · 4 server unreachable");
			expect(f.asked).toHaveLength(0);
		}
	});
});

describe("pi-web-ui notify: what it sends", () => {
	it("telegram: telegram_send with the app token it read itself; prints the message id", async () => {
		const f = fakeIo();
		const argv = ["telegram", "--text", TEXT, "--from", "RollCall CD", "--url=/s/1", "--link-label", "Look"];
		expect(await runNotify(argv, f.io)).toBe(NOTIFY_EXIT.sent);
		expect(f.tokenDirs).toEqual(["/data/pi"]);
		expect(f.asked).toEqual([
			{
				path: "/data/pi/sock:8787",
				request: {
					cmd: "telegram_send",
					text: TEXT,
					from: "RollCall CD",
					url: "/s/1",
					linkLabel: "Look",
					token: TOKEN,
				},
				timeoutMs: NOTIFY_TIMEOUT_MS.telegram,
			},
		]);
		expect(f.out).toEqual(["901"]);
		expect(f.err).toEqual([]);
	});

	it("role: script_notice's own request (kind fyi|request), prints the id and duplicate", async () => {
		const f = fakeIo({ answer: { state: "answered", answer: { ok: true, id: "rm-1234abcd", duplicate: true } } });
		expect(await runNotify([...ROLE, "--key", "deploy-1a2b3c4", "--data-dir", "/other"], f.io)).toBe(NOTIFY_EXIT.sent);
		expect(f.asked).toEqual([
			{
				path: "/other/sock:8787",
				request: {
					cmd: "script_notice",
					role: "ops",
					kind: "fyi",
					sender: { id: "rollcall-cd", title: "RollCall CD" },
					text: TEXT,
					key: "deploy-1a2b3c4",
					token: TOKEN,
				},
				timeoutMs: NOTIFY_TIMEOUT_MS.role,
			},
		]);
		expect(f.out).toEqual(["rm-1234abcd duplicate=true"]);
		const g = fakeIo({ answer: { state: "answered", answer: { ok: true, id: "rm-5678abcd", duplicate: false } } });
		expect(
			await runNotify(
				ROLE.map((a) => (a === "fyi" ? "request" : a)),
				g.io,
			),
		).toBe(NOTIFY_EXIT.sent);
		expect(g.asked[0].request).toMatchObject({ cmd: "script_notice", kind: "request" });
		expect(g.asked[0].request).not.toHaveProperty("key");
		expect(g.out).toEqual(["rm-5678abcd duplicate=false"]);
	});

	it("--text - reads the text from stdin, trailing line breaks dropped", async () => {
		const f = fakeIo({ stdin: `${TEXT}\nsecond line\n\n` });
		expect(await runNotify(["telegram", "--text", "-"], f.io)).toBe(NOTIFY_EXIT.sent);
		expect(f.asked[0].request.text).toBe(`${TEXT}\nsecond line`);
		const empty = fakeIo({ stdin: "\n" });
		expect(await runNotify(["telegram", "--text", "-"], empty.io)).toBe(NOTIFY_EXIT.badInput);
		expect(empty.asked).toHaveLength(0);
	});

	it("the data dir: --data-dir, else PI_WEB_DATA_DIR, else ~/.pi-web (as the server); --port for the pipe name", async () => {
		const f = fakeIo({ env: {} });
		await runNotify(["telegram", "--text", "x", "--port", "9000"], f.io);
		expect(f.tokenDirs[0]).toMatch(/[\\/]\.pi-web$/);
		expect(f.asked[0].path.endsWith(".pi-web/sock:9000")).toBe(true);
	});
});

describe("pi-web-ui notify: exit codes when it isn't sent", () => {
	const cases: [string, Parameters<typeof fakeIo>[0], number, RegExp][] = [
		["no app token", { token: null }, NOTIFY_EXIT.unreachable, /^pi-web-ui notify: not sent: no app token in /],
		[
			"the server isn't running",
			{ answer: { state: "unreachable", why: "ENOENT" } },
			NOTIFY_EXIT.unreachable,
			/^pi-web-ui notify: not sent: the server isn't reachable at .* \(ENOENT\); is pi-web-ui running\?$/,
		],
		[
			"the server refused it",
			{ answer: { state: "answered", answer: { ok: false, error: "not sent: Telegram is off in its settings" } } },
			NOTIFY_EXIT.refused,
			/^pi-web-ui notify: not sent: not sent: Telegram is off in its settings$/,
		],
		[
			"the server refused it, but it may have gone out",
			{ answer: { state: "answered", answer: { ok: false, error: "Telegram refused it: 429", maybeSent: true } } },
			NOTIFY_EXIT.maybeSent,
			/^pi-web-ui notify: unknown: Telegram refused it: 429; it may have been sent/,
		],
		[
			"no answer after sending",
			{ answer: { state: "no-answer", why: "no answer within 150 s" } },
			NOTIFY_EXIT.maybeSent,
			/^pi-web-ui notify: unknown: no answer within 150 s; it may have been sent/,
		],
	];
	for (const [name, over, code, want] of cases)
		it(name, async () => {
			const f = fakeIo(over);
			expect(await runNotify(["telegram", "--text", TEXT], f.io)).toBe(code);
			expect(f.err).toHaveLength(1);
			expect(f.err[0]).toMatch(want);
			expect(f.out).toEqual([]);
			expect(f.asked.length).toBeLessThanOrEqual(1);
			const printed = [...f.out, ...f.err].join("\n");
			expect(printed).not.toContain(TOKEN);
			expect(printed).not.toContain(TEXT);
		});
});

describe("pi-web-ui notify through a real control socket", () => {
	let data: string;
	beforeEach(() => {
		data = mkdtempSync(join(tmpdir(), "notify-cli-"));
		for (const level of ["log", "warn"] as const) vi.spyOn(console, level).mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(data, { recursive: true, force: true });
	});
	function realIo(stdin = "") {
		const out: string[] = [];
		const err: string[] = [];
		const io: NotifyIo = {
			env: { PI_WEB_DATA_DIR: data },
			readStdin: async () => stdin,
			readToken: readAppToken,
			socketPath: controlPath,
			ask: askControl,
			out: (l) => out.push(l),
			err: (l) => err.push(l),
		};
		return { io, out, err };
	}
	async function listening(sock: string): Promise<void> {
		for (let i = 0; i < 250; i++) {
			try {
				statSync(sock);
				return;
			} catch {
				await new Promise((r) => setTimeout(r, 20));
			}
		}
		throw new Error("the control socket didn't start");
	}

	it("one call sends once and exits 0; the server down or the token missing exits 4", async () => {
		const down = realIo();
		expect(await runNotify(["telegram", "--text", TEXT], down.io)).toBe(NOTIFY_EXIT.unreachable);
		expect(down.err[0]).toMatch(/no app token in /);

		const token = ensureAppToken(data);
		const none = realIo();
		expect(await runNotify(["telegram", "--text", TEXT], none.io)).toBe(NOTIFY_EXIT.unreachable);
		expect(none.err[0]).toMatch(/the server isn't reachable at .*pi-web-ui\.sock/);

		const sent: unknown[] = [];
		const ownerTelegram = vi.fn(async (notice: unknown): Promise<OwnerTelegramResult> => {
			sent.push(notice);
			return { ok: true, messageIds: [4242] };
		});
		const notices: unknown[] = [];
		const service = {
			serviceStatus: () => ({}) as never,
			quiesce: () => {},
			unquiesce: () => {},
			requestScriptNotice: (input: unknown) => {
				notices.push(input);
				return { ok: true, record: { id: "rm-1234abcd" }, duplicate: false } as never;
			},
		};
		const stop = startControlServer({ service, dataDir: data, port: 0, appToken: token, ownerTelegram });
		try {
			await listening(controlPath(data, 0));
			const tg = realIo(`${TEXT}\n`);
			expect(await runNotify(["telegram", "--from", "Ops", "--text", "-"], tg.io)).toBe(NOTIFY_EXIT.sent);
			expect(tg.out).toEqual(["4242"]);
			expect(sent).toEqual([{ text: TEXT, from: "Ops" }]);

			const role = realIo();
			expect(await runNotify(ROLE, role.io)).toBe(NOTIFY_EXIT.sent);
			expect(role.out).toEqual(["rm-1234abcd duplicate=false"]);
			expect(notices).toEqual([
				{ role: "ops", kind: "fyi", sender: { id: "rollcall-cd", title: "RollCall CD" }, text: TEXT },
			]);

			const bad = realIo();
			expect(await runNotify(["telegram", "--text", " "], bad.io)).toBe(NOTIFY_EXIT.badInput);
			expect(ownerTelegram).toHaveBeenCalledTimes(1);
			for (const r of [down, none, tg, role, bad]) expect([...r.out, ...r.err].join("\n")).not.toContain(token);
		} finally {
			stop();
		}
	});
});
