import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesService, MAX_PREVIEW_BYTES } from "../../server/files-service.js";
import { capturePreviewTarget, replacePreviewText, snapshotFileMetadata } from "../../server/file-preview-context.js";
import type { FilePreviewMetadata, ServerMessage } from "../../server/protocol.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const root = () => {
	const path = fs.mkdtempSync(join(tmpdir(), "durable-files-"));
	roots.push(path);
	return path;
};
type Content = Extract<ServerMessage, { type: "file_content" }>;
function fixture() {
	const a = root(),
		b = root();
	fs.writeFileSync(join(a, "note.txt"), "  original A 雪\n");
	fs.writeFileSync(join(b, "note.txt"), "original B\n");
	let cwd = a,
		sessionId = "s-a",
		disposed = false;
	const seen: ServerMessage[] = [];
	const service = new FilesService({
		emit: (m) => void seen.push(m),
		isDisposed: () => disposed,
		getCwd: () => cwd,
		getActiveCwd: () => cwd,
		getSessionId: () => sessionId,
	});
	const read: FilePreviewMetadata = {
		reqId: "read-1",
		purpose: "read",
		lifetime: "preview-1",
		revision: 0,
		binding: { workspaceId: a, sessionId, openId: "open-1" },
	};
	const contents = () => seen.filter((m): m is Content => m.type === "file_content");
	return {
		a,
		b,
		service,
		seen,
		read,
		contents,
		switch: () => {
			cwd = b;
			sessionId = "s-b";
		},
		close: () => {
			disposed = true;
		},
		async writeRequest(): Promise<FilePreviewMetadata> {
			await service.readFile("note.txt", read);
			return {
				reqId: "write-1",
				purpose: "write",
				lifetime: "editor-1",
				revision: 2,
				binding: { ...contents().at(-1)!.binding! },
			};
		},
	};
}

describe("W2 actual FilesService original-target and operation replies", () => {
	it("bootstraps only the server-resolved resource and echoes the exact full read", async () => {
		const f = fixture();
		await f.service.readFile("note.txt", f.read);
		expect(f.contents()).toHaveLength(1);
		expect(f.contents()[0]).toMatchObject({
			...f.read,
			text: "  original A 雪\n",
			complete: true,
			writeSucceeded: false,
		});
		expect(f.contents()[0].binding!.resourceId).toMatch(/^file:[a-f0-9]{64}$/);
	});
	it("captures cwd/session and mutable caller metadata before the first await", async () => {
		const f = fixture();
		const pending = f.service.readFile("note.txt", f.read);
		f.switch();
		f.read.reqId = "mutated";
		f.read.binding!.openId = "mutated";
		await pending;
		expect(f.contents()[0]).toMatchObject({
			text: "  original A 雪\n",
			reqId: "read-1",
			binding: { workspaceId: f.a, sessionId: "s-a", openId: "open-1" },
		});
	});
	it("returns the full successful submitted body beyond the preview prefix, with write identity", async () => {
		const f = fixture(),
			request = await f.writeRequest();
		const text = `  ${"雪🙂\n".repeat(80_000)}\n`;
		expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_PREVIEW_BYTES);
		await f.service.writeFile("note.txt", text, request);
		expect(fs.readFileSync(join(f.a, "note.txt"), "utf8")).toBe(text);
		expect(f.contents().at(-1)).toMatchObject({
			...request,
			text,
			complete: true,
			writeSucceeded: true,
			truncated: false,
		});
		expect(f.contents()).toHaveLength(2); // no second read masquerading as an acknowledgement
	});
	it.each(["workspace", "session", "resource", "missing-resource", "purpose", "lifetime", "revision"])(
		"refuses %s mismatch without touching the file and returns the original operation",
		async (kind) => {
			const f = fixture(),
				request = await f.writeRequest();
			if (kind === "workspace") request.binding!.workspaceId = f.b;
			if (kind === "session") request.binding!.sessionId = "other";
			if (kind === "resource") request.binding!.resourceId = "file:wrong";
			if (kind === "missing-resource") delete request.binding!.resourceId;
			if (kind === "purpose") request.purpose = "read";
			if (kind === "lifetime") delete request.lifetime;
			if (kind === "revision") request.revision = -1;
			await f.service.writeFile("note.txt", "must not publish", request);
			expect(fs.readFileSync(join(f.a, "note.txt"), "utf8")).toBe("  original A 雪\n");
			expect(f.contents().at(-1)).toMatchObject({
				reqId: "write-1",
				purpose: "write",
				complete: false,
				writeSucceeded: false,
			});
			expect(f.contents().at(-1)?.error).toBeTruthy();
		},
	);
	it("old binding after a workspace/session switch cannot write the same relative name elsewhere", async () => {
		const f = fixture(),
			request = await f.writeRequest();
		f.switch();
		await f.service.writeFile("note.txt", "wrong", request);
		expect(fs.readFileSync(join(f.b, "note.txt"), "utf8")).toBe("original B\n");
		expect(f.contents().at(-1)).toMatchObject({ complete: false, writeSucceeded: false, reqId: "write-1" });
	});
	it("missing paths, traversal, closed sessions and the existing size ceiling produce explicit failed replies", async () => {
		const f = fixture();
		await f.service.readFile("missing.txt", f.read);
		await f.service.readFile("../escape.txt", { ...f.read, reqId: "escape" });
		const request = await f.writeRequest();
		await f.service.writeFile("note.txt", "x".repeat(2 * 1024 * 1024 + 1), request);
		f.close();
		await f.service.readFile("note.txt", { ...f.read, reqId: "closed" });
		expect(
			f
				.contents()
				.filter((m) => m.complete === false)
				.map((m) => m.reqId),
		).toEqual(["read-1", "escape", "write-1", "closed"]);
		expect(fs.readFileSync(join(f.a, "note.txt"), "utf8")).toBe("  original A 雪\n");
	});
	it("partial and binary reads cannot bootstrap editable full-file authority", async () => {
		const f = fixture();
		fs.writeFileSync(join(f.a, "large.txt"), "x".repeat(MAX_PREVIEW_BYTES + 20));
		fs.writeFileSync(join(f.a, "binary.bin"), Buffer.from([0, 1, 2, 3]));
		await f.service.readFile("large.txt", f.read);
		await f.service.readFile("binary.bin", f.read);
		expect(f.contents()).toMatchObject([
			{ truncated: true, complete: false },
			{ binary: true, complete: false },
		]);
	});
	it.skipIf(process.platform === "win32")(
		"symlink retarget is refused, while a stable link keeps its original target and link",
		async () => {
			const f = fixture();
			const link = join(f.a, "link.txt");
			fs.symlinkSync(join(f.a, "note.txt"), link);
			await f.service.readFile("link.txt", f.read);
			const request: FilePreviewMetadata = {
				reqId: "link-write",
				purpose: "write",
				lifetime: "edit",
				revision: 1,
				binding: f.contents().at(-1)!.binding,
			};
			fs.unlinkSync(link);
			fs.symlinkSync(join(f.b, "note.txt"), link);
			await f.service.writeFile("link.txt", "wrong", request);
			expect(fs.readFileSync(join(f.b, "note.txt"), "utf8")).toBe("original B\n");
			fs.unlinkSync(link);
			fs.symlinkSync(join(f.a, "note.txt"), link);
			await f.service.writeFile("link.txt", "  link original target\n", request);
			expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
			expect(fs.readFileSync(join(f.a, "note.txt"), "utf8")).toBe("  link original target\n");
		},
	);
	it("legacy requests still read and write, without manufacturing a modern request id", async () => {
		const f = fixture();
		await f.service.readFile("note.txt");
		await f.service.writeFile("note.txt", " legacy \n");
		expect(f.contents().at(-1)).toMatchObject({ text: " legacy \n", writeSucceeded: true });
		expect(f.contents().every((m) => m.reqId === undefined)).toBe(true);
	});
});

describe("W2 staged replacement failure preserves existing bytes", () => {
	function target() {
		const directory = root(),
			file = join(directory, "source.txt");
		fs.writeFileSync(file, "original", { mode: 0o640 });
		return {
			directory,
			file,
			target: capturePreviewTarget(file, directory, undefined, "write", snapshotFileMetadata()),
		};
	}
	it.each(["partial-write", "readback", "rename"])("%s failure cannot truncate or replace the original", (stage) => {
		const f = target();
		const io = {
			...fs,
			writeFileSync:
				stage === "partial-write"
					? (...args: Parameters<typeof fs.writeFileSync>) => {
							fs.writeFileSync(args[0], "partial");
							throw new Error("injected write failure");
						}
					: stage === "readback"
						? (...args: Parameters<typeof fs.writeFileSync>) => fs.writeFileSync(args[0], "wrong bytes")
						: fs.writeFileSync,
			renameSync:
				stage === "rename"
					? () => {
							throw new Error("injected rename failure");
						}
					: fs.renameSync,
		};
		expect(() => replacePreviewText(f.target, "full replacement", io)).toThrow();
		expect(fs.readFileSync(f.file, "utf8")).toBe("original");
		expect(fs.readdirSync(f.directory)).toEqual(["source.txt"]);
	});
	it("preserves the original ordinary POSIX permissions, owner and exact new bytes", () => {
		const f = target(),
			old = fs.statSync(f.file);
		replacePreviewText(f.target, "  replacement 雪🙂\n");
		const next = fs.statSync(f.file);
		expect(next.mode & 0o777).toBe(old.mode & 0o777);
		expect(next.uid).toBe(old.uid);
		expect(next.gid).toBe(old.gid);
		expect(fs.readFileSync(f.file, "utf8")).toBe("  replacement 雪🙂\n");
	});
	it.skipIf(process.platform === "win32")(
		"post-rename sync error remains uncertain rather than pretending the original is unchanged",
		() => {
			const f = target();
			let syncs = 0;
			expect(() =>
				replacePreviewText(f.target, "new", {
					...fs,
					fsyncSync: (fd) => {
						if (++syncs === 2) throw new Error("injected directory sync failure");
						fs.fsyncSync(fd);
					},
				}),
			).toThrow("directory sync failure");
			expect(fs.readFileSync(f.file, "utf8")).toBe("new");
		},
	);
	it("does not evaluate metadata getters or turn malformed correlated writes into legacy writes", () => {
		let read = false;
		const request = Object.defineProperty({}, "reqId", {
			get() {
				read = true;
				return "secret";
			},
		});
		const snapshot = snapshotFileMetadata(request);
		expect(read).toBe(false);
		expect(snapshot).toMatchObject({ present: true, valid: false });
		const f = target();
		expect(() => capturePreviewTarget(f.file, f.directory, undefined, "write", snapshot)).toThrow();
	});
});
