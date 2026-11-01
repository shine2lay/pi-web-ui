"use strict";
/**
 * file-read-recorder.cjs: notes which files of the repo each unit test file reads, lists, copies, runs or loads,
 * for the read map (scripts/test-read-map.mjs, docs/gate-selected-tests.md, Ops #693). Paths only, never contents.
 *
 * Off unless PI_TEST_READ_MAP names a folder: then each process appends what it sees to a file of its own there,
 * one JSON line per new finding: [test file, kind, path], the paths relative to PI_TEST_READ_MAP_ROOT (the repo),
 * without node_modules/ and .git/. Kinds:
 *   r  read: readFile, exists, stat, lstat, access, open, realpath, createReadStream, copyFile's source
 *   d  listed: readdir, opendir (a file added or deleted under it can change the test)
 *   t  copied as a tree: cp's source (any change under it can change the test)
 *   m  loaded or run: a module a child process loads, a repo file a child process is started with
 *   c  done: the test file's own afterAll ran (path ".")
 *
 * Two ways in:
 * - In a vitest worker, tests/lib/record-file-reads.ts (a setup file) calls startInTestWorker(): the test file is
 *   vitest's current one. It also hands PI_TEST_READ_MAP_TEST and `--require <this file>` to child processes.
 * - In a child process, NODE_OPTIONS loads this file first: the test file is PI_TEST_READ_MAP_TEST, and module
 *   loads are noted too (in a worker, vitest's own module list says that, see record-file-reads.ts).
 *
 * The functions it wraps are the ones scripts/sealed.sh's fence (tests/lib/sealed-fence.cjs) already wrapped; it
 * only notes the path and calls on, so what the test sees is unchanged.
 */
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

const STARTED = Symbol.for("pi-web-ui.file-read-recorder.started");
const outDir = process.env.PI_TEST_READ_MAP;
const root = process.env.PI_TEST_READ_MAP_ROOT;
const requireFlag = /\s/.test(__filename) ? `--require "${__filename}"` : `--require ${__filename}`;

const write = { openSync: fs.openSync, writeSync: fs.writeSync, existsSync: fs.existsSync };
let fd;
const seen = new Set();
let currentTest = () => undefined;

function toAbsolute(value) {
	try {
		if (typeof value === "string") {
			if (value.startsWith("file:")) return fileURLToPath(value);
			return path.resolve(value);
		}
		if (Buffer.isBuffer(value)) return path.resolve(value.toString());
		if (value instanceof URL && value.protocol === "file:") return fileURLToPath(value);
	} catch {
		/* not a path */
	}
	return undefined;
}

/** The path from the top of the repo, or undefined when it is outside, in node_modules/ or in .git/. */
function inRepo(absolute) {
	if (absolute === undefined || !root) return undefined;
	const rel = path.relative(root, absolute);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
	if (rel === "") return ".";
	if (/(^|\/)(node_modules|\.git)(\/|$)/.test(rel)) return undefined;
	return rel;
}

function note(kind, value) {
	try {
		const rel = inRepo(toAbsolute(value));
		if (rel === undefined) return;
		noteRelative(kind, rel);
	} catch {
		/* never let the record change what the test sees */
	}
}

function noteRelative(kind, rel, test = currentTest()) {
	if (test === undefined) return;
	const key = `${test}\0${kind}\0${rel}`;
	if (seen.has(key)) return;
	seen.add(key);
	if (fd === undefined) {
		fd = write.openSync(path.join(outDir, `${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`), "a", 0o600);
	}
	write.writeSync(fd, `${JSON.stringify([test, kind, rel])}\n`);
}

const READS = ["readFile", "exists", "stat", "lstat", "access", "open", "realpath", "copyFile"];
const LISTS = ["readdir", "opendir"];

function wrap(owner, name, kind) {
	const original = owner?.[name];
	if (typeof original !== "function") return;
	const wrapped = function (...args) {
		note(kind, args[0]);
		return Reflect.apply(original, this, args);
	};
	for (const key of Reflect.ownKeys(original)) {
		if (key === "length" || key === "name" || key === "prototype") continue;
		try {
			Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key));
		} catch {
			/* non-configurable */
		}
	}
	if (typeof original.native === "function") wrapped.native = wrap({ native: original.native }, "native", kind);
	owner[name] = wrapped;
	return wrapped;
}

function wrapFs() {
	for (const [names, kind] of [
		[READS, "r"],
		[LISTS, "d"],
		[["cp"], "t"],
	]) {
		for (const name of names) {
			wrap(fs, name, kind);
			wrap(fs, `${name}Sync`, kind);
			wrap(fs.promises, name, kind);
		}
	}
	wrap(fs, "createReadStream", "r");
}

/** Notes each argument of a child process launch that names a file of the repo, and passes the record on. */
function wrapChildProcess() {
	const cp = require("node:child_process");
	const util = require("node:util");
	function words(value) {
		if (typeof value === "string") return value.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ""));
		if (Array.isArray(value)) return value.filter((w) => typeof w === "string");
		return [];
	}
	function noteLaunch(name, args) {
		const at = args.findIndex((a, i) => i > 0 && a !== null && typeof a === "object" && !Array.isArray(a));
		const options = at === -1 ? undefined : args[at];
		const cwd = typeof options?.cwd === "string" ? options.cwd : options?.cwd instanceof URL ? fileURLToPath(options.cwd) : process.cwd();
		const list = name === "exec" || name === "execSync" ? words(args[0]) : [args[0], ...words(args[1])];
		for (const word of list) {
			if (typeof word !== "string" || !/[/.]/.test(word)) continue;
			const absolute = toAbsolute(path.resolve(cwd, word));
			if (absolute !== undefined && inRepo(absolute) !== undefined && write.existsSync(absolute)) note("m", absolute);
		}
		if (options?.env && typeof options.env === "object") {
			const env = { ...options.env };
			env.PI_TEST_READ_MAP = outDir;
			env.PI_TEST_READ_MAP_ROOT = root;
			const test = currentTest();
			if (test !== undefined) env.PI_TEST_READ_MAP_TEST = test;
			const opts = env.NODE_OPTIONS ?? "";
			if (!opts.includes(__filename)) env.NODE_OPTIONS = `${opts} ${requireFlag}`.trim();
			const copy = args.slice();
			copy[at] = { ...options, env };
			return copy;
		}
		return args;
	}
	for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
		const original = cp[name];
		if (typeof original !== "function") continue;
		const launcher = function (...args) {
			let fixed = args;
			try {
				fixed = noteLaunch(name, args);
			} catch {
				/* never let the record change what the test sees */
			}
			return Reflect.apply(original, this, fixed);
		};
		for (const key of Reflect.ownKeys(original)) {
			if (key === "length" || key === "name" || key === "prototype" || key === util.promisify.custom) continue;
			try {
				Object.defineProperty(launcher, key, Object.getOwnPropertyDescriptor(original, key));
			} catch {
				/* non-configurable */
			}
		}
		const custom = original[util.promisify.custom];
		if (typeof custom === "function") {
			Object.defineProperty(launcher, util.promisify.custom, {
				value: (...args) => {
					let fixed = args;
					try {
						fixed = noteLaunch(name, args);
					} catch {
						/* as above */
					}
					return custom(...fixed);
				},
			});
		}
		cp[name] = launcher;
	}
}

const LOADER_SOURCE = `
import { appendFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
let cfg;
const seen = new Set();
export function initialize(data) { cfg = data; }
export async function load(url, context, nextLoad) {
	if (cfg && typeof url === "string" && url.startsWith("file:")) {
		try {
			const clean = fileURLToPath(url).replace(/[?#].*$/, "");
			const rel = relative(cfg.root, clean);
			if (rel && !rel.startsWith("..") && !isAbsolute(rel) && !/(^|\\/)((node_modules|\\.git))(\\/|$)/.test(rel) && !seen.has(rel)) {
				seen.add(rel);
				appendFileSync(cfg.file, JSON.stringify([cfg.test, "m", rel]) + "\\n", { mode: 0o600 });
			}
		} catch {}
	}
	return nextLoad(url, context);
}
`;

function start(testOf, { modules }) {
	if (!outDir || !root || globalThis[STARTED]) return globalThis[STARTED] !== undefined;
	globalThis[STARTED] = true;
	currentTest = testOf;
	wrapFs();
	wrapChildProcess();
	const mod = require("node:module");
	mod.syncBuiltinESMExports();
	if (modules && typeof mod.register === "function") {
		const test = testOf();
		if (test) {
			try {
				const file = path.join(outDir, `${process.pid}-loader-${Math.random().toString(36).slice(2)}.jsonl`);
				mod.register(`data:text/javascript,${encodeURIComponent(LOADER_SOURCE)}`, {
					parentURL: pathToFileURL(__filename).href,
					data: { file, root, test },
				});
			} catch {
				/* ignore if loader registration is unavailable */
			}
		}
	}
	return true;
}

/**
 * In a vitest worker: start recording (once a process), name the current test file `test` (from the top of the
 * repo) for child processes, and have them record too.
 */
function startInTestWorker(testOf) {
	if (!outDir || !root) return false;
	start(testOf, { modules: false });
	const test = testOf();
	if (test !== undefined) process.env.PI_TEST_READ_MAP_TEST = test;
	const opts = process.env.NODE_OPTIONS ?? "";
	if (!opts.includes(__filename)) process.env.NODE_OPTIONS = `${opts} ${requireFlag}`.trim();
	return true;
}

/** Notes, for test file `test`, paths it loaded (absolute; others are skipped) and that its afterAll ran. */
function finishTestFile(test, loadedPaths) {
	if (!outDir || !root) return;
	try {
		for (const loaded of loadedPaths) {
			if (typeof loaded !== "string" || !path.isAbsolute(loaded)) continue;
			const rel = inRepo(loaded.replace(/[?#].*$/, ""));
			if (rel !== undefined) noteRelative("m", rel, test);
		}
		noteRelative("c", ".", test);
	} catch {
		/* never let the record change what the test sees */
	}
}

// Loaded through NODE_OPTIONS in a child process of a test: record for the test that started it.
if (outDir && root && process.env.PI_TEST_READ_MAP_TEST && globalThis.__vitest_worker__ === undefined) {
	start(() => process.env.PI_TEST_READ_MAP_TEST, { modules: true });
}

module.exports = { startInTestWorker, finishTestFile };
