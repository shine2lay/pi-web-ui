import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardSourceCheckpoints } from "../../web/src/recovery-board";
import {
	BoardDraftError,
	boardDraftKey,
	copyBoardDraftRecord,
	encodeBoardDraftRecord,
	type BoardDraftStorage,
} from "../../web/src/board-draft-store";
import {
	boardRequest,
	createBoardDraft,
	getBoardAdmissionSource,
	getBoardCurrentSources,
	getBoardDraftRecoveries,
	resetBoardDrafts,
	restoreBoardDraft,
	reviseBoardDraft,
	subscribeBoardCurrentSources,
	type BoardDraftSource,
} from "../../web/src/roles-state";
import { setAppAdmit } from "../../web/src/app-admit";
import type { ClientMessage } from "../../web/src/types";

function postSource(revision = 0, editorId = "board-ed-1"): BoardDraftSource {
	return {
		editorId,
		revision,
		form: {
			type: "board_post",
			kind: "order",
			toAll: true,
			picked: ["qa", "ops"],
			title: "  untrimmed title 雪 ",
			text: "  untrimmed body\nsecond line  ",
		},
	};
}

function closeSource(revision = 0, id = "bp-42", editorId = "board-close-1"): BoardDraftSource {
	return {
		editorId,
		revision,
		form: {
			type: "board_close",
			id,
			note: "  pause lifted  ",
		},
	};
}

function postWire(value = postSource(), reqId = "board-req-1"): Extract<ClientMessage, { type: "board_post" }> {
	const f = value.form;
	if (f.type !== "board_post") throw new Error("expected board_post");
	return {
		type: "board_post",
		reqId,
		kind: f.kind,
		to: f.toAll ? "all" : [...f.picked].sort(),
		title: f.title.trim(),
		text: f.text.trim(),
	};
}

function closeWire(value = closeSource(), reqId = "board-req-2"): Extract<ClientMessage, { type: "board_close" }> {
	const f = value.form;
	if (f.type !== "board_close") throw new Error("expected board_close");
	return {
		type: "board_close",
		reqId,
		id: f.id,
		...(f.note.trim() ? { note: f.note.trim() } : {}),
	};
}

function fixture() {
	const rows = new Map<string, unknown>();
	const problem = vi.fn();
	let rejectSwap = false;
	const storage: BoardDraftStorage = {
		async read(key) {
			if (rows.has(key) && rows.get(key) === undefined) throw new BoardDraftError("invalid-record");
			return rows.get(key);
		},
		async scan() {
			return {
				status: "present",
				rows: [...rows].map(([key, value]) => ({ key, value })),
			};
		},
		async swap(key, expected, replacement) {
			if (rejectSwap) {
				rejectSwap = false;
				throw new BoardDraftError("transaction-failed", false);
			}
			const actual = rows.has(key) ? encodeBoardDraftRecord(rows.get(key)) : null;
			if (actual !== expected || boardDraftKey(replacement.current) !== key) {
				throw new BoardDraftError("conflict", false);
			}
			rows.set(key, copyBoardDraftRecord(replacement));
		},
	};
	const checkpoints = createBoardSourceCheckpoints({ storage, problem });
	return {
		rows,
		problem,
		storage,
		checkpoints,
		setRejectSwap(v: boolean) {
			rejectSwap = v;
		},
	};
}

describe("recovery-board host adapter and roles-state Board source observer", () => {
	beforeEach(() => {
		resetBoardDrafts();
		setAppAdmit(null);
	});

	it("notifies current-source subscribers on authored createBoardDraft and reviseBoardDraft and skips blank initial forms", () => {
		const observed: BoardDraftSource[] = [];
		const unsub = subscribeBoardCurrentSources((s) => observed.push(s));
		createBoardDraft({
			type: "board_post",
			kind: "news",
			toAll: true,
			picked: [],
			title: "",
			text: "",
		});
		expect(observed).toHaveLength(0);

		const initial = createBoardDraft({
			type: "board_post",
			kind: "news",
			toAll: true,
			picked: ["ops", "qa"],
			title: " initial ",
			text: " body ",
		});
		const revised = reviseBoardDraft(initial, {
			type: "board_post",
			kind: "order",
			toAll: true,
			picked: ["qa", "ops"],
			title: " revised ",
			text: " body 2 ",
		});
		unsub();

		expect(observed).toHaveLength(2);
		expect(observed[0]).toEqual(initial);
		expect(observed[1]).toEqual(revised);
		expect(getBoardCurrentSources()).toEqual([revised]);
	});

	it("atomically retains initial current + submitted source before wire admission and preserves newer current edits across retirement", async () => {
		const f = fixture();
		const a = postSource(0);
		const msg = postWire(a, "board-req-atomic");
		const captured = f.checkpoints.captureOriginal(msg, a);
		expect(captured).not.toBeNull();
		expect(await captured!.beforeCheckpoint!()).toBe(true);

		// User edits form to B while A is in flight.
		const bEdited: BoardDraftSource = {
			...a,
			revision: 1,
			form: {
				type: "board_post",
				kind: "news",
				toAll: false,
				picked: ["ops"],
				title: " edited after submit ",
				text: " new text ",
			},
		};
		expect(await f.checkpoints.persistCurrent(bEdited)).toBe(true);

		const inspected = await f.checkpoints.inspect();
		expect(inspected.status).toBe("ready");
		expect(inspected.records).toHaveLength(1);
		expect(inspected.records[0]?.current).toEqual(bEdited);
		expect(inspected.records[0]?.submitted).toEqual([a]);
		expect(inspected.records[0]?.retired).toBe(false);

		// Retiring reqId for revision 0 does NOT retire the record because current revision 1 is newer!
		expect(await f.checkpoints.retire("board-req-atomic")).toBe(false);
		expect((await f.checkpoints.inspect()).records[0]?.retired).toBe(false);

		// Submitting revision 1 and retiring its reqId marks retired: true without deleting the row.
		const capturedB = f.checkpoints.captureOriginal(postWire(bEdited, "board-req-b"), bEdited);
		expect(await capturedB!.beforeCheckpoint!()).toBe(true);
		expect(await f.checkpoints.retire("board-req-b")).toBe(true);
		const afterRetire = await f.checkpoints.inspect();
		expect(afterRetire.records[0]?.retired).toBe(true);
		expect(afterRetire.records[0]?.current).toEqual(bEdited);
		expect(afterRetire.records[0]?.submitted).toEqual([a, bEdited]);
	});

	it("refuses mismatched wire payload or storage failure before admission", async () => {
		const f = fixture();
		const a = closeSource(0, "bp-1");
		const wrongTarget = closeWire(closeSource(0, "bp-other"), "req-wrong");
		expect(f.checkpoints.captureOriginal(wrongTarget, a)).toBeNull();
		expect(f.rows.size).toBe(0);

		f.setRejectSwap(true);
		const goodCapture = f.checkpoints.captureOriginal(closeWire(a, "req-fail"), a);
		expect(await goodCapture!.beforeCheckpoint!()).toBe(false);
		expect(f.checkpoints.getSnapshot().failures[0]).toMatchObject({ source: a, submitted: true });
		expect(f.problem).toHaveBeenCalled();
	});

	it("end-to-end boardRequest -> getBoardAdmissionSource -> captureOriginal -> reload restoreBoardDraft preserves inactive picked roles and whitespace", async () => {
		const f = fixture();
		setAppAdmit(async (message) => {
			if (message.type !== "board_post" && message.type !== "board_close") return false;
			const captured = f.checkpoints.captureOriginal(message, getBoardAdmissionSource(message));
			if (!captured?.beforeCheckpoint) return false;
			if ((await captured.beforeCheckpoint()) !== true) return false;
			return false; // Simulate connection drop / admission refusal after checkpoint
		});

		const draft = createBoardDraft({
			type: "board_post",
			kind: "order",
			toAll: true,
			picked: ["qa", "ops"],
			title: "  keep whitespace  ",
			text: "  keep body\nlines  ",
		});
		const res = await boardRequest(
			{
				type: "board_post",
				kind: "order",
				to: "all",
				title: "keep whitespace",
				text: "keep body\nlines",
			},
			draft,
		);
		expect(res.ok).toBe(false);

		// Simulate fresh page reload: clear in-memory board drafts, then inspect IndexedDB and restore look-only.
		resetBoardDrafts();
		expect(getBoardDraftRecoveries()).toEqual([]);
		const inspected = await f.checkpoints.inspect();
		expect(inspected.records).toHaveLength(1);
		for (const record of inspected.records) {
			if (record.retired) continue;
			for (const source of record.submitted) {
				expect(restoreBoardDraft(source)).toBe(true);
			}
			expect(restoreBoardDraft(record.current)).toBe(true);
		}
		const recoveries = getBoardDraftRecoveries();
		expect(recoveries).toHaveLength(1);
		expect(recoveries[0]?.restoredSources[0]).toEqual(draft);
	});
});
