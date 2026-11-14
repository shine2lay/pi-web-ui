/**
 * QA's fixed big chat (qa #146, made by agent-tools' pi-web-check-fixture: 100 MB, 1000 turns, pictures
 * 3, 9, 14 and 25 turns back) for F3: check it against its manifest, put a copy where the app finds it,
 * and clean up after (the copy's file and folder, and pi-memory's automatic summary of the copy).
 * Never a real chat: the copy has a header of its own (new id, its own work folder).
 */
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { unsure } from "./harness.mjs";

export const COPY_NAME = "release smoke copy (deleted after the check)";
export const FIXTURE_DIR =
	process.env.PI_WEB_SMOKE_FIXTURE_DIR ?? join(userInfo().homedir, ".cache", "pi-web-check-fixture");

/** pi's sessions folder for a work folder. */
export const sessionsFolder = (agentDir, cwd) =>
	join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

/** The fixture's manifest, once its chat file matches it (size and sha256); else unsure with the remake command. */
export async function verifiedFixture(dir = FIXTURE_DIR) {
	const remake = `QA's big-chat fixture is missing or changed; remake it: pi-web-check-fixture make --out ${dir}`;
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
	} catch {
		throw unsure(remake);
	}
	const file = join(dir, manifest.file ?? "bigchat.jsonl");
	if (!existsSync(file) || statSync(file).size !== manifest.bytes) throw unsure(remake);
	const hash = createHash("sha256");
	await pipeline(createReadStream(file), hash);
	if (hash.digest("hex") !== manifest.sha256) throw unsure(remake);
	if (!Array.isArray(manifest.pictures) || !manifest.pictures.length)
		throw unsure(`${remake} (its manifest lists no pictures)`);
	return { ...manifest, path: file };
}

/** Copy the chat to dest with a header of its own (new id, cwd) and a name; returns the new id. */
export async function copyChat(src, dest, cwd) {
	const fd = openSync(src, "r");
	const head = Buffer.alloc(1 << 20);
	const got = readSync(fd, head, 0, head.length, 0);
	closeSync(fd);
	const nl = head.subarray(0, got).indexOf(10);
	if (nl < 0) throw new Error(`${src} has no header line`);
	const header = JSON.parse(head.subarray(0, nl).toString("utf8"));
	const id = randomUUID();
	mkdirSync(cwd, { recursive: true });
	mkdirSync(dirname(dest), { recursive: true });
	const out = createWriteStream(dest);
	out.write(`${JSON.stringify({ ...header, id, cwd })}\n`);
	await pipeline(createReadStream(src, { start: nl + 1 }), out);
	const tail = readTail(dest, 1 << 20);
	const lines = tail.trimEnd().split("\n");
	const last = JSON.parse(lines.at(-1));
	const info = {
		type: "session_info",
		id: randomUUID().replace(/-/g, "").slice(0, 8),
		parentId: last.id,
		timestamp: new Date().toISOString(),
		name: COPY_NAME,
	};
	appendFileSync(dest, `${JSON.stringify(info)}\n`);
	return id;
}

function readTail(file, n) {
	const size = statSync(file).size;
	const len = Math.min(size, n);
	const buf = Buffer.alloc(len);
	const fd = openSync(file, "r");
	readSync(fd, buf, 0, len, size - len);
	closeSync(fd);
	return buf.toString("utf8");
}

const dayOf = (ms) => {
	const d = new Date(ms);
	const p = (x) => String(x).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const ENTRY_HEAD = /^<!-- \d{4}-\d{2}-\d{2}[ T][\d:.]+Z? \[[0-9A-Za-z-]{1,36}\] -->$/;

/** `text` without pi-memory's automatic summaries of session sid8, or null when it has none. */
export function withoutSummaryOf(text, sid8) {
	const lines = text.split("\n");
	const out = [];
	let dropping = false;
	let dropped = 0;
	for (let i = 0; i < lines.length; i++) {
		if (ENTRY_HEAD.test(lines[i])) {
			dropping = lines[i].includes(`[${sid8}]`) && /^## Session Summary \(auto/.test(lines[i + 1] ?? "");
			if (dropping) {
				dropped++;
				continue;
			}
		}
		if (!dropping) out.push(lines[i]);
	}
	if (!dropped) return null;
	const joined = out.join("\n");
	return text.endsWith("\n") && !joined.endsWith("\n") ? `${joined}\n` : joined;
}

/**
 * pi-memory may write an automatic summary of the closed copy into the daily log within 10 s: watch
 * for 15 s and take exactly that entry out again. Returns the file it was in, or null.
 */
export async function takeOutMemorySummary(memoryDir, sid8, watchMs = 15_000) {
	const started = Date.now();
	for (;;) {
		for (const day of new Set([dayOf(started), dayOf(Date.now())])) {
			const file = join(memoryDir, `${day}.md`);
			let text;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const next = text.includes(`[${sid8}]`) ? withoutSummaryOf(text, sid8) : null;
			// Something else may be appending: write only if the file is still what was read.
			if (next != null && readFileSync(file, "utf8") === text) {
				writeFileSync(file, next);
				return file;
			}
		}
		if (Date.now() - started >= watchMs) return null;
		await sleep(1000);
	}
}
