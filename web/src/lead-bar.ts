/**
 * lead-bar: the left bar's leads view. One row per role lead (an identity with a home chat), in the
 * Roles page's order, each with the chats of its queue's open, started tasks under it; one "Open now"
 * row for the chat on screen when it is neither; nothing else. Every other chat is one click away in
 * "All chats" (the old Recent chats + History lists) and in search.
 *
 * Worked out from what the page already has: the identity list, this window's chat rows, chats running
 * elsewhere, open task chats that aren't rows (conversations.queueTasks), the saved chats, and the open
 * chat. Leads are found by identity and file, never by title. Rows never move when a chat gets a message:
 * leads keep the Roles page's order (self-start first, then the rest, each by id), tasks their creation
 * order (newest first, as under a queue chat in Recent chats).
 *
 * Pure: LeftPanel draws what buildLeadBar returns. Unit tests: tests/unit/lead-bar.test.ts.
 */
import { needsUser } from "./conv-groups";
import type { ConversationSummary, ElsewhereRunning, SessionSummary, UiIdentityInfo } from "./types";

/** A transcript path as the page compares them: forward slashes, no empty, "." or ".." parts, no
 *  trailing slash. Links (queueHomeFile) come resolved; rows and home chats as written. */
export function normPath(p: string): string {
	const out: string[] = [];
	for (const part of p.replace(/\\/g, "/").split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return (/^[\\/]/.test(p) ? "/" : "") + out.join("/");
}

/** The lead's own chat, as this window can show it. */
export type LeadChat =
	/** Open (a live row of the list): its row as in Recent chats, lights, marks and menu included. */
	| { kind: "conv"; conv: ConversationSummary }
	/** Running in another tab or device: today's "elsewhere" row (take over to open it here). */
	| { kind: "elsewhere"; entry: ElsewhereRunning; index: number }
	/** Only saved: an idle row that opens the transcript, as a History row does. `session`: its History
	 *  row, if listed; `row`: its saved Recent chats row, if it is one (title, "waiting for you" light). */
	| { kind: "saved"; session?: SessionSummary; row?: ConversationSummary }
	/** The home chat's file isn't there: greyed out, can't be opened. */
	| { kind: "missing" };

/** One open, started task's chat under its lead. */
export type LeadTask =
	{ kind: "conv"; conv: ConversationSummary } | { kind: "elsewhere"; entry: ElsewhereRunning; index: number };

/** A lead's task chats, for its row's fold toggle (as a queue chat's in Recent chats). */
export interface LeadGroup {
	count: number;
	folded: boolean;
	streaming: boolean;
	needsYou: boolean;
}

export interface LeadEntry {
	identity: { id: string; title: string };
	/** The home chat as the identity list names it (opens it, keys its fold). */
	homeChat: string;
	/** normPath(homeChat). */
	file: string;
	chat: LeadChat;
	/** Its task chats, newest first; while folded away (`group.folded`) only the one on screen, if any. */
	tasks: LeadTask[];
	/** Only when it has task chats. */
	group?: LeadGroup;
}

/** The chat on screen when it's neither a lead's nor one of their tasks'. */
export type OpenNow =
	| { kind: "conv"; conv: ConversationSummary }
	/** A saved chat that isn't a row yet (its row comes with the next list). */
	| { kind: "saved"; file: string; session: SessionSummary }
	/** A new chat with nothing in it yet (not a row until it has). */
	| { kind: "new" };

export interface LeadBar {
	leads: LeadEntry[];
	openNow: OpenNow | null;
	/** The chats only All chats shows that are running, or wait on the owner's answer. */
	others: { running: number; asking: number };
}

export interface LeadBarInput {
	identities: readonly UiIdentityInfo[];
	conversations: readonly ConversationSummary[];
	elsewhere: readonly ElsewhereRunning[];
	queueTasks: readonly ConversationSummary[];
	sessions: readonly SessionSummary[];
	activeConversationId: string;
	/** The open chat's transcript (the snapshot's), if it has one. */
	sessionFile: string | null;
}

/** Whether the leads view applies: some identity has a home chat. */
export function hasLeads(identities: readonly UiIdentityInfo[]): boolean {
	return identities.some((i) => Boolean(i.homeChat));
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The leads in the Roles page's order (roles-view-model.ts groupRoles): self-start roles first, then the
 *  rest, each by id. Work mode: the owner's word, else the every-chat rules' default. */
export function leadOrder(identities: readonly UiIdentityInfo[]): UiIdentityInfo[] {
	const leads = identities.filter((i) => Boolean(i.homeChat)).sort(byId);
	const selfStart = (i: UiIdentityInfo) => (i.workMode ?? i.rules?.workMode) === "self-start";
	return [...leads.filter(selfStart), ...leads.filter((i) => !selfStart(i))];
}

/** Newest first; rows without a creation time last, in the order they came (stable sort). */
const byCreated = (a: LeadTask, b: LeadTask): number => {
	const ax = a.kind === "conv" ? a.conv.createdAt : undefined;
	const bx = b.kind === "conv" ? b.conv.createdAt : undefined;
	if (ax === undefined && bx === undefined) return 0;
	if (ax === undefined) return 1;
	if (bx === undefined) return -1;
	return bx - ax;
};

const asking = (c: { hasQuestion?: boolean; dialogId?: number }): boolean =>
	Boolean(c.hasQuestion || c.dialogId !== undefined);

/**
 * The leads view. `isFolded(key)`: whether the owner folded away the task chats under the lead whose
 * home chat is `key` (normPath of it; the same key its row has in Recent chats).
 */
export function buildLeadBar(input: LeadBarInput, isFolded: (key: string) => boolean = () => false): LeadBar {
	const { conversations, elsewhere, queueTasks, sessions, activeConversationId, sessionFile } = input;
	const leadsInOrder = leadOrder(input.identities);
	const leadFiles = new Set(leadsInOrder.map((i) => normPath(i.homeChat ?? "")));

	// This window's rows by transcript (a live row over a saved one), chats elsewhere, saved chats.
	const convByFile = new Map<string, ConversationSummary>();
	for (const c of conversations) {
		if (c.isSubagent || !c.sessionPath) continue;
		const key = normPath(c.sessionPath);
		const had = convByFile.get(key);
		if (!had || (had.live === false && c.live !== false)) convByFile.set(key, c);
	}
	const elsewhereByFile = new Map<string, { entry: ElsewhereRunning; index: number }>();
	elsewhere.forEach((entry, index) => {
		if (entry.sessionFile && !elsewhereByFile.has(normPath(entry.sessionFile)))
			elsewhereByFile.set(normPath(entry.sessionFile), { entry, index });
	});
	const sessionByFile = new Map<string, SessionSummary>();
	for (const s of sessions) if (!sessionByFile.has(normPath(s.path))) sessionByFile.set(normPath(s.path), s);

	// Task chats: open, started tasks of a lead's queue, each once, never a lead's own chat.
	const tasksOf = new Map<string, LeadTask[]>();
	const taskFiles = new Set<string>();
	const addTask = (own: string | undefined, home: string | undefined, task: LeadTask): void => {
		if (!own || !home) return;
		const ownKey = normPath(own);
		const homeKey = normPath(home);
		if (ownKey === homeKey || leadFiles.has(ownKey) || taskFiles.has(ownKey) || !leadFiles.has(homeKey)) return;
		taskFiles.add(ownKey);
		const list = tasksOf.get(homeKey) ?? [];
		list.push(task);
		tasksOf.set(homeKey, list);
	};
	for (const c of conversations) if (!c.isSubagent) addTask(c.sessionPath, c.queueHomeFile, { kind: "conv", conv: c });
	for (const c of queueTasks) if (!c.isSubagent) addTask(c.sessionPath, c.queueHomeFile, { kind: "conv", conv: c });
	elsewhere.forEach((entry, index) => {
		addTask(entry.sessionFile, entry.queueHomeFile, { kind: "elsewhere", entry, index });
	});

	const seenFiles = new Set<string>();
	const leads: LeadEntry[] = leadsInOrder.map((identity) => {
		const homeChat = identity.homeChat ?? "";
		const file = normPath(homeChat);
		const conv = convByFile.get(file);
		const away = elsewhereByFile.get(file);
		const session = sessionByFile.get(file);
		const chat: LeadChat =
			conv && conv.live !== false
				? { kind: "conv", conv }
				: away
					? { kind: "elsewhere", entry: away.entry, index: away.index }
					: identity.homeChatMissing
						? { kind: "missing" }
						: { kind: "saved", ...(session ? { session } : {}), ...(conv ? { row: conv } : {}) };
		// Two leads with one home chat (shouldn't happen): the tasks go under the first.
		const all = seenFiles.has(file) ? [] : [...(tasksOf.get(file) ?? [])].sort(byCreated);
		seenFiles.add(file);
		const entry: LeadEntry = { identity: { id: identity.id, title: identity.title }, homeChat, file, chat, tasks: all };
		if (all.length > 0) {
			// (A lead running elsewhere draws that row, which has no fold toggle: never folded.)
			const folded = chat.kind !== "elsewhere" && isFolded(file);
			entry.group = {
				count: all.length,
				folded,
				streaming: all.some((t) => (t.kind === "conv" ? t.conv.isStreaming : t.entry.isStreaming)),
				needsYou: all.some((t) => (t.kind === "conv" ? needsUser(t.conv) : Boolean(t.entry.hasQuestion))),
			};
			// Folded away, but the one on screen stays (it's never lost from the bar).
			if (folded) entry.tasks = all.filter((t) => t.kind === "conv" && t.conv.id === activeConversationId);
		}
		return entry;
	});

	// Shown: the leads' chats and their task chats (folded away or not).
	const shown = (file: string | undefined): boolean =>
		file !== undefined && (leadFiles.has(normPath(file)) || taskFiles.has(normPath(file)));

	// The chat on screen, when the bar shows it nowhere else.
	let openNow: OpenNow | null = null;
	const active = activeConversationId ? conversations.find((c) => c.id === activeConversationId) : undefined;
	if (active) {
		if (!shown(active.sessionPath)) openNow = { kind: "conv", conv: active };
	} else if (activeConversationId) {
		const saved = sessionFile ? sessionByFile.get(normPath(sessionFile)) : undefined;
		if (!shown(sessionFile ?? undefined))
			openNow = saved && sessionFile ? { kind: "saved", file: sessionFile, session: saved } : { kind: "new" };
	}

	// What only All chats shows: running, or waiting on an answer (subagents count only when they ask).
	const others = { running: 0, asking: 0 };
	for (const c of conversations) {
		if (c.id === activeConversationId) continue;
		if (!c.isSubagent && shown(c.sessionPath)) continue;
		if (asking(c)) others.asking += 1;
		else if (c.isStreaming && !c.isSubagent) others.running += 1;
	}
	for (const w of elsewhere) {
		if (shown(w.sessionFile)) continue;
		if (w.hasQuestion) others.asking += 1;
		else if (w.isStreaming) others.running += 1;
	}
	return { leads, openNow, others };
}
