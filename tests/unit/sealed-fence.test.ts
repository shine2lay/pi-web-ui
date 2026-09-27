import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The fence of a sealed test run (tests/lib/sealed-fence.cjs, loaded by scripts/sealed.sh through
 * NODE_OPTIONS). Each case runs a small script in a child node with the fence pointed at a fake
 * "real home" inside a temp folder, so nothing here touches the machine's real ~/.pi.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const FENCE = join(repo, "tests", "lib", "sealed-fence.cjs");

let box: string;
let realHome: string;
let agentDir: string;
let settings: string;
let chat: string;
let addonFile: string;
let sandbox: string;
let log: string;
let livePort = 0;
let otherPort = 0;
const servers: Server[] = [];
let n = 0;

type Hit = { pid: number; kind: string; fn: string; path: string; mode: string; allowed?: boolean };

beforeAll(async () => {
	box = mkdtempSync(join(tmpdir(), "fence-test-"));
	realHome = join(box, "realhome");
	agentDir = join(realHome, ".pi", "agent");
	settings = join(agentDir, "settings.json");
	chat = join(agentDir, "sessions", "--home-x--", "2026-01-01T00-00-00-000Z_chat.jsonl");
	addonFile = join(agentDir, "npm", "node_modules", "addon", "index.js");
	sandbox = join(box, "sandbox");
	log = join(box, "fence.log");
	for (const f of [settings, chat, addonFile, join(realHome, ".pi-web-ui", "client-state.json")]) {
		mkdirSync(dirname(f), { recursive: true });
	}
	writeFileSync(settings, '{"real":true}');
	writeFileSync(chat, '{"type":"session","id":"chat"}\n');
	writeFileSync(addonFile, "module.exports = 'addon code';");
	writeFileSync(join(realHome, ".pi-web-ui", "client-state.json"), "{}");
	mkdirSync(sandbox, { recursive: true });
	for (let i = 0; i < 2; i++) {
		const server = createServer((socket) => socket.end());
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		servers.push(server);
	}
	const port = (s: Server) => (s.address() as { port: number }).port;
	livePort = port(servers[0]);
	otherPort = port(servers[1]);
});

afterAll(() => {
	for (const s of servers) s.close();
	rmSync(box, { recursive: true, force: true });
});

beforeEach(() => {
	writeFileSync(log, "");
});

function fenceEnv(mode: "enforce" | "report"): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		NODE_OPTIONS: `--require ${FENCE}`,
		PI_SEALED: "1",
		PI_SEALED_ROOT: box,
		PI_SEALED_FENCE: mode,
		PI_SEALED_FORBID: `${join(realHome, ".pi")}:${join(realHome, ".pi-web-ui")}`,
		PI_SEALED_READONLY: join(agentDir, "npm"),
		PI_SEALED_LIVE_PORTS: String(livePort),
		PI_SEALED_FENCE_LOG: log,
		PI_SEALED_REAL_AGENT_DIR: agentDir,
		HOME: sandbox,
		TMPDIR: sandbox,
	};
}

function script(code: string, ext: "cjs" | "mjs"): string {
	const file = join(sandbox, `snippet-${n++}.${ext}`);
	writeFileSync(file, code);
	return file;
}

function run(
	code: string,
	opts: { mode?: "enforce" | "report"; cwd?: string; ext?: "cjs" | "mjs" } = {},
): { out: Record<string, unknown>; status: number | null; stderr: string; hits: Hit[] } {
	const r: SpawnSyncReturns<string> = spawnSync(process.execPath, [script(code, opts.ext ?? "cjs")], {
		cwd: opts.cwd ?? sandbox,
		env: fenceEnv(opts.mode ?? "enforce"),
		encoding: "utf8",
		timeout: 30_000,
	});
	const last = r.stdout.trim().split("\n").pop() ?? "";
	let out: Record<string, unknown> = {};
	try {
		out = JSON.parse(last) as Record<string, unknown>;
	} catch {
		out = { raw: r.stdout };
	}
	return { out, status: r.status, stderr: r.stderr, hits: readHits() };
}

function readHits(): Hit[] {
	return readFileSync(log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Hit);
}

const blocked = (hits: Hit[]) => hits.filter((h) => !h.allowed);

describe("sealed fence: real folders", () => {
	it("blocks sync, callback, promise and stream reads, and names the path", () => {
		const { out, hits } = run(`
			const fs = require("node:fs");
			const target = ${JSON.stringify(settings)};
			const out = {};
			try { fs.readFileSync(target); out.sync = "read"; } catch (e) { out.sync = e.code; out.message = e.message; }
			try { fs.createReadStream(target); out.stream = "opened"; } catch (e) { out.stream = e.code; }
			fs.readFile(target, (e) => {
				out.callback = e ? e.code : "read";
				fs.promises.readFile(target).then(
					() => { out.promise = "read"; console.log(JSON.stringify(out)); },
					(e) => { out.promise = e.code; console.log(JSON.stringify(out)); },
				);
			});
		`);
		expect(out).toMatchObject({ sync: "EACCES", stream: "EACCES", callback: "EACCES", promise: "EACCES" });
		expect(out.message).toContain(settings);
		expect(blocked(hits).map((h) => h.fn)).toEqual(
			expect.arrayContaining(["readFileSync", "createReadStream", "readFile", "promises.readFile"]),
		);
		expect(blocked(hits).every((h) => h.path === settings && h.kind === "read")).toBe(true);
	});

	it("also blocks ES module named imports of fs and fs/promises", () => {
		const { out } = run(
			`
			import { readFileSync, existsSync } from "node:fs";
			import { readdir } from "node:fs/promises";
			const out = {};
			try { readFileSync(${JSON.stringify(chat)}); out.sync = "read"; } catch (e) { out.sync = e.code; }
			try { existsSync(${JSON.stringify(agentDir)}); out.exists = "asked"; } catch (e) { out.exists = e.code; }
			try { await readdir(${JSON.stringify(join(agentDir, "sessions"))}); out.readdir = "listed"; } catch (e) { out.readdir = e.code; }
			console.log(JSON.stringify(out));
		`,
			{ ext: "mjs" },
		);
		expect(out).toEqual({ sync: "EACCES", exists: "EACCES", readdir: "EACCES" });
	});

	it("blocks writes, moves and deletes, including deleting a folder that holds a real folder", () => {
		const { out, hits } = run(`
			const fs = require("node:fs");
			const out = {};
			const tryIt = (name, f) => { try { f(); out[name] = "done"; } catch (e) { out[name] = e.code; } };
			tryIt("write", () => fs.writeFileSync(${JSON.stringify(join(agentDir, "auth.json"))}, "{}"));
			tryIt("mkdir", () => fs.mkdirSync(${JSON.stringify(join(agentDir, "sessions", "new"))}));
			tryIt("rmHome", () => fs.rmSync(${JSON.stringify(realHome)}, { recursive: true, force: true }));
			tryIt("unlink", () => fs.unlinkSync(${JSON.stringify(settings)}));
			fs.writeFileSync("mine.txt", "x");
			tryIt("renameIn", () => fs.renameSync("mine.txt", ${JSON.stringify(join(agentDir, "mine.txt"))}));
			tryIt("copyOut", () => fs.copyFileSync(${JSON.stringify(chat)}, "copy.jsonl"));
			console.log(JSON.stringify(out));
		`);
		expect(out).toEqual({
			write: "EACCES",
			mkdir: "EACCES",
			rmHome: "EACCES",
			unlink: "EACCES",
			renameIn: "EACCES",
			copyOut: "EACCES",
		});
		expect(readFileSync(settings, "utf8")).toBe('{"real":true}');
		expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
		expect(existsSync(join(sandbox, "copy.jsonl"))).toBe(false);
		expect(blocked(hits).find((h) => h.fn === "rmSync")).toMatchObject({ kind: "delete", path: realHome });
	});

	it("lets the test's own temp folders alone and records nothing", () => {
		const { out, hits } = run(`
			const fs = require("node:fs");
			const path = require("node:path");
			fs.mkdirSync("work/a", { recursive: true });
			fs.writeFileSync("work/a/f.txt", "hello");
			fs.renameSync("work/a/f.txt", "work/f.txt");
			const text = fs.readFileSync(path.join(process.env.TMPDIR, "work", "f.txt"), "utf8");
			fs.rmSync("work", { recursive: true });
			console.log(JSON.stringify({ text, home: require("node:os").homedir() }));
		`);
		expect(out).toEqual({ text: "hello", home: sandbox });
		expect(hits).toEqual([]);
	});

	it("resolves relative paths against the working folder", () => {
		const { out } = run(
			`
			const fs = require("node:fs");
			try { fs.readFileSync(".pi/agent/settings.json"); console.log(JSON.stringify({ r: "read" })); }
			catch (e) { console.log(JSON.stringify({ r: e.code })); }
		`,
			{ cwd: realHome },
		);
		expect(out).toEqual({ r: "EACCES" });
	});

	it("lets installed add-on code be read and required, but not written", () => {
		const { out, hits } = run(`
			const fs = require("node:fs");
			const out = { code: require(${JSON.stringify(addonFile)}) };
			try { fs.writeFileSync(${JSON.stringify(addonFile)}, "changed"); out.write = "done"; } catch (e) { out.write = e.code; }
			console.log(JSON.stringify(out));
		`);
		expect(out).toEqual({ code: "addon code", write: "EACCES" });
		expect(readFileSync(addonFile, "utf8")).toBe("module.exports = 'addon code';");
		expect(hits.filter((h) => h.allowed).map((h) => h.path)).toContain(join(agentDir, "npm", "node_modules", "addon"));
		expect(blocked(hits)).toHaveLength(1);
	});

	it("blocks symlinks into a real folder, allows them into add-on code", () => {
		const { out } = run(`
			const fs = require("node:fs");
			const out = {};
			try { fs.symlinkSync(${JSON.stringify(join(agentDir, "sessions"))}, "link-sessions"); out.sessions = "linked"; } catch (e) { out.sessions = e.code; }
			try { fs.symlinkSync(${JSON.stringify(join(agentDir, "npm", "node_modules", "addon"))}, "link-addon"); out.addon = "linked"; } catch (e) { out.addon = e.code; }
			console.log(JSON.stringify(out));
		`);
		expect(out).toEqual({ sessions: "EACCES", addon: "linked" });
	});

	it("report mode records the access but lets it through", () => {
		const { out, hits } = run(
			`console.log(JSON.stringify({ text: require("node:fs").readFileSync(${JSON.stringify(settings)}, "utf8") }));`,
			{ mode: "report" },
		);
		expect(out).toEqual({ text: '{"real":true}' });
		expect(blocked(hits)).toMatchObject([{ fn: "readFileSync", path: settings, mode: "report" }]);
	});
});

describe("sealed fence: child processes", () => {
	it("reaches child node processes that were given their own env", () => {
		const child = `try { require("node:fs").readFileSync(${JSON.stringify(settings)}); console.log("read"); } catch (e) { console.log(e.code); }`;
		const { out, hits } = run(`
			const cp = require("node:child_process");
			const { promisify } = require("node:util");
			const bare = { PATH: process.env.PATH };
			const out = {};
			out.spawnSync = cp.spawnSync(process.execPath, ["-e", ${JSON.stringify(child)}], { env: bare, encoding: "utf8" }).stdout.trim();
			out.execSync = cp.execSync(${JSON.stringify(`node -e '${child}'`)}, { env: bare, encoding: "utf8" }).trim();
			promisify(cp.exec)(${JSON.stringify(`node -e '${child}'`)}, { env: bare }).then(({ stdout }) => {
				out.exec = stdout.trim();
				console.log(JSON.stringify(out));
			});
		`);
		expect(out).toEqual({ spawnSync: "EACCES", execSync: "EACCES", exec: "EACCES" });
		const pids = new Set(blocked(hits).map((h) => h.pid));
		expect(pids.size).toBe(3);
	});

	it("blocks starting a program inside a real folder", () => {
		const { out } = run(`
			try { require("node:child_process").spawnSync("ls", { cwd: ${JSON.stringify(agentDir)} }); console.log(JSON.stringify({ r: "ran" })); }
			catch (e) { console.log(JSON.stringify({ r: e.code })); }
		`);
		expect(out).toEqual({ r: "EACCES" });
	});
});

describe("sealed fence: the live server's port", () => {
	it("refuses to connect to a live port, other ports work", async () => {
		const file = script(
			`
			const net = require("node:net");
			const attempt = (port) => new Promise((resolve) => {
				const s = net.connect(port, "127.0.0.1");
				s.on("connect", () => { s.destroy(); resolve("connected"); });
				s.on("error", (e) => resolve(e.code));
			});
			Promise.all([attempt(${livePort}), attempt(${otherPort})]).then(([live, other]) => console.log(JSON.stringify({ live, other })));
		`,
			"cjs",
		);
		const stdout = await new Promise<string>((resolve) => {
			const child = spawn(process.execPath, [file], { env: fenceEnv("enforce") });
			let text = "";
			child.stdout.on("data", (d: Buffer) => (text += d.toString()));
			child.on("exit", () => resolve(text));
		});
		expect(JSON.parse(stdout.trim())).toEqual({ live: "EACCES", other: "connected" });
		expect(blocked(readHits())).toMatchObject([{ kind: "connect", path: `127.0.0.1:${livePort}` }]);
	});
});

describe("sealed fence: the clone helper's door", () => {
	it("lists and reads real chat files read-only, and nothing else", () => {
		const { out, hits } = run(`
			const door = globalThis[Symbol.for("pi.sealed.fence")];
			const chats = door.listRealChats();
			const out = { chats: chats.map((c) => c.path), text: door.readRealChat(chats[0].path).toString().trim() };
			try { door.readRealChat(${JSON.stringify(settings)}); out.settings = "read"; } catch (e) { out.settings = "refused"; }
			console.log(JSON.stringify(out));
		`);
		expect(out).toEqual({ chats: [chat], text: '{"type":"session","id":"chat"}', settings: "refused" });
		expect(blocked(hits)).toEqual([]);
	});

	it("cloneRealChat copies a chat and its sidecar into the sealed home, never outside it", () => {
		writeFileSync(`${chat}.acp.json`, '{"folds":[]}');
		const helper = join(repo, "tests", "lib", "real-chat-clone.mjs");
		const outside = join(tmpdir(), `clone-outside-${process.pid}-${Date.now()}`);
		try {
			const { out, hits } = run(
				`
				import { readFileSync } from "node:fs";
				import { cloneRealChat } from ${JSON.stringify(helper)};
				const c = cloneRealChat();
				const out = { ...c, text: readFileSync(c.file, "utf8").trim(), acp: readFileSync(c.acpFile, "utf8") };
				try { cloneRealChat({ into: ${JSON.stringify(outside)} }); out.outside = "copied"; } catch (e) { out.outside = e.message; }
				try { cloneRealChat({ minBytes: 1e9 }); out.tooBig = "copied"; } catch (e) { out.tooBig = e.message; }
				console.log(JSON.stringify(out));
			`,
				{ ext: "mjs" },
			);
			const copy = join(box, "home", ".pi", "agent", "sessions", "--home-x--", "2026-01-01T00-00-00-000Z_chat.jsonl");
			expect(out).toMatchObject({
				file: copy,
				acpFile: `${copy}.acp.json`,
				source: chat,
				text: '{"type":"session","id":"chat"}',
				acp: '{"folds":[]}',
			});
			expect(out.outside).toContain("outside the sealed home");
			expect(out.tooBig).toContain("no real chat to clone");
			expect(existsSync(outside)).toBe(false);
			expect(blocked(hits)).toEqual([]);
		} finally {
			rmSync(`${chat}.acp.json`, { force: true });
			rmSync(outside, { recursive: true, force: true });
			rmSync(join(box, "home"), { recursive: true, force: true });
		}
	});

	it("cloneRealChat refuses to run outside a sealed run", async () => {
		const { cloneRealChat } = (await import("../lib/real-chat-clone.mjs")) as {
			cloneRealChat: () => unknown;
		};
		const sealed = process.env.PI_SEALED;
		delete process.env.PI_SEALED;
		try {
			expect(() => cloneRealChat()).toThrow(/only in a sealed test run/);
		} finally {
			if (sealed !== undefined) process.env.PI_SEALED = sealed;
		}
	});
});

describe("scripts/sealed.sh", () => {
	it("runs in a clean temp home, stops leftovers, removes the home, and fails on a fence hit", () => {
		const realPwHome = spawnSync("sh", ["-c", 'getent passwd "$(id -u)" | cut -d: -f6'], {
			encoding: "utf8",
		}).stdout.trim();
		const code = `
			const fs = require("node:fs");
			const sleeper = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
			sleeper.unref();
			console.log(JSON.stringify({
				home: require("node:os").homedir(),
				dataDir: process.env.PI_WEB_DATA_DIR,
				agentDir: process.env.PI_CODING_AGENT_DIR,
				keys: Object.keys(process.env).filter((k) => /KEY|TOKEN|PI_WEB_PORT/.test(k)),
				auth: fs.readFileSync(process.env.PI_CODING_AGENT_DIR + "/auth.json", "utf8"),
				models: fs.readFileSync(process.env.PI_CODING_AGENT_DIR + "/models.json", "utf8"),
				sleeper: sleeper.pid,
			}));
			try { fs.statSync(${JSON.stringify(join(realPwHome, ".pi-web-ui", "sealed-fence-probe"))}); } catch {}
		`;
		const r = spawnSync("bash", [join(repo, "scripts", "sealed.sh"), process.execPath, "-e", code], {
			cwd: repo,
			env: {
				PATH: process.env.PATH,
				PI_SEALED: "",
				PI_WEB_PORT: "8787",
				PI_WEB_DATA_DIR: "/nonexistent/live-data",
				ANTHROPIC_API_KEY: "sk-test-not-a-key",
				CLAUDE_CODE_OAUTH_TOKEN: "not-a-token",
			},
			encoding: "utf8",
			timeout: 60_000,
		});
		const seen = JSON.parse(r.stdout.trim().split("\n")[0]) as {
			home: string;
			dataDir: string;
			agentDir: string;
			keys: string[];
			auth: string;
			models: string;
			sleeper: number;
		};
		expect(r.status).toBe(97);
		// The stand-in model: only a dummy key, and an address nothing listens on.
		expect(JSON.parse(seen.auth)).toEqual({ fastfail: { type: "api_key", key: "sealed-test-dummy" } });
		expect(JSON.parse(seen.models).providers.fastfail.baseUrl).toBe("http://127.0.0.1:1");
		expect(seen.home).toMatch(/pi-sealed-[^/]+\/home$/);
		expect(seen.dataDir).toBe(join(seen.home, ".pi-web-ui"));
		expect(seen.agentDir).toBe(join(seen.home, ".pi", "agent"));
		expect(seen.keys).toEqual([]);
		expect(r.stderr).toContain("sealed-fence-probe");
		expect(r.stderr).toContain("stopped 1 process");
		expect(existsSync(dirname(seen.home))).toBe(false);
		expect(spawnSync("kill", ["-0", String(seen.sleeper)]).status).not.toBe(0);
	});

	it("leaves the temp pi folder without any model when PI_SEALED_MODEL=none", () => {
		const code = `console.log(JSON.stringify(require("node:fs").readdirSync(process.env.PI_CODING_AGENT_DIR)))`;
		const r = spawnSync("bash", [join(repo, "scripts", "sealed.sh"), process.execPath, "-e", code], {
			cwd: repo,
			env: { PATH: process.env.PATH, PI_SEALED: "", PI_SEALED_MODEL: "none" },
			encoding: "utf8",
			timeout: 60_000,
		});
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout.trim().split("\n")[0])).toEqual([]);
	});
});
