/**
 * 对话身份（identities）。
 *
 * pi-identity 扩展（~/projects/pi-identity）给对话一个身份：temper、rollcall、ops……每个身份一个文件夹
 * ~/.pi/agent/memory/identities/<id>/：
 *
 *   identity.json  { id, title, folder, homeChat: <会话文件>, pastHomeChats: [] }
 *   about.md       这个身份的介绍页
 *   notebook.md    它的笔记本（最多 NOTEBOOK_CAP 字节，pi-identity 的 notebook 工具守同一个上限）
 *
 * 对话的身份是会话里的自定义条目（pi-identity 写）：
 *
 *   { type: "custom", customType: "identity", data: { v: 1, id: string | null, via, from? } }
 *
 * 分支上最后一条算数；id 为 null = 清掉了。家对话加载时自己写一条（via "home"）。
 *
 * 这里只**读**身份，规则跟 pi-identity 一致：
 * - 加载着的对话：当前分支上最后一条 identity 条目；没有就看它是不是某个身份的家对话；
 * - 只在磁盘上的对话（历史行）：跟 pi-identity 的 identityOfFile 一样——家对话 → 文件里最后一条
 *   identity 条目 → 以前的家对话。文件是增量读的（IdentityFileIndex），只读上次之后追加的部分。
 *
 * 设置 / 清除走 pi-identity 自己的 `/identity` 命令（ClientSession.setChatIdentity），逻辑只在一处。
 * Settings → Identities 读写 about.md / notebook.md：整个文件原子写（临时文件 + rename）；笔记本超上限、
 * 或者文件在页面打开之后被别人改过，都不存。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { IdentityFileName, IdentitySaveError, UiChatIdentity, UiIdentityInfo } from "./protocol.js";

/** pi-identity 的 customType（与 pi-identity identity.ts 的 ENTRY_TYPE 一致）。 */
export const IDENTITY_ENTRY_TYPE = "identity";

/** 笔记本的上限（字节），与 pi-identity 的 NOTEBOOK_CAP 一致。 */
export const NOTEBOOK_CAP = 8_000;

/** about.md 的安全上限（字节）：它没有规定的上限，这里只防一次粘贴把整份注入撑爆。 */
export const ABOUT_MAX = 64_000;

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

type Env = Record<string, string | undefined>;

/** 一个身份（identity.json 读出来的样子）。 */
export interface IdentityDef {
	id: string;
	title: string;
	/** 这个身份干活的文件夹；没写就是 null。 */
	folder: string | null;
	/** 家对话的会话文件（绝对路径）；没有就是 null。 */
	homeChat: string | null;
	pastHomeChats: string[];
	/** 身份文件夹。 */
	dir: string;
}

function home(env: Env): string {
	return env.HOME || homedir();
}

/** 身份所在的文件夹：PI_IDENTITY_DIR，否则 <PI_MEMORY_DIR 或 ~/.pi/agent/memory>/identities（同 pi-identity）。 */
export function identitiesDir(env: Env = process.env): string {
	return env.PI_IDENTITY_DIR || join(env.PI_MEMORY_DIR || join(home(env), ".pi", "agent", "memory"), "identities");
}

function expandHome(p: string, env: Env): string {
	if (p === "~") return home(env);
	if (p.startsWith("~/")) return join(home(env), p.slice(2));
	return p;
}

/** 两个路径是不是同一个文件（展开 ~、规整后比较）。 */
export function samePath(a: string | null | undefined, b: string | null | undefined, env: Env = process.env): boolean {
	if (!a || !b) return false;
	return resolve(expandHome(a, env)) === resolve(expandHome(b, env));
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** dir 里的每个身份（一个文件夹一个，带 identity.json），加上坏掉的那些的问题。规则同 pi-identity 的 loadIdentities。 */
export function loadIdentities(dir: string, env: Env = process.env): { identities: IdentityDef[]; problems: string[] } {
	const identities: IdentityDef[] = [];
	const problems: string[] = [];
	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return { identities, problems };
	}
	for (const name of names) {
		const d = join(dir, name);
		try {
			if (!statSync(d).isDirectory()) continue;
		} catch {
			continue;
		}
		const jsonPath = join(d, "identity.json");
		if (!existsSync(jsonPath)) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(jsonPath, "utf8"));
		} catch {
			problems.push(`${name}: identity.json isn't valid JSON`);
			continue;
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			problems.push(`${name}: identity.json isn't an object`);
			continue;
		}
		const o = raw as Record<string, unknown>;
		const id = str(o.id) || name;
		if (id !== name) {
			problems.push(`${name}: its id "${id}" must match its folder's name`);
			continue;
		}
		if (!ID_RE.test(id)) {
			problems.push(`${name}: an id is lowercase letters, digits and dashes`);
			continue;
		}
		const homeChat = str(o.homeChat);
		const past = Array.isArray(o.pastHomeChats) ? o.pastHomeChats.map(str).filter(Boolean) : [];
		identities.push({
			id,
			title: str(o.title) || id,
			folder: str(o.folder) ? expandHome(str(o.folder), env) : null,
			homeChat: homeChat ? expandHome(homeChat, env) : null,
			pastHomeChats: past.map((p) => expandHome(p, env)),
			dir: d,
		});
	}
	return { identities, problems };
}

/** 读出来的身份表，缓存几秒：对话列表每次推送都要用，身份文件又很少变。 */
interface Registry {
	dir: string;
	at: number;
	identities: IdentityDef[];
	problems: string[];
}

const REGISTRY_TTL_MS = 3_000;
let registry: Registry | null = null;

/** 当前的身份表（缓存 REGISTRY_TTL_MS；force 立即重读，设置身份、打开设置页时用）。 */
export function identityRegistry(force = false, env: Env = process.env): Registry {
	const dir = identitiesDir(env);
	const now = Date.now();
	if (!force && registry && registry.dir === dir && now - registry.at < REGISTRY_TTL_MS) return registry;
	const { identities, problems } = loadIdentities(dir, env);
	registry = { dir, at: now, identities, problems };
	return registry;
}

// ---------------------------------------------------------------------------
// 一条对话的身份
// ---------------------------------------------------------------------------

/** 只用到的会话条目字段（SessionEntry 的子集，测试好造）。 */
export interface IdentityEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** 是不是一条 identity 条目的 data（同 pi-identity 的 isIdentityEntry）。 */
export function isIdentityData(data: unknown): data is { id: string | null; via: string } {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	return (d.id === null || typeof d.id === "string") && typeof d.via === "string";
}

/** 一条会话条目若是 identity 条目，返回它的 id（null = 清掉）；不是就 undefined。 */
export function identityIdOfEntry(entry: IdentityEntryLike): string | null | undefined {
	if (entry.type !== "custom" || entry.customType !== IDENTITY_ENTRY_TYPE || !isIdentityData(entry.data)) {
		return undefined;
	}
	return entry.data.id;
}

/** 一条分支上最后一条 identity 条目的 id（null = 清掉了；undefined = 从没写过）。 */
export function identityIdOnBranch(entries: Iterable<IdentityEntryLike>): string | null | undefined {
	let found: string | null | undefined;
	for (const e of entries) {
		const id = identityIdOfEntry(e);
		if (id !== undefined) found = id;
	}
	return found;
}

/** 这个会话文件是哪个身份的家对话。 */
export function homeChatOf(file: string | undefined, identities: IdentityDef[]): IdentityDef | undefined {
	return file ? identities.find((i) => samePath(i.homeChat, file)) : undefined;
}

/** 这个会话文件以前是哪个身份的家对话。 */
export function pastHomeChatOf(file: string, identities: IdentityDef[]): IdentityDef | undefined {
	return identities.find((i) => i.pastHomeChats.some((p) => samePath(p, file)));
}

/** 加载着的对话的身份 id：分支上的条目（onBranch）算数；从没写过条目就看它是不是家对话。 */
export function liveChatIdentityId(
	onBranch: string | null | undefined,
	sessionFile: string | undefined,
	identities: IdentityDef[],
): string | null {
	if (onBranch !== undefined) return onBranch;
	return homeChatOf(sessionFile, identities)?.id ?? null;
}

/**
 * 设置 / 清除身份要跑的那行 pi-identity 命令：`/identity <id>` / `/identity none`。
 * 不是身份表里的 id（或者根本不是 id）返回 null —— 什么都不跑。
 */
export function identityCommandLine(identity: unknown, identities: IdentityDef[]): string | null {
	if (identity === null) return "/identity none";
	if (typeof identity !== "string" || !ID_RE.test(identity)) return null;
	return identities.some((i) => i.id === identity) ? `/identity ${identity}` : null;
}

/** 给页面的标签：{ id, title }。身份表里没有这个 id（文件夹被删了）就用 id 当标题。 */
export function uiChatIdentity(id: string | null | undefined, identities: IdentityDef[]): UiChatIdentity | undefined {
	if (!id) return undefined;
	const def = identities.find((i) => i.id === id);
	return { id, title: def?.title ?? id };
}

// ---------------------------------------------------------------------------
// 磁盘上的对话：增量读会话文件
// ---------------------------------------------------------------------------

const MARK = Buffer.from(`"customType":"${IDENTITY_ENTRY_TYPE}"`);
/** 一次读多少字节。每一块都从行首开始，所以短于它的行总是整行落在一块里。 */
const CHUNK = 1 << 20;
/** identity 条目是一行小 JSON；超过这么长的行不可能是它，不解析。 */
const LINE_MAX = 64 * 1024;

/** 一行若是 identity 条目，返回它的 id（null = 清掉）；不是或坏了就 undefined。 */
function identityIdOfLine(line: string): string | null | undefined {
	try {
		const e = JSON.parse(line) as IdentityEntryLike;
		return e && typeof e === "object" ? identityIdOfEntry(e) : undefined;
	} catch {
		return undefined;
	}
}

interface FileScan {
	ino: number;
	size: number;
	mtimeMs: number;
	/** 读到哪了（总是一行的开头）。 */
	offset: number;
	/** 正在跳过一条超过 CHUNK 的长行：下一个换行之前的都不看。 */
	skipping: boolean;
	last: string | null | undefined;
}

/**
 * 会话文件里最后一条 identity 条目，增量读：记住每个文件读到哪了，下次只读追加的部分（会话文件
 * 只往后加）。文件变短了或换了 inode（被整个重写）就从头读。用 Buffer.indexOf 找标记，只解析带标记
 * 的短行，所以几百 MB 的对话也只是顺序扫一遍。同一个文件同时只读一次。
 */
export class IdentityFileIndex {
	private scans = new Map<string, FileScan>();
	private inflight = new Map<string, Promise<string | null | undefined>>();

	/** 文件里最后一条 identity 条目的 id（null = 清掉了；undefined = 没有，或读不了）。 */
	lastEntry(file: string): Promise<string | null | undefined> {
		const running = this.inflight.get(file);
		if (running) return running;
		const p = this.scan(file).finally(() => this.inflight.delete(file));
		this.inflight.set(file, p);
		return p;
	}

	private async scan(file: string): Promise<string | null | undefined> {
		let st: Awaited<ReturnType<typeof stat>>;
		try {
			st = await stat(file);
		} catch {
			this.scans.delete(file);
			return undefined;
		}
		let prev = this.scans.get(file);
		if (prev && (prev.ino !== st.ino || st.size < prev.offset)) prev = undefined;
		if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev.last;
		const state: FileScan = prev
			? { ...prev, size: st.size, mtimeMs: st.mtimeMs }
			: { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, offset: 0, skipping: false, last: undefined };
		let fh: Awaited<ReturnType<typeof open>>;
		try {
			fh = await open(file, "r");
		} catch {
			return prev?.last;
		}
		try {
			const buf = Buffer.allocUnsafe(CHUNK);
			let pos = state.offset;
			while (pos < st.size) {
				const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - pos), pos);
				if (bytesRead <= 0) break;
				const chunk = buf.subarray(0, bytesRead);
				const lastNl = chunk.lastIndexOf(10);
				if (lastNl === -1) {
					// 整块没有换行：一条超长的行（不是 identity 条目）。文件在这里结束 = 这一行还在写，下次再读。
					if (pos + bytesRead >= st.size) break;
					state.skipping = true;
					pos += bytesRead;
					state.offset = pos;
					continue;
				}
				const body = chunk.subarray(0, lastNl + 1);
				let from = 0;
				if (state.skipping) {
					from = body.indexOf(10) + 1;
					state.skipping = false;
				}
				let at = body.indexOf(MARK, from);
				while (at !== -1) {
					const start = body.lastIndexOf(10, at) + 1;
					const end = body.indexOf(10, at);
					if (end - start <= LINE_MAX) {
						const id = identityIdOfLine(body.toString("utf8", start, end));
						if (id !== undefined) state.last = id;
					}
					at = body.indexOf(MARK, end + 1);
				}
				pos += lastNl + 1;
				state.offset = pos;
			}
		} catch {
			// 读到一半出错：已经读过的部分照样算，下次从停下的地方接着读
		} finally {
			await fh.close().catch(() => {});
		}
		this.scans.set(file, state);
		return state.last;
	}
}

/** 服务端共用的一个索引（所有 ClientSession 共用，同一个文件不读两遍）。 */
export const identityFileIndex = new IdentityFileIndex();

/**
 * 一批磁盘上的对话各自的身份 id（同 pi-identity 的 identityOfFile）：家对话（不用读文件）→ 文件里
 * 最后一条 identity 条目（null = 清掉）→ 以前的家对话。最多同时读 4 个文件。
 */
export async function fileIdentityIds(
	files: string[],
	identities: IdentityDef[],
	index: IdentityFileIndex = identityFileIndex,
): Promise<Map<string, string | null>> {
	const out = new Map<string, string | null>();
	const queue = [...new Set(files)];
	const worker = async () => {
		for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
			const homeOf = homeChatOf(file, identities);
			if (homeOf) {
				out.set(file, homeOf.id);
				continue;
			}
			const last = await index.lastEntry(file);
			out.set(file, last !== undefined ? last : (pastHomeChatOf(file, identities)?.id ?? null));
		}
	};
	await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
	return out;
}

// ---------------------------------------------------------------------------
// Settings → Identities：读写 about.md / notebook.md
// ---------------------------------------------------------------------------

export function identityFilePath(def: IdentityDef, file: IdentityFileName): string {
	return join(def.dir, file === "about" ? "about.md" : "notebook.md");
}

/** 文件内容的指纹：存盘时拿它确认文件在页面打开之后没被别人改过。 */
export function textHash(text: string): string {
	return createHash("sha1").update(text, "utf8").digest("hex");
}

function readTextOrEmpty(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw err;
	}
}

function sizeOf(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/** Settings 页的身份列表。 */
export function identityInfos(identities: IdentityDef[]): UiIdentityInfo[] {
	return identities.map((d) => ({
		id: d.id,
		title: d.title,
		...(d.folder ? { folder: d.folder } : {}),
		...(d.homeChat ? { homeChat: d.homeChat } : {}),
		aboutSize: sizeOf(identityFilePath(d, "about")),
		notebookSize: sizeOf(identityFilePath(d, "notebook")),
		notebookCap: NOTEBOOK_CAP,
	}));
}

export type IdentityFileRead =
	{ ok: true; text: string; hash: string; size: number; cap?: number } | { ok: false; error: string };

/** 读一个身份的 about.md / notebook.md（没有这个文件 = 空）。 */
export function readIdentityFile(identities: IdentityDef[], id: string, file: IdentityFileName): IdentityFileRead {
	const def = identities.find((i) => i.id === id);
	if (!def) return { ok: false, error: `No identity "${id}"` };
	try {
		const text = readTextOrEmpty(identityFilePath(def, file));
		return {
			ok: true,
			text,
			hash: textHash(text),
			size: Buffer.byteLength(text, "utf8"),
			...(file === "notebook" ? { cap: NOTEBOOK_CAP } : {}),
		};
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

export type IdentityFileSave = { ok: true; hash: string; size: number } | { ok: false; code: IdentitySaveError };

/** 整个文件写进去，不会写一半：同目录的临时文件，再 rename（同 pi-identity 的 writeWhole）。 */
function writeWhole(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, path);
}

/**
 * 存一个身份的 about.md / notebook.md（整个文件）。拒绝：没有这个身份（unknown）、笔记本超上限
 * （over_cap）、about 超安全上限（too_big）、文件在读出 baseHash 之后被改过（changed）、写不进去（io）。
 */
export function saveIdentityFile(
	identities: IdentityDef[],
	id: string,
	file: IdentityFileName,
	text: string,
	baseHash: string,
): IdentityFileSave {
	const def = identities.find((i) => i.id === id);
	if (!def || typeof text !== "string") return { ok: false, code: "unknown" };
	const size = Buffer.byteLength(text, "utf8");
	if (file === "notebook" && size > NOTEBOOK_CAP) return { ok: false, code: "over_cap" };
	if (file === "about" && size > ABOUT_MAX) return { ok: false, code: "too_big" };
	const path = identityFilePath(def, file);
	try {
		if (textHash(readTextOrEmpty(path)) !== baseHash) return { ok: false, code: "changed" };
		writeWhole(path, text);
	} catch {
		return { ok: false, code: "io" };
	}
	return { ok: true, hash: textHash(text), size };
}

let reindexTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 存盘后刷新记忆搜索的索引（`qmd update`，同 pi-identity 的 notebook 工具），两秒防抖，出错不管。
 * PI_IDENTITY_REINDEX=0 关掉（测试里）。
 */
export function scheduleMemoryReindex(env: Env = process.env): void {
	if (env.PI_IDENTITY_REINDEX === "0") return;
	if (reindexTimer) clearTimeout(reindexTimer);
	reindexTimer = setTimeout(() => {
		reindexTimer = null;
		execFile("qmd", ["update"], { timeout: 60_000 }, () => {});
	}, 2_000);
	reindexTimer.unref?.();
}
