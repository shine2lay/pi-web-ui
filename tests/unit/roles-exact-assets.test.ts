import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { readRoleFont, ROLE_FONT_INPUTS, rolesDesignAssets } from "../../web/roles-design-assets";

const temporary: string[] = [];
const directory = () => {
	const dir = mkdtempSync(join(tmpdir(), "roles-font-"));
	temporary.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("immutable supplied Roles fonts", () => {
	it("uses only the two pinned original fonts", () => {
		const source =
			process.env.PI_ROLES_DESIGN_ASSETS ??
			join(userInfo().homedir, "company-lab/shared/roles-renderer-u0-2026-10-13/extract");
		for (const kind of ["geist", "mono"] as const) {
			expect(Buffer.from(readRoleFont(source, kind), "base64")).toHaveLength(ROLE_FONT_INPUTS[kind].bytes);
		}
		expect(rolesDesignAssets().name).toBe("roles-design-assets");
	});
	it("fails closed on absent, wrong-sized, hash-mismatched or directory inputs", () => {
		const dir = directory();
		const file = join(dir, ROLE_FONT_INPUTS.geist.file);
		const refused = () => expect(() => readRoleFont(dir, "geist")).toThrow("Exact Roles geist font missing or changed");
		refused();
		writeFileSync(file, "wrong");
		refused();
		writeFileSync(file, Buffer.alloc(ROLE_FONT_INPUTS.geist.bytes));
		refused();
		rmSync(file);
		mkdirSync(file);
		refused();
	});
	it("does not follow a substituted symlink", () => {
		const dir = directory();
		const target = join(dir, "target");
		writeFileSync(target, Buffer.alloc(ROLE_FONT_INPUTS.geist.bytes));
		symlinkSync(target, join(dir, ROLE_FONT_INPUTS.geist.file));
		expect(() => readRoleFont(dir, "geist")).toThrow("Exact Roles geist font missing or changed");
	});
});
