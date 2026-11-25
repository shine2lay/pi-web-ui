// The waiting-questions bell's window state (Ops #1090): the list the server pushes, the bell's count and words, and
// what the list's buttons hand to the Answer dialog and to Open chat.
import { describe, expect, it } from "vitest";
import { en } from "../../web/src/i18n";
import {
	bellBadge,
	bellLabel,
	disconnectOwnerAsks,
	getOwnerAsks,
	ownerAskAge,
	ownerAskDialogItem,
	ownerAskKindKey,
	ownerAskOpenTarget,
	ownerAskWho,
	receiveOwnerAsks,
} from "../../web/src/owner-asks-state";
import type { UiOwnerAskItem } from "../../web/src/types";

const t = ((key: keyof typeof en, vars?: Record<string, string | number>) =>
	String(en[key]).replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ""))) as Parameters<typeof bellLabel>[0];

const item = (over: Partial<UiOwnerAskItem> = {}): UiOwnerAskItem => ({
	askId: "q-1",
	kind: "question",
	title: "Question",
	summary: "Which port?",
	createdAt: 1_000_000,
	answerable: true,
	...over,
});

describe("owner-asks-state", () => {
	it("keeps the server's whole list and marks it not current when the socket drops", () => {
		receiveOwnerAsks({ type: "owner_asks", asks: [item(), item({ askId: "q-2" })] });
		expect(getOwnerAsks()).toMatchObject({ received: true, asks: [{ askId: "q-1" }, { askId: "q-2" }] });
		receiveOwnerAsks({ type: "owner_asks", asks: [item({ askId: "q-2" })] });
		expect(getOwnerAsks().asks.map((a) => a.askId)).toEqual(["q-2"]);
		const before = getOwnerAsks();
		disconnectOwnerAsks();
		expect(getOwnerAsks()).toEqual({ asks: before.asks, received: false });
		receiveOwnerAsks({ type: "owner_asks", asks: [] });
		expect(getOwnerAsks()).toEqual({ asks: [], received: true });
	});

	it("says how many wait, with a badge only when something does", () => {
		expect(bellLabel(t, 0)).toBe("No questions waiting");
		expect(bellLabel(t, 1)).toBe("1 question waiting for you");
		expect(bellLabel(t, 2)).toBe("2 questions waiting for you");
		expect(bellBadge(0)).toBeNull();
		expect(bellBadge(2)).toBe("2");
		expect(bellBadge(100)).toBe("99+");
	});

	it("names who asks, how long ago and what kind", () => {
		expect(ownerAskWho(item({ roleTitle: "ops/tooling", conversationTitle: "Ops lead" }), t)).toBe("ops/tooling");
		expect(ownerAskWho(item({ conversationTitle: "Fix the port" }), t)).toBe("Fix the port");
		expect(ownerAskWho(item(), t)).toBe("A chat");
		expect(ownerAskAge(item({ createdAt: 1_000_000 }), 1_000_000 + 14 * 60_000)).toBe("14m ago");
		expect(ownerAskAge(item({ createdAt: Number.NaN }), 1)).toBe("");
		expect(t(ownerAskKindKey("approval"))).toBe("Approval");
		expect(t(ownerAskKindKey("stuck"))).toBe("Task");
	});

	it("opens the asking chat at the question, and hands the Answer dialog the ask's id", () => {
		expect(ownerAskOpenTarget(item())).toBeNull();
		const withChat = item({ sessionFile: "/s/plain.jsonl", conversationTitle: "plain" });
		expect(ownerAskOpenTarget(withChat)).toEqual({ file: "/s/plain.jsonl", focus: { kind: "question", id: "q-1" } });
		expect(ownerAskDialogItem(withChat, t)).toMatchObject({
			key: "q-1",
			answer: { key: "q-1", id: "q-1" },
			roleId: null,
			roleLabel: "plain",
			text: "Which port?",
			since: 1_000_000,
			link: { file: "/s/plain.jsonl" },
		});
	});
});
