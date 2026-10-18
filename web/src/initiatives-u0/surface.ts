// initiatives-exact: the supplied Initiatives template, its fonts and its frame document. Inert: no
// registration, DOM work or resources on import. The shared binder (../exact-surface.ts) binds ONLY this
// static template, never HTML from data; the frame runs no script of its own.
import template from "./surface.html?raw";
// The design's StateChip is the same component as Roles' (same markup, same table): one copy.
import chipTemplate from "../roles-u0/state-chip.html?raw";
import { bindSurface, type SurfaceBinding, type SurfaceValues } from "../exact-surface";
import {
	INITIATIVE_FONT_FACES,
	INITIATIVE_FONT_FILES,
	INITIATIVE_FONT_KEYS,
	type InitiativeFontKey,
} from "./font-pins";

export type InitiativeFontBytes = Readonly<Record<InitiativeFontKey, Uint8Array>>;

/** Checks each font's size and sha256, then declares the design's 32 faces, in its order. */
export async function prepareInitiativesDocument(doc: Document, fonts: InitiativeFontBytes): Promise<void> {
	const win = doc.defaultView;
	if (!win) throw new Error("Initiatives document is detached");
	const buffers = new Map<InitiativeFontKey, ArrayBuffer>();
	for (const key of INITIATIVE_FONT_KEYS) {
		const bytes = fonts[key];
		const pin = INITIATIVE_FONT_FILES[key];
		if (!(bytes instanceof Uint8Array) || bytes.byteLength !== pin.bytes)
			throw new Error("Initiatives exact font bytes required");
		const copy = new Uint8Array(bytes);
		const digest = await win.crypto.subtle.digest("SHA-256", copy);
		const hash = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
		if (hash !== pin.sha256) throw new Error("Initiatives font hash mismatch");
		buffers.set(key, copy.buffer);
	}
	for (const face of INITIATIVE_FONT_FACES) {
		const font = new win.FontFace(face.family, buffers.get(face.file) as ArrayBuffer, {
			weight: face.weight,
			style: "normal",
			display: "swap",
			unicodeRange: face.unicodeRange,
		});
		await font.load();
		doc.fonts.add(font);
	}
	doc.documentElement.lang = "en";
	doc.title = "Initiatives";
	const css = doc.createElement("style");
	css.dataset.initiativesU0 = "semantics";
	css.textContent =
		"html,body{height:100%;margin:0} #dc-root{height:100%} :focus-visible{outline:2px solid #9CC7FF;outline-offset:3px}";
	doc.head.appendChild(css);
	await doc.fonts.ready;
}

/** Binds the template to the values `read` returns (the view's), again on every `update`. */
export function bindInitiativesSurface(doc: Document, read: () => SurfaceValues): SurfaceBinding {
	return bindSurface(doc, template, read, { name: "Initiatives", chip: chipTemplate, mount: "root" });
}
