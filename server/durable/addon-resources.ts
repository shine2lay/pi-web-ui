import { existsSync, globSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

// Use the SDK's own pattern engines without depending on npm's hoisting layout.
// Its public package manager resolves asynchronously and may reconcile installs;
// this helper deliberately does only synchronous filesystem discovery.
const requireSdk = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { minimatch } = requireSdk("minimatch") as {
	minimatch(path: string, pattern: string): boolean;
};
interface IgnoreMatcher {
	add(patterns: string[]): IgnoreMatcher;
	ignores(path: string): boolean;
}
const createIgnore = requireSdk("ignore") as () => IgnoreMatcher;

interface PackageSelection {
	source: string;
	autoload?: boolean;
	extensions?: string[];
}
interface ResourceSettings {
	extensions?: string[];
	packages?: (string | PackageSelection)[];
}
interface PackageManifest {
	name?: string;
	pi?: { extensions?: string[] };
}

const posix = (path: string): string => path.split(sep).join("/");
const override = (pattern: string): boolean => /^[!+-]/.test(pattern);
const glob = (pattern: string): boolean => /[*?]/.test(pattern);

function manifestAt(root: string): PackageManifest | undefined {
	try {
		const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8").replace(/^\uFEFF/, ""));
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const manifest: PackageManifest = {};
		if (typeof value.name === "string") manifest.name = value.name;
		const pi = value.pi;
		if (pi && typeof pi === "object" && !Array.isArray(pi)) {
			manifest.pi = {};
			if (Array.isArray(pi.extensions) && pi.extensions.every((entry: unknown) => typeof entry === "string"))
				manifest.pi.extensions = pi.extensions;
		}
		return manifest;
	} catch {
		return undefined; // Same missing/invalid-manifest behavior as SDK readPiManifest.
	}
}

function canonical(path: string): string {
	return realpathSync(path);
}

function isFile(path: string): boolean {
	return existsSync(path) && statSync(path).isFile();
}

function localPath(path: string, base: string): string {
	const value = path.trim();
	return value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(base, value);
}

function matches(path: string, pattern: string, root: string, exact = false): boolean {
	const targets = [posix(relative(root, path)), posix(path)];
	const normalized = posix(exact ? pattern.replace(/^\.\//, "") : pattern);
	return exact
		? targets.includes(normalized)
		: [...targets, basename(path)].some((target) => minimatch(target, normalized));
}

/** Mirrors SDK applyPatterns/applyAutoloadDisabledPatterns, including exact +/- overrides. */
function decisions(
	paths: string[],
	patterns: string[] | undefined,
	root: string,
	autoload = true,
): Map<string, boolean> {
	const result = new Map<string, boolean>();
	if (!autoload) {
		// A delta starts empty. Only explicitly matched resources acquire a decision;
		// later delta patterns win, as in the SDK (not the normal +/- precedence).
		for (const pattern of patterns ?? []) {
			const prefix = pattern[0];
			const target = override(pattern) ? pattern.slice(1) : pattern;
			for (const path of paths)
				if (matches(path, target, root, prefix === "+" || prefix === "-"))
					result.set(path, prefix !== "!" && prefix !== "-");
		}
		return result;
	}
	if (patterns === undefined) return new Map(paths.map((path) => [path, true]));
	if (patterns.length === 0) return new Map(paths.map((path) => [path, false]));
	const includes = patterns.filter((pattern) => !override(pattern));
	const excludes = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = patterns.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = patterns.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));
	for (const path of paths) {
		let enabled = !includes.length || includes.some((pattern) => matches(path, pattern, root));
		if (excludes.some((pattern) => matches(path, pattern, root))) enabled = false;
		if (forceIncludes.some((pattern) => matches(path, pattern, root, true))) enabled = true;
		if (forceExcludes.some((pattern) => matches(path, pattern, root, true))) enabled = false;
		result.set(path, enabled);
	}
	return result;
}

function ignoredIn(root: string): IgnoreMatcher {
	const matcher = createIgnore();
	for (const name of [".gitignore", ".ignore", ".fdignore"]) {
		const path = join(root, name);
		if (!existsSync(path)) continue;
		matcher.add(readFileSync(path, "utf8").split(/\r?\n/));
	}
	return matcher;
}

function manifestResources(root: string, entries: string[], parents: Set<string>): string[] {
	const paths = entries
		.filter((entry) => !override(entry))
		.flatMap((entry) => {
			if (!glob(entry)) return [resolve(root, entry)];
			// SDK globs discover visible paths; explicit paths may name dot/symlink roots.
			return globSync(entry, { cwd: root })
				.map((match) => resolve(root, match))
				.filter((path) =>
					relative(root, path)
						.split(sep)
						.every((part) => part === ".." || !part.startsWith(".")),
				)
				.sort();
		});
	const files = collectPaths(paths, parents);
	const patterns = entries.filter(override);
	return [...decisions(files, patterns.length ? patterns : undefined, root)]
		.filter(([, enabled]) => enabled)
		.map(([path]) => path);
}

/** A directory's declared entry/index, or undefined when it needs one-level discovery. */
function directoryEntry(root: string, parents: Set<string>): string[] | undefined {
	const entries = manifestAt(root)?.pi?.extensions;
	if (entries?.length) return manifestResources(root, entries, parents);
	for (const name of ["index.ts", "index.js"]) {
		const path = join(root, name);
		if (isFile(path)) return [path];
	}
	return undefined;
}

/** Same smart extension layout as the SDK: files plus declared/index entries in immediate subdirectories. */
function directoryResources(root: string, parents: Set<string>): string[] {
	const key = canonical(root);
	if (parents.has(key)) return []; // A manifest or symlink may point back to an ancestor.
	const next = new Set(parents).add(key);
	const declared = directoryEntry(root, next);
	if (declared !== undefined) return declared;
	const ignored = ignoredIn(root);
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const path = join(root, entry.name);
		if (!existsSync(path)) continue;
		const stats = statSync(path);
		if (ignored.ignores(`${entry.name}${stats.isDirectory() ? "/" : ""}`)) continue;
		if (stats.isFile() && /\.(ts|js)$/.test(entry.name)) files.push(path);
		else if (stats.isDirectory() && !next.has(canonical(path))) {
			const child = directoryEntry(path, new Set(next).add(canonical(path)));
			if (child) files.push(...child);
		}
	}
	return files;
}

function collectPaths(paths: string[], parents = new Set<string>()): string[] {
	const files: string[] = [];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		const stats = statSync(path);
		if (stats.isFile()) files.push(path);
		else if (stats.isDirectory()) files.push(...directoryResources(path, parents));
	}
	return [...new Set(files)];
}

function packageResources(root: string, local: boolean, filter?: PackageSelection): string[] {
	const manifest = manifestAt(root);
	if (manifest?.pi) {
		const entries = manifest.pi.extensions;
		const patternFilter = filter?.autoload === false || filter?.extensions !== undefined;
		// Match SDK collectDefaultResources vs collectManifestFiles: default selection
		// honors an empty declaration; pattern selection falls back to extensions/.
		if (!filter || (entries !== undefined && (!patternFilter || entries.length > 0)))
			return manifestResources(root, entries ?? [], new Set([canonical(root)]));
	}
	const convention = join(root, "extensions");
	if (existsSync(convention)) return collectPaths([convention]);
	// Local extension-only directories can use an index or the SDK's one-level layout.
	// npm packages, and packages declaring other resource directories, cannot expose
	// arbitrary root scripts as extensions merely because no extension was declared.
	if (local && !filter && !["skills", "prompts", "themes"].some((name) => existsSync(join(root, name))))
		return directoryResources(root, new Set());
	return [];
}

function packageRoot(source: string, agentDir: string): { path: string; local: boolean } | undefined {
	if (source.startsWith("npm:")) {
		const spec = source.slice(4).trim();
		const name = /^(@[^/@]+\/[^/@]+|[^/@]+)(?:@.+)?$/.exec(spec)?.[1];
		if (!name || name.split("/").some((part) => part === "." || part === ".." || part.includes("\\"))) return undefined;
		const path = join(agentDir, "npm", "node_modules", name);
		return existsSync(path) ? { path, local: false } : undefined;
	}
	if (/^(?:[a-z][a-z\d+.-]*:|git@)/i.test(source)) return undefined;
	const path = localPath(source, agentDir);
	return existsSync(path) ? { path, local: true } : undefined;
}

/** Also accepts missing entry paths from SDK load errors and package-directory paths. */
export function isClassicBillionContext(path: string): boolean {
	let root = resolve(path);
	// Resolve the nearest accessible ancestor so a missing file below a symlinked
	// package can still be classified without throwing while filtering load errors.
	for (;;) {
		try {
			root = canonical(root);
			break;
		} catch {
			const parent = dirname(root);
			if (parent === root) return false;
			root = parent;
		}
	}
	for (;;) {
		if (manifestAt(root)?.name === "billion-context-pi") return true;
		const parent = dirname(root);
		if (parent === root) return false;
		root = parent;
	}
}

/**
 * Resolve enabled, existing SDK extension FILES from agentDir/settings.json only.
 * No extension imports, installation, subprocesses, network, or settings writes.
 * The caller still uses discoverAndLoadExtensions for automatic user/project discovery.
 * Native ACP replaces this package's classic SDK resources, including explicit/symlink paths.
 */
export function configuredExtensionPaths(agentDir: string, options: { nativeBillionContext?: boolean } = {}): string[] {
	const base = resolve(agentDir);
	const settingsPath = join(base, "settings.json");
	if (!existsSync(settingsPath)) return [];
	const settings = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "")) as ResourceSettings;
	const selected = new Map<string, { path: string; enabled: boolean }>();
	const add = (resources: Map<string, boolean>) => {
		for (const [path, enabled] of resources) {
			const key = canonical(path);
			if (!selected.has(key)) selected.set(key, { path, enabled });
		}
	};
	const entries = settings.extensions ?? [];
	const explicit = collectPaths(
		entries.filter((entry) => !override(entry) && !glob(entry)).map((entry) => localPath(entry, base)),
	);
	const patterns = entries.filter((entry) => override(entry) || glob(entry));
	add(decisions(explicit, patterns.length ? patterns : undefined, base));
	for (const item of settings.packages ?? []) {
		const source = typeof item === "string" ? item : item.source;
		if (!source?.trim()) continue;
		const root = packageRoot(source.trim(), base);
		if (!root) continue;
		const filter = typeof item === "string" ? undefined : item;
		if (
			options.nativeBillionContext &&
			(/^npm:billion-context-pi(?:@[^/]+)?$/.test(source.trim()) ||
				manifestAt(root.path)?.name === "billion-context-pi")
		)
			continue;
		const directory = statSync(root.path).isDirectory();
		const files = directory ? packageResources(root.path, root.local, filter) : [root.path];
		add(decisions(files, filter?.extensions, directory ? root.path : dirname(root.path), filter?.autoload !== false));
	}
	return [...selected.values()]
		.filter(({ path, enabled }) => enabled && (!options.nativeBillionContext || !isClassicBillionContext(path)))
		.map(({ path }) => path);
}
