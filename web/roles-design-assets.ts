import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";

// Owner-supplied, immutable build inputs. No source HTML/JS is executed or shipped.
// The generated lazy bundle contains only these two verified font byte strings;
// the running app never needs the private reference directory.
export const ROLE_FONT_INPUTS = {
	geist: {
		file: "1-0592d29f-5525-4f6f-9b51-dacd640aa587.woff2",
		bytes: 29400,
		sha256: "19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1",
	},
	mono: {
		file: "1-90cc2d43-1794-4d43-9ca7-f63bd9dcf368.woff2",
		bytes: 23128,
		sha256: "684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc",
	},
} as const;

export function readRoleFont(root: string, kind: keyof typeof ROLE_FONT_INPUTS): string {
	const pin = ROLE_FONT_INPUTS[kind];
	let fd: number | undefined;
	try {
		fd = openSync(join(root, pin.file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
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
			`Exact Roles ${kind} font missing or changed. Set PI_ROLES_DESIGN_ASSETS to the original extracted design assets; no substitute font is allowed.`,
		);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function rolesDesignAssets(): Plugin {
	const publicId = "virtual:roles-design-fonts";
	const internalId = "\0" + publicId;
	return {
		name: "roles-design-assets",
		resolveId(id) {
			return id === publicId ? internalId : undefined;
		},
		load(id) {
			if (id !== internalId) return;
			const root =
				process.env.PI_ROLES_DESIGN_ASSETS ??
				join(userInfo().homedir, "company-lab/shared/roles-renderer-u0-2026-10-13/extract");
			return Object.keys(ROLE_FONT_INPUTS)
				.map((key) => {
					const kind = key as keyof typeof ROLE_FONT_INPUTS;
					return `export const ${kind} = ${JSON.stringify(readRoleFont(root, kind))};`;
				})
				.join("\n");
		},
	};
}
