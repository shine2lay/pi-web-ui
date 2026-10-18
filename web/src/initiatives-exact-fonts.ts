import { fonts } from "virtual:initiatives-design-fonts";
import { INITIATIVE_FONT_KEYS } from "./initiatives-u0/font-pins";
import type { InitiativeFontBytes } from "./initiatives-u0/surface";

function decode(value: string | undefined): Uint8Array {
	return Uint8Array.from(atob(value ?? ""), (char) => char.charCodeAt(0));
}

// initiatives-exact: loaded only with the Initiatives view. prepareInitiativesDocument also checks each
// font's length and SHA-256 before declaring any FontFace in the frame.
export const exactInitiativesFonts: InitiativeFontBytes = Object.freeze(
	Object.fromEntries(INITIATIVE_FONT_KEYS.map((key) => [key, decode(fonts[key])])),
) as InitiativeFontBytes;
