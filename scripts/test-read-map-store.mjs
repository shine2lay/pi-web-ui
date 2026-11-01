/**
 * test-read-map-store.mjs: where the read maps live, and which one a check may use (Ops #693,
 * docs/gate-selected-tests.md). scripts/test-read-map.mjs writes them; scripts/select-tests.mjs reads them.
 *
 * A read map says, for one commit, which repo files each unit test file read, listed, copied, ran or loaded. It
 * holds paths only, never contents, in one file per commit: <folder>/<commit>.json, mode 0600, outside the repo
 * (${XDG_CACHE_HOME:-~/.cache}/pi-web-ui/test-read-map, or PI_TEST_READ_MAP_DIR).
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isAncestor } from "./changed-files.mjs";

export const MAP_VERSION = 1;

/** The folder of the read maps. */
export function mapFolder(env = process.env) {
	if (env.PI_TEST_READ_MAP_DIR) return env.PI_TEST_READ_MAP_DIR;
	const cache = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
	return join(cache, "pi-web-ui", "test-read-map");
}

/** Writes `map` (its commit names the file) into `folder`, readable by its owner only; returns the file's path. */
export function writeMap(folder, map) {
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	const file = join(folder, `${map.commit}.json`);
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(map)}\n`, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, file);
	return file;
}

/**
 * The read map a check of changes on top of `base` may use, in the checkout at `root`: the one of the commit nearest
 * `base` among those that are `base` or its ancestors. { map, file } or { none: why }.
 */
export function findMap(root, folder, base) {
	let names;
	try {
		names = readdirSync(folder).filter((name) => /^[0-9a-f]{40}\.json$/.test(name));
	} catch (error) {
		return { none: `no read map folder (${error.code ?? error.message})` };
	}
	let best;
	for (const name of names) {
		const commit = name.slice(0, 40);
		if (!isAncestor(root, commit, base)) continue;
		const count = spawnSync("git", ["rev-list", "--count", `${commit}..${base}`], { cwd: root, encoding: "utf8" });
		const distance = Number.parseInt(count.stdout, 10);
		if (count.status !== 0 || !Number.isFinite(distance)) continue;
		if (best === undefined || distance < best.distance) best = { commit, distance };
	}
	if (best === undefined) return { none: `no read map of ${base.slice(0, 7)} or an ancestor in ${folder}` };
	const file = join(folder, `${best.commit}.json`);
	let map;
	try {
		map = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { none: `read map ${file} unreadable (${error.message})` };
	}
	if (map?.v !== MAP_VERSION || map.commit !== best.commit || map.tests === null || typeof map.tests !== "object") {
		return { none: `read map ${file} is not a version ${MAP_VERSION} map of ${best.commit.slice(0, 7)}` };
	}
	return { map, file };
}
