#!/usr/bin/env node
/** Retain first-party recovery readers outside the versioned application bundle.
 * No browser records are read here. Existing versions and all source work survive. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const FORMAT = "pi-web-retained-recovery-readers-v1";
export const READER_PLUGIN_ID = "pi-web-pending-recovery";
const REQUIRED = ["pending.html", "plugin-start.html"];
const TYPED = ["composer", "scheduler", "board"];
const LABELS = {
	"pending.html": "Prompts and authored work",
	"plugin-start.html": "Legacy plugin start intents",
	"composer.html": "Complete composer checkpoints (look only)",
	"scheduler.html": "Complete scheduler drafts (look only)",
	"board.html": "Complete board drafts (look only)",
};
function assetNames(files) {
	if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("Missing retained-reader files.");
	const names = Object.keys(files);
	if (
		REQUIRED.some((name) => !Object.hasOwn(files, name)) ||
		names.some(
			(name) => !REQUIRED.includes(name) && !TYPED.some((kind) => name === `${kind}.html` || name === `${kind}.mjs`),
		) ||
		TYPED.some((kind) => Object.hasOwn(files, `${kind}.html`) !== Object.hasOwn(files, `${kind}.mjs`))
	)
		throw new Error("Reader assets must contain known complete HTML/module pairs, with both core documents.");
	return names;
}
const sha = (value) => createHash("sha256").update(value).digest("hex");
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
function indexHtml(versions) {
	const links = versions
		.map(
			(v) =>
				`<li>Checked source ${escapeHtml(v.revision)}<ul>${assetNames(v.files)
					.filter((name) => name.endsWith(".html"))
					.map(
						(name) =>
							`<li><a href="./${v.version}/${name}" target="_blank" rel="noopener noreferrer">${LABELS[name]}</a></li>`,
					)
					.join("")}</ul></li>`,
		)
		.join("");
	return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Retained work recovery</title><h1>Retained work recovery</h1><p>These first-party readers use this original origin's saved work. They do not send, execute, approve or automatically replay anything. Keep exports private. Open only on the original application's authenticated origin, not file://.</p><p>The current app bundle is not required. Older checked readers are retained. Missing or external source references remain incomplete unless their actual resolver or bytes are available; an export alone is not execution or server persistence.</p><ul>${links}</ul></html>\n`;
}
function validateManifest(value) {
	if (!value || value.format !== FORMAT || !Array.isArray(value.versions) || value.versions.length === 0)
		throw new Error("Unrecognized retained-reader manifest; preserve it, do not overwrite another plugin.");
	const seen = new Set();
	for (const v of value.versions) {
		if (!v || !/^[a-f0-9]{64}$/.test(v.version) || !/^[a-f0-9]{40}$/.test(v.revision) || seen.has(v.version))
			throw new Error("Invalid/duplicate retained-reader version; preserve the existing source.");
		seen.add(v.version);
		for (const name of assetNames(v.files))
			if (!/^[a-f0-9]{64}$/.test(v.files[name])) throw new Error("Missing retained-reader integrity metadata.");
		if (
			!v.sources ||
			typeof v.sources !== "object" ||
			Array.isArray(v.sources) ||
			v.version !== sha(JSON.stringify({ revision: v.revision, sources: v.sources, files: v.files }))
		)
			throw new Error("Retained-reader source/version metadata no longer matches its integrity digest.");
	}
	return value;
}
async function maybeRead(path) {
	try {
		return await readFile(path);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
async function syncDirectory(path) {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function atomicWrite(path, bytes) {
	const temp = `${path}.part-${process.pid}-${globalThis.crypto.randomUUID()}`;
	const handle = await open(temp, "wx", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	if (sha(await readFile(temp)) !== sha(bytes)) throw new Error(`Artifact write/readback failed: ${path}`);
	await rename(temp, path);
	await syncDirectory(dirname(path));
}

/** Only complete HTML/source metadata is accepted; this never reads an origin DB. */
export function readerAssets({ pendingHtml, pluginHtml, revision, sources, extraFiles = {} }) {
	if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("A checked source revision is required.");
	if (REQUIRED.some((name) => Object.hasOwn(extraFiles, name))) throw new Error("Core readers cannot be overridden.");
	const html = { "pending.html": pendingHtml, "plugin-start.html": pluginHtml, ...extraFiles };
	const names = assetNames(html);
	for (const name of names)
		if (
			typeof html[name] !== "string" ||
			!html[name] ||
			(name.endsWith(".html") && !html[name].startsWith("<!doctype html>"))
		)
			throw new Error("All complete standalone reader documents and modules are required.");
	const files = Object.fromEntries(names.map((name) => [name, sha(html[name])]));
	const version = sha(JSON.stringify({ revision, sources, files }));
	return { html, manifest: { version, revision, sources, files } };
}

export async function verifyReaders(dataDir) {
	const client = join(resolve(dataDir), "plugins", READER_PLUGIN_ID, "client");
	const raw = await readFile(join(client, "readers.json"), "utf8");
	const manifest = validateManifest(JSON.parse(raw));
	for (const version of manifest.versions) {
		for (const name of assetNames(version.files)) {
			const actual = sha(await readFile(join(client, version.version, name)));
			if (actual !== version.files[name])
				throw new Error(
					`Retained reader hash mismatch: ${version.version}/${name}. Keep all records and repair from the checked source.`,
				);
		}
	}
	const actualIndex = await readFile(join(client, "index.html"), "utf8");
	if (actualIndex !== indexHtml(manifest.versions))
		throw new Error(
			"Reader index publication is incomplete; retain the old readers and finish the checked install before deploying.",
		);
	return {
		format: FORMAT,
		versions: manifest.versions,
		path: client,
		url: `/plugins/${READER_PLUGIN_ID}/client/index.html`,
	};
}

/** Publication is additive. The navigation index is last; never delete an old version. */
export async function installReaders(dataDir, assets) {
	const plugin = join(resolve(dataDir), "plugins", READER_PLUGIN_ID);
	const client = join(plugin, "client");
	const marker = join(plugin, ".retained-reader-owner.json");
	const existingMarker = await maybeRead(marker);
	if (existingMarker) {
		if (JSON.parse(existingMarker.toString()).format !== FORMAT)
			throw new Error("This plugin directory is not owned by the retained-reader installer.");
	} else {
		let entries = [];
		try {
			entries = await readdir(plugin);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (entries.length !== 0)
			throw new Error(
				"The reserved reader directory already contains another source; refuse overwrite and choose a reviewed repair.",
			);
		await mkdir(client, { recursive: true, mode: 0o700 });
		await atomicWrite(marker, JSON.stringify({ format: FORMAT }));
	}
	await mkdir(client, { recursive: true, mode: 0o700 });
	await syncDirectory(dirname(plugin));
	await syncDirectory(resolve(dataDir));
	// Separate installers must not replace one another's version catalogue.
	const lock = join(plugin, ".reader-install-lock");
	try {
		await mkdir(lock, { mode: 0o700 });
	} catch (error) {
		if (error.code === "EEXIST")
			throw new Error(
				`A reader install owns ${lock}. Check its recorded process and the normal installer; preserve files and resolve any interrupted owner explicitly before retrying.`,
			);
		throw error;
	}
	const nonce = globalThis.crypto.randomUUID();
	const lockOwner = join(lock, "owner.json");
	try {
		await writeFile(lockOwner, JSON.stringify({ nonce, pid: process.pid, startedAt: new Date().toISOString() }), {
			flag: "wx",
			mode: 0o600,
		});
		const catalogPath = join(client, "readers.json");
		const old = await maybeRead(catalogPath);
		const manifest = old ? validateManifest(JSON.parse(old.toString())) : { format: FORMAT, versions: [] };
		// Verify existing version bytes before changing their navigation/catalogue.
		for (const prior of manifest.versions)
			for (const name of assetNames(prior.files)) {
				if (sha(await readFile(join(client, prior.version, name))) !== prior.files[name])
					throw new Error(
						"An older retained reader is damaged; preserve it and repair integrity before adding another version.",
					);
			}
		validateManifest({ format: FORMAT, versions: [assets.manifest] });
		const versionDir = join(client, assets.manifest.version);
		await mkdir(versionDir, { recursive: true, mode: 0o700 });
		for (const name of assetNames(assets.manifest.files)) {
			const bytes = assets.html[name];
			if (sha(bytes) !== assets.manifest.files[name])
				throw new Error("Reader input no longer matches its checked hash.");
			const path = join(versionDir, name);
			const previous = await maybeRead(path);
			if (previous && sha(previous) !== assets.manifest.files[name])
				throw new Error(
					"Never overwrite a different retained version; preserve the damaged asset and repair explicitly.",
				);
			if (!previous) await atomicWrite(path, bytes);
		}
		const prior = manifest.versions.find((v) => v.version === assets.manifest.version);
		if (prior && JSON.stringify(prior) !== JSON.stringify(assets.manifest))
			throw new Error("Retained version metadata conflicts; keep both sources and investigate.");
		if (!prior) manifest.versions.push(assets.manifest);
		await atomicWrite(catalogPath, JSON.stringify(manifest, null, 2) + "\n");
		await atomicWrite(join(client, "index.html"), indexHtml(manifest.versions));
		const verified = await verifyReaders(dataDir);
		if (!verified.versions.some((v) => v.version === assets.manifest.version))
			throw new Error("This install's version is not published; retain all assets and finish the checked install.");
		return verified;
	} finally {
		// Only our ephemeral lock is removed; never reader versions or browser/source records.
		const owner = await maybeRead(lockOwner);
		if (owner && JSON.parse(owner.toString()).nonce === nonce) await rm(lock, { recursive: true });
	}
}

async function pinnedBundle(root, entry, factory, revision) {
	const capturedSources = new Map();
	const result = await build({
		absWorkingDir: root,
		entryPoints: [join(root, entry)],
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		target: "es2022",
		metafile: true,
		logLevel: "silent",
		legalComments: "none",
		plugins: [
			{
				name: "checked-reader-source",
				setup(context) {
					context.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/ }, async ({ path }) => {
						const rel = relative(root, path).split("\\").join("/");
						if (rel.startsWith("../") || rel.startsWith("node_modules/"))
							throw new Error(
								"Reader unexpectedly depends on a non-source runtime; review it rather than adding an unpinned import.",
							);
						const actual = await readFile(path);
						const checked = execFileSync("git", ["-C", root, "show", `${revision}:${rel}`], {
							stdio: ["ignore", "pipe", "pipe"],
						});
						if (!actual.equals(checked)) throw new Error(`Reader source differs from the checked revision: ${rel}`);
						capturedSources.set(rel, sha(actual));
						const extension = path.split(".").at(-1);
						const loader =
							extension === "json"
								? "json"
								: extension === "tsx"
									? "tsx"
									: extension === "ts" || extension === "mts" || extension === "cts"
										? "ts"
										: extension === "jsx"
											? "jsx"
											: "js";
						// Compile these exact verified bytes, not a later path read (no check/use race).
						return { contents: actual.toString("utf8"), loader, resolveDir: dirname(path) };
					});
				},
			},
		],
	});
	for (const input of Object.keys(result.metafile.inputs)) {
		const rel = relative(root, isAbsolute(input) ? input : resolve(root, input))
			.split("\\")
			.join("/");
		if (!capturedSources.has(rel)) throw new Error(`Reader input was not captured and verified: ${rel}`);
	}
	const sources = Object.fromEntries([...capturedSources].sort(([a], [b]) => a.localeCompare(b)));
	const moduleSource = result.outputFiles[0].text;
	if (!factory) return { moduleSource, sources, bundleSha256: sha(moduleSource) };
	const bundled = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`);
	if (typeof bundled[factory] !== "function") throw new Error(`Checked reader factory is missing: ${factory}`);
	return { html: bundled[factory](moduleSource), sources, bundleSha256: sha(moduleSource) };
}

export async function buildPinnedReaders(root) {
	const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const pending = await pinnedBundle(
		root,
		"web/src/pending-recovery-coordinator.ts",
		"createPendingRecoveryReaderHtml",
		revision,
	);
	const plugin = await pinnedBundle(
		root,
		"web/src/plugin-start-checkpoint.ts",
		"createPluginStartReaderHtml",
		revision,
	);
	const extraFiles = {},
		typedSources = {};
	for (const [kind, entry, page, src] of [
		[
			"composer",
			"web/src/composer-checkpoint-reader.ts",
			"web/composer-checkpoint-recovery.html",
			"/src/composer-checkpoint-reader.ts",
		],
		[
			"scheduler",
			"web/src/scheduler-draft-reader.ts",
			"web/scheduler-draft-recovery.html",
			"./src/scheduler-draft-reader.ts",
		],
		["board", "web/src/board-draft-reader.ts", "web/board-draft-recovery.html", "./src/board-draft-reader.ts"],
	]) {
		const compiled = await pinnedBundle(root, entry, null, revision);
		const actual = await readFile(join(root, page));
		const checked = execFileSync("git", ["-C", root, "show", `${revision}:${page}`], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (!actual.equals(checked)) throw new Error(`Reader template differs from the checked revision: ${page}`);
		const needle = `<script type="module" src="${src}"></script>`;
		const html = actual.toString("utf8");
		if (html.split(needle).length !== 2) throw new Error(`Expected one checked reader entry in ${page}`);
		extraFiles[`${kind}.html`] = html.replace(needle, `<script type="module" src="./${kind}.mjs"></script>`);
		extraFiles[`${kind}.mjs`] = compiled.moduleSource;
		typedSources[kind] = { ...compiled.sources, [page]: sha(actual), bundleSha256: compiled.bundleSha256 };
	}
	return readerAssets({
		pendingHtml: pending.html,
		pluginHtml: plugin.html,
		revision,
		extraFiles,
		sources: {
			pending: pending.sources,
			plugin: plugin.sources,
			pendingBundleSha256: pending.bundleSha256,
			pluginBundleSha256: plugin.bundleSha256,
			typed: typedSources,
		},
	});
}
async function main() {
	const args = process.argv.slice(2);
	let dataDir;
	let verify = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--data-dir") dataDir = args[++i];
		else if (args[i] === "--verify") verify = true;
		else throw new Error("Usage: pending-recovery-reader.mjs --data-dir <explicit-data-dir> [--verify]");
	}
	if (!dataDir || !isAbsolute(dataDir))
		throw new Error("An explicit absolute --data-dir is required; no live default is assumed.");
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const result = verify ? await verifyReaders(dataDir) : await installReaders(dataDir, await buildPinnedReaders(root));
	console.log(
		JSON.stringify({
			ok: true,
			url: result.url,
			path: result.path,
			versions: result.versions.map((v) => ({ version: v.version, revision: v.revision, files: v.files })),
		}),
	);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
	main().catch((error) => {
		console.error(`Retained reader not ready: ${error.message}`);
		process.exitCode = 1;
	});
