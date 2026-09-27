/**
 * lazy-images: facts about a picture the page needs before it loads the picture itself.
 *
 * Messages sent to the browser carry a placeholder instead of the picture: its type, size in bytes,
 * width and height (so the page can reserve a same-size box), and a URL the page fetches when the
 * picture is about to scroll into view (GET /api/chat-image/...). Width and height come from the
 * file header (PNG, GIF, WebP, JPEG); only the first few KB of the base64 are decoded, so a 3 MB
 * screenshot costs microseconds, not a full decode.
 *
 * `v` is a fingerprint of the picture's bytes. It goes into the URL, so the browser may cache a
 * picture forever (a URL always means the same bytes), and a stale URL (say, after a rewind renumbered
 * the messages) gets a 404 instead of the wrong picture.
 */
import { createHash } from "node:crypto";

export interface ImageMeta {
	/** Decoded size in bytes. */
	bytes: number;
	width?: number;
	height?: number;
	/** Content fingerprint for the URL (16 base64url chars of a SHA-1). */
	v: string;
}

/** Decoded byte count of a base64 string (padding aware, no decode). */
export function base64Bytes(b64: string): number {
	let len = b64.length;
	// Tolerate trailing whitespace/newlines some encoders add.
	while (len > 0 && /\s/.test(b64[len - 1])) len--;
	let pad = 0;
	if (len > 0 && b64[len - 1] === "=") pad++;
	if (len > 1 && b64[len - 2] === "=") pad++;
	return Math.max(0, Math.floor((len * 3) / 4) - pad);
}

/** Decode the first `bytes` bytes of a base64 string (or all of it when shorter). */
function decodePrefix(b64: string, bytes: number): Buffer {
	const chars = Math.ceil(bytes / 3) * 4;
	return Buffer.from(chars >= b64.length ? b64 : b64.slice(0, chars), "base64");
}

function pngSize(b: Buffer): { width: number; height: number } | null {
	// 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4).
	if (b.length < 24) return null;
	if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
	if (b.toString("latin1", 12, 16) !== "IHDR") return null;
	return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gifSize(b: Buffer): { width: number; height: number } | null {
	if (b.length < 10) return null;
	const sig = b.toString("latin1", 0, 6);
	if (sig !== "GIF87a" && sig !== "GIF89a") return null;
	return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function webpSize(b: Buffer): { width: number; height: number } | null {
	if (b.length < 30) return null;
	if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
	const chunk = b.toString("latin1", 12, 16);
	if (chunk === "VP8 ") {
		// Lossy: frame header at 20; start code 9D 01 2A at 23; 14-bit width/height at 26/28.
		if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
		return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
	}
	if (chunk === "VP8L") {
		// Lossless: signature 0x2F at 20, then width-1 and height-1 as 14-bit fields.
		if (b[20] !== 0x2f) return null;
		const bits = b.readUInt32LE(21);
		return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
	}
	if (chunk === "VP8X") {
		// Extended: canvas width-1 and height-1 as 24-bit fields at 24 and 27.
		return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
	}
	return null;
}

/** JPEG: walk the segments to the first SOFn frame header. May need more than the first few KB
 *  (EXIF and ICC segments come first), so it asks for more bytes as it goes. */
function jpegSize(b64: string, first: Buffer): { width: number; height: number } | null {
	if (first.length < 4 || first[0] !== 0xff || first[1] !== 0xd8) return null;
	let buf = first;
	const total = base64Bytes(b64);
	const need = (end: number): boolean => {
		if (end <= buf.length) return true;
		if (buf.length >= total) return false;
		// Grow geometrically; each step decodes only a prefix of the base64.
		buf = decodePrefix(b64, Math.min(total, Math.max(end + 1024, buf.length * 4)));
		return end <= buf.length;
	};
	let pos = 2;
	for (let guard = 0; guard < 10_000; guard++) {
		if (!need(pos + 4)) return null;
		if (buf[pos] !== 0xff) return null;
		let marker = buf[pos + 1];
		// Fill bytes: any number of 0xFF before the marker.
		while (marker === 0xff) {
			pos++;
			if (!need(pos + 4)) return null;
			marker = buf[pos + 1];
		}
		// Standalone markers carry no length.
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			pos += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan: no SOF seen
		const len = buf.readUInt16BE(pos + 2);
		if (len < 2) return null;
		const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			if (!need(pos + 9)) return null;
			return { width: buf.readUInt16BE(pos + 7), height: buf.readUInt16BE(pos + 5) };
		}
		pos += 2 + len;
	}
	return null;
}

/** Width and height from the file header, whatever the declared MIME type says. */
export function imageSize(b64: string): { width: number; height: number } | null {
	if (typeof b64 !== "string" || b64.length < 8) return null;
	try {
		const head = decodePrefix(b64, 4096);
		const size = pngSize(head) ?? gifSize(head) ?? webpSize(head) ?? jpegSize(b64, head);
		if (!size || !(size.width > 0) || !(size.height > 0)) return null;
		return size;
	} catch {
		return null;
	}
}

/** Content fingerprint of the base64 data (URL-safe, 16 chars). */
export function imageVersion(b64: string): string {
	return createHash("sha1").update(b64, "latin1").digest("base64url").slice(0, 16);
}

/** Image blocks never change once a message is saved, so the facts are cached per block object. */
const metaCache = new WeakMap<object, ImageMeta>();

/** Facts about an SDK image block's base64 data (cached per block object). */
export function imageMetaOf(block: object, b64: string): ImageMeta {
	const hit = metaCache.get(block);
	if (hit) return hit;
	const size = imageSize(b64);
	const meta: ImageMeta = {
		bytes: base64Bytes(b64),
		...(size ? { width: size.width, height: size.height } : {}),
		v: imageVersion(b64),
	};
	metaCache.set(block, meta);
	return meta;
}

/** MIME type to serve: the sniffed type when the header is recognised, else the declared image type. */
export function servedImageType(bytes: Buffer, declared: string | undefined): string {
	if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 6 && bytes.toString("latin1", 0, 4) === "GIF8") return "image/gif";
	if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP")
		return "image/webp";
	const d = (declared ?? "").toLowerCase().trim();
	return /^image\/[a-z0-9.+-]+$/.test(d) ? d : "application/octet-stream";
}
