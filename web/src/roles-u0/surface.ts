// Inert U0: no registration, DOM work or resources on import. This small,
// non-evaluating renderer binds ONLY the supplied static template, never HTML
// from a DTO. It deliberately retains the source's interpolation spans.
// initiatives-exact: the binder itself is shared (../exact-surface.ts); this file keeps the Roles template,
// its fonts and its frame, so what Roles renders is unchanged.
import template from "./surface.html?raw";
import chipTemplate from "./state-chip.html?raw";
import { bindSurface, type SurfaceBinding } from "../exact-surface";

import type { SurfaceValues } from "./types.js";
export type { SurfaceValue, SurfaceValues } from "./types.js";
export const FONT_PINS = Object.freeze({
	geist: "19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1",
	mono: "684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc",
});
export interface FontBytes {
	geist: Uint8Array;
	mono: Uint8Array;
}

export async function prepareRolesDocument(doc: Document, fonts: FontBytes): Promise<void> {
	const win = doc.defaultView;
	if (!win) throw new Error("Roles document is detached");
	for (const name of ["geist", "mono"] as const) {
		const bytes = fonts[name];
		if (!(bytes instanceof Uint8Array) || bytes.byteLength !== (name === "geist" ? 29400 : 23128))
			throw new Error("Roles exact font bytes required");
		const copy = new Uint8Array(bytes);
		const digest = await win.crypto.subtle.digest("SHA-256", copy);
		const hash = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
		if (hash !== FONT_PINS[name]) throw new Error("Roles font hash mismatch");
		// Single weights deliberately match the supplied source, whose variable
		// font bytes are NOT declared as a variable CSS range. A range changes ink.
		for (const weight of name === "geist" ? ["400", "600", "700"] : ["400", "500"]) {
			const face = new win.FontFace(name === "geist" ? "Geist" : "Geist Mono", copy.buffer, {
				weight,
				style: "normal",
				display: "swap",
				unicodeRange:
					"U+0-FF, U+131, U+152-153, U+2BB-2BC, U+2C6, U+2DA, U+2DC, U+304, U+308, U+329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
			});
			await face.load();
			doc.fonts.add(face);
		}
	}
	doc.documentElement.lang = "en";
	doc.title = "Roles";
	doc.body.style.margin = "0";
	const css = doc.createElement("style");
	css.dataset.rolesU0 = "semantics";
	css.textContent =
		"html,body{height:100%;margin:0} #dc-root{height:100%} :focus-visible{outline:2px solid #9CC7FF;outline-offset:3px}";
	doc.head.appendChild(css);
	await doc.fonts.ready;
}

/** Private low-level view binder. Tests can supply fictional values; the public
 * native entry always derives them via native.ts and never admits this object. */
export function bindRolesSurface(doc: Document, read: () => SurfaceValues, chipOnly = false): SurfaceBinding {
	return bindSurface(doc, chipOnly ? chipTemplate : template, read, {
		name: "Roles",
		chip: chipTemplate,
		mount: chipOnly ? "body" : "frame",
		// The accepted child scenes have a viewport frame background as well as
		// the main's background. Even that invisible layer affects rounded ink.
		// The chain is #dc-root > frame > template, the same depth as the source
		// scene, so per-node font provenance paths match it (H-ROLES-U0-16).
		frameStyle:
			"width:100vw;height:100vh;overflow:hidden;background:#0E0F11;color:#ECEDEE;font-family:'Geist',ui-sans-serif,system-ui,sans-serif",
	});
}
