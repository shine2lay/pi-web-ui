import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { AgentService, ClientSession } from "../../server/agent-service.js";
import type { ServerMessage } from "../../server/protocol.js";
import { defaultSessionDirPath } from "../../server/session-index.js";
import { HANG_GUARD_MS } from "./load-independent.js";

/**
 * open-chain (Ops #641, H-OPEN-CHAIN-1). On 2026-10-29 one chat open never finished and, because every open
 * (a new window, New chat, opening a past chat, a folder switch) waits its turn on one server-wide queue with no
 * bound, nobody could start or open a chat for 78 minutes, with nothing in the log.
 *
 * This wedges one open of a look-only window on the real queue (ClientSession's) and then asks for what the owner
 * couldn't do that day: a new window, New chat, opening a past chat. Before the fix none of them ever completes
 * (the test fails at its first check); after it, the wedged open is named in the log, gives way at its bound, the
 * others go ahead, and no transcript is written (sha256 of every chat file before and after).
 * Real AgentService and ClientSession on temp folders; no model, no port.
 */

type Fake = { clientId: string; cwd: string; switchHave: unknown; [k: string]: unknown };
type Timing = { boundMs: number; slowAfterMs: number; slowEveryMs: number };
const timingHost = ClientSession as unknown as { openChainTiming?: Timing };

function sha(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function chatFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl")) out.push(p);
		}
	};
	walk(dir);
	return out.sort();
}
function hashes(files: string[]): Record<string, string> {
	return Object.fromEntries(files.map((f) => [f, `${statSync(f).size}:${sha(f)}`]));
}

/** Resolves with the value, or with "never" when `ms` passes first (the failure before the fix). */
function orNever<T>(p: Promise<T>, ms: number): Promise<T | "never"> {
	return Promise.race([p, new Promise<"never">((r) => setTimeout(() => r("never"), ms).unref?.())]);
}

describe("open-chain: one stuck open no longer blocks every window", () => {
	let root: string;
	let projectDir: string;
	let sessionsDir: string;
	let savedTiming: Timing | undefined;
	let warn: MockInstance<typeof console.warn>;

	const transcript = (name: string, text: string, minute: number): string => {
		const file = join(sessionsDir, `2026-10-29T14-${String(minute).padStart(2, "0")}-00-000Z_${name}.jsonl`);
		const ts = `2026-10-29T14:${String(minute).padStart(2, "0")}:00.000Z`;
		const lines = [
			{ type: "session", version: 3, id: name, timestamp: ts, cwd: projectDir },
			{
				type: "message",
				id: `${name.slice(0, 4)}0001`,
				parentId: null,
				timestamp: ts,
				message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(ts) },
			},
			// Like every real chat: its thinking level is set (pi's own open appends one to a chat that has none,
			// which is pi's behaviour, not the queue's; with it there, any write at all shows in the hash).
			{
				type: "thinking_level_change",
				id: `${name.slice(0, 4)}0002`,
				parentId: `${name.slice(0, 4)}0001`,
				timestamp: ts,
				thinkingLevel: "off",
			},
		];
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		// "Most recent" goes by the file's time: set it, so the new window's pick is the one named most recent (the
		// stuck open's file is the oldest; a new window that would open that one waits for it, by design).
		const at = new Date(Date.parse(ts));
		utimesSync(file, at, at);
		return file;
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "open-chain-wedge-"));
		projectDir = join(root, "project");
		mkdirSync(projectDir, { recursive: true });
		sessionsDir = defaultSessionDirPath(projectDir);
		mkdirSync(sessionsDir, { recursive: true });
		savedTiming = timingHost.openChainTiming;
		warn = vi.spyOn(console, "warn");
	});

	afterEach(() => {
		timingHost.openChainTiming = savedTiming;
		warn.mockRestore();
		rmSync(root, { recursive: true, force: true });
		rmSync(sessionsDir, { recursive: true, force: true });
	});

	it("a wedged open is named in the log and gives way; a new window, New chat and a past chat still open; no transcript written", async () => {
		const pastChat = transcript("aaaaaaaa-0000-4000-8000-000000000001", "an older chat", 1);
		const recentChat = transcript("aaaaaaaa-0000-4000-8000-000000000002", "the most recent chat", 2);
		const wedgedTarget = transcript("aaaaaaaa-0000-4000-8000-000000000003", "the chat the stuck open wanted", 0);
		const before = hashes(chatFiles(sessionsDir));
		expect(Object.keys(before)).toHaveLength(3);

		// A short bound only for the job that wedges (read when its turn comes); the later opens get the hang guard,
		// so a busy machine can't make an honest open give way here.
		timingHost.openChainTiming = { boundMs: 400, slowAfterMs: 100, slowEveryMs: 100 };
		let wedgeStarted = false;
		let unwedge!: () => void;
		const wedgedWindow = Object.create(ClientSession.prototype) as Fake;
		Object.assign(wedgedWindow, {
			clientId: "ops-live-look-632",
			cwd: projectDir,
			switchHave: null,
			failed: [] as string[],
			switchSessionNow: () => {
				wedgeStarted = true;
				return new Promise<void>((r) => (unwedge = r));
			},
			emitSwitchFailed(_target: unknown, text: string) {
				(this.failed as string[]).push(text);
			},
		});
		const wedged = (ClientSession.prototype.switchSession as (this: Fake, p: string) => Promise<void>).call(
			wedgedWindow,
			wedgedTarget,
		);
		await vi.waitFor(() => expect(wedgeStarted).toBe(true));
		timingHost.openChainTiming = { boundMs: HANG_GUARD_MS, slowAfterMs: HANG_GUARD_MS, slowEveryMs: HANG_GUARD_MS };

		// A new window: before the fix it waits forever behind the stuck open.
		const svc = new AgentService(projectDir, join(root, "client-state.json"));
		const sent: ServerMessage[] = [];
		const cs = await orNever(
			svc.attach("owner-tab", (m) => sent.push(m)),
			60_000,
		);
		expect(cs, "a new window never got its chat while one open was stuck").not.toBe("never");
		if (cs === "never") return;

		// The stuck open was named in the log, then gave way; its own caller got an honest failure.
		const logged = warn.mock.calls.map((c) => String(c[0]));
		expect(logged.some((l) => l.includes("[open-chain] still running after") && l.includes("ops-live-look-632"))).toBe(
			true,
		);
		expect(logged.some((l) => l.includes("[open-chain] gave way after") && l.includes(`open ${wedgedTarget}`))).toBe(
			true,
		);
		await wedged;
		expect((wedgedWindow.failed as string[])[0]).toContain("Opening timed out");

		// New chat, then the past chat, from the new window.
		expect(await orNever(cs.newChat(), 60_000)).toBe(true);
		await orNever(cs.switchSession(pastChat), 60_000);
		expect(
			sent.some((m) => m.type === "switch_done" && (m as { target?: { path?: string } }).target?.path === pastChat),
		).toBe(true);
		expect(cs.session.sessionFile).toBe(pastChat);

		// The stuck open ends late: it lets go of its window and is logged.
		unwedge();
		await vi.waitFor(() =>
			expect(
				warn.mock.calls.some((c) => String(c[0]).includes("ended") && String(c[0]).includes("ops-live-look-632")),
			).toBe(true),
		);

		// No transcript was written, truncated or rewritten (a new chat's file, if any, is new, not a changed one).
		const after = hashes(chatFiles(sessionsDir));
		for (const [file, h] of Object.entries(before)) expect(after[file], file).toBe(h);
		expect(recentChat in after).toBe(true);
		await svc.disposeAll?.();
	});
});
