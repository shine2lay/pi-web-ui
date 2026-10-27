import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	composeToComposer,
	focusComposer,
	isComposerReady,
	registerAttachmentSink,
	registerDraftSink,
	registerFocusSink,
	resetComposerSinks,
} from "../../web/src/composer-bridge.js";
import { composerRecovery, type ComposerHostSnapshot } from "../../web/src/recovery-composer.js";
import type { DraftAttachment } from "../../web/src/composer-draft.js";

/** Same public boolean bridge contract; owned complete checkpoint replaces the old
 * independent half-sink fixture. Source/forwarding/failure assertions are retained. */
const shot: DraftAttachment = { path: "", name: "shot.png", mode: "inline", imageData: "AAAA", key: "k1" };
let dispose: (() => void) | undefined;
let rows: Map<string, string>;
let order: string[];
function harness() {
	const drafts: string[] = [],
		attachments: DraftAttachment[][] = [];
	let state: ComposerHostSnapshot = {
		binding: { ownerId: "o", composerId: "composer", conversationId: "c", sessionId: "s", revision: 0 },
		draft: { text: "", attachments: [] },
	};
	dispose = composerRecovery().attach({
		snapshot: () => state,
		apply(_original, record) {
			order.push("whole-draft");
			if (record.incoming.text) drafts.push(record.incoming.text);
			if (record.incoming.attachments) attachments.push([...record.incoming.attachments]);
			state = {
				binding: { ...record.binding, revision: record.nextRevision },
				draft: structuredClone(record.effective),
			};
			return true;
		},
		problem() {},
	});
	return { drafts, attachments, dispose: () => dispose?.() };
}
beforeEach(() => {
	resetComposerSinks();
	rows = new Map();
	order = [];
	vi.stubGlobal("localStorage", {
		get length() {
			return rows.size;
		},
		key: (i: number) => [...rows.keys()][i] ?? null,
		getItem: (key: string) => rows.get(key) ?? null,
		setItem: (key: string, value: string) => {
			order.push("checkpoint");
			rows.set(key, value);
		},
	});
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	resetComposerSinks();
	vi.unstubAllGlobals();
});

describe("composer-bridge", () => {
	it("no actual owner/sink: readiness false and every compose refuses", () => {
		expect(isComposerReady()).toBe(false);
		expect(composeToComposer({ text: "hi" })).toBe(false);
		expect(composeToComposer({ attachments: [shot] })).toBe(false);
	});
	it("legacy half-sinks do not claim checkpoint readiness or receive partial work", () => {
		const draft = vi.fn(),
			attachment = vi.fn();
		registerDraftSink(draft);
		expect(isComposerReady()).toBe(false);
		expect(composeToComposer({ attachments: [shot] })).toBe(false);
		registerAttachmentSink(attachment);
		expect(composeToComposer({ text: "x", attachments: [shot] })).toBe(false);
		expect(draft).not.toHaveBeenCalled();
		expect(attachment).not.toHaveBeenCalled();
		harness();
		expect(isComposerReady()).toBe(true);
		expect(composeToComposer({ attachments: [shot] })).toBe(true);
	});
	it("text plus attachments: one full placement only after the complete checkpoint", () => {
		const h = harness();
		expect(composeToComposer({ text: "看这个", attachments: [shot] })).toBe(true);
		expect(h.drafts).toEqual(["看这个"]);
		expect(h.attachments).toEqual([[shot]]);
		expect(order).toEqual(["checkpoint", "whole-draft"]);
	});
	it("empty/whitespace-only input refuses without inserting blank lines", () => {
		const h = harness();
		expect(composeToComposer({})).toBe(false);
		expect(composeToComposer({ text: "   \n\t " })).toBe(false);
		expect(composeToComposer({ text: "", attachments: [] })).toBe(false);
		expect(h.drafts).toEqual([]);
		expect(order).toEqual([]);
	});
	it("forwards the exact original text including whitespace and markdown", () => {
		const h = harness(),
			md = "### 元素\n\n```css\n.card{color:red}\n```";
		expect(composeToComposer({ text: `  ${md}\n` })).toBe(true);
		expect(h.drafts).toEqual([`  ${md}\n`]);
	});
	it("malformed input refuses without throw; subsequent valid input still works", () => {
		const h = harness();
		expect(composeToComposer(null as never)).toBe(false);
		expect(composeToComposer({ text: 42 as never, attachments: "nope" as never })).toBe(false);
		expect(composeToComposer({ text: "ok" })).toBe(true);
		expect(h.drafts).toEqual(["ok"]);
	});
	it("successive compose calls retain complete original inputs, including deduplicated items", () => {
		const h = harness();
		expect(composeToComposer({ text: "A" })).toBe(true);
		expect(composeToComposer({ text: "B" })).toBe(true);
		expect(composeToComposer({ attachments: [shot, shot] })).toBe(true);
		expect(h.drafts).toEqual(["A", "B"]);
		expect(h.attachments).toEqual([[shot, shot]]);
		expect(rows.size).toBe(3);
	});
	it("detaching the actual owner immediately rejects later work", () => {
		const h = harness();
		expect(composeToComposer({ text: "x" })).toBe(true);
		h.dispose();
		resetComposerSinks();
		expect(isComposerReady()).toBe(false);
		expect(composeToComposer({ text: "y" })).toBe(false);
		expect(rows.size).toBe(1);
	});
	it("focus preserves the synchronous non-checkpoint control contract", () => {
		expect(focusComposer()).toBe(false);
		let focused = 0;
		registerFocusSink(() => {
			focused++;
		});
		expect(focusComposer()).toBe(true);
		expect(focused).toBe(1);
		registerFocusSink(null);
		expect(focusComposer()).toBe(false);
		expect(focused).toBe(1);
	});
});
