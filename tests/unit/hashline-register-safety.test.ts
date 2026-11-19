import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hashlineEngine from "../../server/hashline-engine.js";
import { applyHashlinePatch, computeFileHash, parseHashlinePatch } from "../../server/hashline-engine.js";
import { makePatchTool } from "../../server/patch-tool.js";

describe("Hashline cross-file @register $ anchors & atomic syntax/register safety (#1036)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "hashline-reg-safety-"));
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("reproducer (rm-5aba3961): CUT @reg + cross-file PUT >$ @reg moves lines atomically via applyHashlinePatch and makePatchTool", async () => {
		const srcInit = [
			"import os",
			"def moved_a():",
			"    return 1",
			"def moved_b():",
			"    return 2",
			"keep_end = True",
			"",
		].join("\n");
		const dstInit = ["from typing import Any", "", "EXISTING = 1", ""].join("\n");

		writeFileSync(join(tempDir, "source.py"), srcInit);
		writeFileSync(join(tempDir, "target.py"), dstInit);

		const patch = [
			`[source.py#${computeFileHash(srcInit)}]`,
			"CUT 2.=5 @registry",
			"",
			`[target.py#${computeFileHash(dstInit)}]`,
			"PUT >$ @registry",
		].join("\n");

		const tool = makePatchTool({ cwd: tempDir, ownerId: "test-agent" });
		const exec = tool.execute as unknown as (
			_id: string,
			p: { patch: string },
		) => Promise<{ content: Array<{ type: "text"; text: string }>; details: { ok: boolean; summary: string } }>;

		const res = await exec("call-repro", { patch });
		expect(res.details.ok).toBe(true);

		expect(readFileSync(join(tempDir, "source.py"), "utf8")).toBe("import os\nkeep_end = True\n");
		expect(readFileSync(join(tempDir, "target.py"), "utf8")).toBe(
			[
				"from typing import Any",
				"",
				"EXISTING = 1",
				"def moved_a():",
				"    return 1",
				"def moved_b():",
				"    return 2",
				"",
			].join("\n"),
		);
	});

	it("supports PUT >$ @reg on 1-line and 0-byte empty target files without leading blank lines", () => {
		const srcInit = "top\nalpha = 10\nbeta = 20\nbottom\n";
		const oneLineTarget = "# module stub\n";
		const emptyTarget = "";

		writeFileSync(join(tempDir, "source.py"), srcInit);
		writeFileSync(join(tempDir, "one_line.py"), oneLineTarget);
		writeFileSync(join(tempDir, "empty.py"), emptyTarget);

		const patch = [
			`[source.py#${computeFileHash(srcInit)}]`,
			"CUT 2.=3 @chunk",
			"",
			`[one_line.py#${computeFileHash(oneLineTarget)}]`,
			"PUT >$ @chunk",
			"",
			`[empty.py#${computeFileHash(emptyTarget)}]`,
			"PUT >$ @chunk",
		].join("\n");

		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);
		expect(readFileSync(join(tempDir, "source.py"), "utf8")).toBe("top\nbottom\n");
		expect(readFileSync(join(tempDir, "one_line.py"), "utf8")).toBe("# module stub\nalpha = 10\nbeta = 20\n");
		expect(readFileSync(join(tempDir, "empty.py"), "utf8")).toBe("alpha = 10\nbeta = 20\n");
	});

	it("supports PUT <$ @reg, PUT $ @reg, and PUT $: last-line replacement across files", () => {
		const srcInit = "keep\npayload_1\npayload_2\n";
		const beforeLastInit = "first\nlast\n";
		const replaceLastInit = "head\nreplace_me\n";
		const colonLastInit = "head\nold_tail\n";

		writeFileSync(join(tempDir, "src.py"), srcInit);
		writeFileSync(join(tempDir, "before_last.py"), beforeLastInit);
		writeFileSync(join(tempDir, "replace_last.py"), replaceLastInit);
		writeFileSync(join(tempDir, "colon_last.py"), colonLastInit);

		const patch = [
			`[src.py#${computeFileHash(srcInit)}]`,
			"CUT 2.=3 @reg",
			"",
			`[before_last.py#${computeFileHash(beforeLastInit)}]`,
			"PUT <$ @reg",
			"",
			`[replace_last.py#${computeFileHash(replaceLastInit)}]`,
			"PUT $ @reg",
			"",
			`[colon_last.py#${computeFileHash(colonLastInit)}]`,
			"PUT $:",
			"+new_tail",
		].join("\n");

		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);
		expect(readFileSync(join(tempDir, "src.py"), "utf8")).toBe("keep\n");
		expect(readFileSync(join(tempDir, "before_last.py"), "utf8")).toBe("first\npayload_1\npayload_2\nlast\n");
		expect(readFileSync(join(tempDir, "replace_last.py"), "utf8")).toBe("head\npayload_1\npayload_2\n");
		expect(readFileSync(join(tempDir, "colon_last.py"), "utf8")).toBe("head\nnew_tail\n");
	});

	it("fails atomically with 0 disk writes/deletes when PUT references an unknown @register", () => {
		const srcInit = "a\nb\nc\nd\n";
		const dstInit = "x\ny\n";
		const victimInit = "do_not_delete\n";

		writeFileSync(join(tempDir, "source.py"), srcInit);
		writeFileSync(join(tempDir, "target.py"), dstInit);
		writeFileSync(join(tempDir, "victim.py"), victimInit);

		const patch = [
			`[victim.py#${computeFileHash(victimInit)}]`,
			"REM",
			"",
			`[source.py#${computeFileHash(srcInit)}]`,
			"CUT 2.=3 @regA",
			"",
			`[target.py#${computeFileHash(dstInit)}]`,
			"PUT 1.=2 @regTypo",
		].join("\n");

		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.results).toEqual([]);
		expect(res.summary).toContain("@regTypo");

		expect(existsSync(join(tempDir, "victim.py"))).toBe(true);
		expect(readFileSync(join(tempDir, "victim.py"), "utf8")).toBe(victimInit);
		expect(readFileSync(join(tempDir, "source.py"), "utf8")).toBe(srcInit);
		expect(readFileSync(join(tempDir, "target.py"), "utf8")).toBe(dstInit);
	});

	it("fails atomically with actionable guidance and 0 disk writes when PUT @reg precedes CUT @reg", () => {
		const srcInit = "a\nb\nc\nd\n";
		const dstInit = "x\ny\n";

		writeFileSync(join(tempDir, "source.py"), srcInit);
		writeFileSync(join(tempDir, "target.py"), dstInit);

		const patch = [
			`[target.py#${computeFileHash(dstInit)}]`,
			"PUT >1 @reg",
			"",
			`[source.py#${computeFileHash(srcInit)}]`,
			"CUT 2.=3 @reg",
		].join("\n");

		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.results).toEqual([]);
		expect(res.summary).toMatch(/CUT.*@reg.*before.*PUT.*@reg/i);
		expect(readFileSync(join(tempDir, "source.py"), "utf8")).toBe(srcInit);
		expect(readFileSync(join(tempDir, "target.py"), "utf8")).toBe(dstInit);
	});

	it("fails atomically with 0 disk writes on malformed directives or bad headers", () => {
		const srcInit = "line1\nline2\nline3\n";
		const dstInit = "dst1\ndst2\n";
		writeFileSync(join(tempDir, "source.py"), srcInit);
		writeFileSync(join(tempDir, "target.py"), dstInit);

		const badPatches = [
			`[source.py]\nCUT 2.=3 @reg\n[target.py]\nPUT >>1 @reg\n`,
			`[source.py]\nCUT 2.=3 @reg\n[target.py]\nFOO 1.=2\n`,
			`[source.py]\nCUT 2.=3 @reg\n[target.py]\nPUT >1 @reg:\n`,
			`[source.py]\nCUT 2.=3 @reg\n[target.py#ZZZZ]\nPUT >1 @reg\n`,
			`# prose comment before header\n[source.py]\nPUT 1.=1:\n+changed\n`,
			`[source.py]\nREM extra_arg\n`,
			`[source.py]\nMV a.py b.py\n`,
		];

		for (const bad of badPatches) {
			let writes = 0;
			let deletes = 0;
			const res = applyHashlinePatch(bad, {
				cwd: tempDir,
				readFile: (p) => readFileSync(join(tempDir, p), "utf8"),
				writeFile: () => {
					writes++;
				},
				deleteFile: () => {
					deletes++;
				},
			});
			expect(res.ok, `expected ok:false for:\n${bad}`).toBe(false);
			expect(writes, `expected 0 writes for:\n${bad}`).toBe(0);
			expect(deletes, `expected 0 deletes for:\n${bad}`).toBe(0);
		}

		expect(readFileSync(join(tempDir, "source.py"), "utf8")).toBe(srcInit);
		expect(readFileSync(join(tempDir, "target.py"), "utf8")).toBe(dstInit);
	});

	it("fails atomically with 0 disk writes on orphan '+' lines, unprefixed blank lines inside PUT blocks, or empty PUT: blocks", () => {
		const srcInit = "line1\nline2\nline3\n";
		const dstInit = "dst1\ndst2\n";
		writeFileSync(join(tempDir, "source.py"), srcInit);
		writeFileSync(join(tempDir, "target.py"), dstInit);

		const badCases = [
			// Orphan + line after register paste
			`[source.py]\nCUT 2.=3 @reg\n[target.py]\nPUT >1 @reg\n+orphan line\n`,
			// Orphan + line after CUT
			`[source.py]\nCUT 2.=3 @reg\n+orphan after cut\n`,
			// Unprefixed blank line inside colon PUT body followed by +line
			`[source.py]\nPUT 1.=2:\n+first\n\n+second_after_missing_plus\n`,
			// Colon PUT header with zero + body lines
			`[source.py]\nPUT 1.=1:\n[target.py]\nPUT 1.=1:\n+ok\n`,
		];

		for (const bad of badCases) {
			const res = applyHashlinePatch(bad, { cwd: tempDir });
			expect(res.ok, `expected ok:false for:\n${bad}`).toBe(false);
			expect(readFileSync(join(tempDir, "source.py"), "utf8")).toBe(srcInit);
			expect(readFileSync(join(tempDir, "target.py"), "utf8")).toBe(dstInit);
		}
	});

	it("fails atomically with 0 disk writes when any [path] section has 0 hunks", () => {
		const srcInit = "line1\nline2\nline3\n";
		const dstInit = "dst1\n";
		writeFileSync(join(tempDir, "source.py"), srcInit);
		writeFileSync(join(tempDir, "target.py"), dstInit);

		const patch = `[source.py]\nCUT 2.=3 @reg\n\n[target.py]\n`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("target.py");
		expect(readFileSync(join(tempDir, "source.py"), "utf8")).toBe(srcInit);
		expect(readFileSync(join(tempDir, "target.py"), "utf8")).toBe(dstInit);
	});

	it("rejects out-of-bounds block start (PUT 99*: / CUT 99*) and CUT on 0-line empty files", () => {
		writeFileSync(join(tempDir, "small.py"), "def f():\n    return 1\n");
		writeFileSync(join(tempDir, "empty.py"), "");

		const outOfRangeBlock = applyHashlinePatch("[small.py]\nPUT 99*:\n+replaced\n", { cwd: tempDir });
		expect(outOfRangeBlock.ok).toBe(false);
		expect(outOfRangeBlock.summary).toContain("Line out of range");

		const cutEmpty = applyHashlinePatch("[empty.py]\nCUT 1.=1 @reg\n", { cwd: tempDir });
		expect(cutEmpty.ok).toBe(false);
	});

	it("exposes structured parse errors from parseHashlinePatch and preserves all hashline-engine exports", () => {
		expect(typeof hashlineEngine.HL_HASH_LENGTH).toBe("number");
		expect(typeof hashlineEngine.normalizeLineEndings).toBe("function");
		expect(typeof hashlineEngine.computeFileHash).toBe("function");
		expect(typeof hashlineEngine.formatHashlineHeader).toBe("function");
		expect(typeof hashlineEngine.formatNumberedLines).toBe("function");
		expect(typeof hashlineEngine.resolveBlockSpan).toBe("function");
		expect(typeof hashlineEngine.parseHashlinePatch).toBe("function");
		expect(typeof hashlineEngine.HashlineSnapshotStore).toBe("function");
		expect(typeof hashlineEngine.globalSnapshotStore).toBe("object");
		expect(typeof hashlineEngine.tryRecoverEdits).toBe("function");
		expect(typeof hashlineEngine.applyHashlinePatch).toBe("function");

		const badParsed = parseHashlinePatch("[a.py]\nPUT >>1 @reg\n") as unknown as {
			sections: unknown[];
			errors: Array<{ line: number; message: string }>;
		};
		expect(Array.isArray(badParsed.errors)).toBe(true);
		expect(badParsed.errors.length).toBeGreaterThan(0);
		expect(badParsed.errors[0].line).toBe(2);

		const goodParsed = parseHashlinePatch("[a.py]\nPUT >$ @reg\n") as unknown as {
			sections: Array<{ filePath: string; hunks: Array<{ kind: string; lineStart?: number; registerName?: string }> }>;
			errors: unknown[];
		};
		expect(goodParsed.errors).toEqual([]);
		expect(goodParsed.sections).toHaveLength(1);
		expect(goodParsed.sections[0].hunks[0]).toMatchObject({
			kind: "insert_after",
			lineStart: -1,
			registerName: "reg",
		});
	});

	it("exercises makePatchTool end-to-end for atomic failure on unknown @reg before cross-file PUT >$ @reg", async () => {
		writeFileSync(join(tempDir, "source.py"), "KEEP = 1\nMOVE_A = 2\nMOVE_B = 3\n");
		writeFileSync(join(tempDir, "target.py"), "HEAD = 0\n");
		const tool = makePatchTool({ cwd: tempDir, ownerId: "test-agent" });
		const exec = tool.execute as unknown as (
			_id: string,
			p: { patch: string },
		) => Promise<{ content: Array<{ type: "text"; text: string }>; details: { ok: boolean; summary: string } }>;

		const badRes = await exec("call-bad", {
			patch: ["[source.py]", "CUT 2.=3 @reg", "", "[target.py]", "PUT >$ @missingReg"].join("\n"),
		});
		expect(badRes.details.ok).toBe(false);
		expect(badRes.content[0].text).toContain("Patch Failed:");
		expect(readFileSync(join(tempDir, "source.py"), "utf8")).toBe("KEEP = 1\nMOVE_A = 2\nMOVE_B = 3\n");
		expect(readFileSync(join(tempDir, "target.py"), "utf8")).toBe("HEAD = 0\n");

		const goodRes = await exec("call-good", {
			patch: ["[source.py]", "CUT 2.=3 @reg", "", "[target.py]", "PUT >$ @reg"].join("\n"),
		});
		expect(goodRes.details.ok).toBe(true);
		expect(readFileSync(join(tempDir, "source.py"), "utf8")).toBe("KEEP = 1\n");
		expect(readFileSync(join(tempDir, "target.py"), "utf8")).toBe("HEAD = 0\nMOVE_A = 2\nMOVE_B = 3\n");
	});
});
