import { geist, mono } from "virtual:roles-design-fonts";
import type { FontBytes } from "./roles-u0/surface";

function decode(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

// This module is loaded only with the Roles page. prepareRolesDocument also
// verifies the length and SHA-256 before creating any FontFace in the frame.
export const exactRolesFonts: FontBytes = { geist: decode(geist), mono: decode(mono) };
