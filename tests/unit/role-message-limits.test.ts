// Ops #318: standalone admission core must not import the native host or initialize the SDK.
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("standalone core's runtime import graph loads neither role-messages nor the SDK", () => {
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const built = buildSync({
		absWorkingDir: root,
		entryPoints: ["server/role-message-guard-core.ts"],
		bundle: true,
		write: false,
		platform: "node",
		format: "esm",
		packages: "external",
		metafile: true,
	});
	const inputs = Object.keys(built.metafile.inputs);
	const imports = Object.values(built.metafile.outputs).flatMap((output) => output.imports.map((i) => i.path));
	expect(inputs).not.toContain("server/role-messages.ts");
	expect([...inputs, ...imports].filter((path) => /@(?:earendil-works|mariozechner)\/pi-/.test(path))).toEqual([]);
});
