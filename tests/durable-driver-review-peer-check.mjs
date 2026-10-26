// Local source/installed-peer compatibility proof, without building or editing the BCP checkout.
// The actual source is compiled into a disposable package with the real export map.
import { build } from "esbuild";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const source = process.argv[2];
if (!source) throw new Error("Usage: node tests/durable-driver-review-peer-check.mjs /path/to/billion-context-pi");
const cwd = process.cwd();
const fixture = mkdtempSync(join(tmpdir(), "durable-real-bcp-peers-"));
const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const packageRoot = (url) => dirname(dirname(fileURLToPath(url)));
const durableRoot = packageRoot(import.meta.resolve("@earendil-works/pi-durable"));
const hostAiRoot = packageRoot(import.meta.resolve("@earendil-works/pi-ai"));
function durablePeerRoot(name) {
	for (let at = durableRoot; ; at = dirname(at)) {
		const candidate = join(at, "node_modules", name);
		try {
			readFileSync(join(candidate, "package.json"));
			return candidate;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (dirname(at) === at) throw new Error(`Missing durable peer ${name}`);
	}
}
const version = (root) => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
try {
	if (
		version(hostAiRoot) !== "1.0.1" ||
		version(durableRoot) !== "1.4.0" ||
		version(durablePeerRoot("@earendil-works/pi-ai")) !== "1.4.0"
	)
		throw new Error("Unexpected installed SDK/durable peer versions; no upgrade or substitution is allowed");
	mkdirSync(join(fixture, "src"));
	mkdirSync(join(fixture, "node_modules", "@earendil-works"), { recursive: true });
	for (const file of ["durable.ts", "durable-files.ts"]) cpSync(join(source, "src", file), join(fixture, "src", file));
	writeFileSync(join(fixture, "package.json"), JSON.stringify(manifest));
	for (const name of ["pi-durable", "pi-ai", "chord"])
		symlinkSync(
			name === "pi-durable" ? durableRoot : durablePeerRoot(`@earendil-works/${name}`),
			join(fixture, "node_modules", "@earendil-works", name),
			"dir",
		);
	for (const name of ["typebox", "@types"])
		symlinkSync(join(cwd, "node_modules", name), join(fixture, "node_modules", name), "dir");
	writeFileSync(
		join(fixture, "src", "peer-check.ts"),
		`
		import type { Conversation, Extension } from '@earendil-works/pi-durable';
		import { createDurableExtension } from './durable.js';
		declare const conversation: Conversation;
		const extension: Extension = createDurableExtension({ context: (_id, ctx) => conversation.context(ctx) });
		void extension;
	`,
	);
	const checked = spawnSync(
		process.execPath,
		[
			resolve("node_modules/typescript/bin/tsc"),
			"--module",
			"nodenext",
			"--target",
			"es2022",
			"--skipLibCheck",
			"--declaration",
			"--emitDeclarationOnly",
			"--outDir",
			"dist",
			"--rootDir",
			"src",
			"src/durable.ts",
			"src/durable-files.ts",
			"src/peer-check.ts",
		],
		{ cwd: fixture, encoding: "utf8" },
	);
	if (checked.error) throw checked.error;
	if (checked.status !== 0) throw new Error(`Installed-peer typecheck failed:\n${checked.stdout}\n${checked.stderr}`);
	await build({
		entryPoints: [join(fixture, "src", "durable.ts")],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outfile: join(fixture, "dist", "durable.js"),
		logLevel: "silent",
	});
	// Native import exercises the published path and actual source's runtime imports, never a provider.
	const { createDurableExtension } = await import(pathToFileURL(join(fixture, "dist", "durable.js")).href);
	const extension = createDurableExtension({
		context: async () => {
			throw new Error("Type/import check must not access any context");
		},
	});
	const actual = extension.tools.map((tool) => tool.name).sort();
	if (
		JSON.stringify(actual) !== JSON.stringify(["acp_cache", "acp_status", "compress", "decompress", "search_context"])
	)
		throw new Error("Actual BCP source did not export the five expected native ACP tools");
	console.log(
		"Actual BCP source: declaration/typecheck + native import PASS; SDK pi-ai1.0.1 and durable/pi-ai1.4.0 preserved. No tool execution or model requests.",
	);
} finally {
	rmSync(fixture, { recursive: true, force: true });
}
