/**
 * lazy-images: pictures in chat messages go to the page as placeholders (type, bytes, width, height,
 * URL) and load when they scroll into view.
 *
 * Covered here: width/height from the file header (PNG, GIF, WebP, JPEG), the placeholder serializer
 * and its picture numbering (the n in the URL is the index the endpoint looks up), the endpoint's
 * address checks, bytes and headers, the question index and digests over raw SDK messages, the page's
 * picture helpers, and edit-and-re-ask with placeholders.
 */
import { describe, expect, it, vi } from "vitest";
import { base64Bytes, imageMetaOf, imageSize, imageVersion, servedImageType } from "../../server/image-meta.js";
import { chatImageHeaders, imageIfVersion, parseChatImageAddress } from "../../server/chat-image.js";
import {
	imageBlocksOf,
	imageDataOf,
	isShownMessage,
	serializeMessage,
	type ImageUrlFor,
} from "../../server/serialize.js";
import { buildQuestionIndex } from "../../server/question-index.js";
import { snapshotDigests } from "../../server/exchange-digest.js";
import type { UiContentBlock, UiImageBlock, UiMessage } from "../../server/protocol.js";
import {
	fetchImageBase64,
	imageSrc,
	isLazyImage,
	isShownImage,
	markImageLoaded,
	placeholderSrc,
	resolveImageUrls,
	resolveLazyImages,
	retrySrc,
	splitDataUrl,
	wasImageLoaded,
} from "../../web/src/chat-image.js";
import { collectQuestionAttachments, type EditPromptAttachment } from "../../web/src/question-attachments.js";

type Msg = Parameters<typeof serializeMessage>[0];

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A PNG header of the given size, padded with `extra` zero bytes (a big picture without a real body). */
function png(width: number, height: number, extra = 0): string {
	const b = Buffer.alloc(33 + extra);
	b.writeUInt32BE(0x89504e47, 0);
	b.writeUInt32BE(0x0d0a1a0a, 4);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "latin1");
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	return b.toString("base64");
}

function gif(width: number, height: number): string {
	const b = Buffer.alloc(16);
	b.write("GIF89a", 0, "latin1");
	b.writeUInt16LE(width, 6);
	b.writeUInt16LE(height, 8);
	return b.toString("base64");
}

function webp(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): string {
	const b = Buffer.alloc(40);
	b.write("RIFF", 0, "latin1");
	b.writeUInt32LE(32, 4);
	b.write("WEBP", 8, "latin1");
	b.write(chunk, 12, "latin1");
	b.writeUInt32LE(20, 16);
	if (chunk === "VP8 ") {
		b[23] = 0x9d;
		b[24] = 0x01;
		b[25] = 0x2a;
		b.writeUInt16LE(width, 26);
		b.writeUInt16LE(height, 28);
	} else if (chunk === "VP8L") {
		b[20] = 0x2f;
		b.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
	} else {
		b.writeUIntLE(width - 1, 24, 3);
		b.writeUIntLE(height - 1, 27, 3);
	}
	return b.toString("base64");
}

/** A JPEG up to its frame header: APP0, an optional big APP1 (EXIF), an optional DHT, fill bytes, SOFn. */
function jpeg(
	width: number,
	height: number,
	opts: { app1Bytes?: number; dht?: boolean; fill?: number; sof?: number } = {},
): string {
	const out: number[] = [0xff, 0xd8];
	out.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0);
	if (opts.app1Bytes) {
		const len = opts.app1Bytes + 2;
		out.push(0xff, 0xe1, (len >> 8) & 0xff, len & 0xff);
		for (let i = 0; i < opts.app1Bytes; i++) out.push(0x41);
	}
	if (opts.dht) out.push(0xff, 0xc4, 0x00, 0x04, 0x00, 0x00);
	for (let i = 0; i < (opts.fill ?? 0); i++) out.push(0xff);
	out.push(
		0xff,
		opts.sof ?? 0xc0,
		0x00,
		0x11,
		0x08,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
	);
	out.push(0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
	out.push(0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0xff, 0xd9);
	return Buffer.from(out).toString("base64");
}

describe("imageSize: width and height from the file header", () => {
	it("PNG", () => {
		expect(imageSize(TINY_PNG)).toEqual({ width: 1, height: 1 });
		expect(imageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
	});

	it("GIF", () => {
		expect(imageSize(gif(64, 32))).toEqual({ width: 64, height: 32 });
	});

	it("WebP: lossy (VP8), lossless (VP8L) and extended (VP8X)", () => {
		expect(imageSize(webp("VP8 ", 800, 600))).toEqual({ width: 800, height: 600 });
		expect(imageSize(webp("VP8L", 1024, 768))).toEqual({ width: 1024, height: 768 });
		expect(imageSize(webp("VP8X", 4000, 3000))).toEqual({ width: 4000, height: 3000 });
	});

	it("JPEG: baseline, progressive (SOF2), after a DHT and fill bytes", () => {
		expect(imageSize(jpeg(1280, 720))).toEqual({ width: 1280, height: 720 });
		expect(imageSize(jpeg(640, 480, { sof: 0xc2 }))).toEqual({ width: 640, height: 480 });
		expect(imageSize(jpeg(300, 200, { dht: true, fill: 3 }))).toEqual({ width: 300, height: 200 });
	});

	it("JPEG whose frame header comes after an EXIF segment bigger than the first decoded 4 KB", () => {
		const b64 = jpeg(3024, 4032, { app1Bytes: 20_000 });
		expect(base64Bytes(b64)).toBeGreaterThan(20_000);
		expect(imageSize(b64)).toEqual({ width: 3024, height: 4032 });
	});

	it("null for unknown data, too-short input, zero sizes and a JPEG without a frame header", () => {
		expect(imageSize(Buffer.from("just some text, not a picture").toString("base64"))).toBeNull();
		expect(imageSize("")).toBeNull();
		expect(imageSize("AAAA")).toBeNull();
		expect(imageSize(png(0, 10))).toBeNull();
		const noSof = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0xff, 0xd9]);
		expect(imageSize(noSof.toString("base64"))).toBeNull();
		// A JPEG cut off in the middle of a segment.
		expect(imageSize(jpeg(10, 10, { app1Bytes: 9000 }).slice(0, 3000))).toBeNull();
	});
});

describe("image facts: bytes, fingerprint, served type", () => {
	it("base64Bytes counts decoded bytes without decoding", () => {
		expect(base64Bytes("eA==")).toBe(1);
		expect(base64Bytes("eHk=")).toBe(2);
		expect(base64Bytes("eHl6")).toBe(3);
		expect(base64Bytes("eHl6\n")).toBe(3);
		expect(base64Bytes("")).toBe(0);
		const p = png(10, 10, 1000);
		expect(base64Bytes(p)).toBe(Buffer.from(p, "base64").length);
	});

	it("imageVersion: 16 URL-safe chars, the same for the same bytes, different for different bytes", () => {
		const a = imageVersion(png(1, 1));
		expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/);
		expect(imageVersion(png(1, 1))).toBe(a);
		expect(imageVersion(png(1, 2))).not.toBe(a);
	});

	it("imageMetaOf is cached per block object", () => {
		const data = png(10, 20, 100);
		const block = { type: "image", data, mimeType: "image/png" };
		const meta = imageMetaOf(block, data);
		expect(meta).toEqual({ bytes: 133, width: 10, height: 20, v: imageVersion(data) });
		expect(imageMetaOf(block, data)).toBe(meta);
	});

	it("servedImageType sniffs the bytes and only trusts a declared image type", () => {
		const bytes = (b64: string) => Buffer.from(b64, "base64");
		expect(servedImageType(bytes(png(1, 1)), "image/jpeg")).toBe("image/png");
		expect(servedImageType(bytes(jpeg(1, 1)), undefined)).toBe("image/jpeg");
		expect(servedImageType(bytes(gif(1, 1)), undefined)).toBe("image/gif");
		expect(servedImageType(bytes(webp("VP8X", 1, 1)), undefined)).toBe("image/webp");
		expect(servedImageType(Buffer.from("<svg/>"), "image/svg+xml")).toBe("image/svg+xml");
		expect(servedImageType(Buffer.from("<html>"), "text/html")).toBe("application/octet-stream");
		expect(servedImageType(Buffer.from("??"), undefined)).toBe("application/octet-stream");
	});
});

const URL_FOR: ImageUrlFor = (msgId, n, v) => `/api/chat-image/s1/${encodeURIComponent(msgId)}/${n}?v=${v}`;

function toolResult(content: unknown[]): Msg {
	return {
		role: "toolResult",
		toolCallId: "tc-shot",
		toolName: "web_shot",
		content,
		isError: false,
		timestamp: 456,
	} as unknown as Msg;
}

function imagesOf(m: UiMessage): UiImageBlock[] {
	return m.content.filter((b): b is UiImageBlock => b.type === "image");
}

/** The n and v a placeholder URL carries. */
function addressOf(img: UiImageBlock): { n: number; v: string } {
	const m = /\/(\d+)\?v=([A-Za-z0-9_-]+)$/.exec(img.url ?? "");
	if (!m) throw new Error(`not a placeholder URL: ${img.url}`);
	return { n: Number(m[1]), v: m[2] };
}

describe("serializeMessage with a picture URL: placeholders instead of pictures", () => {
	it("user pictures become placeholders numbered in order; text between them is untouched", () => {
		const p1 = png(1920, 1080, 500);
		const p2 = gif(64, 32);
		const m = {
			role: "user",
			timestamp: 111,
			content: [
				{ type: "image", data: p1, mimeType: "image/png" },
				{ type: "text", text: "between" },
				{ type: "image", data: p2, mimeType: "image/gif" },
			],
		} as unknown as Msg;
		const ui = serializeMessage(m, 1, URL_FOR);
		if (!ui) throw new Error("no message");
		const imgs = imagesOf(ui);
		expect(imgs).toEqual([
			{
				type: "image",
				url: `/api/chat-image/s1/${ui.id}/0?v=${imageVersion(p1)}`,
				mimeType: "image/png",
				bytes: 533,
				width: 1920,
				height: 1080,
			},
			{
				type: "image",
				url: `/api/chat-image/s1/${ui.id}/1?v=${imageVersion(p2)}`,
				mimeType: "image/gif",
				bytes: 16,
				width: 64,
				height: 32,
			},
		]);
		expect(ui.content[1]).toEqual({ type: "text", text: "between" });
		expect(JSON.stringify(ui)).not.toContain(p1);
	});

	it("without a picture URL pictures stay inline, as before", () => {
		const m = { role: "user", timestamp: 1, content: [{ type: "image", data: TINY_PNG, mimeType: "image/png" }] };
		const ui = serializeMessage(m as unknown as Msg, 1);
		expect(ui && imagesOf(ui)[0].dataUrl).toBe(`data:image/png;base64,${TINY_PNG}`);
	});

	it("a 3 MB tool screenshot becomes a small placeholder, not '[image result]'", () => {
		const big = png(2560, 1600, 2_300_000);
		expect(big.length).toBeGreaterThan(3_000_000);
		const m = toolResult([
			{ type: "text", text: "shot" },
			{ type: "image", data: big, mimeType: "image/png" },
		]);
		const lazy = serializeMessage(m, 0, URL_FOR);
		if (!lazy) throw new Error("no message");
		expect(lazy.content[0]).toMatchObject({ type: "text", text: "shot" });
		expect(imagesOf(lazy)).toEqual([
			{
				type: "image",
				url: `/api/chat-image/s1/t-tc-shot/0?v=${imageVersion(big)}`,
				mimeType: "image/png",
				bytes: 2_300_033,
				width: 2560,
				height: 1600,
			},
		]);
		expect(JSON.stringify(lazy).length).toBeLessThan(400);
		// The inline path still falls back to the text for a picture this big.
		const inline = serializeMessage(m, 0);
		expect(JSON.stringify(inline?.content)).toContain("[image result]");
	});

	it("tool results: 8 placeholders at most, and each n is the picture's index among the message's images", () => {
		const content: unknown[] = [];
		for (let i = 0; i < 10; i++) {
			content.push({ type: "text", text: `step ${i}` });
			content.push({ type: "image", data: png(i + 1, 1), mimeType: "image/png" });
		}
		const m = toolResult(content);
		const ui = serializeMessage(m, 0, URL_FOR);
		if (!ui) throw new Error("no message");
		const imgs = imagesOf(ui);
		expect(imgs.map((b) => b.width)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		const text = ui.content.find((b): b is Extract<UiContentBlock, { type: "text" }> => b.type === "text");
		expect(text?.text.split("[image result]").length).toBe(3);
		// What the endpoint does: imageBlocksOf(message)[n] must be exactly the picture of that placeholder.
		const blocks = imageBlocksOf(m);
		expect(blocks).toHaveLength(10);
		for (const img of imgs) {
			const { n, v } = addressOf(img);
			const hit = imageIfVersion(blocks[n], v);
			expect(hit?.bytes.equals(Buffer.from((blocks[n] as { data: string }).data, "base64"))).toBe(true);
		}
	});

	it("a picture given by a remote URL is passed through as is", () => {
		const m = {
			role: "user",
			timestamp: 2,
			content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }],
		};
		const ui = serializeMessage(m as unknown as Msg, 1, URL_FOR);
		expect(ui && imagesOf(ui)).toEqual([{ type: "image", dataUrl: "https://example.com/a.png" }]);
	});

	it("an image card (custom 'file', mode image) shows only its placeholder", () => {
		const data = png(5, 7);
		const m = {
			role: "custom",
			customType: "file",
			display: true,
			timestamp: 3,
			content: [
				{ type: "text", text: "[image: a.png]" },
				{ type: "image", data, mimeType: "image/png" },
			],
			details: { mode: "image", name: "a.png" },
		};
		const ui = serializeMessage(m as unknown as Msg, 0, URL_FOR);
		if (!ui) throw new Error("no message");
		expect(ui.content).toHaveLength(1);
		expect(ui.content[0]).toMatchObject({ type: "image", width: 5, height: 7, bytes: 33 });
		expect(addressOf(ui.content[0] as UiImageBlock)).toEqual({ n: 0, v: imageVersion(data) });
	});

	it("isShownMessage, imageDataOf and imageBlocksOf", () => {
		expect(isShownMessage({ role: "system" } as unknown as Msg)).toBe(false);
		expect(isShownMessage({ role: "custom", display: false } as unknown as Msg)).toBe(false);
		expect(isShownMessage({ role: "custom", display: true } as unknown as Msg)).toBe(true);
		expect(isShownMessage({ role: "user", content: "x" } as unknown as Msg)).toBe(true);

		expect(imageDataOf({ type: "image", data: "AAAA", mimeType: "image/png" })).toEqual({
			data: "AAAA",
			mimeType: "image/png",
		});
		expect(imageDataOf({ type: "image", source: { type: "base64", data: "AAAA", mediaType: "image/jpeg" } })).toEqual({
			data: "AAAA",
			mimeType: "image/jpeg",
		});
		expect(imageDataOf({ type: "image", source: { type: "url", url: "https://x" } })).toBeNull();
		expect(imageDataOf(null)).toBeNull();

		expect(imageBlocksOf({ role: "user", content: "plain" } as unknown as Msg)).toEqual([]);
		const a = { type: "image", data: "AAAA" };
		const b = { type: "image", data: "BBBB" };
		expect(imageBlocksOf({ role: "user", content: [a, { type: "text", text: "t" }, b] } as unknown as Msg)).toEqual([
			a,
			b,
		]);
	});
});

describe("the picture endpoint's pure parts", () => {
	const V = "abcdefghijklmnop";

	it("parseChatImageAddress: any id text within limits, n digits only, v exactly 16 URL-safe chars", () => {
		expect(parseChatImageAddress("sess-1", "t-call_01:x", "3", V)).toEqual({
			sessionId: "sess-1",
			msgId: "t-call_01:x",
			n: 3,
			v: V,
		});
		// Ids are only compared with in-memory ids, never used as paths: odd text is allowed and can only miss.
		expect(parseChatImageAddress("../../etc", "passwd", "0", V)).toMatchObject({ sessionId: "../../etc" });
		expect(parseChatImageAddress("", "m", "0", V)).toBeNull();
		expect(parseChatImageAddress("s", "x".repeat(301), "0", V)).toBeNull();
		expect(parseChatImageAddress("s", "m", "-1", V)).toBeNull();
		expect(parseChatImageAddress("s", "m", "12345", V)).toBeNull();
		expect(parseChatImageAddress("s", "m", "1e2", V)).toBeNull();
		expect(parseChatImageAddress("s", "m", "0", "short")).toBeNull();
		expect(parseChatImageAddress("s", "m", "0", "abcdefghijklmno/")).toBeNull();
		expect(parseChatImageAddress("s", "m", "0", undefined)).toBeNull();
		expect(parseChatImageAddress("s", "m", "0", [V, V])).toBeNull();
	});

	it("imageIfVersion returns the exact bytes and the sniffed type, and nothing for another fingerprint", () => {
		const data = jpeg(40, 30);
		const block = { type: "image", data, mimeType: "image/png" };
		const hit = imageIfVersion(block, imageVersion(data));
		expect(hit?.bytes.equals(Buffer.from(data, "base64"))).toBe(true);
		expect(hit?.mimeType).toBe("image/jpeg");
		expect(imageIfVersion(block, imageVersion(png(1, 1)))).toBeNull();
		expect(imageIfVersion({ type: "image", source: { type: "url", url: "https://x" } }, V)).toBeNull();
		expect(imageIfVersion(undefined, V)).toBeNull();
	});

	it("headers: exact length, long private cache, sandboxed, no sniffing", () => {
		const bytes = Buffer.from(TINY_PNG, "base64");
		expect(chatImageHeaders({ bytes, mimeType: "image/png" })).toEqual({
			"Content-Type": "image/png",
			"Content-Length": String(bytes.length),
			"Cache-Control": "private, max-age=31536000, immutable",
			"Content-Security-Policy": "sandbox",
			"X-Content-Type-Options": "nosniff",
		});
	});
});

describe("question index and digests over raw SDK messages (only the sent messages are serialized)", () => {
	const raw = [
		{ role: "user", content: "first question" },
		{ role: "assistant", content: [{ type: "text", text: "a1" }], stopReason: "stop" },
		{
			role: "user",
			content: [
				{ type: "image", data: TINY_PNG, mimeType: "image/png" },
				{ type: "text", text: "second" },
			],
		},
		{ role: "assistant", content: [{ type: "text", text: "a2" }], stopReason: "stop" },
		{ role: "user", content: "third" },
		{ role: "assistant", content: [{ type: "text", text: "a3" }], stopReason: "stop" },
	];

	it("buildQuestionIndex reads plain-string and block content, ids from the given function", () => {
		expect(buildQuestionIndex(raw, (i) => `id-${i}`)).toEqual([
			{ id: "id-0", index: 0, text: "first question" },
			{ id: "id-2", index: 2, text: "second" },
			{ id: "id-4", index: 4, text: "third" },
		]);
	});

	it("snapshotDigests takes the display form of only the messages it shows", () => {
		const full = vi.fn((i: number): UiMessage => ({
			id: `full-${i}`,
			role: raw[i].role as UiMessage["role"],
			content: [{ type: "text", text: `shown ${i}` }],
			stopReason: raw[i].role === "assistant" ? "stop" : undefined,
		}));
		const digests = snapshotDigests(raw, 4, 2, full);
		expect(digests).toHaveLength(1);
		expect(digests[0]).toMatchObject({ index: 2, end: 4 });
		expect(digests[0].head.map((m) => m.id)).toEqual(["full-2"]);
		expect(digests[0].answers.every((m) => m.id.startsWith("full-"))).toBe(true);
		// Only the digested exchange (messages 2 and 3) was turned into display form.
		expect(new Set(full.mock.calls.map((c) => c[0]))).toEqual(new Set([2, 3]));
	});
});

describe("the page's picture helpers (web/src/chat-image.ts)", () => {
	it("isShownImage and isLazyImage", () => {
		expect(isShownImage({ type: "image", url: "/a" } as { type: string })).toBe(true);
		expect(isShownImage({ type: "image", dataUrl: "data:x" } as { type: string })).toBe(true);
		expect(isShownImage({ type: "image" })).toBe(false);
		expect(isShownImage({ type: "text" })).toBe(false);
		expect(isLazyImage({ type: "image", url: "/a" })).toBe(true);
		expect(isLazyImage({ type: "image", url: "/a", dataUrl: "data:x" })).toBe(false);
		expect(isLazyImage({ type: "image", url: "" })).toBe(false);
	});

	it("imageSrc: inline data as is, a placeholder through the base-path/token function", () => {
		const base = vi.fn((p: string) => `/pi${p}&token=t`);
		expect(imageSrc({ type: "image", dataUrl: "data:image/png;base64,AA" }, base)).toBe("data:image/png;base64,AA");
		expect(base).not.toHaveBeenCalled();
		expect(imageSrc({ type: "image", url: "/api/chat-image/s/m/0?v=x" }, base)).toBe(
			"/pi/api/chat-image/s/m/0?v=x&token=t",
		);
		expect(imageSrc({ type: "image" }, base)).toBeUndefined();
	});

	it("placeholderSrc: a gray box of the picture's own size, or a default size", () => {
		const svg = (src: string) => decodeURIComponent(src.replace(/^data:image\/svg\+xml,/, ""));
		expect(svg(placeholderSrc(1920, 1080))).toContain('width="1920" height="1080"');
		expect(svg(placeholderSrc())).toContain('width="320" height="180"');
		expect(svg(placeholderSrc(0, -5))).toContain('width="320" height="180"');
	});

	it("retrySrc makes a new address per retry, never for inline data", () => {
		expect(retrySrc("/a?v=1", 0)).toBe("/a?v=1");
		expect(retrySrc("/a?v=1", 2)).toBe("/a?v=1&retry=2");
		expect(retrySrc("/a", 1)).toBe("/a?retry=1");
		expect(retrySrc("data:image/png;base64,AA", 3)).toBe("data:image/png;base64,AA");
	});

	it("remembers loaded pictures", () => {
		expect(wasImageLoaded("/x?v=unique")).toBe(false);
		markImageLoaded("/x?v=unique");
		expect(wasImageLoaded("/x?v=unique")).toBe(true);
	});

	it("splitDataUrl", () => {
		expect(splitDataUrl("data:image/png;base64,AAAA")).toEqual({ data: "AAAA", mimeType: "image/png" });
		expect(splitDataUrl("data:;base64,AA")).toEqual({ data: "AA", mimeType: "image/png" });
		expect(splitDataUrl("https://example.com/a.png")).toBeNull();
	});

	it("fetchImageBase64: the bytes as base64 (big ones too) and the type from the response", async () => {
		const bytes = Buffer.alloc(100_000);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
		const fetchFn = vi.fn(
			async () => new Response(new Uint8Array(bytes), { headers: { "content-type": "image/webp; x=1" } }),
		);
		const got = await fetchImageBase64("/api/chat-image/s/m/0?v=x", fetchFn as unknown as typeof fetch, (p) => `B${p}`);
		expect(fetchFn).toHaveBeenCalledWith("B/api/chat-image/s/m/0?v=x");
		expect(got).toEqual({ data: bytes.toString("base64"), mimeType: "image/webp" });
		const missing = vi.fn(async () => new Response("picture not found", { status: 404 }));
		await expect(fetchImageBase64("/p", missing as unknown as typeof fetch, (p) => p)).rejects.toThrow("HTTP 404");
	});

	it("resolveImageUrls fetches only placeholder pictures and fails if one can't be fetched", async () => {
		const other: EditPromptAttachment = { path: "src/a.ts", mode: "reference" };
		const inline: EditPromptAttachment = { path: "", imageData: "AAAA", mimeType: "image/gif" };
		const atts: EditPromptAttachment[] = [
			{ path: "", imageUrl: "/p1", mimeType: "image/png", name: "a.png" },
			other,
			inline,
		];
		const fetchOne = vi.fn(async (p: string) => ({ data: `DATA${p}`, mimeType: "image/jpeg" }));
		const out = await resolveImageUrls(atts, fetchOne);
		expect(out[0]).toEqual({ path: "", imageData: "DATA/p1", mimeType: "image/png", name: "a.png" });
		expect(out[1]).toBe(other);
		expect(out[2]).toBe(inline);
		expect(fetchOne).toHaveBeenCalledTimes(1);
		await expect(
			resolveImageUrls([{ path: "", imageUrl: "/gone" }], async () => {
				throw new Error("HTTP 404");
			}),
		).rejects.toThrow("HTTP 404");
	});

	it("resolveLazyImages puts the real address into pictures that haven't loaded (copy as image)", () => {
		const fakeImg = (attrs: Record<string, string>) => {
			const a = new Map(Object.entries(attrs));
			return {
				attrs: a,
				getAttribute: (k: string) => a.get(k) ?? null,
				setAttribute: (k: string, v: string) => void a.set(k, v),
				removeAttribute: (k: string) => void a.delete(k),
			};
		};
		const pending = fakeImg({ src: "data:image/svg+xml,box", "data-src": "/real?v=1" });
		const loaded = fakeImg({ src: "/loaded" });
		const root = {
			querySelectorAll: (sel: string) =>
				[pending, loaded].filter((i) => sel === "img[data-src]" && i.attrs.has("data-src")),
		};
		resolveLazyImages(root as unknown as ParentNode);
		expect(Object.fromEntries(pending.attrs)).toEqual({ src: "/real?v=1" });
		expect(Object.fromEntries(loaded.attrs)).toEqual({ src: "/loaded" });
	});
});

describe("edit and re-ask with placeholder pictures", () => {
	it("a question's own placeholder picture and a following image card become imageUrl attachments", () => {
		const atts = collectQuestionAttachments([
			{
				id: "u-1-1",
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", url: "/api/chat-image/s/u-1-1/0?v=abcdefghijklmnop", mimeType: "image/jpeg" },
				],
			},
			{
				id: "c-2",
				role: "custom",
				customType: "file",
				details: { mode: "image", name: "shot.png" },
				content: [{ type: "image", url: "/api/chat-image/s/c-2/0?v=bcdefghijklmnopq", mimeType: "image/png" }],
			},
		]).get("u-1-1");
		expect(atts).toEqual([
			{
				path: "",
				imageUrl: "/api/chat-image/s/u-1-1/0?v=abcdefghijklmnop",
				mimeType: "image/jpeg",
				name: "image.jpeg",
			},
			{ path: "", imageUrl: "/api/chat-image/s/c-2/0?v=bcdefghijklmnopq", mimeType: "image/png", name: "shot.png" },
		]);
	});
});
