import { afterEach, describe, expect, it, vi } from "vitest";

import { BgServerTracker } from "../../server/bg-servers.js";
import { snapshotListeningPorts } from "../../server/process-utils.js";
import type { ServerMessage } from "../../server/protocol.js";

/**
 * Ops #699 (PATCHES.md "port-snapshots-no-spawn"): outside Windows, snapshotListeningPorts spawns nothing and
 * returns what the lsof parser it replaces returned for the same machine state: an empty map, because that
 * parser read the port from a line's last token, which lsof always prints as the TCP state "(LISTEN)".
 * Every bash tool call used to spawn lsof twice for that empty answer.
 */

const childProcess = vi.hoisted(() => ({
	calls: [] as Array<{ file: string; args: readonly string[] }>,
	stdout: "",
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: (
			file: string,
			args: readonly string[],
			_options: unknown,
			callback: (err: Error | null, stdout: string) => void,
		) => {
			childProcess.calls.push({ file, args });
			void Promise.resolve().then(() => callback(null, childProcess.stdout));
			return {};
		},
	};
});

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function onPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { ...realPlatform, value: platform });
}

afterEach(() => {
	Object.defineProperty(process, "platform", realPlatform);
	childProcess.calls.length = 0;
	childProcess.stdout = "";
	vi.useRealTimers();
});

/** The POSIX parser of snapshotListeningPorts before Ops #699, verbatim (server/process-utils.ts at a3b635cb). */
function removedLsofParser(out: string): Map<number, number> {
	const m = new Map<number, number>();
	for (const line of out.split(/\r?\n/).slice(1)) {
		const p = line.trim().split(/\s+/);
		if (p.length >= 9) {
			// NAME column tail: "*:5173 (LISTEN)" or "[::1]:5173 (LISTEN)"
			const mm = (p[p.length - 1] ?? "").match(/(\d+)\)?\s*$/);
			const port = mm ? Number(mm[1]) : NaN;
			const pid = Number(p[1]);
			if (Number.isFinite(port) && Number.isFinite(pid)) m.set(port, pid);
		}
	}
	return m;
}

const HEADER = "COMMAND       PID     USER   FD   TYPE    DEVICE SIZE/OFF NODE NAME";

/**
 * Output of the exact command the old code ran, `lsof -iTCP -sTCP:LISTEN -P -n`, for known machine states.
 * lsof prints the TCP state after every TCP address unless given -T (its man page: "the default is
 * equivalent to -Ts"), and -sTCP:LISTEN keeps only listening sockets, so every line ends in "(LISTEN)".
 */
const LSOF_STATES: Record<string, string> = {
	// This machine, 2026-10-31 19:12 PDT, lsof 4.95.0 run by the server's user: IPv4 and IPv6 sockets of own
	// processes, the live pi-web-ui (8787) among them. Other users' sockets don't show without root.
	"captured live, own processes, IPv4 and IPv6": [
		HEADER,
		"x11vnc       2713 shinelay    8u  IPv4     31303      0t0  TCP 127.0.0.1:5900 (LISTEN)",
		"x11vnc       2713 shinelay    9u  IPv6     31307      0t0  TCP [::1]:5900 (LISTEN)",
		"websockif    2714 shinelay    3u  IPv4     36184      0t0  TCP 127.0.0.1:6080 (LISTEN)",
		"python       2736 shinelay   13u  IPv4     67302      0t0  TCP 172.21.0.1:8097 (LISTEN)",
		"python3      2737 shinelay    3u  IPv4     14265      0t0  TCP 127.0.0.1:8434 (LISTEN)",
		"python       2740 shinelay    3u  IPv4     14283      0t0  TCP 127.0.0.1:8190 (LISTEN)",
		"node        40781 shinelay   21u  IPv4 299898493      0t0  TCP 127.0.0.1:17318 (LISTEN)",
		"node        90210 shinelay   24u  IPv4 910182965      0t0  TCP 127.0.0.1:8650 (LISTEN)",
		"standee    703603 shinelay    3u  IPv4 678680052      0t0  TCP 127.0.0.1:8470 (LISTEN)",
		"node      4147296 shinelay   24u  IPv4 894370810      0t0  TCP 127.0.0.1:8787 (LISTEN)",
		"node      4147296 shinelay   92u  IPv4 895507345      0t0  TCP 127.0.0.1:9229 (LISTEN)",
		"",
	].join("\n"),
	// A dev server the agent left running: wildcard IPv4 and IPv6 binds, a socket shared by a parent and its
	// forked worker, an IPv6-only port.
	"agent dev server, wildcard binds and a shared socket": [
		HEADER,
		"node      812345 shinelay   23u  IPv4 912345678      0t0  TCP *:5173 (LISTEN)",
		"node      812345 shinelay   24u  IPv6 912345679      0t0  TCP *:5173 (LISTEN)",
		"node      812350 shinelay   21u  IPv4 912345700      0t0  TCP *:3000 (LISTEN)",
		"node      812351 shinelay   21u  IPv4 912345700      0t0  TCP *:3000 (LISTEN)",
		"python3   812400 shinelay    5u  IPv6 912345800      0t0  TCP [::]:8080 (LISTEN)",
		"vite      812500 shinelay   30u  IPv6 912345900      0t0  TCP [::1]:4173 (LISTEN)",
		"",
	].join("\n"),
	// lsof run with root rights also lists other users' processes.
	"foreign pids (root's view)": [
		HEADER,
		"systemd-r     812 systemd-resolve   14u  IPv4  19890      0t0  TCP 127.0.0.53:53 (LISTEN)",
		"sshd         1520            root    3u  IPv4  21002      0t0  TCP *:22 (LISTEN)",
		"sshd         1520            root    4u  IPv6  21004      0t0  TCP *:22 (LISTEN)",
		"cupsd        1601            root    7u  IPv6  22110      0t0  TCP [::1]:631 (LISTEN)",
		"node      4147296        shinelay   24u  IPv4 894370810      0t0  TCP 127.0.0.1:8787 (LISTEN)",
		"",
	].join("\n"),
	// Only connected sockets (no listener): lsof's LISTEN filter leaves nothing, not even the header.
	"nothing listening": "",
};

describe("snapshotListeningPorts outside Windows (Ops #699)", () => {
	for (const platform of ["linux", "darwin", "freebsd"] as const) {
		it(`spawns nothing on ${platform} and returns an empty map`, async () => {
			onPlatform(platform);
			childProcess.stdout = LSOF_STATES["captured live, own processes, IPv4 and IPv6"];

			const ports = await snapshotListeningPorts();

			expect(childProcess.calls).toEqual([]);
			expect([...ports]).toEqual([]);
		});
	}

	for (const [state, lsofOutput] of Object.entries(LSOF_STATES)) {
		it(`gives the removed lsof parser's answer for the same state: ${state}`, async () => {
			onPlatform("linux");
			childProcess.stdout = lsofOutput;
			const listening = lsofOutput.split("\n").filter((line) => line.endsWith("(LISTEN)")).length;
			expect(listening).toBe(state === "nothing listening" ? 0 : lsofOutput.split("\n").length - 2);

			const before = removedLsofParser(lsofOutput);
			const now = await snapshotListeningPorts();

			expect([...now]).toEqual([...before]);
			expect(now.size).toBe(0);
		});
	}
});

describe("snapshotListeningPorts on Windows keeps its netstat snapshot", () => {
	it("parses netstat's LISTENING rows into port -> pid", async () => {
		onPlatform("win32");
		childProcess.stdout = [
			"",
			"Active Connections",
			"",
			"  Proto  Local Address          Foreign Address        State           PID",
			"  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1040",
			"  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       12345",
			"  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     12345",
			"  TCP    [::]:8080              [::]:0                 LISTENING       4321",
			"",
		].join("\r\n");

		const ports = await snapshotListeningPorts();

		expect(childProcess.calls).toEqual([{ file: "netstat", args: ["-ano", "-p", "tcp"] }]);
		expect([...ports]).toEqual([
			[135, 1040],
			[5173, 12345],
			[8080, 4321],
		]);
	});
});

describe("BgServerTracker around a bash run on Linux", () => {
	// The panel's answer (nothing recorded, nothing sent) is checked before the spawns, so on the old code this
	// fails only on its two lsof runs: what a chat sees is the same before and after Ops #699.
	it("records nothing, sends nothing and spawns nothing", async () => {
		onPlatform("linux");
		vi.useFakeTimers();
		childProcess.stdout = LSOF_STATES["agent dev server, wildcard binds and a shared socket"];
		const sent: ServerMessage[] = [];
		const bg = new BgServerTracker({ emit: (m) => sent.push(m), flushSnapshot: () => {}, isDisposed: () => false });

		bg.snapshotBefore();
		const after = bg.trackAfterBash();
		await vi.advanceTimersByTimeAsync(1500);
		await after;
		await bg.refresh();

		expect(bg.list()).toEqual([]);
		expect(sent).toEqual([]);
		expect(childProcess.calls).toEqual([]);
	});
});
