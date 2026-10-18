import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import { INITIATIVE_FONT_FILES, INITIATIVE_FONT_KEYS, type InitiativeFontKey } from "./src/initiatives-u0/font-pins";

// initiatives-exact: the owner-supplied Initiatives design's 11 fonts, as immutable build inputs. No source
// HTML or JS is executed or shipped; the lazy bundle holds only these verified font bytes, so the running app
// never needs the private reference directory. Every build checks all 11, used or not, so a missing or
// changed font fails the build before the page is wired to anything.
export const INITIATIVE_FONT_DIR = "company-lab/shared/initiatives-reference-audit-2026-10-11/embedded-fonts";

export function initiativeFontRoot(): string {
	return process.env.PI_INITIATIVES_DESIGN_ASSETS ?? join(userInfo().homedir, INITIATIVE_FONT_DIR);
}

export function readInitiativeFont(root: string, key: InitiativeFontKey): string {
	const pin = INITIATIVE_FONT_FILES[key];
	let fd: number | undefined;
	try {
		fd = openSync(
			join(root, `${pin.sha256}.woff2`),
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size !== pin.bytes) throw new Error("Wrong font size");
		const bytes = Buffer.alloc(pin.bytes + 1);
		const count = readSync(fd, bytes, 0, bytes.length, 0);
		const content = bytes.subarray(0, count);
		if (count !== pin.bytes || createHash("sha256").update(content).digest("hex") !== pin.sha256) {
			throw new Error("Wrong font hash");
		}
		return content.toString("base64");
	} catch {
		throw new Error(
			`Exact Initiatives font ${key} (${pin.sha256}.woff2, ${pin.bytes} bytes) missing or changed in ${root}. Set PI_INITIATIVES_DESIGN_ASSETS to the design's original extracted fonts; no substitute font is allowed.`,
		);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function readInitiativeFonts(root = initiativeFontRoot()): Record<InitiativeFontKey, string> {
	return Object.fromEntries(INITIATIVE_FONT_KEYS.map((key) => [key, readInitiativeFont(root, key)])) as Record<
		InitiativeFontKey,
		string
	>;
}

export function initiativesDesignAssets(): Plugin {
	const publicId = "virtual:initiatives-design-fonts";
	const internalId = "\0" + publicId;
	let fonts: Record<InitiativeFontKey, string> | undefined;
	return {
		name: "initiatives-design-assets",
		buildStart() {
			fonts = readInitiativeFonts();
		},
		resolveId(id) {
			return id === publicId ? internalId : undefined;
		},
		load(id) {
			if (id !== internalId) return;
			fonts ??= readInitiativeFonts();
			return `export const fonts = Object.freeze(${JSON.stringify(fonts)});`;
		},
	};
}
