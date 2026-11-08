/**
 * Local control socket for the pi-web-ui server.
 *
 * Lets the CLI (and humans) query status and quiesce/unquiesce the server
 * WITHOUT opening a network port or exposing an unauthenticated HTTP
 * endpoint. Only the local OS user can reach it:
 *   - POSIX: a mode-0600 Unix domain socket at <dataDir>/pi-web-ui.sock
 *   - Windows: a named pipe  \\.\pipe\pi-web-ui-<port>
 *
 * Protocol: one JSON object per line.
 *   → {"cmd":"status"}        ← {"ok":true, ...serviceStatus}
 *   → {"cmd":"quiesce"}       ← {"ok":true}
 *   → {"cmd":"unquiesce"}     ← {"ok":true}
 *   → {"cmd":"role_report","token":"<app token>","role":"design","date":"YYYY-MM-DD","activity":{...}}
 *                             ← {"ok":true,"receipt":{...},"existing":false,"paused":false}
 *     role-reports: only the app's 6 am report job (it shows <dataDir>/app-token); once per role and day.
 *   → {"cmd":"role_reports","date":"YYYY-MM-DD"}  ← {"ok":true,"receipts":[...]} (no text)
 *   → {"cmd":"ci_alert","token":"<app token>","role":"ops","alert":{"kind":"failed","repo":"o/n",...}}
 *                             ← {"ok":true,"id":"rm-…","duplicate":false}
 *     ci-alert (Ops #720): the CI watch tells a role's home chat about a CI run; checked fields only, one per
 *     key (docs/ci-alert.md).
 *   → {"cmd":"script_notice","token":"<app token>","role":"rollcall","kind":"fyi"|"request",
 *      "sender":{"id":"rollcall-cd","title":"RollCall deployer"},"text":"...","key":"..."(optional)}
 *                             ← {"ok":true,"id":"rm-…","duplicate":false}
 *     script-notice (Ops #782): a script on this machine tells a role's home chat something; an fyi adds it without
 *     a turn, a request starts one; one per sender, role and key (docs/script-notice.md).
 *   → {"cmd":"telegram_send","token":"<app token>","text":"...","from":"...","url":"...","linkLabel":"..."}
 *                             ← {"ok":true,"messageIds":[901]} | {"ok":false,"error":"...","maybeSent":true?}
 *     owner-telegram (Ops #783): a script on this machine sends the owner a Telegram message through the Telegram
 *     plugin's own telegram_send tool; answered once the tool has sent it or refused (docs/script-notice.md).
 *   → {"cmd":"decisions_backfill","date":"YYYY-MM-DD"}  ← {"ok":true,"decisions":{...}} (starts it in the
 *     background; decision-records, task #83)
 *   → {"cmd":"decisions_status"}  ← {"ok":true,"decisions":{file, backfill, counts, reader, decisions}}
 *   → {"cmd":"decisions_read","maxBatches":N}  ← {"ok":true,"decisions":{started}} (the decision reader reads
 *     now, in the background, within its settings and daily cap; initiatives-page, task #84)
 *   → {"cmd":"feed_status"}  ← {"ok":true,"feed":{settings, <initiative>: {lead, updates, unlinked, open, ...}}}
 *   → {"cmd":"feed_catch_up","initiative":"team-in-temper","date":"YYYY-MM-DD"}  ← {"ok":true,"feed":{id,unlinked}}
 *     (progress-feed, task #85: the one-time catch-up ask to the initiative's lead, from that day on)
 *   → {"cmd":"stall_list"}  ← {"ok":true,"stall":{mode, settings, running, rounds, at, tookMs, findings, items}}
 *     (stall-watch, Ops #283: the stall check's last round; read only)
 *   → anything else           ← {"ok":false,"error":"..."}
 *
 * Idle connections are closed after a short timeout so a stuck CLI never
 * holds the socket.
 */
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync } from "node:fs";
import type { AgentService } from "./agent-service.js";
import { isAppToken } from "./app-token.js";
import { askControl, controlPath } from "./control-client.js";
import { checkOwnerTelegram, type OwnerTelegramNotice, type OwnerTelegramResult } from "./owner-telegram.js";
import type { UiServiceInfo } from "./protocol.js";
import type { RoleReportReceipt } from "./role-messages.js";
import { parseRecoveryCommand } from "./decision-recovery.js";
import type { SchedulerWakeJob, SchedulerWakeResult } from "./scheduler-tasks.js";

/** 探测既有 socket 的超时：活实例对 connect 的响应是内核级的，300ms 足够。 */
const CONTROL_PROBE_TIMEOUT_MS = 300;

/** 控制路径探测：连得上（有活实例在 listen）→ null；失败 → errno
 *  （ECONNREFUSED/ENOENT = 崩溃残留，可安全删除）。超时按「可能是活实例」
 *  保守处理，返回超时码 —— 宁可不删残留也别摘掉正在服务的 socket。 */
function probeControlPath(path: string): Promise<string | null> {
	return new Promise((resolve) => {
		const sock = createConnection(path);
		let settled = false;
		const finish = (result: string | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish("ETIMEDOUT"), CONTROL_PROBE_TIMEOUT_MS);
		sock.once("connect", () => finish(null));
		sock.once("error", (err: NodeJS.ErrnoException) => finish(err.code ?? "EUNKNOWN"));
	});
}

/** 控制 socket 只需服务状态与 quiesce 控制（pi/dsh 引擎都满足）。role-reports: the report requests
 *  (pi engine only). */
type ControlService = Pick<AgentService, "serviceStatus" | "quiesce" | "unquiesce"> &
	Partial<
		Pick<
			AgentService,
			| "requestRoleReport"
			| "roleReportReceipts"
			| "noteRoleReportRefused"
			| "requestCiAlert"
			| "noteCiAlertRefused"
			| "requestScriptNotice"
			| "noteScriptNoticeRefused"
			| "decisionsBackfill"
			| "decisionsStatus"
			| "decisionsRead"
			| "decisionsRecoverCall"
			| "feedStatus"
			| "feedCatchUp"
			| "stallList"
		>
	>;

/** script-notice: the keys script_notice takes (any other is refused). */
const SCRIPT_NOTICE_KEYS: readonly string[] = ["cmd", "token", "role", "kind", "sender", "text", "key"];

/** How long a control connection may sit idle before the server closes it. */
const CONTROL_IDLE_TIMEOUT_MS = 5_000;

/** How long the CLI waits for a reply before giving up. */
const CONTROL_CLIENT_TIMEOUT_MS = 3_000;

/** Socket path (POSIX) or pipe name (Windows); in control-client.ts since Ops #783, where the CLI reads it too. */
export { controlPath };

export interface ControlCommand {
	cmd:
		| "status"
		| "quiesce"
		| "unquiesce"
		| "role_report"
		| "role_reports"
		| "ci_alert"
		| "script_notice"
		| "telegram_send"
		| "scheduler_wake"
		| "decisions_backfill"
		| "decisions_status"
		| "decisions_read"
		| "decisions_recover_call"
		| "feed_status"
		| "feed_catch_up"
		| "stall_list";
	/** feed_catch_up: the initiative (date = the day it covers from). */
	initiative?: unknown;
	/** decisions_recover_call: fixed operation metadata, never supplied proof/approval. */
	recovery?: unknown;
	/** decisions_read: at most this many calls. */
	maxBatches?: unknown;
	/** role-reports: role_report's app token, role, day and what the job found; role_reports' day. */
	token?: unknown;
	role?: unknown;
	date?: unknown;
	activity?: unknown;
	/** ci-alert: ci_alert's alert (ci-alert.ts checkCiAlert); with token and role. */
	alert?: unknown;
	/** script-notice: script_notice's fields (script-notice.ts checkScriptNotice); with token and role. */
	kind?: unknown;
	sender?: unknown;
	text?: unknown;
	key?: unknown;
	/** owner-telegram (Ops #783): telegram_send's optional fields (owner-telegram.ts checkOwnerTelegram); with token
	 *  and text. */
	from?: unknown;
	url?: unknown;
	linkLabel?: unknown;
	/** scheduler-wake (Ops #788): wake job payload from pi-scheduler daemon; with token. */
	job?: unknown;
}

export interface ControlStatus {
	ok: boolean;
	error?: string;
	/** serviceStatus fields, present on "status". */
	pid?: number;
	version?: string;
	cwd?: string;
	quiesced?: boolean;
	quiescedSince?: number;
	connectedClients?: number;
	activeConversations?: number;
	pendingMessages?: number;
	/** 托管本实例的平台服务（null = 前台/dev/Docker）——CLI 显示启动方式。 */
	service?: UiServiceInfo | null;
	/** role-reports: role_report's request (new or the day's first), and whether delivery is paused. */
	receipt?: RoleReportReceipt;
	existing?: boolean;
	paused?: boolean;
	/** role-reports: role_reports' receipts. */
	receipts?: RoleReportReceipt[];
	/** ci-alert, script-notice: the record, and whether it was already sent (the key's first record). */
	id?: string;
	duplicate?: boolean;
	/** owner-telegram (Ops #783): telegram_send's Telegram message ids; on a refusal, whether it may have gone out. */
	messageIds?: number[];
	maybeSent?: true;
	/** scheduler-wake (Ops #788): wake outcome and rebound conversation/sessionFile. */
	action?: string;
	conversationId?: string;
	sessionFile?: string;
	summary?: string;
	retryable?: boolean;
	noLiveConversation?: boolean;
	/** decision-records: decisions_backfill's progress, or decisions_status. */
	decisions?: unknown;
	/** progress-feed: feed_status, or what feed_catch_up sent. */
	feed?: unknown;
	/** stall-watch (Ops #283): stall_list's last round. */
	stall?: unknown;
}

/** Start the control socket; returns a stop function. */
export function startControlServer(opts: {
	service: ControlService;
	dataDir: string;
	port: number;
	/** role-reports: the app's token (app-token.ts); none = role_report is refused. */
	appToken?: string;
	/** owner-telegram (Ops #783): sends the owner one checked Telegram message (index.ts: the Telegram plugin's
	 *  telegram_send tool); none = telegram_send is refused. */
	ownerTelegram?: (notice: OwnerTelegramNotice) => Promise<OwnerTelegramResult>;
	/** scheduler-wake (Ops #788): wakes a bound chat on behalf of the pi-scheduler daemon. */
	schedulerWake?: (job: SchedulerWakeJob) => Promise<SchedulerWakeResult>;
	/** How long a connection may sit idle with no answer pending (default CONTROL_IDLE_TIMEOUT_MS; tests shorten it). */
	idleTimeoutMs?: number;
}): () => void {
	const { service, dataDir, port, appToken, ownerTelegram, schedulerWake } = opts;
	const idleTimeoutMs = opts.idleTimeoutMs ?? CONTROL_IDLE_TIMEOUT_MS;
	const path = controlPath(dataDir, port);
	let server: Server;
	// 只有本实例真正 bind 成功才允许 stop 时删 socket 文件：探测发现活实例而
	// listen 失败时，path 上是对方的 socket，删了会让后续客户端全部失联。
	let bound = false;

	if (process.platform === "win32") {
		// Windows named pipe 不落盘（最后一个句柄关闭即消失），不存在崩溃残留
		// 文件可清理；撞上活实例时 listen 直接 EADDRINUSE，走下方统一 error
		// 处理。无需探测。
		server = createServer(handleConnection);
		server.listen(path, () => {
			bound = true;
			console.log(`  control    : ${path}`);
		});
	} else {
		server = createServer(handleConnection);
		// POSIX socket 文件崩溃后会残留，但先探测再删：无条件 rmSync 会把正在
		// 服务的实例（比如被新的 pi-web 抢占前仍在跑的旧实例）的 socket 文件摘
		// 走，新旧实例互相踩。只有连不上的残留（ECONNREFUSED/ENOENT）才删；
		// 探测超时保守当作活实例，让 listen 自己以 EADDRINUSE 失败告警。
		void probeControlPath(path).then((probeErr) => {
			if (probeErr && existsSync(path)) {
				try {
					rmSync(path);
				} catch {
					/* best-effort */
				}
			}
			server.listen(path, () => {
				bound = true;
				try {
					chmodSync(path, 0o600);
				} catch {
					/* best-effort */
				}
				console.log(`  control    : ${path}`);
			});
		});
	}
	// A second instance on the same data dir / port would fail to bind — don't
	// crash the server over it, just log and run without a control socket.
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			console.warn(`[control] socket ${path} already in use — control socket disabled`);
		} else {
			console.warn(`[control] socket error: ${err.message}`);
		}
	});

	/** role-reports: the app's 6 am report job asks a role for its report (only with the app token). */
	function roleReport(req: ControlCommand): ControlStatus {
		if (!service.requestRoleReport || !service.roleReportReceipts) {
			return { ok: false, error: "report requests aren't supported here" };
		}
		const why = appTokenRefusal(req.token);
		if (why) {
			service.noteRoleReportRefused?.(req.role, req.date, why);
			return { ok: false, error: `refused: only the app's report job may ask for reports (${why})` };
		}
		const res = service.requestRoleReport({ role: req.role, date: req.date, activity: req.activity });
		if (!res.ok) return { ok: false, error: res.error };
		const receipt = service.roleReportReceipts(res.record.report?.date).find((x) => x.id === res.record.id);
		return { ok: true, ...(receipt ? { receipt } : {}), existing: res.existing, paused: res.paused };
	}

	/** Why a command that needs the app token is refused (no token, a wrong one), or undefined when it's the token. */
	function appTokenRefusal(token: unknown): string | undefined {
		if (appToken && isAppToken(token, appToken)) return undefined;
		return token === undefined ? "no app token" : "a wrong app token";
	}

	/** ci-alert (Ops #720): the CI watch tells a role's home chat about a CI run (only with the app token). */
	function ciAlert(req: ControlCommand): ControlStatus {
		if (!service.requestCiAlert) return { ok: false, error: "CI alerts aren't supported here" };
		const why = appTokenRefusal(req.token);
		if (why) {
			service.noteCiAlertRefused?.(req.role, why);
			return { ok: false, error: `refused: only the app's own jobs may send CI alerts (${why})` };
		}
		const extra = Object.keys(req).filter((k) => !["cmd", "token", "role", "alert"].includes(k));
		if (extra.length) return { ok: false, error: "ci_alert takes only cmd, token, role and alert" };
		const res = service.requestCiAlert({ role: req.role, alert: req.alert });
		return res.ok ? { ok: true, id: res.record.id, duplicate: res.duplicate } : { ok: false, error: res.error };
	}

	/** script-notice (Ops #782): a script on this machine tells a role's home chat something (only with the app
	 *  token). Any key it doesn't take is refused; never logs the token or the text. */
	function scriptNotice(req: ControlCommand): ControlStatus {
		if (!service.requestScriptNotice) return { ok: false, error: "script notices aren't supported here" };
		const why = appTokenRefusal(req.token);
		if (why) {
			service.noteScriptNoticeRefused?.(req.role, why);
			return {
				ok: false,
				error: `refused: only scripts on this machine with the app token may send script notices (${why})`,
			};
		}
		const extra = Object.keys(req).filter((k) => !SCRIPT_NOTICE_KEYS.includes(k));
		if (extra.length)
			return {
				ok: false,
				error: `script_notice takes only cmd, token, role, kind, sender, text and key (not ${extra.slice(0, 5).join(", ")})`,
			};
		const res = service.requestScriptNotice({
			role: req.role,
			kind: req.kind,
			sender: req.sender,
			text: req.text,
			...("key" in req ? { key: req.key } : {}),
		});
		return res.ok ? { ok: true, id: res.record.id, duplicate: res.duplicate } : { ok: false, error: res.error };
	}

	/** owner-telegram (Ops #783): a script on this machine sends the owner a Telegram message (only with the app
	 *  token). Answers once the Telegram plugin has sent it or refused; logs the outcome, never the token or text. */
	async function telegramSend(req: ControlCommand): Promise<ControlStatus> {
		if (!ownerTelegram) return { ok: false, error: "Telegram messages aren't supported here" };
		const why = appTokenRefusal(req.token);
		if (why) {
			console.warn(`[control] refused telegram_send: ${why}`);
			return {
				ok: false,
				error: `refused: only scripts on this machine with the app token may send Telegram messages (${why})`,
			};
		}
		const checked = checkOwnerTelegram(req as unknown as Record<string, unknown>);
		if (!checked.ok) return { ok: false, error: checked.error };
		let res: OwnerTelegramResult;
		try {
			res = await ownerTelegram(checked.notice);
		} catch (err) {
			res = { ok: false, error: `the send failed: ${(err as Error)?.message ?? String(err)}`, maybeSent: true };
		}
		if (res.ok) {
			console.log(`[control] telegram_send: sent to the owner as message ${res.messageIds.join(", ")}`);
			return { ok: true, messageIds: res.messageIds };
		}
		console.warn(`[control] telegram_send: ${res.error}${res.maybeSent ? " (it may have gone out)" : ""}`);
		return { ok: false, error: res.error, ...(res.maybeSent ? { maybeSent: true as const } : {}) };
	}

	/** scheduler-wake (Ops #788): the pi-scheduler daemon wakes a bound chat in pi-web-ui (only with the app token). */
	async function schedulerWakeCmd(req: ControlCommand): Promise<ControlStatus> {
		if (!schedulerWake) return { ok: false, error: "scheduler wake isn't supported here" };
		const why = appTokenRefusal(req.token);
		if (why) {
			console.warn(`[control] refused scheduler_wake: ${why}`);
			return {
				ok: false,
				error: `refused: only the scheduler daemon with the app token may wake chats (${why})`,
			};
		}
		const extra = Object.keys(req).filter((k) => !["cmd", "token", "job"].includes(k));
		if (extra.length) {
			return {
				ok: false,
				error: `scheduler_wake takes only cmd, token and job (not ${extra.slice(0, 5).join(", ")})`,
			};
		}
		const rawJob = req.job;
		if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob)) {
			return { ok: false, error: "scheduler_wake requires a job object" };
		}
		const j = rawJob as Record<string, unknown>;
		const name = String(j.name ?? "").trim();
		const prompt = String(j.prompt ?? j.target ?? "").trim();
		const cwd = String(j.cwd ?? "").trim() || process.cwd();
		const conversationId = String(j.conversationId ?? "").trim() || undefined;
		const sessionFile = String(j.sessionFile ?? "").trim() || undefined;
		if (!name) return { ok: false, error: "scheduler_wake job requires a name" };
		if (!prompt) return { ok: false, error: "scheduler_wake job requires a prompt/target" };
		try {
			return await schedulerWake({
				id: typeof j.id === "string" ? j.id.trim() : undefined,
				name,
				prompt,
				cwd,
				conversationId,
				sessionFile,
			});
		} catch (err) {
			return { ok: false, error: `scheduler_wake failed: ${(err as Error)?.message ?? String(err)}` };
		}
	}

	function handleConnection(sock: Socket): void {
		let buf = "";
		// owner-telegram (Ops #783): an answer that takes a while (telegram_send) keeps the connection open; answers
		// go out in the order their requests came.
		let waiting = 0;
		let answers: Promise<void> = Promise.resolve();
		const timer = setTimeout(function idle() {
			if (waiting > 0) {
				timer.refresh();
				return;
			}
			sock.destroy();
		}, idleTimeoutMs);
		const answer = (resp: ControlStatus | Promise<ControlStatus>): void => {
			if (!(resp instanceof Promise) && waiting === 0) {
				sock.write(JSON.stringify(resp) + "\n");
				return;
			}
			waiting++;
			answers = answers.then(async () => {
				let out: ControlStatus;
				try {
					out = await resp;
				} catch (err) {
					out = { ok: false, error: `failed: ${(err as Error)?.message ?? String(err)}` };
				}
				waiting--;
				timer.refresh();
				if (!sock.destroyed) sock.write(JSON.stringify(out) + "\n");
			});
		};
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				timer.refresh();
				let req: ControlCommand;
				try {
					req = JSON.parse(line) as ControlCommand;
				} catch {
					answer({ ok: false, error: "bad json" });
					continue;
				}
				let resp: ControlStatus | Promise<ControlStatus>;
				switch (req.cmd) {
					case "status":
						resp = { ok: true, ...service.serviceStatus() };
						break;
					case "quiesce":
						service.quiesce();
						resp = { ok: true };
						break;
					case "unquiesce":
						service.unquiesce();
						resp = { ok: true };
						break;
					case "role_report":
						resp = roleReport(req);
						break;
					case "ci_alert":
						resp = ciAlert(req);
						break;
					case "script_notice":
						resp = scriptNotice(req);
						break;
					case "telegram_send":
						resp = telegramSend(req);
						break;
					case "scheduler_wake":
						resp = schedulerWakeCmd(req);
						break;
					case "role_reports":
						resp = service.roleReportReceipts
							? { ok: true, receipts: service.roleReportReceipts(typeof req.date === "string" ? req.date : undefined) }
							: { ok: false, error: "report requests aren't supported here" };
						break;
					case "decisions_backfill": {
						if (!service.decisionsBackfill) {
							resp = { ok: false, error: "decision records aren't kept here" };
							break;
						}
						const res = service.decisionsBackfill(req.date);
						resp = res.ok ? { ok: true, decisions: res.progress } : { ok: false, error: res.error };
						break;
					}
					case "decisions_read": {
						if (!service.decisionsRead) {
							resp = { ok: false, error: "this engine has no decision reader" };
							break;
						}
						const res = service.decisionsRead(req.maxBatches);
						resp = res.ok ? { ok: true, decisions: { started: res.started } } : { ok: false, error: res.error };
						break;
					}
					case "decisions_recover_call": {
						const command = parseRecoveryCommand(req.recovery);
						if (!command || Object.keys(req).some((key) => !["cmd", "recovery"].includes(key))) {
							resp = { ok: false, error: "invalid recovery operation binding" };
							break;
						}
						if (!service.decisionsRecoverCall) {
							resp = { ok: false, error: "decision reader control unavailable" };
							break;
						}
						const result = service.decisionsRecoverCall(command);
						resp = result.ok ? { ok: true, decisions: result } : { ok: false, error: result.error };
						break;
					}
					case "decisions_status":
						resp = service.decisionsStatus
							? { ok: true, decisions: service.decisionsStatus() }
							: { ok: false, error: "decision records aren't kept here" };
						break;
					case "feed_status":
						resp = service.feedStatus
							? { ok: true, feed: service.feedStatus() }
							: { ok: false, error: "this engine has no progress feed" };
						break;
					case "feed_catch_up": {
						if (!service.feedCatchUp) {
							resp = { ok: false, error: "this engine has no progress feed" };
							break;
						}
						const res = service.feedCatchUp(req.initiative, req.date);
						resp = res.ok
							? { ok: true, feed: { id: res.id, unlinked: res.unlinked } }
							: { ok: false, error: res.error };
						break;
					}
					case "stall_list": {
						const list = service.stallList?.();
						resp = list ? { ok: true, stall: list } : { ok: false, error: "the stall check isn't running here" };
						break;
					}
					default:
						resp = { ok: false, error: `unknown cmd: ${String((req as { cmd?: unknown }).cmd)}` };
						break;
				}
				answer(resp);
			}
		});
		sock.on("error", () => {
			/* client vanished */
		});
		sock.on("close", () => clearTimeout(timer));
	}

	return () => {
		server.close();
		try {
			if (process.platform !== "win32" && bound && existsSync(path)) rmSync(path);
		} catch {
			/* best-effort */
		}
	};
}

/**
 * CLI-side client: send one command and return the parsed reply (or null if
 * the server is unreachable / timed out). On askControl (control-client.ts) since Ops #783.
 */
export async function sendControlCommand(
	dataDir: string,
	port: number,
	cmd: ControlCommand["cmd"],
	extra: Omit<ControlCommand, "cmd"> = {},
): Promise<ControlStatus | null> {
	const out = await askControl(controlPath(dataDir, port), { ...extra, cmd }, CONTROL_CLIENT_TIMEOUT_MS);
	return out.state === "answered" ? (out.answer as unknown as ControlStatus) : null;
}
