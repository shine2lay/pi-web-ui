"use strict";
/**
 * sealed-fence.cjs: the fence of a sealed test run (see scripts/sealed.sh).
 *
 * sealed.sh puts `--require <this file>` into NODE_OPTIONS, so every node process of the run loads
 * it first. This machine can't use bwrap/unshare (no user namespaces), so the fence works inside
 * node: it wraps the path-taking functions of `fs` / `fs/promises`, the `child_process` launchers
 * and `net` connects.
 *
 * - A call on a path under one of the real folders in PI_SEALED_FORBID (the real ~/.pi,
 *   ~/.pi-web-ui, ~/.pi-scheduler) is a *fence hit*. Reading installed add-on code under
 *   PI_SEALED_READONLY (~/.pi/agent/npm, ~/.pi/agent/git) is allowed; writing there is a hit.
 * - Connecting to a port in PI_SEALED_LIVE_PORTS on this machine (the live pi-web-ui) is a hit.
 * - A child started with its own `env` still gets NODE_OPTIONS (this file), the PI_SEALED_*
 *   settings, HOME and TMPDIR, so the fence reaches every node descendant.
 *
 * Every hit is appended to PI_SEALED_FENCE_LOG (one JSON line; sealed.sh lists them at the end
 * and fails the run). In `enforce` mode the call also fails: sync calls throw, callbacks get the
 * error, promises reject, sockets are destroyed. The error is EACCES and names the path.
 * In `report` mode the call goes through (used for the inventory of a test suite).
 *
 * Env: PI_SEALED_FENCE=report|enforce (unset: this file does nothing), PI_SEALED_FORBID and
 * PI_SEALED_READONLY (folders separated by ":"), PI_SEALED_LIVE_PORTS (ports separated by ","),
 * PI_SEALED_FENCE_LOG, PI_SEALED_REAL_AGENT_DIR (for the real-chat clone helper).
 */
const KEY = Symbol.for("pi.sealed.fence");
const mode = process.env.PI_SEALED_FENCE;
if ((mode === "report" || mode === "enforce") && !globalThis[KEY]) install(mode);

function install(mode) {
	const fs = require("node:fs");
	const path = require("node:path");
	const util = require("node:util");
	const { fileURLToPath } = require("node:url");

	const enforce = mode === "enforce";
	const list = (v, sep) =>
		(v ?? "")
			.split(sep)
			.map((s) => s.trim())
			.filter(Boolean);
	const forbid = list(process.env.PI_SEALED_FORBID, ":").map((p) => path.resolve(p));
	const readonly = list(process.env.PI_SEALED_READONLY, ":").map((p) => path.resolve(p));
	const livePorts = new Set(
		list(process.env.PI_SEALED_LIVE_PORTS, ",")
			.map(Number)
			.filter((n) => Number.isInteger(n) && n > 0),
	);
	const logFile = process.env.PI_SEALED_FENCE_LOG;
	const realAgentDir = process.env.PI_SEALED_REAL_AGENT_DIR
		? path.resolve(process.env.PI_SEALED_REAL_AGENT_DIR)
		: undefined;

	// The originals, for the fence's own use (logging, the clone helper).
	const orig = {
		appendFileSync: fs.appendFileSync,
		writeSync: fs.writeSync,
		readFileSync: fs.readFileSync,
		readdirSync: fs.readdirSync,
		statSync: fs.statSync,
	};

	const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
	const forbidden = (abs) => forbid.some((r) => within(abs, r));
	const inReadonly = (abs) => readonly.some((r) => within(abs, r));
	// Deleting or moving a folder that *contains* a real folder (e.g. rm -r of the real home).
	const containsForbidden = (abs) => forbid.some((r) => within(r, abs));

	function toPath(arg) {
		if (typeof arg === "string") return arg;
		if (Buffer.isBuffer(arg)) return arg.toString();
		if (arg instanceof URL) return arg.protocol === "file:" ? fileURLToPath(arg) : undefined;
		return undefined;
	}
	function absolute(p, base) {
		if (path.isAbsolute(p)) return path.normalize(p);
		try {
			return path.resolve(base ?? process.cwd(), p);
		} catch {
			return undefined; // the cwd is gone: a relative path can't reach a real folder by name
		}
	}

	let doorOpen = false;
	const seen = new Set();
	function record(rec) {
		if (!logFile) return;
		const key = `${rec.kind}\0${rec.fn}\0${rec.path}`;
		if (seen.has(key)) return;
		seen.add(key);
		const line = JSON.stringify({
			pid: process.pid,
			script: process.argv[1] ?? process.argv0,
			mode,
			...rec,
			at: rec.allowed ? undefined : caller(),
		});
		try {
			orig.appendFileSync(logFile, `${line}\n`);
		} catch {
			/* the log is best effort */
		}
	}
	function caller() {
		const frames = (new Error().stack ?? "").split("\n").slice(1);
		return frames
			.map((f) => f.trim().replace(/^at /, ""))
			.filter((f) => !f.includes("sealed-fence.cjs") && !f.includes("node:internal"))
			.slice(0, 3)
			.join(" | ");
	}

	/**
	 * Judge one access. Returns undefined when it may go on, or the EACCES error (enforce mode).
	 * kind: read | write | delete | target (a symlink's target) | cwd (a child's working folder).
	 */
	function judge(fn, raw, kind, base) {
		if (doorOpen) return undefined; // the clone helper's own read-only calls (below)
		const p = toPath(raw);
		if (p === undefined) return undefined;
		const abs = absolute(p, base);
		if (abs === undefined) return undefined;
		let hit = forbidden(abs);
		if (hit && (kind === "read" || kind === "target") && inReadonly(abs)) {
			record({ kind: "readonly", fn, path: readonlyRoot(abs), allowed: true });
			return undefined;
		}
		if (!hit && kind === "delete" && containsForbidden(abs)) hit = true;
		if (!hit) return undefined;
		record({ kind, fn, path: abs });
		if (!enforce) return undefined;
		const verb = kind === "cwd" ? "run a program in" : kind === "target" ? "link to" : kind;
		const err = new Error(
			`sealed test run: ${fn}() would ${verb} the real ${abs} (tests must use their own temp folders)`,
		);
		err.code = "EACCES";
		err.errno = -13;
		err.syscall = fn;
		err.path = abs;
		try {
			orig.writeSync(2, `\n[sealed] BLOCKED ${fn}(${abs}): ${kind} of a real folder\n`);
		} catch {
			/* stderr closed */
		}
		return err;
	}
	// For the readonly log: the package folder, not every file in it.
	function readonlyRoot(abs) {
		const root = readonly.find((r) => within(abs, r));
		const rest = path.relative(root, abs).split(path.sep);
		const depth = rest[0] === "node_modules" ? (rest[1]?.startsWith("@") ? 3 : 2) : 1;
		return path.join(root, ...rest.slice(0, depth));
	}

	// ── fs ──────────────────────────────────────────────────────────────────────────────────
	const R = "read";
	const W = "write";
	const D = "delete";
	const T = "target";
	/** name → [[argIndex, kind], …]; "open" = read or write depending on the flags. */
	const FS_ARGS = {
		access: [[0, R]],
		exists: [[0, R]],
		readFile: [[0, R]],
		readdir: [[0, R]],
		stat: [[0, R]],
		lstat: [[0, R]],
		statfs: [[0, R]],
		readlink: [[0, R]],
		realpath: [[0, R]],
		opendir: [[0, R]],
		open: "open",
		writeFile: [[0, W]],
		appendFile: [[0, W]],
		mkdir: [[0, W]],
		mkdtemp: [[0, W]],
		chmod: [[0, W]],
		lchmod: [[0, W]],
		chown: [[0, W]],
		lchown: [[0, W]],
		utimes: [[0, W]],
		lutimes: [[0, W]],
		truncate: [[0, W]],
		rm: [[0, D]],
		rmdir: [[0, D]],
		unlink: [[0, D]],
		rename: [
			[0, D],
			[1, W],
		],
		copyFile: [
			[0, R],
			[1, W],
		],
		cp: [
			[0, R],
			[1, W],
		],
		link: [
			[0, W],
			[1, W],
		],
		symlink: [
			[0, T],
			[1, W],
		],
	};
	const STREAMS = { createReadStream: R, createWriteStream: W, watch: R, watchFile: R };

	function openKind(flags) {
		// open(path, cb) / open(path, undefined, mode): no flags means "r".
		if (typeof flags !== "string" && typeof flags !== "number") return R;
		if (typeof flags === "number") {
			const c = fs.constants;
			return flags & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_APPEND) ? W : R;
		}
		return /[wa+]/.test(String(flags)) ? W : R;
	}
	function checks(spec, args) {
		if (spec === "open") return [[0, openKind(args[1])]];
		return spec;
	}
	function firstError(fn, spec, args) {
		for (const [i, kind] of checks(spec, args)) {
			// A symlink target is relative to the link's folder.
			const base =
				kind === T && typeof toPath(args[1]) === "string" ? path.dirname(absolute(toPath(args[1])) ?? ".") : undefined;
			const err = judge(fn, args[i], kind, base);
			if (err) return err;
		}
		return undefined;
	}
	function copyProps(from, to, skip) {
		for (const key of Reflect.ownKeys(from)) {
			if (key === "length" || key === "name" || key === "prototype" || key === skip) continue;
			const d = Object.getOwnPropertyDescriptor(from, key);
			try {
				Object.defineProperty(to, key, d);
			} catch {
				/* non-configurable */
			}
		}
		return to;
	}
	function wrapCallback(obj, name, spec) {
		const original = obj[name];
		if (typeof original !== "function") return;
		const wrapped = function (...args) {
			const err = firstError(name, spec, args);
			if (err) {
				const cb = args[args.length - 1];
				if (name === "exists" || typeof cb !== "function") throw err;
				process.nextTick(cb, err);
				return undefined;
			}
			return Reflect.apply(original, this, args);
		};
		obj[name] = copyProps(original, wrapped);
		if (typeof original.native === "function") wrapped.native = wrapSimple(original.native, `${name}.native`, spec, "callback");
	}
	function wrapSimple(original, name, spec, style) {
		return copyProps(original, function (...args) {
			const err = firstError(name, spec, args);
			if (err) {
				if (style === "promise") return Promise.reject(err);
				if (style === "callback") {
					const cb = args[args.length - 1];
					if (typeof cb === "function") {
						process.nextTick(cb, err);
						return undefined;
					}
				}
				throw err;
			}
			return Reflect.apply(original, this, args);
		});
	}
	for (const [name, spec] of Object.entries(FS_ARGS)) {
		wrapCallback(fs, name, spec);
		const sync = `${name}Sync`;
		if (typeof fs[sync] === "function") {
			const original = fs[sync];
			fs[sync] = wrapSimple(original, sync, spec, "sync");
			if (typeof original.native === "function") fs[sync].native = wrapSimple(original.native, `${sync}.native`, spec, "sync");
		}
		if (fs.promises && typeof fs.promises[name] === "function") {
			fs.promises[name] = wrapSimple(fs.promises[name], `promises.${name}`, spec, "promise");
		}
	}
	for (const [name, kind] of Object.entries(STREAMS)) {
		if (typeof fs[name] === "function") fs[name] = wrapSimple(fs[name], name, [[0, kind]], "sync");
	}
	if (fs.promises && typeof fs.promises.watch === "function") {
		fs.promises.watch = wrapSimple(fs.promises.watch, "promises.watch", [[0, R]], "sync");
	}

	// ── child_process ───────────────────────────────────────────────────────────────────────
	const cp = require("node:child_process");
	const fenceFile = __filename;
	const requireFlag = /\s/.test(fenceFile) ? `--require "${fenceFile}"` : `--require ${fenceFile}`;
	const CARRY = [
		"PI_SEALED",
		"PI_SEALED_ROOT",
		"PI_SEALED_FENCE",
		"PI_SEALED_FORBID",
		"PI_SEALED_READONLY",
		"PI_SEALED_LIVE_PORTS",
		"PI_SEALED_FENCE_LOG",
		"PI_SEALED_REAL_AGENT_DIR",
		"HOME",
		"TMPDIR",
	];
	function sealEnv(env) {
		const out = { ...env };
		const opts = out.NODE_OPTIONS ?? "";
		if (!opts.includes(fenceFile)) out.NODE_OPTIONS = `${requireFlag} ${opts}`.trim();
		for (const k of CARRY) if (out[k] === undefined && process.env[k] !== undefined) out[k] = process.env[k];
		return out;
	}
	/** Fix the options object of a launcher call (in place on a copy); returns an error or undefined. */
	function sealArgs(fn, args) {
		const at = args.findIndex((a, i) => i > 0 && a !== null && typeof a === "object" && !Array.isArray(a));
		if (at === -1) return { args };
		const options = { ...args[at] };
		if (options.cwd !== undefined) {
			const err = judge(fn, options.cwd, "cwd");
			if (err) return { err };
		}
		if (options.env && typeof options.env === "object") options.env = sealEnv(options.env);
		const copy = args.slice();
		copy[at] = options;
		return { args: copy };
	}
	for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
		const original = cp[name];
		if (typeof original !== "function") continue;
		const launcher = function (...args) {
			const { args: fixed, err } = sealArgs(name, args);
			if (err) {
				const cb = args[args.length - 1];
				if ((name === "exec" || name === "execFile") && typeof cb === "function") {
					process.nextTick(cb, err, "", "");
					return undefined;
				}
				throw err;
			}
			return Reflect.apply(original, this, fixed);
		};
		const wrapped = copyProps(original, launcher, util.promisify.custom);
		const custom = original[util.promisify.custom];
		if (typeof custom === "function") {
			Object.defineProperty(wrapped, util.promisify.custom, {
				value: (...args) => {
					const { args: fixed, err } = sealArgs(name, args);
					return err ? Promise.reject(err) : custom(...fixed);
				},
			});
		}
		cp[name] = wrapped;
	}

	// ── net: the live pi-web-ui port ────────────────────────────────────────────────────────
	if (livePorts.size > 0) {
		const net = require("node:net");
		const os = require("node:os");
		const localNames = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::", os.hostname()]);
		const originalConnect = net.Socket.prototype.connect;
		net.Socket.prototype.connect = function (...args) {
			let port;
			let host;
			let ipcPath;
			const first = Array.isArray(args[0]) ? args[0][0] : args[0];
			if (first !== null && typeof first === "object") {
				port = first.port;
				host = first.host;
				ipcPath = first.path;
			} else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
				port = first;
				host = typeof args[1] === "string" ? args[1] : undefined;
			}
			const n = Number(port);
			if (ipcPath === undefined && livePorts.has(n) && (host === undefined || localNames.has(String(host)) || String(host).startsWith("127."))) {
				record({ kind: "connect", fn: "net.connect", path: `${host ?? "localhost"}:${n}` });
				if (enforce) {
					const err = new Error(
						`sealed test run: connecting to ${host ?? "localhost"}:${n} (the live pi-web-ui) is not allowed; start a test server`,
					);
					err.code = "EACCES";
					try {
						orig.writeSync(2, `\n[sealed] BLOCKED connect to the live port ${n}\n`);
					} catch {
						/* stderr closed */
					}
					process.nextTick(() => this.destroy(err));
					return this;
				}
			}
			return Reflect.apply(originalConnect, this, args);
		};
	}

	require("node:module").syncBuiltinESMExports();

	// ── the sanctioned way to read a real chat: tests/lib/clone-real-chat.mjs ─────────────────
	const sessionsDir = realAgentDir ? path.join(realAgentDir, "sessions") : undefined;
	/** Run fn with the fence stepping aside (sync only, so nothing else can slip through meanwhile). */
	function throughDoor(fn) {
		doorOpen = true;
		try {
			return fn();
		} finally {
			doorOpen = false;
		}
	}
	function realSessionFile(p) {
		const abs = path.resolve(String(p));
		// A chat file, or its billion-context-pi sidecar (<chat>.jsonl.acp.json).
		if (!sessionsDir || !within(abs, sessionsDir) || !/\.jsonl(\.acp\.json)?$/.test(abs)) {
			throw new Error(`sealed fence: ${abs} is not a chat file under the real sessions folder`);
		}
		return abs;
	}
	globalThis[KEY] = Object.freeze({
		mode,
		/** The real chat files: [{ path, size, mtimeMs }] (read-only listing). */
		listRealChats() {
			if (!sessionsDir) return [];
			const out = [];
			let dirs = [];
			try {
				dirs = throughDoor(() => orig.readdirSync(sessionsDir, { withFileTypes: true }));
			} catch {
				return [];
			}
			throughDoor(() => {
				for (const d of dirs) {
					if (!d.isDirectory()) continue;
					const dir = path.join(sessionsDir, d.name);
					let files = [];
					try {
						files = orig.readdirSync(dir);
					} catch {
						continue;
					}
					for (const f of files) {
						if (!f.endsWith(".jsonl")) continue;
						const file = path.join(dir, f);
						try {
							const st = orig.statSync(file);
							out.push({ path: file, size: st.size, mtimeMs: st.mtimeMs });
						} catch {
							/* gone meanwhile */
						}
					}
				}
			});
			record({ kind: "clone-list", fn: "listRealChats", path: sessionsDir, allowed: true });
			return out;
		},
		/** The bytes of one real chat file, or of its .acp.json sidecar (read-only). */
		readRealChat(p) {
			const abs = realSessionFile(p);
			record({ kind: "clone-read", fn: "readRealChat", path: abs, allowed: true });
			return throughDoor(() => orig.readFileSync(abs));
		},
	});
}
