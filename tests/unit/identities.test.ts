/**
 * identities (pi-identity in pi-web-ui): unit tests.
 *
 * - the identity list (identity.json folders) and a chat's label: a loaded chat (the last `identity` entry
 *   on its branch, else the home chat) and a History chat (its file, read incrementally: home chat ->
 *   last entry -> past home chat);
 * - setting and clearing through pi-identity's own `/identity` command (ClientSession.setChatIdentity);
 * - Settings -> Identities: reading and saving about.md / notebook.md (whole file, the cap refusal, a file
 *   changed meanwhile);
 * - the page side: the identity menu entries, the Settings store, the Layout slot entries.
 *
 * No model and no port: the production functions, a temp identities folder and fake chats.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSession, personaFirst } from "../../server/agent-service.js";
import {
	fileIdentityIds,
	identityCommandLine,
	IdentityFileIndex,
	identityIdOnBranch,
	identityInfos,
	identityRegistry,
	liveChatIdentityId,
	loadIdentities,
	NOTEBOOK_CAP,
	readIdentityFile,
	saveIdentityFile,
	textHash,
	uiChatIdentity,
} from "../../server/identities.js";
import type { ServerMessage, SessionSummary, UiChatIdentity, UiIdentityInfo } from "../../server/protocol.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { identityChoiceOf, identityMenuChildren, withIdentityChildren } from "../../web/src/identity-menu.js";
import {
	closeIdentityFile,
	getIdentityFile,
	getIdentityList,
	openIdentityFile,
	receiveIdentities,
	receiveIdentityFile,
	receiveIdentitySaved,
	resetIdentityState,
	saveOpenIdentityFile,
	shortChatName,
	utf8Bytes,
} from "../../web/src/identity-state.js";
import { buildUiSlots, CONV_IDENTITY_ENTRY_ID } from "../../web/src/ui-slots.js";

type Proto = {
	identityOf(this: unknown, conv: unknown): UiChatIdentity | undefined;
	setChatIdentity(this: unknown, conversationId: unknown, sessionPath: unknown, identity: unknown): Promise<void>;
	attachIdentities(this: unknown, rows: SessionSummary[], resend: () => void): Promise<void>;
};
const proto = ClientSession.prototype as unknown as Proto;

let root: string;
let idDir: string;
let sessions: string;
const savedEnv = process.env.PI_IDENTITY_DIR;

function writeIdentity(id: string, json: Record<string, unknown>, files: { about?: string; notebook?: string } = {}) {
	const d = join(idDir, id);
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, "identity.json"), JSON.stringify({ id, ...json }));
	if (files.about !== undefined) writeFileSync(join(d, "about.md"), files.about);
	if (files.notebook !== undefined) writeFileSync(join(d, "notebook.md"), files.notebook);
}

/** A session entry pi-identity writes (id null = cleared). */
const entry = (id: string | null, via = "command") => ({
	type: "custom",
	customType: "identity",
	data: { v: 1, id, via },
});
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "identities-"));
	idDir = join(root, "identities");
	sessions = join(root, "sessions");
	mkdirSync(idDir);
	mkdirSync(sessions);
	process.env.PI_IDENTITY_DIR = idDir;
	writeIdentity(
		"temper",
		{ title: "temper", folder: "/work/temper-ai", homeChat: join(sessions, "temper-home.jsonl") },
		{ about: "About temper\n", notebook: "- #fact one\n" },
	);
	writeIdentity("rollcall", {
		title: "RollCall",
		homeChat: join(sessions, "rollcall-home.jsonl"),
		pastHomeChats: [join(sessions, "rollcall-old.jsonl")],
	});
	writeIdentity("ops", { title: "ops/tooling" });
	identityRegistry(true);
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.PI_IDENTITY_DIR;
	else process.env.PI_IDENTITY_DIR = savedEnv;
	rmSync(root, { recursive: true, force: true });
	setAppSend(null);
	resetIdentityState();
});

describe("the identity list", () => {
	it("lists each identity folder by id with its title (the id when none), and says which folders are broken", () => {
		writeIdentity("plain", {});
		mkdirSync(join(idDir, "broken"));
		writeFileSync(join(idDir, "broken", "identity.json"), "{ not json");
		mkdirSync(join(idDir, "wrong"));
		writeFileSync(join(idDir, "wrong", "identity.json"), JSON.stringify({ id: "other" }));
		writeIdentity("Bad_Id", {});
		mkdirSync(join(idDir, "no-json"));
		writeIdentity("home", { folder: "~/code" });
		const { identities, problems } = loadIdentities(idDir, { HOME: "/home/u" });
		expect(identities.map((i) => [i.id, i.title])).toEqual([
			["home", "home"],
			["ops", "ops/tooling"],
			["plain", "plain"],
			["rollcall", "RollCall"],
			["temper", "temper"],
		]);
		expect(identities.find((i) => i.id === "home")?.folder).toBe("/home/u/code");
		expect(problems).toHaveLength(3);
		expect(problems.join("\n")).toContain("broken: identity.json isn't valid JSON");
	});

	it("Settings gets each identity's home chat and its notebook size against the cap", () => {
		const infos = identityInfos(identityRegistry(true).identities);
		expect(infos.map((i) => i.id)).toEqual(["ops", "rollcall", "temper"]);
		expect(infos.find((i) => i.id === "temper")).toEqual({
			id: "temper",
			title: "temper",
			folder: "/work/temper-ai",
			homeChat: join(sessions, "temper-home.jsonl"),
			aboutSize: Buffer.byteLength("About temper\n"),
			notebookSize: Buffer.byteLength("- #fact one\n"),
			notebookCap: NOTEBOOK_CAP,
		});
		const ops = infos.find((i) => i.id === "ops");
		expect(ops).toMatchObject({ aboutSize: 0, notebookSize: 0, notebookCap: NOTEBOOK_CAP });
		expect(ops?.homeChat).toBeUndefined();
	});
});

describe("a chat's label", () => {
	it("the last identity entry on the branch counts; null clears it; other entries don't", () => {
		expect(identityIdOnBranch([])).toBeUndefined();
		expect(
			identityIdOnBranch([
				entry("temper"),
				{ type: "message" },
				{ type: "custom", customType: "tldr", data: { id: "ops", via: "x" } },
			]),
		).toBe("temper");
		expect(identityIdOnBranch([entry("temper"), entry(null)])).toBeNull();
		expect(identityIdOnBranch([entry(null), entry("ops")])).toBe("ops");
		expect(identityIdOnBranch([{ type: "custom", customType: "identity", data: { id: 3, via: "x" } }])).toBeUndefined();
	});

	it("a loaded chat: its branch entry, else the identity whose home chat it is; the label is the title", () => {
		const ids = identityRegistry(true).identities;
		const home = join(sessions, "rollcall-home.jsonl");
		expect(liveChatIdentityId(undefined, home, ids)).toBe("rollcall");
		expect(liveChatIdentityId(null, home, ids)).toBeNull();
		expect(liveChatIdentityId("ops", home, ids)).toBe("ops");
		expect(liveChatIdentityId(undefined, join(sessions, "other.jsonl"), ids)).toBeNull();
		expect(uiChatIdentity("rollcall", ids)).toEqual({ id: "rollcall", title: "RollCall" });
		expect(uiChatIdentity("gone", ids)).toEqual({ id: "gone", title: "gone" });
		expect(uiChatIdentity(null, ids)).toBeUndefined();
	});

	it("follows the chat's session tree as entries are added (ClientSession.identityOf)", () => {
		type E = { id: string; parentId: string | null; type: string; customType?: string; data?: unknown };
		const byId = new Map<string, E>();
		let leaf: string | null = null;
		const add = (e: E) => {
			byId.set(e.id, e);
			leaf = e.id;
		};
		const conv: Record<string, unknown> = {
			session: {
				sessionManager: {
					getSessionFile: () => join(sessions, "a.jsonl"),
					getSessionId: () => "s1",
					getLeafId: () => leaf,
					getEntry: (id: string) => byId.get(id),
				},
			},
		};
		add({ id: "1", parentId: null, type: "message" });
		expect(proto.identityOf.call({}, conv)).toBeUndefined();
		add({ id: "2", parentId: "1", ...entry("temper") });
		expect(proto.identityOf.call({}, conv)).toEqual({ id: "temper", title: "temper" });
		add({ id: "3", parentId: "2", type: "message" });
		expect(proto.identityOf.call({}, conv)).toEqual({ id: "temper", title: "temper" });
		add({ id: "4", parentId: "3", ...entry(null) });
		expect(proto.identityOf.call({}, conv)).toBeUndefined();
		// Back on the old branch (the tree was navigated): the label follows.
		leaf = "3";
		expect(proto.identityOf.call({}, conv)).toEqual({ id: "temper", title: "temper" });
	});

	it("a home chat shows its identity before it wrote any entry", () => {
		const conv = {
			session: {
				sessionManager: {
					getSessionFile: () => join(sessions, "rollcall-home.jsonl"),
					getSessionId: () => "s2",
					getLeafId: () => "1",
					getEntry: (id: string) => (id === "1" ? { id: "1", parentId: null, type: "message" } : undefined),
				},
			},
		};
		expect(proto.identityOf.call({}, conv)).toEqual({ id: "rollcall", title: "RollCall" });
	});
});

describe("History chats show their identity", () => {
	it("each file: its home chat (not read), else its last entry, else a past home chat", async () => {
		const set = join(sessions, "set.jsonl");
		writeFileSync(set, line({ type: "session" }) + line(entry("temper")) + line({ type: "message", text: "hi" }));
		const cleared = join(sessions, "cleared.jsonl");
		writeFileSync(cleared, line(entry("ops")) + line(entry(null)));
		const plain = join(sessions, "plain.jsonl");
		writeFileSync(plain, line({ type: "session" }));
		const old = join(sessions, "rollcall-old.jsonl");
		writeFileSync(old, line({ type: "session" }));
		// Not even on disk: a home chat is known from identity.json alone.
		const home = join(sessions, "rollcall-home.jsonl");
		const ids = await fileIdentityIds(
			[set, cleared, plain, old, home],
			identityRegistry(true).identities,
			new IdentityFileIndex(),
		);
		expect(Object.fromEntries(ids)).toEqual({
			[set]: "temper",
			[cleared]: null,
			[plain]: null,
			[old]: "rollcall",
			[home]: "rollcall",
		});
	});

	it("reads only what was added since last time; waits for a line still being written", async () => {
		const index = new IdentityFileIndex();
		const f = join(sessions, "grow.jsonl");
		writeFileSync(f, line({ type: "session" }) + line(entry("temper")));
		expect(await index.lastEntry(f)).toBe("temper");
		appendFileSync(f, JSON.stringify(entry("ops")));
		expect(await index.lastEntry(f)).toBe("temper");
		appendFileSync(f, "\n");
		expect(await index.lastEntry(f)).toBe("ops");
		// A line longer than one read (1 MB) before the next entry; a message that only quotes the marker.
		appendFileSync(
			f,
			line({ type: "message", text: "x".repeat(1_200_000) }) +
				line({ type: "message", text: '"customType":"identity"' }) +
				line(entry(null)),
		);
		expect(await index.lastEntry(f)).toBeNull();
		// Rewritten shorter: read again from the start.
		writeFileSync(f, line(entry("rollcall")));
		expect(await index.lastEntry(f)).toBe("rollcall");
		expect(await index.lastEntry(join(sessions, "missing.jsonl"))).toBeUndefined();
	});

	it("the History rows carry the label", async () => {
		const a = join(sessions, "a.jsonl");
		writeFileSync(a, line(entry("temper")));
		const b = join(sessions, "b.jsonl");
		writeFileSync(b, line({ type: "session" }));
		const rows: SessionSummary[] = [
			{ path: a, firstMessage: "a", messageCount: 2, modified: 2 },
			{ path: b, firstMessage: "b", messageCount: 2, modified: 1, identity: { id: "ops", title: "ops/tooling" } },
			{ path: join(sessions, "rollcall-home.jsonl"), firstMessage: "c", messageCount: 9, modified: 0 },
		];
		const resend = vi.fn();
		await proto.attachIdentities.call({}, rows, resend);
		expect(rows.map((r) => r.identity)).toEqual([
			{ id: "temper", title: "temper" },
			undefined,
			{ id: "rollcall", title: "RollCall" },
		]);
		expect(resend).not.toHaveBeenCalled();
	});
});

describe("set and clear go through pi-identity's /identity", () => {
	type FakeChat = {
		id: string;
		session: {
			sessionFile: string;
			extensionRunner: { getCommand(name: string): object | undefined };
			prompt: ReturnType<typeof vi.fn>;
		};
	};
	function fakeChat(id: string, file: string, hasPiIdentity = true): FakeChat {
		return {
			id,
			session: {
				sessionFile: file,
				extensionRunner: { getCommand: (name) => (hasPiIdentity && name === "identity" ? {} : undefined) },
				prompt: vi.fn(async () => {}),
			},
		};
	}
	function fakeWindow(chats: FakeChat[]) {
		const emitted: ServerMessage[] = [];
		return {
			disposed: false,
			convs: new Map(chats.map((c) => [c.id, c])),
			emitted,
			emit(msg: ServerMessage) {
				emitted.push(msg);
			},
			switchSession: vi.fn(async (_path: string) => {}),
		};
	}

	it("the command lines: /identity <id> sets, /identity none clears, anything else runs nothing", () => {
		const ids = identityRegistry(true).identities;
		expect(identityCommandLine("temper", ids)).toBe("/identity temper");
		expect(identityCommandLine(null, ids)).toBe("/identity none");
		expect(identityCommandLine("nobody", ids)).toBeNull();
		expect(identityCommandLine("temper; rm -rf /", ids)).toBeNull();
		expect(identityCommandLine("Temper", ids)).toBeNull();
		expect(identityCommandLine(undefined, ids)).toBeNull();
		expect(identityCommandLine(3, ids)).toBeNull();
	});

	it("sets and clears a loaded chat's identity with pi-identity's own command", async () => {
		const chat = fakeChat("c1", join(sessions, "a.jsonl"));
		const win = fakeWindow([chat]);
		await proto.setChatIdentity.call(win, "c1", undefined, "rollcall");
		await proto.setChatIdentity.call(win, "c1", undefined, null);
		await proto.setChatIdentity.call(win, "c1", undefined, "nobody");
		expect(chat.session.prompt.mock.calls).toEqual([["/identity rollcall"], ["/identity none"]]);
		expect(win.switchSession).not.toHaveBeenCalled();
	});

	it("a chat found by its file; a History chat is opened first", async () => {
		const loaded = fakeChat("c1", join(sessions, "loaded.jsonl"));
		const history = fakeChat("c2", join(sessions, "history.jsonl"));
		const win = fakeWindow([loaded]);
		win.switchSession = vi.fn(async () => {
			win.convs.set(history.id, history);
		});
		await proto.setChatIdentity.call(win, undefined, join(sessions, "loaded.jsonl"), "temper");
		expect(loaded.session.prompt).toHaveBeenCalledWith("/identity temper");
		await proto.setChatIdentity.call(win, undefined, join(sessions, "history.jsonl"), "ops");
		expect(win.switchSession).toHaveBeenCalledWith(join(sessions, "history.jsonl"));
		expect(history.session.prompt).toHaveBeenCalledWith("/identity ops");
	});

	it("a chat without pi-identity gets a notice, and nothing goes to the model", async () => {
		const chat = fakeChat("c1", join(sessions, "a.jsonl"), false);
		const win = fakeWindow([chat]);
		await proto.setChatIdentity.call(win, "c1", undefined, "temper");
		expect(chat.session.prompt).not.toHaveBeenCalled();
		expect(win.emitted.map((m) => m.type)).toEqual(["notice"]);
	});
});

describe("Settings: about.md and notebook.md", () => {
	const notebook = () => join(idDir, "temper", "notebook.md");

	it("reads a file with its hash (the notebook with its cap); a missing file is empty", () => {
		const ids = identityRegistry(true).identities;
		expect(readIdentityFile(ids, "temper", "notebook")).toEqual({
			ok: true,
			text: "- #fact one\n",
			hash: textHash("- #fact one\n"),
			size: 12,
			cap: NOTEBOOK_CAP,
		});
		expect(readIdentityFile(ids, "temper", "about")).toMatchObject({ ok: true, text: "About temper\n" });
		expect(readIdentityFile(ids, "ops", "about")).toMatchObject({ ok: true, text: "", hash: textHash("") });
		expect(readIdentityFile(ids, "nobody", "about")).toMatchObject({ ok: false });
	});

	it("saves the whole file (no temp file left) and returns the new hash", () => {
		const ids = identityRegistry(true).identities;
		const saved = saveIdentityFile(ids, "temper", "notebook", "- #fact two\n", textHash("- #fact one\n"));
		expect(saved).toEqual({ ok: true, hash: textHash("- #fact two\n"), size: 12 });
		expect(readFileSync(notebook(), "utf8")).toBe("- #fact two\n");
		expect(readdirSync(join(idDir, "temper")).sort()).toEqual(["about.md", "identity.json", "notebook.md"]);
		// A first about.md for an identity that had none.
		expect(saveIdentityFile(ids, "ops", "about", "# ops\n", textHash(""))).toMatchObject({ ok: true });
		expect(readFileSync(join(idDir, "ops", "about.md"), "utf8")).toBe("# ops\n");
	});

	it("refuses a notebook over its cap (in bytes) and leaves the file alone", () => {
		const ids = identityRegistry(true).identities;
		const base = textHash("- #fact one\n");
		const over = `${"é".repeat(NOTEBOOK_CAP / 2)}x`;
		expect(Buffer.byteLength(over)).toBe(NOTEBOOK_CAP + 1);
		expect(saveIdentityFile(ids, "temper", "notebook", over, base)).toEqual({ ok: false, code: "over_cap" });
		expect(readFileSync(notebook(), "utf8")).toBe("- #fact one\n");
		const atCap = "é".repeat(NOTEBOOK_CAP / 2);
		expect(saveIdentityFile(ids, "temper", "notebook", atCap, base)).toMatchObject({ ok: true, size: NOTEBOOK_CAP });
	});

	it("refuses a file changed after it was opened, an identity that's gone, and a huge about page", () => {
		const ids = identityRegistry(true).identities;
		expect(saveIdentityFile(ids, "temper", "about", "new", textHash("stale"))).toEqual({ ok: false, code: "changed" });
		expect(readFileSync(join(idDir, "temper", "about.md"), "utf8")).toBe("About temper\n");
		expect(saveIdentityFile(ids, "nobody", "about", "x", textHash(""))).toEqual({ ok: false, code: "unknown" });
		expect(saveIdentityFile(ids, "temper", "about", "x".repeat(64_001), textHash("About temper\n"))).toEqual({
			ok: false,
			code: "too_big",
		});
	});
});

describe("the page", () => {
	const list: UiIdentityInfo[] = [
		{ id: "temper", title: "temper", aboutSize: 10, notebookSize: 100, notebookCap: NOTEBOOK_CAP },
		{ id: "rollcall", title: "RollCall", aboutSize: 10, notebookSize: 100, notebookCap: NOTEBOOK_CAP },
	];
	const t = (key: string) => key;

	it("the identity choices: None first, then each identity by title, the chat's own one ticked", () => {
		const kids = identityMenuChildren({ slot: "contextmenu.session", align: "start" }, list, "rollcall", "None");
		expect(kids.map((k) => [k.id, k.label, k.badge])).toEqual([
			["host:conv-identity:none", "None", undefined],
			["host:conv-identity:temper", "temper", undefined],
			["host:conv-identity:rollcall", "RollCall", "✓"],
		]);
		expect(kids[2]?.hint).toBe("rollcall");
		expect(kids.every((k) => k.source === "host" && k.kind === "action")).toBe(true);
		const none = identityMenuChildren({ slot: "contextmenu.session", align: "start" }, list, undefined, "None");
		expect(none[0]?.badge).toBe("✓");
	});

	it("a pick is read back from the entry id: the identity, null for None", () => {
		expect(identityChoiceOf("host:conv-identity:temper")).toBe("temper");
		expect(identityChoiceOf("host:conv-identity:none")).toBeNull();
		expect(identityChoiceOf("host:conv-identity")).toBeUndefined();
		expect(identityChoiceOf("host:conv-rename")).toBeUndefined();
	});

	it("the chat menu's Identity entry gets the choices and shows the current one; hidden with nothing to pick", () => {
		const slots = buildUiSlots([], { locale: "en", t });
		const entry = slots["contextmenu.session"].find((e) => e.id === CONV_IDENTITY_ENTRY_ID);
		expect(entry?.kind).toBe("menu");
		const filled = withIdentityChildren(entry!, list, "temper", "None");
		expect(filled.children?.map((c) => c.id)).toEqual([
			"host:conv-identity:none",
			"host:conv-identity:temper",
			"host:conv-identity:rollcall",
		]);
		expect(filled.badge).toBe("temper");
		expect(withIdentityChildren(entry!, [], undefined, "None").hidden).toBe(true);
	});

	it("the tag, the picker and the list tags are host slot entries that Layout can hide", () => {
		const slots = buildUiSlots([], { locale: "en", t });
		expect(slots["chat.header"].map((e) => e.id)).toEqual(["host:chat-identity"]);
		expect(slots["chat.empty"].map((e) => e.id)).toEqual(["host:identity-picker"]);
		expect(slots["leftpanel.sessions"].map((e) => e.id)).toContain("host:lp-identity");
		const hidden = buildUiSlots([], {
			locale: "en",
			t,
			layout: { hidden: ["host:lp-identity", "host:chat-identity", "host:identity-picker"] },
		});
		expect(hidden["leftpanel.sessions"].find((e) => e.id === "host:lp-identity")?.hidden).toBe(true);
		expect(hidden["chat.header"].find((e) => e.id === "host:chat-identity")?.hidden).toBe(true);
		expect(hidden["chat.empty"].find((e) => e.id === "host:identity-picker")?.hidden).toBe(true);
	});

	it("Settings store: open a file, save it against its hash, keep the draft when a save is refused", () => {
		const sent: unknown[] = [];
		setAppSend((msg) => {
			sent.push(msg);
			return true;
		});
		receiveIdentities({ type: "identities", identities: list, problems: [] });
		expect(getIdentityList()).toEqual({ identities: list, problems: [], loaded: true });

		openIdentityFile("temper", "notebook");
		expect(getIdentityFile()).toMatchObject({ id: "temper", file: "notebook", status: "loading" });
		expect(sent.at(-1)).toEqual({ type: "identity_file_get", id: "temper", file: "notebook" });
		// An answer for another file doesn't count.
		receiveIdentityFile({ type: "identity_file", id: "rollcall", file: "notebook", text: "x", hash: "h0" });
		expect(getIdentityFile()?.status).toBe("loading");
		receiveIdentityFile({ type: "identity_file", id: "temper", file: "notebook", text: "a\n", hash: "h1", cap: 8000 });
		expect(getIdentityFile()).toMatchObject({ status: "ready", text: "a\n", hash: "h1", cap: 8000 });

		expect(saveOpenIdentityFile("a\nb\n")).toBe(true);
		expect(sent.at(-1)).toEqual({
			type: "identity_file_save",
			id: "temper",
			file: "notebook",
			text: "a\nb\n",
			baseHash: "h1",
		});
		expect(saveOpenIdentityFile("again")).toBe(false);
		receiveIdentitySaved({
			type: "identity_file_saved",
			id: "temper",
			file: "notebook",
			ok: true,
			hash: "h2",
			size: 4,
		});
		expect(getIdentityFile()).toMatchObject({ text: "a\nb\n", hash: "h2", saving: false, saved: { ok: true } });

		expect(saveOpenIdentityFile("too long")).toBe(true);
		receiveIdentitySaved({ type: "identity_file_saved", id: "temper", file: "notebook", ok: false, code: "over_cap" });
		expect(getIdentityFile()).toMatchObject({ text: "a\nb\n", hash: "h2", saved: { ok: false, code: "over_cap" } });

		receiveIdentityFile({ type: "identity_file", id: "temper", file: "notebook", error: "EACCES" });
		expect(getIdentityFile()).toMatchObject({ status: "error", error: "EACCES" });
		closeIdentityFile();
		expect(getIdentityFile()).toBeNull();
	});

	it("counts bytes like the server does, and names a home chat by its short session id", () => {
		expect(utf8Bytes("abc")).toBe(3);
		expect(utf8Bytes("é")).toBe(2);
		expect(utf8Bytes("日本")).toBe(6);
		expect(shortChatName("/s/--home--/2026-09-15T00-13-53-291Z_01a0a269-1111-2222.jsonl")).toBe("01a0a269");
		expect(shortChatName("/s/plain.jsonl")).toBe("plain");
	});
});

describe("the about page and notebook reach the model", () => {
	// pi-web-ui's persona rebuilds the whole prompt when it's customized, dropping what extensions before
	// it added. It runs first now, so pi-identity's text (and any extension's) is added to its prompt.
	it("loads the persona extension first and keeps the others in their order", () => {
		const ext = (path: string) => ({ path });
		const loaded = [
			ext("/pkgs/pi-identity/index.ts"),
			ext("/pkgs/pi-tldr/index.ts"),
			ext("<inline:pi-webui-persona>"),
			ext("<inline:fast-mode>"),
		];
		expect(personaFirst(loaded).map((e) => e.path)).toEqual([
			"<inline:pi-webui-persona>",
			"/pkgs/pi-identity/index.ts",
			"/pkgs/pi-tldr/index.ts",
			"<inline:fast-mode>",
		]);
		const first = [ext("<inline:pi-webui-persona>"), ext("/pkgs/pi-identity/index.ts")];
		expect(personaFirst(first)).toBe(first);
		const none = [ext("/pkgs/pi-identity/index.ts")];
		expect(personaFirst(none)).toBe(none);
	});
});
