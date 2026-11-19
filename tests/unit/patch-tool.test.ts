import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeFileHash,
	formatHashlineHeader,
	formatNumberedLines,
	resolveBlockSpan,
	applyHashlinePatch,
	HashlineSnapshotStore,
} from "../../server/hashline-engine.js";
import { makePatchTool, PATCH_TOOL_NAME } from "../../server/patch-tool.js";

describe("Hashline Patch Engine & Tool", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "patch-tool-test-"));
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("computes deterministic 4-hex content hash", () => {
		const text1 = "const a = 1;\nconsole.log(a);\n";
		const text2 = "const a = 1;\r\nconsole.log(a);   \r\n";
		const hash1 = computeFileHash(text1);
		const hash2 = computeFileHash(text2);
		expect(hash1).toHaveLength(4);
		expect(hash1).toBe(hash2);
	});

	it("resolves block span by matching braces in C-like languages", () => {
		const lines = [
			"function test() {",
			"  const x = 10;",
			"  if (x > 5) {",
			"    console.log('nested');",
			"  }",
			"  return x;",
			"}",
			"const other = true;",
		];
		const span = resolveBlockSpan(lines, 1, "test.ts");
		expect(span.start).toBe(1);
		expect(span.end).toBe(7);
	});

	it("resolves block span by indentation in Python", () => {
		const lines = [
			"def compute(n):",
			"    total = 0",
			"    for i in range(n):",
			"        total += i",
			"    return total",
			"",
			"print('done')",
		];
		const span = resolveBlockSpan(lines, 1, "test.py");
		expect(span.start).toBe(1);
		expect(span.end).toBe(5);
	});

	it("applies PUT N.=M: line range replacement", () => {
		const initial = "line 1\nline 2\nline 3\nline 4\n";
		const filePath = "hello.txt";
		writeFileSync(join(tempDir, filePath), initial);
		const hash = computeFileHash(initial);

		const patch = `
[${filePath}#${hash}]
PUT 2.=3:
+line two (replaced)
+line three (replaced)
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);
		expect(res.results[0].op).toBe("updated");

		const updated = readFileSync(join(tempDir, filePath), "utf8");
		expect(updated).toBe("line 1\nline two (replaced)\nline three (replaced)\nline 4\n");
	});

	it("applies PUT N*: syntactic block replacement", () => {
		const initial = [
			"function greet() {",
			"  const msg = 'hello';",
			"  return msg;",
			"}",
			"console.log('after');",
		].join("\n");
		const filePath = "greet.ts";
		writeFileSync(join(tempDir, filePath), initial);
		const hash = computeFileHash(initial);

		const patch = `
[${filePath}#${hash}]
PUT 1*:
+function greet() {
+  return 'fast hello';
+}
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);

		const updated = readFileSync(join(tempDir, filePath), "utf8");
		expect(updated).toContain("fast hello");
		expect(updated).toContain("console.log('after');");
	});

	it("applies PUT <N: and PUT >N: gap insertions", () => {
		const initial = "line 1\nline 2\n";
		const filePath = "gap.txt";
		writeFileSync(join(tempDir, filePath), initial);
		const hash = computeFileHash(initial);

		const patch = `
[${filePath}#${hash}]
PUT <1:
+header line
PUT >2:
+footer line
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);

		const updated = readFileSync(join(tempDir, filePath), "utf8");
		expect(updated).toBe("header line\nline 1\nline 2\nfooter line\n");
	});

	it("supports CUT and register paste (PUT @reg)", () => {
		const initial = "line 1\nMOVE_ME_1\nMOVE_ME_2\nline 4\n";
		const filePath = "cut.txt";
		writeFileSync(join(tempDir, filePath), initial);
		const hash = computeFileHash(initial);

		const patch = `
[${filePath}#${hash}]
CUT 2.=3 @block
PUT >4 @block
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);

		const updated = readFileSync(join(tempDir, filePath), "utf8");
		expect(updated).toBe("line 1\nline 4\nMOVE_ME_1\nMOVE_ME_2\n");
	});

	it("supports file removal (REM) and file renaming (MV)", () => {
		const f1 = "to_delete.txt";
		const f2 = "to_move.txt";
		writeFileSync(join(tempDir, f1), "delete me");
		writeFileSync(join(tempDir, f2), "move me");

		const patch = `
[${f1}#${computeFileHash("delete me")}]
REM
[${f2}#${computeFileHash("move me")}]
PUT 1.=1:
+moved and edited
MV renamed.txt
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);
		expect(existsSync(join(tempDir, f1))).toBe(false);
		expect(existsSync(join(tempDir, f2))).toBe(false);
		expect(readFileSync(join(tempDir, "renamed.txt"), "utf8")).toBe("moved and edited");
	});

	it("recovers automatically via 3-way merge when anchor lines did not change", () => {
		const store = new HashlineSnapshotStore();
		const base = "header\nline A\nline B\nfooter\n";
		const filePath = "diverged.txt";
		const baseHash = store.record(filePath, base);

		// 模拟外部并发修改了 header 行（在行号 1 处插入了一行），导致当前文本与 base 不一致
		const currentOnDisk = "NEW_TOP_HEADER\nheader\nline A\nline B\nfooter\n";
		writeFileSync(join(tempDir, filePath), currentOnDisk);

		// 补丁是基于 baseHash 编写的，修改 line A/line B（原行 2~3）
		const patch = `
[${filePath}#${baseHash}]
PUT 2.=3:
+line A (updated)
+line B (updated)
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir, snapshotStore: store });
		expect(res.ok).toBe(true);
		expect(res.results[0].recovered).toBe(true);

		const updated = readFileSync(join(tempDir, filePath), "utf8");
		expect(updated).toContain("NEW_TOP_HEADER");
		expect(updated).toContain("line A (updated)");
	});

	it("fails safely and provides guidance when file hash mismatches without snapshot", () => {
		const filePath = "unknown.txt";
		writeFileSync(join(tempDir, filePath), "live content\n");
		const patch = `
[${filePath}#9999]
PUT 1.=1:
+hacked
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("File content does not match the anchor");
	});

	it("makePatchTool integrates properly as an Agent tool", async () => {
		const tool = makePatchTool({ cwd: tempDir, ownerId: "test-agent" });
		expect(tool.name).toBe(PATCH_TOOL_NAME);

		const initial = "const x = 1;\n";
		writeFileSync(join(tempDir, "agent.js"), initial);
		const hash = computeFileHash(initial);

		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;
		const execRes = await exec("call-1", {
			patch: `[agent.js#${hash}]\nPUT 1.=1:\n+const x = 42;\n`,
		});

		expect(execRes.details.ok).toBe(true);
		expect(execRes.content[0].text).toContain("Changed agent.js");
		expect(readFileSync(join(tempDir, "agent.js"), "utf8")).toBe("const x = 42;\n");
	});

	it("preserves CRLF line endings when present in original file", () => {
		const filePath = "crlf.txt";
		const crlfText = "line1\r\nline2\r\nline3\r\n";
		writeFileSync(join(tempDir, filePath), crlfText);
		const hash = computeFileHash(crlfText);

		const patch = `
[${filePath}#${hash}]
PUT 2.=2:
+modified line 2
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);
		const written = readFileSync(join(tempDir, filePath), "utf8");
		expect(written).toBe("line1\r\nmodified line 2\r\nline3\r\n");
	});

	it("rejects overlapping hunks in the same file", () => {
		const filePath = "overlap.txt";
		const text = "1\n2\n3\n4\n5\n";
		writeFileSync(join(tempDir, filePath), text);
		const hash = computeFileHash(text);

		const patch = `
[${filePath}#${hash}]
PUT 1.=3:
+new 1-3
PUT 2.=4:
+new 2-4
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("overlap");
	});

	it("rejects out-of-bounds line numbers", () => {
		const filePath = "bounds.txt";
		const text = "alpha\nbeta\n";
		writeFileSync(join(tempDir, filePath), text);
		const hash = computeFileHash(text);

		const patch = `
[${filePath}#${hash}]
PUT 10.=10:
+out of bounds
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("Line out of range");
	});

	it("rejects path traversal outside workspace", () => {
		const patch = `
[../outside.txt]
PUT 1.=1:
+bad
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("Path out of bounds");
	});

	it("rejects move_file target attempting traversal outside workspace", () => {
		const filePath = "move_victim.txt";
		writeFileSync(join(tempDir, filePath), "content\n");
		const hash = computeFileHash("content\n");

		const patch = `
[${filePath}#${hash}]
MV ../outside_dest.txt
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("Path out of bounds");
		expect(existsSync(join(tempDir, filePath))).toBe(true);
	});

	it("applies multiple sections to the same file sequentially", () => {
		const filePath = "multi.txt";
		const text = "line1\nline2\nline3\nline4\n";
		writeFileSync(join(tempDir, filePath), text);
		const hash = computeFileHash(text);

		const patch = `
[${filePath}#${hash}]
PUT 1.=1:
+step1

[${filePath}]
PUT 4.=4:
+step2
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);
		expect(readFileSync(join(tempDir, filePath), "utf8")).toBe("step1\nline2\nline3\nstep2\n");
	});
});

describe("Linked git worktrees outside cwd (#1033)", () => {
	let sandboxRoot: string;
	let testHome: string;
	let mainRepoDir: string;
	let wtDir: string;
	let scratchCwd: string;
	let plainSiblingDir: string;
	let savedHome: string | undefined;

	const runGit = (cwd: string, args: string[]) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: testHome,
			GIT_AUTHOR_NAME: "Patch Test",
			GIT_AUTHOR_EMAIL: "patch-test@localhost",
			GIT_COMMITTER_NAME: "Patch Test",
			GIT_COMMITTER_EMAIL: "patch-test@localhost",
		};
		for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
			delete env[k];
		}
		execFileSync("git", args, { cwd, env, stdio: "pipe" });
	};

	const execPatchTool = async (cwd: string, patch: string) => {
		const tool = makePatchTool({ cwd, ownerId: "test-agent" });
		const exec = tool.execute as unknown as (
			_id: string,
			p: { patch: string },
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: { ok: boolean; summary: string; error?: string };
		}>;
		return exec("call-wt", { patch });
	};

	beforeEach(() => {
		savedHome = process.env.HOME;
		sandboxRoot = mkdtempSync(join(tmpdir(), "patch-wt-sandbox-"));
		testHome = join(sandboxRoot, "home");
		mainRepoDir = join(testHome, "projects", "demo-repo");
		wtDir = join(testHome, "projects", "demo-repo-wt");
		plainSiblingDir = join(testHome, "projects", "plain-sibling");
		scratchCwd = join(sandboxRoot, "scratch-cwd");

		mkdirSync(join(mainRepoDir, "src"), { recursive: true });
		mkdirSync(plainSiblingDir, { recursive: true });
		mkdirSync(scratchCwd, { recursive: true });
		mkdirSync(join(testHome, ".pi", "agent"), { recursive: true });
		process.env.HOME = testHome;

		writeFileSync(join(mainRepoDir, "src", "alpha.ts"), "export const alpha = 1;\n");
		writeFileSync(join(mainRepoDir, "src", "source.ts"), "keepTop();\ncutLineOne();\ncutLineTwo();\nkeepBottom();\n");
		writeFileSync(join(mainRepoDir, "src", "target.ts"), "header();\nfooter();\n");
		writeFileSync(join(mainRepoDir, "src", "old-name.ts"), "export const moved = false;\n");
		writeFileSync(join(plainSiblingDir, "note.txt"), "plain sibling\n");
		writeFileSync(join(testHome, ".pi", "agent", "settings.json"), '{"safe":true}\n');

		runGit(mainRepoDir, ["init", "-b", "main"]);
		runGit(mainRepoDir, ["add", "."]);
		runGit(mainRepoDir, ["commit", "-m", "initial"]);
		runGit(mainRepoDir, ["worktree", "add", wtDir, "-b", "wt-feature"]);
	});

	afterEach(() => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		try {
			rmSync(sandboxRoot, { recursive: true, force: true });
		} catch {}
	});

	it("applies PUT inside a linked git worktree (absolute and ~/ paths) when cwd is the main repo", async () => {
		const alphaPath = join(wtDir, "src", "alpha.ts");
		const targetPath = "~/projects/demo-repo-wt/src/target.ts";
		const alphaHash = computeFileHash(readFileSync(alphaPath, "utf8"));
		const targetHash = computeFileHash(readFileSync(join(wtDir, "src", "target.ts"), "utf8"));

		const res = await execPatchTool(
			mainRepoDir,
			`
[${alphaPath}#${alphaHash}]
PUT 1.=1:
+export const alpha = 99;

[${targetPath}#${targetHash}]
PUT 2.=2:
+footerUpdated();
`,
		);

		expect(res.details.ok).toBe(true);
		expect(readFileSync(alphaPath, "utf8")).toBe("export const alpha = 99;\n");
		expect(readFileSync(join(wtDir, "src", "target.ts"), "utf8")).toBe("header();\nfooterUpdated();\n");
		// Main checkout stays untouched
		expect(readFileSync(join(mainRepoDir, "src", "alpha.ts"), "utf8")).toBe("export const alpha = 1;\n");
	});

	it("applies cross-file CUT/PUT @reg and MV into a new subdirectory inside a linked worktree when cwd is /tmp scratch", async () => {
		const srcFile = join(wtDir, "src", "source.ts");
		const dstFile = join(wtDir, "src", "target.ts");
		const oldFile = join(wtDir, "src", "old-name.ts");
		const movedFile = join(wtDir, "src", "nested", "new-name.ts");

		const hSrc = computeFileHash(readFileSync(srcFile, "utf8"));
		const hDst = computeFileHash(readFileSync(dstFile, "utf8"));
		const hOld = computeFileHash(readFileSync(oldFile, "utf8"));

		const res = await execPatchTool(
			scratchCwd,
			`
[${srcFile}#${hSrc}]
CUT 2.=3 @movedBlock

[${dstFile}#${hDst}]
PUT >1 @movedBlock

[${oldFile}#${hOld}]
PUT 1.=1:
+export const moved = true;
MV ${movedFile}
`,
		);

		expect(res.details.ok).toBe(true);
		expect(readFileSync(srcFile, "utf8")).toBe("keepTop();\nkeepBottom();\n");
		expect(readFileSync(dstFile, "utf8")).toBe("header();\ncutLineOne();\ncutLineTwo();\nfooter();\n");
		expect(existsSync(oldFile)).toBe(false);
		expect(readFileSync(movedFile, "utf8")).toBe("export const moved = true;\n");
	});

	it("refuses main git checkouts outside cwd (.git directory is not a linked worktree)", async () => {
		const mainAlpha = join(mainRepoDir, "src", "alpha.ts");
		const hash = computeFileHash(readFileSync(mainAlpha, "utf8"));

		const resAbs = await execPatchTool(scratchCwd, `[${mainAlpha}#${hash}]\nPUT 1.=1:\n+export const alpha = 2;\n`);
		expect(resAbs.details.ok).toBe(false);
		expect(resAbs.details.summary).toContain("Path out of bounds");

		const resTilde = await execPatchTool(
			wtDir,
			`[~/projects/demo-repo/src/alpha.ts#${hash}]\nPUT 1.=1:\n+export const alpha = 2;\n`,
		);
		expect(resTilde.details.ok).toBe(false);
		expect(resTilde.details.summary).toContain("Path out of bounds");
		expect(readFileSync(mainAlpha, "utf8")).toBe("export const alpha = 1;\n");
	});

	it("refuses ~/.pi/... and plain sibling directories without a linked-worktree .git file", async () => {
		const piSettings = join(testHome, ".pi", "agent", "settings.json");
		const plainNote = join(plainSiblingDir, "note.txt");

		const resPi = await execPatchTool(mainRepoDir, `[~/.pi/agent/settings.json]\nPUT 1.=1:\n+{"safe":false}\n`);
		expect(resPi.details.ok).toBe(false);
		expect(resPi.details.summary).toContain("Path out of bounds");
		expect(readFileSync(piSettings, "utf8")).toBe('{"safe":true}\n');

		const resSibling = await execPatchTool(mainRepoDir, `[${plainNote}]\nPUT 1.=1:\n+tampered\n`);
		expect(resSibling.details.ok).toBe(false);
		expect(resSibling.details.summary).toContain("Path out of bounds");
		expect(readFileSync(plainNote, "utf8")).toBe("plain sibling\n");
	});

	it("refuses forged .git files missing commondir/gitdir or pointing to another worktree's gitdir", async () => {
		// Case A: forged .git file pointing to a directory without commondir/gitdir
		const forgedA = join(testHome, "projects", "forged-wt-a");
		mkdirSync(join(forgedA, "fake-gitdir"), { recursive: true });
		writeFileSync(join(forgedA, ".git"), "gitdir: ./fake-gitdir\n");
		writeFileSync(join(forgedA, "app.ts"), "const ok = true;\n");

		const resA = await execPatchTool(scratchCwd, `[${join(forgedA, "app.ts")}]\nPUT 1.=1:\n+const ok = false;\n`);
		expect(resA.details.ok).toBe(false);
		expect(resA.details.summary).toContain("Path out of bounds");
		expect(readFileSync(join(forgedA, "app.ts"), "utf8")).toBe("const ok = true;\n");

		// Case B: forged .git file pointing at demo-repo-wt's real gitdir (back-pointer mismatch)
		const forgedB = join(testHome, "projects", "forged-wt-b");
		mkdirSync(forgedB, { recursive: true });
		const realWtDotGit = readFileSync(join(wtDir, ".git"), "utf8");
		writeFileSync(join(forgedB, ".git"), realWtDotGit);
		writeFileSync(join(forgedB, "app.ts"), "const safe = true;\n");

		const resB = await execPatchTool(scratchCwd, `[${join(forgedB, "app.ts")}]\nPUT 1.=1:\n+const safe = false;\n`);
		expect(resB.details.ok).toBe(false);
		expect(resB.details.summary).toContain("Path out of bounds");
		expect(readFileSync(join(forgedB, "app.ts"), "utf8")).toBe("const safe = true;\n");
	});

	it("refuses ../ traversal and MV dest escaping the linked worktree root", async () => {
		const alphaPath = join(wtDir, "src", "alpha.ts");
		const hash = computeFileHash(readFileSync(alphaPath, "utf8"));

		// ../ traversal in section header
		const resTraversal = await execPatchTool(scratchCwd, `[${wtDir}/../plain-sibling/note.txt]\nPUT 1.=1:\n+escaped\n`);
		expect(resTraversal.details.ok).toBe(false);
		expect(resTraversal.details.summary).toContain("Path out of bounds");

		// MV ../escape out of worktree to sibling folder
		const escapedSibling = join(wtDir, "..", "escaped.ts");
		const resMvSibling = await execPatchTool(scratchCwd, `[${alphaPath}#${hash}]\nMV ${escapedSibling}\n`);
		expect(resMvSibling.details.ok).toBe(false);
		expect(resMvSibling.details.summary).toContain("Path out of bounds");
		expect(existsSync(alphaPath)).toBe(true);
		expect(existsSync(join(testHome, "projects", "escaped.ts"))).toBe(false);

		// MV out of linked worktree into cwd (main repo)
		const snuckIntoCwd = join(mainRepoDir, "src", "snuck.ts");
		const resMvIntoCwd = await execPatchTool(mainRepoDir, `[${alphaPath}#${hash}]\nMV ${snuckIntoCwd}\n`);
		expect(resMvIntoCwd.details.ok).toBe(false);
		expect(resMvIntoCwd.details.summary).toContain("Path out of bounds");
		expect(existsSync(alphaPath)).toBe(true);
		expect(existsSync(snuckIntoCwd)).toBe(false);
	});

	it("refuses symlinks inside worktree or cwd pointing outside their root, and refuses .git itself", async () => {
		// 1. Symlink inside worktree -> existing file outside worktree
		const linkToOutside = join(wtDir, "src", "outside-link.txt");
		symlinkSync(join(plainSiblingDir, "note.txt"), linkToOutside);
		const resLink = await execPatchTool(mainRepoDir, `[${linkToOutside}]\nPUT 1.=1:\n+via symlink\n`);
		expect(resLink.details.ok).toBe(false);
		expect(resLink.details.summary).toContain("Path out of bounds");
		expect(readFileSync(join(plainSiblingDir, "note.txt"), "utf8")).toBe("plain sibling\n");

		// 2. Broken symlink inside worktree -> non-existent file outside worktree used as MV target
		const brokenEscapeLink = join(wtDir, "src", "broken-escape.ts");
		symlinkSync(join(plainSiblingDir, "created-outside.ts"), brokenEscapeLink);
		const alphaPath = join(wtDir, "src", "alpha.ts");
		const hash = computeFileHash(readFileSync(alphaPath, "utf8"));
		const resBrokenMv = await execPatchTool(mainRepoDir, `[${alphaPath}#${hash}]\nMV ${brokenEscapeLink}\n`);
		expect(resBrokenMv.details.ok).toBe(false);
		expect(resBrokenMv.details.summary).toContain("Path out of bounds");
		expect(existsSync(join(plainSiblingDir, "created-outside.ts"))).toBe(false);
		expect(existsSync(alphaPath)).toBe(true);

		// 3. Symlink inside cwd -> file outside cwd
		const cwdLink = join(scratchCwd, "cwd-escape.txt");
		symlinkSync(join(plainSiblingDir, "note.txt"), cwdLink);
		const resCwdLink = await execPatchTool(scratchCwd, `[cwd-escape.txt]\nPUT 1.=1:\n+escaped cwd\n`);
		expect(resCwdLink.details.ok).toBe(false);
		expect(resCwdLink.details.summary).toContain("Path out of bounds");
		expect(readFileSync(join(plainSiblingDir, "note.txt"), "utf8")).toBe("plain sibling\n");

		// 4. Directory symlink inside worktree -> directory outside worktree
		const outsideSubDir = join(plainSiblingDir, "sub");
		mkdirSync(outsideSubDir, { recursive: true });
		writeFileSync(join(outsideSubDir, "secret.txt"), "do not touch\n");
		const dirLink = join(wtDir, "src", "dir-link");
		symlinkSync(outsideSubDir, dirLink);
		const resDirLink = await execPatchTool(mainRepoDir, `[${join(dirLink, "secret.txt")}]\nPUT 1.=1:\n+touched\n`);
		expect(resDirLink.details.ok).toBe(false);
		expect(resDirLink.details.summary).toContain("Path out of bounds");
		expect(readFileSync(join(outsideSubDir, "secret.txt"), "utf8")).toBe("do not touch\n");

		// 5. .git file inside linked worktree cannot be modified via patch
		const resDotGit = await execPatchTool(scratchCwd, `[${join(wtDir, ".git")}]\nPUT 1.=1:\n+gitdir: /bad\n`);
		expect(resDotGit.details.ok).toBe(false);
		expect(resDotGit.details.summary).toContain("Path out of bounds");
	});

	it("keeps raw applyHashlinePatch default strict to cwd unless allowLinkedWorktrees is enabled", () => {
		const alphaPath = join(wtDir, "src", "alpha.ts");
		const hash = computeFileHash(readFileSync(alphaPath, "utf8"));
		const res = applyHashlinePatch(`[${alphaPath}#${hash}]\nPUT 1.=1:\n+export const alpha = 7;\n`, {
			cwd: mainRepoDir,
		});
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("Path out of bounds");
		expect(readFileSync(alphaPath, "utf8")).toBe("export const alpha = 1;\n");
	});
});
