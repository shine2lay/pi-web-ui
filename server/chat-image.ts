/**
 * lazy-images: the picture endpoint's pure parts (GET /api/chat-image/:session/:message/:n?v=).
 *
 * Messages sent to the page carry a placeholder (size, type, URL) instead of the picture; the page
 * fetches the picture when it is about to scroll into view. The endpoint serves it from the chat's
 * messages in memory: no file path is ever built from the address, so a strange id can only miss.
 */
import { imageMetaOf, servedImageType } from "./image-meta.js";
import { imageDataOf } from "./serialize.js";

/** A picture served by GET /api/chat-image. */
export interface ChatImage {
	bytes: Buffer;
	mimeType: string;
}

/** A checked picture address. */
export interface ChatImageAddress {
	sessionId: string;
	msgId: string;
	n: number;
	v: string;
}

/** Ids are only compared with in-memory ids (tool-call ids may hold any character), so a length limit
 *  is enough. */
const ID_MAX = 300;
/** The content fingerprint in the URL (imageVersion: 16 base64url chars). */
const V_RE = /^[A-Za-z0-9_-]{16}$/;
/** Picture number inside one message. */
const N_RE = /^\d{1,4}$/;

function idOk(s: string): boolean {
	return s.length > 0 && s.length <= ID_MAX;
}

/** The address from the route's params and query, or null when any part is malformed (answer 400). */
export function parseChatImageAddress(
	session: unknown,
	message: unknown,
	n: unknown,
	v: unknown,
): ChatImageAddress | null {
	if (typeof session !== "string" || typeof message !== "string" || typeof n !== "string" || typeof v !== "string")
		return null;
	if (!idOk(session) || !idOk(message) || !N_RE.test(n) || !V_RE.test(v)) return null;
	return { sessionId: session, msgId: message, n: Number(n), v };
}

/** The picture in an SDK image block, if its content fingerprint is v; null otherwise. */
export function imageIfVersion(block: unknown, v: string): ChatImage | null {
	const raw = imageDataOf(block);
	if (!raw || typeof block !== "object" || block === null) return null;
	if (imageMetaOf(block, raw.data).v !== v) return null;
	const bytes = Buffer.from(raw.data, "base64");
	return { bytes, mimeType: servedImageType(bytes, raw.mimeType) };
}

/** Response headers for a served picture. */
export function chatImageHeaders(img: ChatImage): Record<string, string> {
	return {
		"Content-Type": img.mimeType,
		"Content-Length": String(img.bytes.length),
		// private: user content behind auth; immutable: the URL carries the content fingerprint.
		"Cache-Control": "private, max-age=31536000, immutable",
		// Same guard as /api/attachment for an SVG opened as a document; harmless for other types.
		"Content-Security-Policy": "sandbox",
		"X-Content-Type-Options": "nosniff",
	};
}
