import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CgroupFs,
	detectCgroupSplit,
	moveStrayProcesses,
	realCgroupFs,
	SERVER_CPU_WEIGHT,
	setupCgroupSplit,
	startCgroupSplit,
	TOOLS_CPU_WEIGHT,
	unifiedCgroupPath,
} from "../../server/cgroup-split.js";

// A fake cgroup v2 tree in a temp dir. Writing a pid to some <dir>/cgroup.procs moves it there the
// way the kernel does (out of every other group); a pid that's in no group (exited) fails with ESRCH.
const REL = "/user.slice/user-1000.slice/user@1000.service/app.slice/pi-web-ui.service";
let root: string;
let service: string;

function procsFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) walk(path.join(dir, e.name));
			else if (e.name === "cgroup.procs") out.push(path.join(dir, e.name));
		}
	};
	walk(root);
	return out;
}
const pidsIn = (dir: string) =>
	fs.readFileSync(path.join(dir, "cgroup.procs"), "utf8").split(/\s+/).filter(Boolean).map(Number);

const fakeFs: CgroupFs = {
	...realCgroupFs,
	mkdir: (dir) => {
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "cgroup.procs"), "");
		fs.writeFileSync(path.join(dir, "cpu.weight"), "100\n");
	},
	writeFile: (file, data) => {
		if (path.basename(file) !== "cgroup.procs") return realCgroupFs.writeFile(file, data);
		const pid = Number(data);
		let found = false;
		for (const f of procsFiles()) {
			const list = fs.readFileSync(f, "utf8").split(/\s+/).filter(Boolean).map(Number);
			if (list.includes(pid)) {
				found = true;
				fs.writeFileSync(
					f,
					list
						.filter((p) => p !== pid)
						.map((p) => `${p}\n`)
						.join(""),
				);
			}
		}
		if (!found) throw Object.assign(new Error("ESRCH: No such process"), { code: "ESRCH" });
		fs.appendFileSync(file, `${pid}\n`);
	},
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "cgroup-split-"));
	service = path.join(root, REL);
	fs.mkdirSync(path.join(service, "server"), { recursive: true });
	fs.writeFileSync(path.join(service, "cgroup.controllers"), "cpu memory pids\n");
	fs.writeFileSync(path.join(service, "cgroup.subtree_control"), "\n");
	fs.writeFileSync(path.join(service, "cgroup.procs"), "");
	fs.writeFileSync(path.join(service, "server", "cgroup.procs"), "100\n200\n300\n");
	fs.writeFileSync(path.join(service, "server", "cpu.weight"), "100\n");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const selfCgroup = (rel: string) => `0::${rel}\n`;

describe("cgroup-split detection", () => {
	it("reads the cgroup v2 path", () => {
		expect(unifiedCgroupPath("0::/a/b/server\n")).toBe("/a/b/server");
		expect(unifiedCgroupPath("12:cpu:/x\n")).toBeNull();
	});

	it("finds the delegated layout when started in <service>/server", () => {
		const d = detectCgroupSplit(fakeFs, { procSelfCgroup: selfCgroup(`${REL}/server`), cgroupRoot: root });
		expect(d).toEqual({
			ok: true,
			layout: { serviceDir: service, serverDir: path.join(service, "server"), toolsDir: path.join(service, "tools") },
		});
	});

	it("is off when the server runs in the service cgroup itself (no DelegateSubgroup)", () => {
		const d = detectCgroupSplit(fakeFs, { procSelfCgroup: selfCgroup(REL), cgroupRoot: root });
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.reason).toMatch(/DelegateSubgroup=server/);
	});

	it("is off without the cpu controller or without write access (not delegated)", () => {
		fs.writeFileSync(path.join(service, "cgroup.controllers"), "memory pids\n");
		expect(detectCgroupSplit(fakeFs, { procSelfCgroup: selfCgroup(`${REL}/server`), cgroupRoot: root }).ok).toBe(false);
		fs.writeFileSync(path.join(service, "cgroup.controllers"), "cpu memory pids\n");
		const ro: CgroupFs = { ...fakeFs, writable: (f) => !f.endsWith("cgroup.subtree_control") };
		const d = detectCgroupSplit(ro, { procSelfCgroup: selfCgroup(`${REL}/server`), cgroupRoot: root });
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.reason).toMatch(/isn't writable/);
	});
});

describe("cgroup-split setup and mover", () => {
	const layout = () => ({
		serviceDir: service,
		serverDir: path.join(service, "server"),
		toolsDir: path.join(service, "tools"),
	});

	it("creates tools/, turns cpu on for the children and sets both weights", () => {
		setupCgroupSplit(fakeFs, layout());
		expect(fs.readFileSync(path.join(service, "cgroup.subtree_control"), "utf8")).toBe("+cpu");
		expect(fs.readFileSync(path.join(service, "server", "cpu.weight"), "utf8")).toBe(String(SERVER_CPU_WEIGHT));
		expect(fs.readFileSync(path.join(service, "tools", "cpu.weight"), "utf8")).toBe(String(TOOLS_CPU_WEIGHT));
		// Again (a second start with tools/ already there and cpu on): no error.
		fs.writeFileSync(path.join(service, "cgroup.subtree_control"), "cpu\n");
		expect(() => setupCgroupSplit(fakeFs, layout())).not.toThrow();
	});

	it("moves every process but the main pid into tools/", () => {
		setupCgroupSplit(fakeFs, layout());
		expect(moveStrayProcesses(fakeFs, layout(), 100)).toEqual({ moved: 2, skipped: 0 });
		expect(pidsIn(path.join(service, "server"))).toEqual([100]);
		expect(pidsIn(path.join(service, "tools")).sort()).toEqual([200, 300]);
		// Nothing left to move: the main pid is never moved.
		expect(moveStrayProcesses(fakeFs, layout(), 100)).toEqual({ moved: 0, skipped: 0 });
		expect(pidsIn(path.join(service, "server"))).toEqual([100]);
	});

	it("skips a pid that is gone by the time it's moved", () => {
		setupCgroupSplit(fakeFs, layout());
		const racing: CgroupFs = {
			...fakeFs,
			readFile: (f) => (f.endsWith(`server${path.sep}cgroup.procs`) ? "100\n200\n999\n" : fakeFs.readFile(f)),
		};
		expect(moveStrayProcesses(racing, layout(), 100)).toEqual({ moved: 1, skipped: 1 });
		expect(pidsIn(path.join(service, "tools"))).toEqual([200]);
	});
});

describe("startCgroupSplit", () => {
	it("sets up, moves at once and counts, with one log line", () => {
		const logs: string[] = [];
		const h = startCgroupSplit({
			cfs: fakeFs,
			procSelfCgroup: selfCgroup(`${REL}/server`),
			cgroupRoot: root,
			mainPid: 100,
			env: {},
			log: (l) => logs.push(l),
			timer: false,
		});
		expect(h.stats()).toMatchObject({ active: true, moved: 2, skipped: 0, reason: null });
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatch(/^\[cgroup-split\] on: /);
		// A new child of the server starts in server/; the next round moves it.
		fs.appendFileSync(path.join(service, "server", "cgroup.procs"), "400\n");
		h.tick();
		expect(h.stats().moved).toBe(3);
		expect(pidsIn(path.join(service, "server"))).toEqual([100]);
		h.stop();
	});

	it("does nothing but log one line when not delegated, and never touches the tree", () => {
		const logs: string[] = [];
		const h = startCgroupSplit({
			cfs: fakeFs,
			procSelfCgroup: selfCgroup(REL),
			cgroupRoot: root,
			mainPid: 100,
			env: {},
			log: (l) => logs.push(l),
			timer: false,
		});
		h.tick();
		expect(h.stats()).toMatchObject({ active: false, moved: 0 });
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatch(/^\[cgroup-split\] off: /);
		expect(fs.existsSync(path.join(service, "tools"))).toBe(false);
		expect(pidsIn(path.join(service, "server"))).toEqual([100, 200, 300]);
	});

	it("PI_WEB_CGROUP_SPLIT=0 turns it off", () => {
		const logs: string[] = [];
		const h = startCgroupSplit({
			cfs: fakeFs,
			procSelfCgroup: selfCgroup(`${REL}/server`),
			cgroupRoot: root,
			mainPid: 100,
			env: { PI_WEB_CGROUP_SPLIT: "0" },
			log: (l) => logs.push(l),
			timer: false,
		});
		expect(h.stats().active).toBe(false);
		expect(logs[0]).toMatch(/PI_WEB_CGROUP_SPLIT=0/);
		expect(fs.existsSync(path.join(service, "tools"))).toBe(false);
	});

	it("a setup failure runs on as before with one log line", () => {
		const logs: string[] = [];
		const broken: CgroupFs = {
			...fakeFs,
			writeFile: (f, d) => {
				if (f.endsWith("cgroup.subtree_control"))
					throw Object.assign(new Error("EBUSY: device or resource busy"), { code: "EBUSY" });
				fakeFs.writeFile(f, d);
			},
		};
		const h = startCgroupSplit({
			cfs: broken,
			procSelfCgroup: selfCgroup(`${REL}/server`),
			cgroupRoot: root,
			mainPid: 100,
			env: {},
			log: (l) => logs.push(l),
			timer: false,
		});
		h.tick();
		expect(h.stats()).toMatchObject({ active: false, moved: 0 });
		expect(logs).toEqual([expect.stringMatching(/^\[cgroup-split\] off: setup failed, running as before: EBUSY/)]);
		expect(pidsIn(path.join(service, "server"))).toEqual([100, 200, 300]);
	});
});
