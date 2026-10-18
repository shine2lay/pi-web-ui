// initiatives-exact: the 11 woff2 files the owner's Initiatives design embeds, pinned by sha256 and size, and
// its 32 @font-face rules in the design's own order (families, weights, unicode ranges as its CSS declares
// them). Data only: the build plugin (web/initiatives-design-assets.ts) and the frame (surface.ts) read it.
const RANGES = {
	"cyrillic-ext": "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F",
	cyrillic: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
	symbols2: "U+2000-2001, U+2004-2008, U+200A, U+23B8-23BD, U+2500-259F",
	vietnamese:
		"U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
	"latin-ext":
		"U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF",
	latin:
		"U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
} as const;
export type InitiativeFontSubset = keyof typeof RANGES;

/** Each file is named `<sha256>.woff2` in the extracted assets. */
export const INITIATIVE_FONT_FILES = Object.freeze({
	"geist-cyrillic-ext": { sha256: "b7a545bbb08256bd809f11cfe66d88da3e22d169ea4407737b1ef0ec1ed3d791", bytes: 7252 },
	"geist-cyrillic": { sha256: "6129fc8571c3e0cb0a4c41f5160c974a843b055009dc4ad8858bd808e18a2d86", bytes: 14900 },
	"geist-vietnamese": { sha256: "f689f638f29fff460a2d5749edb5d5c38d7bef0389f32032d871f23fc6ebb008", bytes: 7968 },
	"geist-latin-ext": { sha256: "58a6b173d5ca1dec92166ea3c6cb1a84a4144556d10928ac14e8e6b40e4787bd", bytes: 16540 },
	"geist-latin": { sha256: "9b6f5ff45b278c744b5f379a2c4ecbaf858a842b8eaf82ac8d21b699ca16c608", bytes: 29288 },
	"mono-cyrillic-ext": { sha256: "e27f657e38d52887baa3b6b2f812bef93dfdd356f0810e40edd4ee284cc7e9f6", bytes: 6204 },
	"mono-cyrillic": { sha256: "75b3bedbebc35f347c0ae3b416aa871941555357e7b0f83767eb5987875589ed", bytes: 12872 },
	"mono-symbols2": { sha256: "d67e4a94ba498635f764ddca7d1ec4271f5642f032eb24b426764480f66f8497", bytes: 5892 },
	"mono-vietnamese": { sha256: "16e1d48b6dd29eb240aec5db36184eb182933c082cd43de7f35af686d58087d2", bytes: 7728 },
	"mono-latin-ext": { sha256: "745994b5cd950ec201b66526375f057d540847cccfc70f4f24f5f571d26d3923", bytes: 14712 },
	"mono-latin": { sha256: "5f3d6ad60f29d6cb708414ec6887163d63bf197377ef5417d2483ff31ace6c3b", bytes: 23108 },
} as const);
export type InitiativeFontKey = keyof typeof INITIATIVE_FONT_FILES;
export const INITIATIVE_FONT_KEYS = Object.freeze(Object.keys(INITIATIVE_FONT_FILES) as InitiativeFontKey[]);

export interface InitiativeFontFace {
	family: "Geist" | "Geist Mono";
	weight: string;
	subset: InitiativeFontSubset;
	file: InitiativeFontKey;
	unicodeRange: string;
}
const GEIST = ["cyrillic-ext", "cyrillic", "vietnamese", "latin-ext", "latin"] as const;
const MONO = ["cyrillic-ext", "cyrillic", "symbols2", "vietnamese", "latin-ext", "latin"] as const;
/** In the design's order; every rule is font-style normal, font-display swap. */
export const INITIATIVE_FONT_FACES: readonly InitiativeFontFace[] = Object.freeze([
	...["400", "500", "600", "700"].flatMap((weight) =>
		GEIST.map((subset) => ({
			family: "Geist" as const,
			weight,
			subset,
			file: `geist-${subset}` as InitiativeFontKey,
			unicodeRange: RANGES[subset],
		})),
	),
	...["400", "500"].flatMap((weight) =>
		MONO.map((subset) => ({
			family: "Geist Mono" as const,
			weight,
			subset,
			file: `mono-${subset}` as InitiativeFontKey,
			unicodeRange: RANGES[subset],
		})),
	),
]);
