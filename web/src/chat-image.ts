/**
 * lazy-images: pictures in chat messages arrive as placeholders (url, width, height, bytes) instead of
 * inline data, so opening a big chat sends only text. The page fetches a picture when it is about to
 * scroll into view (components/ChatImage.tsx). These helpers build its address, the same-size gray box
 * shown until it loads, and turn a picture back into base64 when a question is edited and re-asked.
 */
import { withToken } from "./auth-token";
import { appUrl } from "./base-url";

/** The fields of an image block this file reads (UiImageBlock, kept structural for the unit tests). */
export interface ImageBlockLike {
	type: string;
	dataUrl?: string;
	url?: string;
	mimeType?: string;
	width?: number;
	height?: number;
	bytes?: number;
}

/** True for an image block the page can show: inline data, a remote address, or a placeholder. */
export function isShownImage(b: { type: string }): b is ImageBlockLike {
	const img = b as ImageBlockLike;
	return img.type === "image" && (typeof img.dataUrl === "string" || typeof img.url === "string");
}

/** True when the picture must be fetched from the server (a placeholder, not inline data). */
export function isLazyImage(b: ImageBlockLike): boolean {
	return !b.dataUrl && typeof b.url === "string" && b.url.length > 0;
}

/** The address the page loads: inline data or a remote URL as is; a placeholder's server path with the
 *  app's base path and the auth token (an <img> can't send headers). */
export function imageSrc(b: ImageBlockLike, withBase: (path: string) => string = defaultBase): string | undefined {
	if (typeof b.dataUrl === "string" && b.dataUrl) return b.dataUrl;
	if (typeof b.url === "string" && b.url) return withBase(b.url);
	return undefined;
}

function defaultBase(path: string): string {
	return withToken(appUrl(path));
}

/** Size of the gray box when the header gave none (a picture of unknown format). */
const FALLBACK_W = 320;
const FALLBACK_H = 180;

/** A gray box with the picture's own size, shown until it loads. The page's max-width/max-height rules
 *  scale it exactly like the picture, so nothing moves when the picture arrives. */
export function placeholderSrc(width?: number, height?: number): string {
	const w = width && width > 0 ? Math.round(width) : FALLBACK_W;
	const h = height && height > 0 ? Math.round(height) : FALLBACK_H;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#888" fill-opacity="0.18"/></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The address for retry n (0 = the plain address). A new address makes the browser ask again. */
export function retrySrc(src: string, attempt: number): string {
	if (attempt <= 0 || src.startsWith("data:")) return src;
	return `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}`;
}

/** Addresses that loaded once in this page: a picture that mounts again (scrolling back, switching
 *  chats) shows at once instead of the gray box. The browser cache has the bytes. */
const loadedSrcs = new Set<string>();
const LOADED_MAX = 2000;

export function markImageLoaded(src: string): void {
	if (loadedSrcs.size >= LOADED_MAX) loadedSrcs.clear();
	loadedSrcs.add(src);
}

export function wasImageLoaded(src: string): boolean {
	return loadedSrcs.has(src);
}

/** Split a data: URL into base64 data and type; null if it isn't base64 data. */
export function splitDataUrl(dataUrl: string): { data: string; mimeType: string } | null {
	const m = dataUrl.match(/^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s);
	if (!m) return null;
	return { data: m[2], mimeType: m[1] || "image/png" };
}

/** Fetch a chat picture (its server path) as base64, for edit-and-re-ask. */
export async function fetchImageBase64(
	path: string,
	fetchFn: typeof fetch = fetch,
	withBase: (path: string) => string = defaultBase,
): Promise<{ data: string; mimeType: string }> {
	const res = await fetchFn(withBase(path));
	if (!res.ok) throw new Error(`picture ${path}: HTTP ${res.status}`);
	const buf = new Uint8Array(await res.arrayBuffer());
	let bin = "";
	for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
	const type = res.headers.get("content-type")?.split(";")[0]?.trim();
	return { data: btoa(bin), mimeType: type || "image/png" };
}

/** Attachments that point at a chat picture (imageUrl) get its bytes (imageData) before they are sent:
 *  the server takes pictures only as data. Throws if a picture can't be fetched, so nothing is sent
 *  without it. */
export async function resolveImageUrls<T extends { imageUrl?: string; imageData?: string; mimeType?: string }>(
	atts: readonly T[],
	fetchOne: (path: string) => Promise<{ data: string; mimeType: string }> = (p) => fetchImageBase64(p),
): Promise<T[]> {
	return Promise.all(
		atts.map(async (a) => {
			if (!a.imageUrl || a.imageData) return a;
			const got = await fetchOne(a.imageUrl);
			const { imageUrl: _drop, ...rest } = a;
			return { ...rest, imageData: got.data, mimeType: a.mimeType ?? got.mimeType } as T;
		}),
	);
}

/** Copy as image: pictures in the copied message that haven't loaded yet keep their real address in
 *  data-src; put it into src so the exported picture shows them. */
export function resolveLazyImages(root: ParentNode): void {
	root.querySelectorAll<HTMLImageElement>("img[data-src]").forEach((img) => {
		const real = img.getAttribute("data-src");
		if (real && img.getAttribute("src") !== real) img.setAttribute("src", real);
		img.removeAttribute("data-src");
	});
}
