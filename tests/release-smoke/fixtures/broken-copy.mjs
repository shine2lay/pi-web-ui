/**
 * Planted breaks for proving the release smoke tests go red (outside wrapper: nothing here is in the
 * app or in the checks). A broken copy is a temp folder with the built output copied (dist/, web/dist/)
 * and everything else linked to the built folder, with one thing broken in the copy. Each break must
 * change exactly the text it names, or it throws: a plant that silently did nothing would prove nothing.
 */
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Replace the one match of `pattern` in `file` (a path in the copy) with `to`; throws unless exactly one. */
function breakOnce(file, pattern, to) {
	const text = readFileSync(file, "utf8");
	const hits = text.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`)) ?? [];
	if (hits.length !== 1) throw new Error(`plant can't be made: ${pattern} matches ${hits.length} times in ${file}`);
	writeFileSync(file, text.replace(pattern, to));
}

const mainBundle = (copy) => {
	const dir = join(copy, "web", "dist", "assets");
	const found = readdirSync(dir).filter(
		(f) => /^index-.*\.js$/.test(f) && readFileSync(join(dir, f), "utf8").includes("(`/ws`)"),
	);
	if (found.length !== 1) throw new Error(`plant can't be made: ${found.length} page bundles hold the socket address`);
	return join(dir, found[0]);
};

/** The app-copy breaks, by name: what each breaks, and how. */
export const COPY_BREAKS = {
	"no-server": {
		what: "the server does not start (its entry file throws at once)",
		make: (copy) => {
			const f = join(copy, "dist", "server", "index.js");
			writeFileSync(f, `throw new Error("planted: the server does not start");\n${readFileSync(f, "utf8")}`);
		},
	},
	"socket-never-ready": {
		what: "the page bundle is broken so its socket never gets ready (it dials /wz instead of /ws)",
		make: (copy) => breakOnce(mainBundle(copy), /\(`\/ws`\)/, "(`/wz`)"),
	},
	"version-banner": {
		what: "the server reports another protocol version than the page, so the version banner shows",
		make: (copy) =>
			breakOnce(
				join(copy, "dist", "server", "protocol-version.js"),
				/PROTOCOL_VERSION = (\d+);/,
				(_, n) => `PROTOCOL_VERSION = ${Number(n) - 1};`,
			),
	},
	"tool-call-hidden": {
		what: "the page never shows a tool call's output (the bundle draws it under another class)",
		make: (copy) => breakOnce(mainBundle(copy), /toolcall-output`/, "toolcall-outpux`"),
	},
	"picture-missing": {
		what: "the big chat's pictures are missing (the server's picture route is gone)",
		make: (copy) =>
			breakOnce(
				join(copy, "dist", "server", "index.js"),
				/"\/api\/chat-image\/:session\/:message\/:n"/,
				'"/api/chat-image-planted/:session/:message/:n"',
			),
	},
	"restart-loses-turn": {
		what: "the restart loses the cut-off turn (the server never reads its list of working chats back)",
		make: (copy) =>
			breakOnce(
				join(copy, "dist", "server", "running-chats.js"),
				/export function readRunningChatsFile\(file\) \{/,
				"export function readRunningChatsFile(file) { return null;",
			),
	},
};

/** Link every entry of `from` into `to` except `except`. */
function linkAll(from, to, except) {
	for (const name of readdirSync(from)) if (!except.includes(name)) symlinkSync(join(from, name), join(to, name));
}

/** A temp copy of the built app in appDir with break `name` (or none) planted; { dir, remove }. */
export function brokenCopy(appDir, name) {
	const brk = name ? COPY_BREAKS[name] : null;
	if (name && !brk) throw new Error(`no such plant: ${name}`);
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "release-smoke-plant-")));
	linkAll(appDir, dir, ["dist", "web"]);
	cpSync(join(appDir, "dist"), join(dir, "dist"), { recursive: true });
	mkdirSync(join(dir, "web"));
	linkAll(join(appDir, "web"), join(dir, "web"), ["dist"]);
	cpSync(join(appDir, "web", "dist"), join(dir, "web", "dist"), { recursive: true });
	brk?.make(dir);
	return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
