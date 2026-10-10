/**
 * quiet-turns (task #96): which turns of a chat another agent began, so the page shows each as one closed
 * row and the owner gets nothing to read from it. The owner (2026-10-10, relayed by COO in rm-37872561):
 * "the response should be sent to the agent only if needed or just don't respond at all".
 *
 * A turn ("run") is quiet when every message that started or joined it is agent-sent: a message from
 * another role (question, request, reply, fyi), an order the Board sent the chat directly, and, when the
 * owner's switch for them is on, a finished queue task waking its main chat, a stall-check poke and a
 * scheduled wake-up. Never quiet: anything the owner typed (browser, Telegram), a reply that answers a
 * question asked for him (the server's stamp says forOwner), the app's 6 am report request, plugin sends
 * (the morning brief). Display only: nothing here changes a transcript.
 *
 * A pure function over a chat's messages plus the server's role-message stamps, so old chats fold too.
 * No Node imports: the page bundles it (web/src/quiet-turns.ts), the server uses it for notifications,
 * unread marks and the digests of turns before the page's window (server/agent-service.ts).
 */
import type { UiQuietKind, UiQuietRun, UiQuietSent } from "./protocol.js";

export type QuietKind = UiQuietKind;
export type QuietSent = UiQuietSent;

/** The owner's switches for the kinds he decides on (UiSettings quietQueueWakes, quietStallPokes,
 *  quietScheduledWakes). Absent = off = shown in full. */
export interface QuietSwitches {
	queueWakes?: boolean;
	stallPokes?: boolean;
	scheduledWakes?: boolean;
}

/** What the server's store says about a role message in this chat (UiRoleMessage): its kind, and whether
 *  it is a reply answering a question asked for the owner. null/absent: no record (the store keeps the
 *  newest 1,000), so the header alone decides. */
export interface QuietStamp {
	kind: string;
	forOwner?: boolean;
}

export interface QuietCall {
	id: string;
	name: string;
	/** The call's arguments: an object (the transcript) or JSON text, maybe cut short (the page). */
	args?: unknown;
}

/** One chat message, as far as this file needs it (adapters: quietMsgOfAgent below, web/src/quiet-turns.ts). */
export interface QuietMsg {
	role: string;
	customType?: string;
	/** A user or custom message's text. */
	text?: string;
	stamp?: QuietStamp | null;
	/** An assistant message's stop reason ("toolUse" = more of the turn follows). */
	stopReason?: string;
	/** An assistant message's tool calls. */
	calls?: QuietCall[];
	/** A tool result: which call, whether it failed, and its details (queue_add's { accepted, id }). */
	toolCallId?: string;
	isError?: boolean;
	details?: unknown;
}

export interface QuietRun {
	/** The message that began the run (its row); -1 when it began before these messages (see QuietLead). */
	row: number;
	/** First and last message of the run, inclusive. */
	start: number;
	last: number;
	/** What agents sent that started or joined it. */
	kinds: QuietKind[];
	/** Something shown in full started or joined it (the owner's own message, a forOwner reply, the 6 am
	 *  report request, a plugin send, an app notice that began a turn). */
	visible: boolean;
	/** Incoming messages that joined it after the first. */
	joined: number;
	/** What it sent: messages to roles, Board acks, queued tasks... (only calls that didn't fail). */
	sent: QuietSent[];
	/** Its last answer failed or was stopped. */
	ended?: "error" | "aborted";
	/** No final answer yet at the end of these messages. */
	running: boolean;
	/** Messages in it that carry something for the owner (a question dialog, a Needs-you item): shown
	 *  outside the fold, only those calls. */
	keep: number[];
}

/** The run the messages begin inside of, when they don't begin where it began (the page's window start). */
export interface QuietLead {
	kinds: QuietKind[];
	visible: boolean;
}

/** What a stall-check poke starts with (#87's stall_poke sends it as a role message). */
export const STALL_CHECK_PREFIX = "[Stall check] ";
/** The words a forOwner reply's hint line carries (server/role-messages.ts roleMessageHint). */
export const FOR_OWNER_HINT = "This answers a question you asked for the owner";

const RM = "rm-[0-9a-f]{8}";
const ROLE_HEAD = new RegExp(
	`^\\[Role message ${RM} from [a-z0-9][a-z0-9._-]* \\(.*\\), sent from its .* \\u00b7 (?:question|request|fyi|reply to ${RM}|reply)\\]$`,
);
const REPORT_HEAD = new RegExp(`^\\[Role message ${RM} from the app \\u00b7 6 am report \\u00b7 [^\\]]+\\]$`);
/** pi-queue's wake-on-done notices (queue.ts wakeOnDoneText, #88). */
const QUEUE_WAKE = /^\[Queue\] (?:Task #\d+ \(.*\) is done in its chat |\d+ tasks are done in their chats:)/;

type Starter = { kind: QuietKind } | "visible" | "neutral";

/** What a message does to a turn when it starts or joins one. "neutral": joins without changing what the
 *  turn is (pi-web-ui's own notices, custom entries); "visible": the owner's, or something he reads. */
export function starterOf(m: QuietMsg): Starter {
	if (m.role === "bashExecution") return "visible";
	if (m.role !== "user") return "neutral";
	const text = m.text ?? "";
	if (text.startsWith("[Role message ")) return roleStarter(text, m.stamp);
	if (text.startsWith("[Board order bp-")) return { kind: "board-order" };
	if (text.startsWith("[Queue] ")) return QUEUE_WAKE.test(text) ? { kind: "queue-wake" } : "visible";
	// server/index.ts and agent-service.ts chatFromScheduler deliver a wake-up as "[Scheduled task <name>] <prompt>";
	// older builds wrote "[定时任务".
	if (text.startsWith("[Scheduled task") || text.startsWith("[定时任务")) return { kind: "scheduled" };
	if (text.startsWith("(System") || text.startsWith("（系统")) return "neutral";
	return "visible";
}

function roleStarter(text: string, stamp: QuietStamp | null | undefined): Starter {
	const nl = text.indexOf("\n");
	const head = (nl === -1 ? text : text.slice(0, nl)).trimEnd();
	const body = nl === -1 ? "" : text.slice(nl + 1).replace(/^\n+/, "");
	if (stamp) {
		if (stamp.kind === "report" || stamp.forOwner) return "visible";
	} else {
		if (REPORT_HEAD.test(head)) return "visible";
		const cut = text.lastIndexOf("\n\n");
		const hint = cut === -1 ? "" : text.slice(cut + 2);
		if (hint.startsWith("(The answer to your message") && hint.includes(FOR_OWNER_HINT)) return "visible";
	}
	if (body.startsWith(STALL_CHECK_PREFIX)) return { kind: "stall-poke" };
	// No record and no header the server writes: not something the app knows came from a role.
	if (!stamp && !ROLE_HEAD.test(head)) return "visible";
	return { kind: "role" };
}

/** Is this run folded, under the owner's switches? */
export function quietUnder(run: { kinds: readonly QuietKind[]; visible?: boolean }, sw: QuietSwitches = {}): boolean {
	if (run.visible || run.kinds.length === 0) return false;
	return run.kinds.every(
		(k) =>
			k === "role" ||
			k === "board-order" ||
			(k === "queue-wake" && !!sw.queueWakes) ||
			(k === "stall-poke" && !!sw.stallPokes) ||
			(k === "scheduled" && !!sw.scheduledWakes),
	);
}

function newRun(row: number, start: number, starter: Starter | null): QuietRun {
	const kind = starter && typeof starter === "object" ? starter.kind : undefined;
	return {
		row,
		start,
		last: start,
		kinds: kind ? [kind] : [],
		visible: starter === "visible" || starter === "neutral",
		joined: 0,
		sent: [],
		running: false,
		keep: [],
	};
}

/**
 * The runs in these messages, oldest first. A run begins at a message from outside (a user message) when
 * the chat isn't in a turn, and takes everything up to its last answer: tool calls and results, messages
 * steered into it, retries. Custom entries (notes, FYIs) after its last answer stay outside it.
 * `lead`: these messages begin inside a run that began earlier.
 */
export function planQuietRuns(msgs: readonly QuietMsg[], lead?: QuietLead): QuietRun[] {
	const runs: QuietRun[] = [];
	let cur: QuietRun | null = null;
	// open: the run waits for more of itself (a tool result, the next answer, a message steered into it).
	let open = false;
	const calls = new Map<string, { run: QuietRun; call: QuietCall }>();
	if (lead) {
		cur = { ...newRun(-1, 0, null), kinds: [...lead.kinds], visible: lead.visible };
		runs.push(cur);
		open = true;
	}
	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i];
		if (m.role === "user") {
			const s = starterOf(m);
			if (cur && open) {
				cur.last = i;
				if (s === "visible") cur.visible = true;
				else if (s !== "neutral") {
					if (!cur.kinds.includes(s.kind)) cur.kinds.push(s.kind);
					cur.joined++;
				}
			} else {
				cur = newRun(i, i, s);
				runs.push(cur);
				open = true;
			}
		} else if (m.role === "bashExecution") {
			// the owner's own `!` command: never part of a turn (pi runs it between turns)
			cur = null;
			open = false;
		} else if (m.role === "assistant") {
			if (!cur) {
				cur = newRun(i, i, "visible");
				runs.push(cur);
			}
			cur.last = i;
			let kept = false;
			for (const c of m.calls ?? []) {
				calls.set(c.id, { run: cur, call: c });
				if (!kept && ownerFacing(c)) {
					cur.keep.push(i);
					kept = true;
				}
			}
			if (m.stopReason === "toolUse") open = true;
			else {
				open = false;
				cur.ended = m.stopReason === "error" ? "error" : m.stopReason === "aborted" ? "aborted" : undefined;
			}
		} else if (m.role === "toolResult") {
			if (!cur) {
				cur = newRun(i, i, "visible");
				runs.push(cur);
			}
			cur.last = i;
			open = true;
			const c = calls.get(m.toolCallId ?? "");
			if (c && !m.isError) {
				const s = sentOf(c.call, m);
				if (s) addSent(c.run.sent, s);
			}
		} else if (cur && open) {
			cur.last = i;
		}
	}
	if (cur && open) cur.running = true;
	return runs;
}

/** The run that message `i` is in, or null (runs as planQuietRuns gives them). */
export function runAt(runs: readonly QuietRun[], i: number): QuietRun | null {
	let lo = 0;
	let hi = runs.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const r = runs[mid];
		if (i < r.start) hi = mid - 1;
		else if (i > r.last) lo = mid + 1;
		else return r;
	}
	return null;
}

/** Were the runs that the agent's last run touched (messages from `from` on) all quiet? The server asks
 *  this when a run ends, to leave out the turn-finished cue and the unread mark. */
export function quietSince(msgs: readonly QuietMsg[], from: number, sw: QuietSwitches = {}): boolean {
	const touched = planQuietRuns(msgs).filter((r) => r.last >= from);
	return touched.length > 0 && touched.every((r) => quietUnder(r, sw));
}

/** Each thing counts once ("replied to coo" twice is one item). */
export function sentKey(s: QuietSent): string {
	switch (s.t) {
		case "message":
			return `message:${s.kind}:${s.to}`;
		case "ack":
		case "close":
			return `${s.t}:${s.id}`;
		case "queued":
			return `queued:${s.n ?? ""}`;
		case "plan":
		case "answered":
		case "passed":
			return `${s.t}:${s.n}`;
		default:
			return s.t;
	}
}

/** `into` plus `s`, unless it is there already. */
export function addSent(into: QuietSent[], s: QuietSent): void {
	const k = sentKey(s);
	if (!into.some((x) => sentKey(x) === k)) into.push(s);
}

function str(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && /^#?\d+$/.test(v.trim())) return Number(v.trim().replace(/^#/, ""));
	return undefined;
}

/** A call's arguments as an object: the transcript has one; the page has JSON text, which may be cut
 *  short (a long call) or still arriving, so the fields this file reads are picked out one by one then. */
export function argsOf(args: unknown): Record<string, unknown> {
	if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
	if (typeof args !== "string" || !args) return {};
	try {
		const v = JSON.parse(args) as unknown;
		if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
	} catch {
		// cut short: read the fields that are there
	}
	const out: Record<string, unknown> = {};
	const re = /"(to|kind|action|id|answer|question|needs_you)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+|true|false)/g;
	for (let m = re.exec(args); m; m = re.exec(args)) {
		if (m[1] in out) continue;
		try {
			out[m[1]] = JSON.parse(m[2]) as unknown;
		} catch {
			// a half-read string: leave it out
		}
	}
	return out;
}

/** Calls whose card is for the owner: shown outside a closed row. */
export function ownerFacing(call: QuietCall): boolean {
	if (call.name === "ask_user_question" || call.name === "queue_stuck") return true;
	if (call.name !== "tldr" && call.name !== "queue_reply") return false;
	const a = argsOf(call.args);
	if (call.name === "tldr") return a.needs_you === true;
	return !str(a.answer) && !!str(a.question);
}

/** What a call that didn't fail sent, for the row; null for the rest (reads, edits, shell...). */
export function sentOf(call: QuietCall, result: Pick<QuietMsg, "details">): QuietSent | null {
	const a = argsOf(call.args);
	switch (call.name) {
		case "message_role": {
			const to = str(a.to);
			return to ? { t: "message", kind: str(a.kind) || "fyi", to } : null;
		}
		case "board": {
			const action = str(a.action);
			if (action === "ack") return { t: "ack", id: str(a.id) };
			if (action === "close") return { t: "close", id: str(a.id) };
			if (action === "post") return { t: "post" };
			return null;
		}
		case "queue_add": {
			const n = num(a.id);
			if (n !== undefined) return { t: "plan", n };
			const d = result.details as { accepted?: unknown; id?: unknown } | undefined;
			if (d && d.accepted === false) return null;
			const id = num(d?.id);
			return id !== undefined ? { t: "queued", n: id } : { t: "queued" };
		}
		case "queue_reply": {
			const n = num(a.id);
			if (n === undefined) return null;
			return str(a.answer) ? { t: "answered", n } : { t: "passed", n };
		}
		case "queue_done":
			return { t: "done" };
		default:
			return null;
	}
}

/** What the server tells the page about a run it hasn't loaded (a digest's turn, the window's lead). */
export function runInfo(run: QuietRun, extra: Partial<UiQuietRun> = {}): UiQuietRun {
	return {
		kinds: [...run.kinds],
		...(run.visible ? { visible: true } : {}),
		sent: run.sent.map((s) => ({ ...s })),
		...(run.joined ? { joined: run.joined } : {}),
		...(run.ended ? { ended: run.ended } : {}),
		...(run.running ? { running: true } : {}),
		...extra,
	};
}

// ---------------------------------------------------------------------------
// transcript messages (the pi SDK's AgentMessage)
// ---------------------------------------------------------------------------

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const b of content) {
		if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
			const t = (b as { text?: unknown }).text;
			if (typeof t === "string") out += t;
		}
	}
	return out;
}

/** A transcript message (AgentMessage) as planQuietRuns reads it; `stampOf` gives the server's role-message
 *  stamp for a user message or FYI entry (RoleMessageService.stampForMessage). */
export function quietMsgOfAgent(raw: unknown, stampOf?: (m: unknown) => QuietStamp | null | undefined): QuietMsg {
	const m = (raw ?? {}) as {
		role?: unknown;
		customType?: unknown;
		content?: unknown;
		stopReason?: unknown;
		toolCallId?: unknown;
		isError?: unknown;
		details?: unknown;
	};
	const role = typeof m.role === "string" ? m.role : "";
	if (role === "user" || role === "custom") {
		const text = textOfContent(m.content);
		const stamp = text.startsWith("[Role message ") && stampOf ? stampOf(raw) : undefined;
		return {
			role,
			...(typeof m.customType === "string" ? { customType: m.customType } : {}),
			text,
			...(stamp ? { stamp } : {}),
		};
	}
	if (role === "assistant") {
		const calls: QuietCall[] = [];
		if (Array.isArray(m.content)) {
			for (const b of m.content) {
				const blk = b as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
				if (blk && blk.type === "toolCall" && typeof blk.id === "string" && typeof blk.name === "string") {
					calls.push({ id: blk.id, name: blk.name, args: blk.arguments });
				}
			}
		}
		return { role, ...(typeof m.stopReason === "string" ? { stopReason: m.stopReason } : {}), calls };
	}
	if (role === "toolResult") {
		return {
			role,
			...(typeof m.toolCallId === "string" ? { toolCallId: m.toolCallId } : {}),
			isError: m.isError === true,
			details: m.details,
		};
	}
	return { role };
}
