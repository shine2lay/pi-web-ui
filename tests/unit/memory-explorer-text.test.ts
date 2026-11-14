/**
 * Memory explorer (design #316): the plain words the page shows for stored paths, kinds, times and
 * summaries. Written failing-first from design #315's HANDOFF.md and the lead's look check of round 2
 * ("# Case: ... **Role:**" shown raw in the one-line summary).
 */

import { describe, expect, it } from "vitest";
import {
	ago,
	folderLabel,
	isSetupFile,
	keptIn,
	kindOf,
	kindWord,
	lengthWords,
	matchLevel,
	noteTitle,
	rootName,
	summaryText,
} from "../../web/src/memory-explorer/explorer-text.js";

const NOW_MS = Date.parse("2026-11-14T01:25:00.000Z");
const minutesAgo = (m: number) => new Date(NOW_MS - m * 60_000).toISOString();

describe("summaryText: one-line summaries read as clean text", () => {
	it("drops heading marks, bold and code marks, link targets and bullets", () => {
		const raw = "# Case: memory page redesign\n**Role:** design. Uses `search-first` and [the brief](./brief.md).\n- Picked P";
		expect(summaryText(raw)).toBe("Case: memory page redesign Role: design. Uses search-first and the brief. Picked P");
	});
	it("drops the store's own label before an abstract", () => {
		expect(summaryText("pi-web-ui L0 abstract: the fork's architecture.")).toBe("the fork's architecture.");
		expect(summaryText("architecture-conventions/deliverable-checks L0 abstract: 9 files.")).toBe("9 files.");
	});
	it("treats placeholders as no summary", () => {
		expect(summaryText(null)).toBeNull();
		expect(summaryText("   ")).toBeNull();
		expect(summaryText("[Directory abstract is not ready]")).toBeNull();
		expect(summaryText("# 02")).toBeNull();
	});
});

describe("names", () => {
	it("titles a note from its file name in plain words", () => {
		expect(noteTitle("viking://user/design/memories/cases/c12-memory-redesign.md")).toBe("Memory redesign");
		expect(noteTitle("viking://user/default/memories/preferences/ui_ux_design.md")).toBe("UI ux design");
		expect(noteTitle("viking://user/default/memories/events/2026/11/12/showtell_review.md")).toBe("Show&Tell review");
		expect(noteTitle("viking://resources/pi-web-ui/README.md")).toBe("README.md");
	});
	it("names the places memory keeps things", () => {
		expect(rootName("viking://user/default/memories")).toBe("Shared notes");
		expect(rootName("viking://resources")).toBe("Project documents");
		expect(rootName("viking://user/design/memories")).toBe("Design");
		expect(rootName("viking://user/qa/memories")).toBe("QA");
		expect(rootName("viking://user/coo/memories")).toBe("COO");
	});
	it("labels folders by what they hold", () => {
		expect(folderLabel("viking://user/default/memories")).toBe("Shared notes");
		expect(folderLabel("viking://user/default/memories/preferences")).toBe("Rules");
		expect(folderLabel("viking://user/design/memories/cases")).toBe("Cases");
		expect(folderLabel("viking://user/design/memories/experiences")).toBe("Lessons");
		expect(folderLabel("viking://user/default/memories/events/2026/11")).toBe("November 2026");
		expect(folderLabel("viking://user/default/memories/events/2026/11/12")).toBe("Nov 12");
		expect(folderLabel("viking://resources/pi-web-ui")).toBe("pi-web-ui");
	});
	it("says where a note is kept", () => {
		expect(keptIn("viking://user/default/memories/preferences/a.md")).toBe("Shared notes");
		expect(keptIn("viking://resources/pi-web-ui/README.md")).toBe("Project documents");
		expect(keptIn("viking://user/ops/memories/cases/a.md")).toBe("Ops's own notes");
	});
});

describe("kinds", () => {
	it("reads the kind from the folder a note is kept in", () => {
		expect(kindOf("viking://user/default/memories/preferences/a.md")).toBe("rule");
		expect(kindOf("viking://user/design/memories/cases/a.md")).toBe("case");
		expect(kindOf("viking://user/design/memories/experiences/a.md")).toBe("case");
		expect(kindOf("viking://user/default/memories/entities/a.md")).toBe("fact");
		expect(kindOf("viking://user/default/memories/events/2026/11/12/a.md")).toBe("event");
		expect(kindOf("viking://resources/pi-web-ui/README.md")).toBe("doc");
		expect(kindOf("viking://user/design/memories/identity.md")).toBe("other");
	});
	it("names each kind in one word", () => {
		expect(kindWord("viking://user/default/memories/preferences/a.md")).toBe("Rule");
		expect(kindWord("viking://user/design/memories/experiences/a.md")).toBe("Lesson");
		expect(kindWord("viking://resources/x/README.md")).toBe("Document");
		expect(kindWord("viking://user/design/memories/identity.md")).toBe("Note");
	});
});

describe("setup files are locked", () => {
	it("knows a department's identity and soul files", () => {
		expect(isSetupFile("viking://user/design/memories/identity.md")).toBe(true);
		expect(isSetupFile("viking://user/design/memories/soul.md")).toBe(true);
		expect(isSetupFile("viking://user/design/memories/cases/identity-check.md")).toBe(false);
	});
});

describe("match labels read each score against the best one for the same question", () => {
	it("gives strong, good and weak", () => {
		expect(matchLevel(0.886, 0.886)).toBe(3);
		expect(matchLevel(0.871, 0.886)).toBe(2);
		expect(matchLevel(0.84, 0.886)).toBe(1);
	});
});

describe("times and lengths in plain words", () => {
	it("says how long ago", () => {
		expect(ago(minutesAgo(0.2), NOW_MS)).toBe("just now");
		expect(ago(minutesAgo(4), NOW_MS)).toBe("4 min ago");
		expect(ago(minutesAgo(90), NOW_MS)).toBe("2 h ago");
		expect(ago(minutesAgo(60 * 30), NOW_MS)).toBe("yesterday");
		expect(ago("2026-11-02T10:00:00.000Z", NOW_MS)).toBe("Nov 2");
		expect(ago(null, NOW_MS)).toBe("unknown");
	});
	it("says how long a note is", () => {
		expect(lengthWords(40)).toBe("a few words");
		expect(lengthWords(2400)).toBe("about 400 words");
		expect(lengthWords(null)).toBe("unknown length");
	});
});
