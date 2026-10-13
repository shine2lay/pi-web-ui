/**
 * auth-lock-trace (#134): logs whatever holds pi's sign-in lock (auth.json) for 60 s or more,
 * as one line per hold, and changes nothing else.
 *
 * The first block is the canary against the installed SDK: it fails when pi's auth-storage.js
 * stops taking the auth.json lock through the proper-lockfile copy the trace wraps, so a pi update
 * can't turn the trace off silently. The rest checks the trace on a stand-in lock module: one line
 * per hold, results and errors passed through untouched, and no token, key or account value in
 * the line.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AUTH_LOCK_HOLD_LOG_MS,
	formatAuthLockLine,
	installAuthLockTrace,
	type LockfileApi,
	scrubAuthLockLine,
	sdkAuthLockTrace,
	sdkLockfileModule,
} from "../../server/auth-lock-trace.js";

const sdkCore = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core");

interface AuthBackend {
	withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T>;
}

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "auth-lock-trace-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("auth-lock-trace on the installed pi SDK (canary)", () => {
	it("pi's auth-storage.js still locks auth.json with proper-lockfile's lock and lockSync", () => {
		const source = readFileSync(join(sdkCore, "auth-storage.js"), "utf8");
		expect(source).toContain('import lockfile from "proper-lockfile";');
		expect(source).toContain("release = await lockfile.lock(this.authPath, {");
		expect(source).toContain("return lockfile.lockSync(path, { realpath: false });");
	});

	it("is installed at import on the copy the SDK uses, and sees the SDK's own holds", async () => {
		expect(sdkAuthLockTrace).not.toBeNull();
		const lockfile = sdkLockfileModule();
		expect(lockfile?.lock.name).toBe("tracedLock");
		expect(lockfile?.lockSync.name).toBe("tracedLockSync");

		const { FileAuthStorageBackend } = (await import(pathToFileURL(join(sdkCore, "auth-storage.js")).href)) as {
			FileAuthStorageBackend: new (path: string) => AuthBackend;
		};
		const backend = new FileAuthStorageBackend(join(tempDir(), "auth.json"));
		expect(sdkAuthLockTrace!.active()).toBe(0);
		const inAsync = await backend.withLockAsync(async () => ({ result: sdkAuthLockTrace!.active() }));
		expect(inAsync).toBe(1);
		const inSync = backend.withLock(() => ({ result: sdkAuthLockTrace!.active() }));
		expect(inSync).toBe(1);
		expect(sdkAuthLockTrace!.active()).toBe(0);
	});

	it("leaves locks on other files alone", async () => {
		const file = join(tempDir(), "models.json");
		writeFileSync(file, "{}");
		const release = await sdkLockfileModule()!.lock(file, { realpath: false });
		expect(sdkAuthLockTrace!.active()).toBe(0);
		await release();
	});

	it("waits 60 s before it logs", () => {
		expect(AUTH_LOCK_HOLD_LOG_MS).toBe(60_000);
	});
});

/** A stand-in for proper-lockfile that records calls and lets each test pick results. */
function fakeLockfile(): LockfileApi & { calls: unknown[][]; releases: unknown[][] } {
	const calls: unknown[][] = [];
	const releases: unknown[][] = [];
	const release = function (this: unknown, ...args: unknown[]) {
		releases.push([this, ...args]);
		return "released";
	};
	return {
		calls,
		releases,
		lock: async (...args: unknown[]) => {
			calls.push(args);
			return release;
		},
		lockSync: (...args: unknown[]) => {
			calls.push(args);
			return release;
		},
	};
}

function traced(thresholdMs = 60) {
	const lines: string[] = [];
	const lockfile = fakeLockfile();
	const trace = installAuthLockTrace(lockfile, { thresholdMs, log: (line) => lines.push(line) })!;
	return { lines, lockfile, trace };
}

describe("auth-lock-trace: one line per hold", () => {
	it("logs a hold past the threshold once, naming where the lock was taken", async () => {
		vi.useFakeTimers();
		const { lines, lockfile, trace } = traced();
		async function holderUnderTest() {
			return lockfile.lock("/home/x/.pi/agent/auth.json", { realpath: false });
		}
		const release = await holderUnderTest();
		expect(trace.active()).toBe(1);
		await vi.advanceTimersByTimeAsync(59);
		expect(lines).toEqual([]);
		await vi.advanceTimersByTimeAsync(10 * 60);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\[auth-lock\] held 60ms\+ by /);
		expect(lines[0]).toContain("holderUnderTest");
		expect(lines[0]).not.toContain("\n");
		expect(lines[0]).not.toContain("auth-lock-trace.ts");
		await release();
		await vi.advanceTimersByTimeAsync(10 * 60);
		expect(lines).toHaveLength(1);
		expect(trace.active()).toBe(0);
	});

	it("logs nothing for a hold released in time", async () => {
		vi.useFakeTimers();
		const { lines, lockfile, trace } = traced();
		const release = await lockfile.lock("/tmp/auth.json");
		await vi.advanceTimersByTimeAsync(30);
		await release();
		await vi.advanceTimersByTimeAsync(10 * 60);
		expect(lines).toEqual([]);
		expect(trace.active()).toBe(0);
	});

	it("logs each long hold once, sync holds too", async () => {
		vi.useFakeTimers();
		const { lines, lockfile } = traced();
		const first = await lockfile.lock("/tmp/a/auth.json");
		const second = lockfile.lockSync("/tmp/b/auth.json");
		await vi.advanceTimersByTimeAsync(10 * 60);
		expect(lines).toHaveLength(2);
		await first();
		second();
		await vi.advanceTimersByTimeAsync(10 * 60);
		expect(lines).toHaveLength(2);
	});

	it("ignores locks on other files", async () => {
		vi.useFakeTimers();
		const { lines, lockfile, trace } = traced();
		await lockfile.lock("/tmp/models.json");
		lockfile.lockSync("/tmp/auth.json.bak");
		await vi.advanceTimersByTimeAsync(10 * 60);
		expect(lines).toEqual([]);
		expect(trace.active()).toBe(0);
	});

	it("installs once per module", () => {
		const lockfile = fakeLockfile();
		const first = installAuthLockTrace(lockfile);
		const wrapped = lockfile.lock;
		expect(installAuthLockTrace(lockfile)).toBe(first);
		expect(lockfile.lock).toBe(wrapped);
	});
});

describe("auth-lock-trace: passes everything through untouched", () => {
	it("gives the original lock the same arguments and its result back", async () => {
		const { lockfile } = traced();
		const onCompromised = () => {};
		const options = { realpath: false, retries: 0, stale: 30_000, onCompromised };
		const release = await lockfile.lock("/tmp/auth.json", options);
		expect(lockfile.calls[0]).toEqual(["/tmp/auth.json", options]);
		expect(lockfile.calls[0][1]).toBe(options);
		const self = { me: 1 };
		expect(release.call(self, "x")).toBe("released");
		expect(lockfile.releases[0]).toEqual([self, "x"]);
	});

	it("returns the original promise itself for other files", () => {
		const promise = Promise.resolve(() => undefined);
		const lockfile: LockfileApi = { lock: () => promise, lockSync: () => () => undefined };
		installAuthLockTrace(lockfile, { log: () => {} });
		expect(lockfile.lock("/tmp/models.json")).toBe(promise);
	});

	it("rejects and throws the original errors and holds nothing", async () => {
		const busy = Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
		const lockfile: LockfileApi = {
			lock: () => Promise.reject(busy),
			lockSync: () => {
				throw busy;
			},
		};
		const trace = installAuthLockTrace(lockfile, { log: () => {} })!;
		await expect(lockfile.lock("/tmp/auth.json")).rejects.toBe(busy);
		expect(() => lockfile.lockSync("/tmp/auth.json")).toThrow(busy);
		expect(trace.active()).toBe(0);
	});

	it("passes a release's own promise and error back", async () => {
		const done = Promise.resolve();
		const broken = new Error("ENOTACQUIRED");
		let fail = false;
		const lockfile: LockfileApi = {
			lock: async () => () => {
				if (fail) throw broken;
				return done;
			},
			lockSync: () => () => undefined,
		};
		const trace = installAuthLockTrace(lockfile, { log: () => {} })!;
		const release = await lockfile.lock("/tmp/auth.json");
		expect(release()).toBe(done);
		fail = true;
		const again = await lockfile.lock("/tmp/auth.json");
		expect(() => again()).toThrow(broken);
		expect(trace.active()).toBe(0);
	});

	it("keeps a failing log away from the lock path", async () => {
		vi.useFakeTimers();
		const lockfile = fakeLockfile();
		installAuthLockTrace(lockfile, {
			thresholdMs: 60,
			log: () => {
				throw new Error("log broke");
			},
		});
		const release = await lockfile.lock("/tmp/auth.json");
		await vi.advanceTimersByTimeAsync(10 * 60);
		expect(release()).toBe("released");
	});
});

describe("auth-lock-trace: no token, key or account value in the line", () => {
	const token = "sk-ant-oat01-FAKEtokenVALUE1234567890abcdefXYZ_q-9";
	const refresh = "sk-ant-ort01-FAKErefreshVALUE0987654321ZYXwvu";
	const email = "owner.account@example.com";
	const accountId = "0f8fad5b-d9cb-469f-a165-70867728950e";
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NvdW50In0.c2lnbmF0dXJlLXZhbHVl";
	const opaque = "Zq3xK9mWv2LrT8pN4bY6cH1dJ5fG7sA0eQ";

	it("holds taken by code that has credentials in hand leave them out", async () => {
		vi.useFakeTimers();
		const { lines, lockfile } = traced();
		const credential = { type: "oauth", access: token, refresh, email, accountId, idToken: jwt, opaque };
		async function refreshUnderLock(cred: typeof credential) {
			return lockfile.lock(`/tmp/${cred.type}/auth.json`);
		}
		await refreshUnderLock(credential);
		await vi.advanceTimersByTimeAsync(10 * 60);
		expect(lines).toHaveLength(1);
		for (const value of [token, refresh, email, accountId, jwt, opaque]) expect(lines[0]).not.toContain(value);
	});

	it("scrubs credential-shaped text even when it shows up in a frame", async () => {
		vi.useFakeTimers();
		const { lines, lockfile } = traced();
		const where = `/tmp/${token}/${email}/${accountId}/${jwt}/${opaque}/holder.js`;
		// eslint-disable-next-line no-new-func
		const holder = new Function("lockfile", `return lockfile.lock("/tmp/auth.json");\n//# sourceURL=${where}`) as (
			l: LockfileApi,
		) => Promise<unknown>;
		await holder(lockfile);
		await vi.advanceTimersByTimeAsync(10 * 60);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("holder.js");
		for (const value of [token, refresh, email, accountId, jwt, opaque, "FAKEtoken", "eyJ"]) {
			expect(lines[0]).not.toContain(value);
		}
	});

	it("keeps ordinary frames readable", () => {
		const frame =
			"async FileAuthStorageBackend.withLockAsync (/home/x/projects/pi-web-ui/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js:129:35)";
		expect(scrubAuthLockLine(frame)).toBe(frame);
		const line = formatAuthLockLine(
			`Error: auth-lock\n    at ${frame}\n    at file:///srv/app/model-runtime.js:12:3`,
			60_000,
		);
		expect(line).toBe(`[auth-lock] held 60s+ by ${frame} <- /srv/app/model-runtime.js:12:3`);
	});
});
