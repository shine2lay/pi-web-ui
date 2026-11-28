/** Canonical process-owned conversation state; type-only extraction, no alternate runtime owner. */
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { SubagentTemplate } from "./subagent-templates.js";
import type { ApprovalPolicy } from "./tool-approval.js";
import type { TerminalManager } from "./terminals.js";
import type { GoalStatus, UiMessage, UiTldrLine, UiTaskQueue, UiTooBig } from "./protocol.js";
import type { PendingCompaction } from "./compact-context-tool.js";
import type { RoleTurnRecord } from "./role-replies.js";
import type { ChatDialogs } from "./chat-dialogs.js";
import type { PromptReceipt } from "./prompt-ack.js";
import type { DurableSessionPort } from "./durable-session-port.js";
import type { ChatIndex, FoldedHistory, DurableSessionHandle } from "./agent-service.js";

/**
 * One open conversation (chat thread) of a client. Each conversation owns its
 * OWN AgentSessionRuntime, so starting a new chat or switching between chats
 * never interrupts another conversation's in-flight run.
 *
 * One process-owned conversation runtime, shared by all subscribing windows.
 */
export interface Conversation {
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	/** 这是子代理对话（左栏带「子代理」徽标；inMemory session，不进历史/resume）。 */
	isSubagent: boolean;
	/** 派发它的父对话 id（Running 面板嵌套用；顶层子代理为空）。 */
	parentId?: string;
	/** 子代理类型/角色展示名（explore/implement/review…）。 */
	subagentType?: string;
	/** 派发子代理时的原始 prompt（快照 SubagentSnapshot.prompt 的来源，按
	 *  SUBAGENT_PROMPT_SNAPSHOT_CAP 截断后下发，避免 list  payload 被长 prompt 撑大）。 */
	subagentPrompt?: string;
	/** 子代理模板带非空扩展白名单时为 true：插件/MCP 工具不进该会话（工厂期不注
	 *  册、refreshPluginTools 不补），与 skills/extensionsOverride 的白名单语义对齐。 */
	subagentBarsPluginTools?: boolean;
	/** 子代理派发时套用的模板快照（runtime factory 的 apply 参数）。forceReset
	 *  重建 runtime 时必须原样复用 —— 否则被看门狗强杀的子代理重建后会回落主
	 *  会话的 system prompt/技能/扩展白名单（模板形同虚设）。 */
	subagentTemplate?: SubagentTemplate;
	/** 子代理最近一次运行报错的文本（快照 error 字段的只读缓存位），消息内容不变 /
	 *  会话重建时保留，避免重复向主对话发 notice（subagentErrorNotified 是去重键）。 */
	subagentError?: string;
	/** 已就当前 subagentError 向主对话发过 notice 的错误文本（去重；文本变化时重置）。 */
	subagentErrorNotified?: string;
	/** 同行协作交接给的目标子代理 convId 列表（该子代理交接给谁）。 */
	peerHandoffTo?: string[];
	/** 同行协作接收自的来源子代理 convId 列表（谁交接给该子代理）。 */
	peerHandoffFrom?: string[];
	runtime: AgentSessionRuntime;
	session: AgentSession;
	cwd: string;
	createdAt: number;
	/** 触碰 sidecar 节流：上次写入时的消息条数（条数没涨就不写，不在热路径）。 */
	touchSidecarCount?: number;
	/** 真正的「后台运行 / 被保留」标记：被换到后台且仍在跑（或有保留态）时置位，
	 *  再次打开并离开（未继续对话）时清除（并释放 runtime）。
	 *  它在左栏「运行的对话」里的可见性还额外包括「当前对话 + 已经有内容」——
	 *  见 shownInRunningList（#140），那是纯展示口径，不改这个标记的语义。 */
	listed: boolean;
	/** A prompt was sent while this conversation was active (cleared whenever
	 *  it becomes active). A listed conversation that is displaced while idle
	 *  with this still false counts as "opened but not continued" and is
	 *  dismissed from the list. */
	promptedSinceActive: boolean;
	/** Last time this conversation became active — set_cwd picks the target
	 *  project's most recently active conversation. */
	lastActiveAt: number;
	/** Last time ANY SDK event arrived for this conversation — drives the
	 *  model-stall watchdog (#7): a run that produces no events at all for
	 *  STALL_NOTIFY_MS is probably a half-open API connection. */
	lastSdkEventAt: number;
	/** Agent 预设 id（standard/minimal/code/reader/ask；默认 standard）。 */
	agentPreset?: string;
	/** 预设已锁定（首轮用户发言后；空白会话可切换）。 */
	presetLocked?: boolean;
	/** 权限预设值（read-only/workspace-write-never/danger-full-access）。 */
	permissionPreset?: string;
	/** queue-lanes: the queue's pseudo client opened it (a task chat, or a chat opened for a queue
	 *  command). When that client moves on, only such chats are let go, never a user's chat. */
	openedByQueue?: boolean;
	/** 临时会话（inMemory，不落盘、不进历史、不占持久会话名额）。 */
	isEphemeral?: boolean;
	/** 本对话的审批放行策略（仅内存，不落盘）：allowAll = 「本对话全部允许」，
	 *  categories = 「允许同类」记住的规则档位。放在对话对象上而非 ClientSession：
	 *  手动过户搬的就是对话本体，策略跟着走；重启/新对话即恢复询问。 */
	approvalPolicy?: ApprovalPolicy;
	/** 派生源信息（若本会话是从另一会话的消息派生而来）。 */
	forkFrom?: {
		conversationId: string;
		messageId?: string;
		title?: string;
	};
	/** Set once the stall notice has been sent for the current silent period;
	 *  cleared on every SDK event and on each new prompt. */
	stallNoticed: boolean;
	/** Independent goal/review state for this conversation. */
	goal: GoalStatus;
	goalGeneration: number;
	goalReviewGeneration: number;
	/** Wizard execution is per conversation; dialog transport itself remains
	 * client-wide because the browser can display one dialog at a time. */
	wizardRunning: boolean;
	/** Session event subscription — events are routed to THIS conversation. */
	unsubscribe?: () => void;
	/** Monotonic sequence for message_delta/tool_delta pushes of this conversation —
	 *  a gap on the client triggers a get_state resync. */
	deltaSeq: number;
	/** PTYs belong to the conversation, not the browser socket or client. */
	terminals: TerminalManager;
	// Per-conversation serialization caches. Message ids derive from
	// (role, timestamp); two conversations can produce identical pairs, so
	// these must never be shared across conversations.
	msgIds: Map<string, number>;
	nextMsgId: number;
	uiMessageCache: Map<string, UiMessage>;
	lastMessagesSig: string;
	lastMessagesArray: UiMessage[];
	/** lazy-images: shown messages with their ids (see ChatIndex); display forms only for what is sent. */
	chatIndex?: ChatIndex;
	/** TL;DR 行的缓存（tldr-panel，见 ClientSession.tldrOf）：key = 会话 + 叶子，树没动就不重扫分支；
	 *  sig = 行 id 串，行没变就沿用同一个数组引用（emitSnapshotNow 靠引用判断要不要随 delta 重发）。 */
	tldrCache?: { key: string; sig: string; lines: UiTldrLine[] };
	/** identities: the chat's identity on its branch (see ClientSession.identityOf): the last `identity`
	 *  entry on the branch up to leafId (null = cleared, undefined = none written). A new leaf that grew from
	 *  leafId only needs the entries after it. */
	identityCache?: { sessionId: string; leafId: string | null; onBranch: string | null | undefined };
	/** 任务队列的缓存（queue-panel，见 ClientSession.taskQueueOf）：同 tldrCache。key 还带「装没装 pi-queue」，
	 *  sig = 整份 JSON，队列没变就沿用同一个对象。 */
	taskQueueCache?: { key: string; sig: string; queue: UiTaskQueue };
	/** telegram-answers: what was last sent into this chat and when (ClientSession.prompt), so a stuck
	 *  queued task answered by typing in the chat can say what the answer was. */
	lastPrompt?: { text: string; at: number };
	/** Actual queued prompt TEXTS (steer = 插队, followUp = 排队) — the UI
	 *  renders them as pending bubbles in the real message list. */
	queueSteering: string[];
	queueFollowUp: string[];
	/** tool_execution_start timestamps keyed by toolCallId — lets tool_status
	 *  report how long a tool actually ran (vs. waiting on the model). */
	toolStartTimes: Map<string, number>;
	/** LLM 瞬时报错自动重试进行中（agent_end willRetry 占位 → auto_retry_start
	 *  填实 → auto_retry_end 清除）。置位期间快照隐藏末尾的 stopReason=error
	 *  assistant 消息（重试成功则用户永远看不到，耗尽才永久标红），前端改显
	 *  温和的「正在重试」条，而非一闪而过的红色报错。 */
	retryState?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null;
	/** fast-mode: retryState is the placeholder for a refused fast reply being retried at normal
	 *  speed (cleared by its reply, or at agent_settled if the retry never started). */
	fastRetrying?: boolean;
	/** AI 主动调 compact_context 登记的压缩请求（agent_settled 结算时执行）。 */
	pendingCompaction?: PendingCompaction | null;
	/** 上下文压缩进行中（compaction_start 已到、compaction_end 未到）。置位期间
	 *  快照携带 compaction 字段，前端在消息区常驻「压缩中…」进度条（toast 会
	 *  自动消失，而摘要 LLM 调用可能持续数十秒）；结束/失败/取消时清除。 */
	compactionState?: { reason: string; startedAt: number } | null;
	/** 最近一次压缩成功的 estimatedTokensAfter（SDK 自算的压缩后上下文大小）。
	 *  压缩后 SDK getContextUsage() 故意报 null（压缩前的 usage 不可信），
	 *  下轮模型响应前快照用此值回填；开始下一次压缩时清掉。 */
	lastCompactionTokens?: number | null;
	/** acp-fold: the compaction now running started without the window being told yet; the progress bar
	 *  and the pending marker come after FOLD_QUIET_MS, so a billion-context-pi fold (well under a second)
	 *  shows nothing and writes nothing. */
	compactionShowTimer?: ReturnType<typeof setTimeout> | null;
	/** acp-fold: the pending marker of the running compaction was written (clearCompactionPending has a
	 *  line to close). */
	compactionMarked?: boolean;
	/** acp-fold: the messages before the newest fold, for the window's "Show older messages". */
	foldedHistory?: FoldedHistory | null;
	/** 下一轮 agent_start 消费的用户任务文本（prompt() 暂存，轨迹插件的 run_start 用；
	 *  steer/内部续跑无暂存时为空，由插件回退为「继续执行」）。 */
	pendingTask?: string;
	/** telegram-coo: what the next run was started by (texts pi took before it starts; agent_start takes them). */
	turnPending?: RoleTurnRecord;
	/** telegram-coo: the running run's causes, send ids, last text and error (handed over when it settles). */
	turnRecord?: RoleTurnRecord;
	/** owner-input-time.ts: when the owner last wrote here (ms), by admission's clock. */
	ownerLastWroteAt?: number;
	/** quiet-turns: its last run was one another agent began (no "done" cue, no green light). */
	lastRunQuiet?: boolean;
	/** tool_call watchdog timers keyed by toolCallId — a tool that runs past
	 *  TOOL_WATCHDOG_TIMEOUT_MS gets the session aborted instead of hanging
	 *  the conversation forever (the SDK bash tool has no default timeout). */
	toolWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
	/** #280：转录链悬空标记——forceReset 后修复没落盘（文件被删/只读）时置位，
	 *  后续 prompt 响亮拒绝而不是静默黑洞；修复成功即清除。 */
	transcriptBlocked?: boolean;
	/** 工作区版本影子快照记录（Dual-State Rollback：时间戳/entryId -> snapshotRef）。 */
	workspaceSnapshots: Array<{ entryId?: string; timestamp: number; snapshotRef: string }>;
	/** 当前正在启动中（读取附件、视觉桥、快照准备等）的 prompt 取消控制器 */
	activePromptAc?: AbortController;
	/** 最近一次 LLM 响应定稿时的 Base Tokens（生效提示词 + 工具 Schema 占用）。
	 *  用于在对话中途切换预设或开关工具时计算上下文增量补偿。 */
	lastTurnBaseTokens?: number;
	/** per-chat-dialogs：这条对话的扩展弹窗（select/confirm/input）在等回答的，最早的在前。
	 *  只在看着这条对话的窗口里显示（快照的 UiState.dialog），左栏挂「?」。 */
	dialogs: ChatDialogs;
	/** rewind-to-here：「回到这里」进行中（navigateTree + 摘要 LLM 调用）。见 UiState.rewinding。 */
	rewinding?: { startedAt: number } | null;
	/** rewind-to-here：上一次请求因为对话太大被拒。见 UiState.tooBig。 */
	tooBig?: UiTooBig | null;
	/** rewind-to-here：回退进行中时是一个回退结束就 resolve 的 promise（这期间发来的话等它）。 */
	rewindDone?: Promise<void>;
	/** optimistic-send: resolves when the latest prompt sent to this chat has been admitted by the SDK
	 *  (its message started, got queued, or was refused). The next prompt waits for it, so two quick
	 *  sends can't both take the "not streaming" path while the first one is still in the add-ons'
	 *  "before the AI starts" step (the second used to fail with "Agent is already processing"). */
	promptAdmission?: Promise<void>;
	/** optimistic-send: messages on their way into this chat (from prompt() until pi takes them in or
	 *  refuses them; takePromptAdmission counts). Such a chat is busy: the add-ons' "before the AI
	 *  starts" step can take seconds, and a chat closed during it would lose the message. */
	sendsInFlight?: number;
	/** Serialized model changes (picker, cycle, All chats, restores): one writer per chat. */
	modelChangeTail?: Promise<unknown>;
	modelPinned?: boolean;
	/** optimistic-send: the receipt of the prompt whose user message is about to start a run. The
	 *  next user message_end of this chat is that message: its snapshot goes out, then this ack. */
	ackOnUserMessage?: PromptReceipt;
	/** Wave 3.4: active DurableSessionHandle when running on DurableSessionPort. */
	durableHandle?: DurableSessionHandle;
	/** Wave 3.4: active DurableSessionPort when running on DurableSessionPort. */
	durablePort?: DurableSessionPort;
}
