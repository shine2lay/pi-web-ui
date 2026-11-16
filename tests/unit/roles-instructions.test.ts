// roles-instructions (Ops #208): what a role's home chat loaded (pi-identity's loaded.json) against the files
// now, and the panel's Instructions line. Temporary folders and fixed texts only; no chats, models or writes
// outside the temporary folder.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRoleInstructions } from "../../server/roles-instructions.js";

const AT = "2026-10-18T16:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
	const base = mkdtempSync(join(tmpdir(), "roles-instr-"));
	dirs.push(base);
	const agents = join(base, "agent", "AGENTS.md");
	const role = join(base, "agent", "memory", "identities", "ops");
	mkdirSync(role, { recursive: true });
	const texts: Record<string, string> = {
		[agents]: "# rules\n",
		[join(role, "about.md")]: "# about\n",
		[join(role, "notebook.md")]: "## notes\n",
	};
	for (const [p, t] of Object.entries(texts)) writeFileSync(p, t);
	const home = join(base, "sessions", "home.jsonl");
	const write = (sessions: Record<string, unknown>) =>
		writeFileSync(join(role, "loaded.json"), JSON.stringify({ v: 1, sessions }));
	const entry = (over: Record<string, string | null> = {}) => ({
		at: AT,
		files: Object.entries(texts).map(([path, text]) => ({
			name: path === agents ? "AGENTS.md" : path.slice(role.length + 1),
			path,
			sha256: path in over ? over[path] : sha(text),
			at: AT,
		})),
	});
	return { agents, role, home, write, entry, read: () => readRoleInstructions(role, home, agents) };
}

describe("roles-instructions reader", () => {
	it("current when every loaded file is unchanged", async () => {
		const f = fixture();
		f.write({ [f.home]: f.entry(), "/other.jsonl": f.entry({ [f.agents]: sha("old") }) });
		expect(await f.read()).toEqual({ state: "current", loadedAt: Date.parse(AT) });
	});

	it("outdated, naming the files changed since", async () => {
		const f = fixture();
		f.write({ [f.home]: f.entry() });
		writeFileSync(join(f.role, "notebook.md"), "## notes\nnew line\n");
		writeFileSync(f.agents, "# rules v2\n");
		expect(await f.read()).toEqual({
			state: "outdated",
			loadedAt: Date.parse(AT),
			changed: ["AGENTS.md", "notebook.md"],
		});
	});

	it("none without a record: no file, no entry for the home chat, no home chat, a broken file", async () => {
		const f = fixture();
		expect(await f.read()).toEqual({ state: "none" });
		f.write({ "/other.jsonl": f.entry() });
		expect(await f.read()).toEqual({ state: "none" });
		f.write({ [f.home]: f.entry() });
		expect(await readRoleInstructions(f.role, null, f.agents)).toEqual({ state: "none" });
		writeFileSync(join(f.role, "loaded.json"), "{ broken");
		expect(await f.read()).toEqual({ state: "none" });
	});

	it("a loaded file now missing counts as changed; one missing then and now does not", async () => {
		const f = fixture();
		const gone = join(f.role, "prompt.md");
		const e = f.entry();
		e.files.push({ name: "prompt.md", path: gone, sha256: null, at: AT });
		f.write({ [f.home]: e });
		expect((await f.read()).state).toBe("current");
		rmSync(join(f.role, "about.md"));
		expect(await f.read()).toEqual({ state: "outdated", loadedAt: Date.parse(AT), changed: ["about.md"] });
	});

	it("never hashes a path outside the rules file and the role's folder", async () => {
		const f = fixture();
		const e = f.entry();
		e.files.push({ name: "passwd", path: "/etc/passwd", sha256: sha("x"), at: AT });
		f.write({ [f.home]: e });
		expect(await f.read()).toEqual({ state: "none" });
	});
});
