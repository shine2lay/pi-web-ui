/**
 * chat-open-speed — the one read of a chat file that decides whether it may open the fast way
 * (server/transcript-scan.ts).
 *
 * What must hold, or a chat opens wrong instead of fast:
 *  - the messages it finds are EXACTLY the ones the pi SDK loads from the same file: the current
 *    branch, a rewind's branch, everything after the newest compaction, the summary in front of it,
 *    context edits applied, a half-written last line skipped;
 *  - anything the file repair would touch is spotted and sent down the old path instead: a leftover
 *    compaction marker, a repeated id, a parent loop, a tool call with no result at the end, an
 *    older file version, a missing header;
 *  - it never writes: the file on disk is byte for byte the same afterwards.
 */

import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPACTION_PENDING_TYPE } from "../../server/compaction-markers.js";
import { contextMessagesOf, openScannedSession, scanTranscriptFile } from "../../server/transcript-scan.js";

const dir = mkdtempSync(join(tmpdir(), "pi-web-transcript-scan-"));
let n = 0;

const header = (over: Record<string, unknown> = {}) => ({
	type: "session",
	version: 3,
	id: "01a0c000-0000-7000-8000-00000000beef",
	timestamp: "2026-09-01T00:00:00.000Z",
	cwd: "/tmp/work",
	...over,
});

const userEntry = (id: string, parentId: string | null, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-09-01T00:00:01.000Z",
	message: { role: "user", content: [{ type: "text", text }], timestamp: `2026-09-01T00:00:0${id.length}.000Z` },
});

const assistantEntry = (id: string, parentId: string | null, text: string, toolCalls?: unknown[]) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-09-01T00:00:02.000Z",
	message: {
		role: "assistant",
		content: [{ type: "text", text }, ...(toolCalls ?? [])],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		stopReason: "stop",
		timestamp: "2026-09-01T00:00:02.000Z",
	},
});

const toolCall = (id: string, name = "bash") => ({ type: "toolCall", id, name, arguments: {} });

const toolResultEntry = (id: string, parentId: string, toolCallId: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-09-01T00:00:03.000Z",
	message: {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: "2026-09-01T00:00:03.000Z",
	},
});

/** Writes the lines as a transcript and returns its path (nothing here touches a real chat). */
function write(lines: unknown[], opts: { trailingNewline?: boolean; extra?: string } = {}): string {
	const file = join(dir, `t${++n}.jsonl`);
	const body = lines.map((l) => JSON.stringify(l)).join("\n") + (opts.trailingNewline === false ? "" : "\n");
	writeFileSync(file, body + (opts.extra ?? ""));
	return file;
}

/** What the SDK itself would load from that file — the yardstick for every "same messages" check. */
function sdkMessages(file: string): unknown[] {
	const entries = readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.flatMap((l) => {
			try {
				return [JSON.parse(l)];
			} catch {
				return [];
			}
		});
	const leaf = [...entries].reverse().find((e) => e.type !== "session" && typeof e.id === "string");
	return buildSessionContext(entries, leaf ? leaf.id : null).messages;
}

const texts = (messages: readonly unknown[]): string[] =>
	messages.map((m) => {
		const msg = m as { role: string; content: unknown };
		const content = Array.isArray(msg.content) ? msg.content : [];
		const text = content
			.filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
			.map((b) => b.text)
			.join("");
		return `${msg.role}:${text}`;
	});

describe("scanTranscriptFile — the messages it finds", () => {
	it("a plain chat: same messages as the SDK, header details, and it does not write", () => {
		const file = write([
			header(),
			userEntry("m1", null, "one"),
			assistantEntry("m2", "m1", "two"),
			userEntry("m3", "m2", "three"),
		]);
		const before = readFileSync(file);
		const scan = scanTranscriptFile(file);
		expect(scan.problem).toBe(null);
		expect(scan.sessionId).toBe("01a0c000-0000-7000-8000-00000000beef");
		expect(scan.cwd).toBe("/tmp/work");
		expect(scan.leafId).toBe("m3");
		expect(texts(contextMessagesOf(scan))).toEqual(texts(sdkMessages(file)));
		expect(readFileSync(file).equals(before)).toBe(true);
	});

	it("a branch: it follows the last line's own chain, not the other one", () => {
		// m2a and m2b both hang off m1; the file ends on the m2b side, so that is the chat shown.
		const file = write([
			header(),
			userEntry("m1", null, "one"),
			assistantEntry("m2a", "m1", "branch A"),
			assistantEntry("m2b", "m1", "branch B"),
			userEntry("m3", "m2b", "after B"),
		]);
		const scan = scanTranscriptFile(file);
		expect(scan.problem).toBe(null);
		const found = texts(contextMessagesOf(scan));
		expect(found).toEqual(texts(sdkMessages(file)));
		expect(found).toEqual(["user:one", "assistant:branch B", "user:after B"]);
	});

	it("a rewind: the messages that were undone are gone", () => {
		// Talk, go back to m1, carry on: the new line's parent is m1 again.
		const file = write([
			header(),
			userEntry("m1", null, "one"),
			assistantEntry("m2", "m1", "undone"),
			userEntry("m3", "m2", "also undone"),
			assistantEntry("m4", "m1", "after the rewind"),
		]);
		const scan = scanTranscriptFile(file);
		expect(texts(contextMessagesOf(scan))).toEqual(["user:one", "assistant:after the rewind"]);
		expect(texts(contextMessagesOf(scan))).toEqual(texts(sdkMessages(file)));
	});

	it("a compaction: the summary, then what it kept, then what came after", () => {
		const file = write([
			header(),
			userEntry("m1", null, "old one"),
			assistantEntry("m2", "m1", "old two"),
			userEntry("m3", "m2", "kept one"),
			{
				type: "compaction",
				id: "c1",
				parentId: "m3",
				timestamp: "2026-09-01T00:00:10.000Z",
				summary: "the story so far",
				firstKeptEntryId: "m3",
				tokensBefore: 99,
			},
			assistantEntry("m4", "c1", "after the compaction"),
		]);
		const scan = scanTranscriptFile(file);
		const found = texts(contextMessagesOf(scan));
		expect(found).toEqual(texts(sdkMessages(file)));
		expect(found.some((t) => t.includes("old two"))).toBe(false);
		expect(found.some((t) => t.includes("kept one"))).toBe(true);
		expect(found[found.length - 1]).toBe("assistant:after the compaction");
	});

	it("a context edit: the replaced message shows its new text (and a removed one is gone)", () => {
		const file = write([
			header(),
			userEntry("m1", null, "one"),
			assistantEntry("m2", "m1", "before the edit"),
			userEntry("m3", "m2", "gone"),
			{
				type: "context_edit",
				id: "e1",
				parentId: "m3",
				timestamp: "2026-09-01T00:00:11.000Z",
				targetId: "m2",
				replacement: { content: [{ type: "text", text: "after the edit" }] },
			},
			{
				type: "context_edit",
				id: "e2",
				parentId: "e1",
				timestamp: "2026-09-01T00:00:12.000Z",
				targetId: "m3",
				replacement: null,
			},
		]);
		const scan = scanTranscriptFile(file);
		const found = texts(contextMessagesOf(scan));
		expect(found).toEqual(texts(sdkMessages(file)));
		expect(found).toEqual(["user:one", "assistant:after the edit"]);
	});

	it("a half-written last line is skipped, exactly as the SDK skips it", () => {
		const file = write([header(), userEntry("m1", null, "one"), assistantEntry("m2", "m1", "two")], {
			extra: '{"type":"message","id":"m3","parentId":"m2","timesta',
		});
		const scan = scanTranscriptFile(file);
		expect(scan.problem).toBe(null);
		expect(scan.leafId).toBe("m2");
		expect(texts(contextMessagesOf(scan))).toEqual(texts(sdkMessages(file)));
	});

	it("no closing newline: still read whole (a chat that was just written to)", () => {
		const file = write([header(), userEntry("m1", null, "one"), assistantEntry("m2", "m1", "two")], {
			trailingNewline: false,
		});
		const scan = scanTranscriptFile(file);
		expect(scan.problem).toBe(null);
		expect(texts(contextMessagesOf(scan))).toEqual(["user:one", "assistant:two"]);
	});

	it("a tool call answered later in the file is fine", () => {
		const file = write([
			header(),
			userEntry("m1", null, "one"),
			assistantEntry("m2", "m1", "running", [toolCall("call-1")]),
			toolResultEntry("m3", "m2", "call-1"),
		]);
		expect(scanTranscriptFile(file).problem).toBe(null);
	});
});

describe("scanTranscriptFile — what sends a chat down the old, repairing path", () => {
	it("a tool call at the end with no result", () => {
		const file = write([
			header(),
			userEntry("m1", null, "one"),
			assistantEntry("m2", "m1", "running", [toolCall("call-1")]),
		]);
		expect(scanTranscriptFile(file).problem).toBe("dangling-tool-call");
	});

	it("a leftover compaction marker", () => {
		const file = write([
			header(),
			userEntry("m1", null, "one"),
			{
				type: "custom",
				customType: COMPACTION_PENDING_TYPE,
				data: { startedAt: 1 },
				id: "k1",
				parentId: "m1",
				timestamp: "2026-09-01T00:00:20.000Z",
			},
		]);
		expect(scanTranscriptFile(file).problem).toBe("pending-marker");
	});

	it("the same id twice", () => {
		const file = write([header(), userEntry("m1", null, "one"), assistantEntry("m1", "m1", "again")]);
		expect(scanTranscriptFile(file).problem).toBe("duplicate-id");
	});

	it("a parent loop", () => {
		const file = write([header(), userEntry("m1", "m2", "one"), assistantEntry("m2", "m1", "two")]);
		expect(scanTranscriptFile(file).problem).toBe("parent-cycle");
	});

	it("an older file version (the SDK rewrites it on open)", () => {
		const file = write([header({ version: 2 }), userEntry("m1", null, "one")]);
		expect(scanTranscriptFile(file).problem).toBe("old-version");
	});

	it("no session header", () => {
		const file = write([userEntry("m1", null, "one")]);
		expect(scanTranscriptFile(file).problem).toBe("no-header");
	});

	it("an empty file", () => {
		const file = write([]);
		expect(scanTranscriptFile(file).problem).toBe("empty");
	});

	it("a file that isn't there", () => {
		const scan = scanTranscriptFile(join(dir, "nope.jsonl"));
		expect(scan.problem).toBe("unreadable");
		expect(scan.entries).toEqual([]);
	});
});

/*
 * open-scan (Ops #638): opening a chat used to parse its file twice, once for the scan and once more
 * in the SDK's own load (SessionManager.open -> loadEntriesFromFile). openScannedSession hands the
 * scan's entries to the SDK instead. What must hold:
 *  - one parse per open: JSON.parse runs once per line in all, not twice;
 *  - the SDK ends up in exactly the state SessionManager.open gives (entries, header, leaf, cwd,
 *    folders, the context with its thinking level and model, the branch, the tree);
 *  - nothing is written on open, and later writes append to the file, as after SessionManager.open;
 *  - whenever the scan's entries are not exactly what the SDK would load, it says so (null) and the
 *    caller lets the SDK read the file as before.
 */

/** A chat with what the SDK's context depends on: a model change, a thinking level, a compaction,
 *  a branch and a label. */
function richChat(): unknown[] {
	return [
		header(),
		{
			type: "model_change",
			id: "c1",
			parentId: null,
			timestamp: "2026-09-01T00:00:01.000Z",
			provider: "anthropic",
			modelId: "claude-x",
		},
		{
			type: "thinking_level_change",
			id: "c2",
			parentId: "c1",
			timestamp: "2026-09-01T00:00:01.000Z",
			thinkingLevel: "high",
		},
		userEntry("m1", "c2", "one"),
		assistantEntry("m2", "m1", "two"),
		userEntry("m3", "m2", "three"),
		assistantEntry("m4", "m3", "four"),
		{
			type: "compaction",
			id: "k1",
			parentId: "m4",
			timestamp: "2026-09-01T00:00:05.000Z",
			summary: "what happened so far",
			firstKeptEntryId: "m3",
			tokensBefore: 1000,
		},
		userEntry("m5a", "k1", "branch A"),
		userEntry("m5b", "k1", "branch B"),
		{ type: "label", id: "l1", parentId: "m5b", timestamp: "2026-09-01T00:00:06.000Z", targetId: "m1", label: "start" },
		assistantEntry("m6", "l1", "six"),
	];
}

/** Everything a caller can read from a SessionManager, for "same state" checks. */
function stateOf(sm: SessionManager) {
	return {
		entries: sm.getEntries(),
		header: sm.getHeader(),
		leaf: sm.getLeafId(),
		cwd: sm.getCwd(),
		sessionDir: sm.getSessionDir(),
		sessionFile: sm.getSessionFile(),
		sessionId: sm.getSessionId(),
		count: sm.getEntryCount(),
		context: sm.buildSessionContext(),
		branch: sm.getBranch(),
		tree: sm.getTree(),
		label: sm.getLabel("m1"),
		name: sm.getSessionName(),
	};
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Lines in the file that JSON.parse would see (non-blank). */
const lineCount = (file: string) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim()).length;

describe("openScannedSession: one parse per open (open-scan)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("scan + open parse each line once; the old open parsed every line twice", () => {
		const file = write(richChat());
		const lines = lineCount(file);
		const parse = vi.spyOn(JSON, "parse");

		const scan = scanTranscriptFile(file);
		const sm = openScannedSession(scan);
		expect(sm).not.toBe(null);
		const once = parse.mock.calls.length;

		parse.mockClear();
		scanTranscriptFile(file);
		SessionManager.open(file);
		const twice = parse.mock.calls.length;

		expect(once).toBe(lines);
		// The SDK's open also reads the header on its own first (readSessionHeader: one more line).
		expect(twice).toBe(2 * lines + 1);
	});

	it("the SDK is in exactly the state SessionManager.open gives, and the entries are the scan's own", () => {
		const file = write(richChat());
		const scan = scanTranscriptFile(file);
		const parsed = scan.entries;
		const sm = openScannedSession(scan);
		if (!sm) throw new Error("expected the scan to stand in for the SDK's load");
		const ref = SessionManager.open(file);
		expect(stateOf(sm)).toEqual(stateOf(ref));
		expect(sm.getEntries()[0]).toBe(parsed[1]); // the very objects, not a second copy
		expect(stateOf(sm).context.thinkingLevel).toBe("high");
		// The newest assistant message's model wins over the earlier model_change.
		expect(stateOf(sm).context.model).toEqual({ provider: "anthropic", modelId: "claude-test" });
		expect(sm.getSessionDir()).toBe(dirname(file));
	});

	it("opening writes nothing; later writes append, exactly as after SessionManager.open", () => {
		const a = write(richChat());
		const b = join(dir, `t${++n}.jsonl`);
		copyFileSync(a, b);
		const before = readFileSync(a);
		const sm = openScannedSession(scanTranscriptFile(a));
		if (!sm) throw new Error("expected the scan to stand in for the SDK's load");
		const ref = SessionManager.open(b);
		expect(readFileSync(a).equals(before)).toBe(true);
		for (const m of [sm, ref]) {
			m.appendThinkingLevelChange("low");
			m.appendMessage({ role: "user", content: [{ type: "text", text: "seven" }], timestamp: 7 } as never);
			m.appendSessionInfo("named");
		}
		const afterA = readFileSync(a);
		const afterB = readFileSync(b);
		expect(sha256(afterA.subarray(0, before.length))).toBe(sha256(before));
		expect(afterA.length).toBeGreaterThan(before.length);
		const added = (buf: Buffer) =>
			buf
				.subarray(before.length)
				.toString("utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					const { id: _id, parentId: _p, timestamp: _t, ...rest } = JSON.parse(l);
					return rest;
				});
		expect(added(afterA)).toEqual(added(afterB));
		expect(sha256(afterB.subarray(0, before.length))).toBe(sha256(before));
		expect(sm.buildSessionContext().thinkingLevel).toBe("low");
		expect(sm.getSessionName()).toBe("named");
	});

	it("no closing newline: the SDK would add one, so it reads the file itself", () => {
		const file = write(richChat(), { trailingNewline: false });
		const scan = scanTranscriptFile(file);
		expect(scan.problem).toBe(null);
		expect(openScannedSession(scan)).toBe(null);
	});

	it("a half-written last line: same, the SDK reads it itself", () => {
		const file = write(richChat(), { extra: '{"type":"message","id":"zz","pare' });
		expect(openScannedSession(scanTranscriptFile(file))).toBe(null);
	});

	it("a line that is a bare value: the SDK keeps it as an entry and the scan doesn't, so no hand-over", () => {
		const file = write([...richChat().slice(0, 4), 42, ...richChat().slice(4)]);
		const scan = scanTranscriptFile(file);
		expect(openScannedSession(scan)).toBe(null);
	});

	it("blank and broken lines in the middle are skipped by both: hand-over, same state", () => {
		const file = join(dir, `t${++n}.jsonl`);
		const lines = richChat().map((l) => JSON.stringify(l));
		lines.splice(3, 0, "", "   ", "{broken", "null", "false", "0", '""');
		writeFileSync(file, `${lines.join("\n")}\n`);
		const sm = openScannedSession(scanTranscriptFile(file));
		if (!sm) throw new Error("expected a hand-over");
		expect(stateOf(sm)).toEqual(stateOf(SessionManager.open(file)));
	});

	it("the file changed after the scan (appended, or touched): the SDK reads it itself", () => {
		const file = write(richChat());
		const scan = scanTranscriptFile(file);
		appendFileSync(file, `${JSON.stringify(userEntry("m7", "m6", "late"))}\n`);
		expect(openScannedSession(scan)).toBe(null);

		const file2 = write(richChat());
		const scan2 = scanTranscriptFile(file2);
		utimesSync(file2, new Date(), new Date(Date.now() + 5000));
		expect(openScannedSession(scan2)).toBe(null);
	});

	it("a file with a problem never hands over (it goes down the repairing path)", () => {
		const cases = [
			write([header(), userEntry("m1", null, "one"), assistantEntry("m2", "m1", "x", [toolCall("c")])]),
			write([header({ version: 2 }), userEntry("m1", null, "one")]),
			write([header(), userEntry("m1", null, "one"), assistantEntry("m1", "m1", "again")]),
			write([userEntry("m1", null, "one")]),
			write([]),
			join(dir, "missing.jsonl"),
		];
		for (const f of cases) expect(openScannedSession(scanTranscriptFile(f))).toBe(null);
	});

	it("a header without a cwd: the process's cwd, as SessionManager.open does", () => {
		const { cwd: _c, ...noCwd } = header();
		const file = write([noCwd, userEntry("m1", null, "one"), assistantEntry("m2", "m1", "two")]);
		const sm = openScannedSession(scanTranscriptFile(file));
		if (!sm) throw new Error("expected a hand-over");
		expect(sm.getCwd()).toBe(SessionManager.open(file).getCwd());
		expect(sm.getCwd()).toBe(process.cwd());
	});
});
