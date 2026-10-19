// Ops #253: the guard folder's own files: current.json's switch reaches the disk (Architecture A2). Real host, store and
// native record (role-message-guard-host-harness.ts); node:fs passes through, noting the renames and flushes a test
// looks at.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { A, data, send, useGuardWorld, world } from "./role-message-guard-host-harness.js";

/** What node:fs was asked to do while `on`: "rename <to>" and "fsync <the path the fd was opened on>". */
const fsx = vi.hoisted(() => ({ on: false, calls: [] as string[], fds: new Map<number, string>() }));
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const wrapped = {
		openSync: (...args: Parameters<typeof real.openSync>) => {
			const fd = real.openSync(...args);
			fsx.fds.set(fd, String(args[0]));
			return fd;
		},
		fsyncSync: (fd: number) => {
			real.fsyncSync(fd);
			if (fsx.on) fsx.calls.push(`fsync ${fsx.fds.get(fd)}`);
		},
		renameSync: (...args: Parameters<typeof real.renameSync>) => {
			real.renameSync(...args);
			if (fsx.on) fsx.calls.push(`rename ${String(args[1])}`);
		},
	};
	return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

useGuardWorld();

const guard = () => join(data, "role-message-guard");

describe("current.json's switch reaches the disk (Ops #253, Architecture A2)", () => {
	it("each rename of current.json is followed at once by a flush of the guard folder", async () => {
		fsx.calls.length = 0;
		fsx.on = true;
		try {
			// A first start (it names gen-1 before and after making it), a rotation at start, one after a send.
			const w = await world(undefined, { rotateBytes: 1 });
			expect(await send(w, "alpha", A, "beta", { kind: "fyi" }, "")).toMatchObject({ ok: true });
		} finally {
			fsx.on = false;
		}
		expect(JSON.parse(readFileSync(join(guard(), "current.json"), "utf8"))).toEqual({ gen: 3 });
		const switched = `rename ${join(guard(), "current.json")}`;
		const at = fsx.calls.flatMap((c, i) => (c === switched ? [i] : []));
		expect(at).toHaveLength(4);
		expect(at.map((i) => fsx.calls[i + 1])).toEqual(at.map(() => `fsync ${guard()}`));
	});
});
