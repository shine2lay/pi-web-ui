/**
 * image-aside-label: every image aside carries one line of text next to its image, and the page
 * doesn't show it.
 *
 * Why: context extensions that rebuild the model's message list from text drop a custom message
 * with no text part. billion-context-pi keeps one only if `extractText(content).length > 0`, so
 * a pasted picture (an aside holding just an image) never reached the model. The end-to-end proof
 * with the real extension is tests/image-aside-acp-test.mjs; here: the asides and the page side.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAttachmentMessages, imageLabel, type AttachmentContext } from "../../server/attachments.js";
import { serializeMessage } from "../../server/serialize.js";

// 1x1 PNG (base64, no data: prefix).
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-image-label-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Aside = { message: { customType: string; content: Block[]; details: { mode?: string; path?: string } } };

function makeCtx(opts: {
	cwd: string;
	input: string[];
	visionBridgeEnabled?: boolean;
	notices?: { level: string; text: string }[];
}): AttachmentContext {
	return {
		cwd: opts.cwd,
		clientId: "image-label-test",
		emit: (m: { level?: string; text?: string; [k: string]: unknown }) =>
			opts.notices?.push({ level: m.level ?? "", text: m.text ?? "" }),
		// Only the vision-bridge path reads settings; these tests never bridge.
		settings: { visionBridgeEnabled: opts.visionBridgeEnabled ?? true } as unknown as AttachmentContext["settings"],
		session: {
			model: { id: "m", name: "M", input: opts.input },
			modelRuntime: null,
		} as unknown as AttachmentContext["session"],
	};
}

/** What billion-context-pi reads to decide whether a custom message stays in context. */
const textOf = (content: Block[]) =>
	content
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");

describe("image-aside-label: image asides carry text", () => {
	it("a pasted image: a line naming it, then the image", async () => {
		const out = (await buildAttachmentMessages(makeCtx({ cwd: tempDir(), input: ["text", "image"] }), [
			{ path: "", imageData: TINY_PNG, mimeType: "image/png", name: "shot.png" },
		])) as Aside[];
		expect(out).toHaveLength(1);
		const { content, details } = out[0].message;
		expect(details.mode).toBe("image");
		expect(content).toEqual([
			{ type: "text", text: '<image name="shot.png" />' },
			{ type: "image", data: TINY_PNG, mimeType: "image/png" },
		]);
		expect(textOf(content).length).toBeGreaterThan(0);
	});

	it("a pasted image with no name gets a default one", async () => {
		const out = (await buildAttachmentMessages(makeCtx({ cwd: tempDir(), input: ["text", "image"] }), [
			{ path: "", imageData: `data:image/png;base64,${TINY_PNG}`, mimeType: "image/png" },
		])) as Aside[];
		expect(out[0].message.content[0]).toEqual({ type: "text", text: '<image name="image.png" />' });
		expect(out[0].message.content[1].data).toBe(TINY_PNG);
	});

	it("quotes and brackets in the name are escaped", () => {
		expect(imageLabel({ name: 'a"<b>&.png' }).text).toBe('<image name="a&quot;&lt;b&gt;&amp;.png" />');
		expect(imageLabel({ path: "x/y.png" }).text).toBe('<image path="x/y.png" />');
	});

	it("a workspace image by path: the line gives its path", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, "pics"));
		writeFileSync(join(cwd, "pics", "a.png"), Buffer.from(TINY_PNG, "base64"));
		const out = (await buildAttachmentMessages(makeCtx({ cwd, input: ["text", "image"] }), [
			{ path: "pics/a.png", mode: "reference", name: "a.png" },
		])) as Aside[];
		expect(out).toHaveLength(1);
		const { content, details } = out[0].message;
		expect(details).toMatchObject({ mode: "image", path: "pics/a.png" });
		expect(content[0]).toEqual({ type: "text", text: '<image path="pics/a.png" />' });
		expect(content[1]).toMatchObject({ type: "image", data: TINY_PNG });
		expect(content).toHaveLength(2);
	});

	it("text-only model with the vision bridge off: the image goes as it is, still with its line", async () => {
		const notices: { level: string; text: string }[] = [];
		const out = (await buildAttachmentMessages(
			makeCtx({ cwd: tempDir(), input: ["text"], visionBridgeEnabled: false, notices }),
			[{ path: "", imageData: TINY_PNG, mimeType: "image/png", name: "shot.png" }],
		)) as Aside[];
		expect(notices.some((n) => n.level === "warning")).toBe(true);
		expect(out[0].message.details.mode).toBe("image");
		expect(out[0].message.content.map((b) => b.type)).toEqual(["text", "image"]);
	});
});

describe("image-aside-label: the page doesn't show the line", () => {
	const aside = (mode: string, content: Block[]) =>
		({
			role: "custom",
			customType: "file",
			content,
			display: true,
			details: { name: "shot.png", mode },
			timestamp: 1,
		}) as unknown as Parameters<typeof serializeMessage>[0];

	it("an image card shows only its image, as before", () => {
		const ui = serializeMessage(
			aside("image", [imageLabel({ name: "shot.png" }), { type: "image", data: TINY_PNG, mimeType: "image/png" }]),
			0,
		);
		expect(ui?.content).toEqual([
			{ type: "image", dataUrl: `data:image/png;base64,${TINY_PNG}`, mimeType: "image/png" },
		]);
		expect(ui?.details).toEqual({ name: "shot.png", mode: "image" });
	});

	it("other cards keep their text (an inline file, a vision-bridge transcript)", () => {
		const inline = serializeMessage(aside("inline", [{ type: "text", text: '<file path="a.txt">x</file>' }]), 0);
		expect(inline?.content).toEqual([{ type: "text", text: '<file path="a.txt">x</file>' }]);
		const bridged = serializeMessage(
			aside("bridged", [
				{ type: "text", text: "<vision-bridge>a red dot</vision-bridge>" },
				{ type: "image", data: TINY_PNG, mimeType: "image/png" },
			]),
			0,
		);
		expect(bridged?.content.map((b) => b.type)).toEqual(["text", "image"]);
	});
});
