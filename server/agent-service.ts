/**
 * AgentService — wraps the pi SDK (@earendil-works/pi-coding-agent) for the web
 * frontend. Each browser client (identified by a persistent clientId) gets its
 * own AgentSessionRuntime, but sessions live in the SDK default per-project
 * directory (<agentDir>/sessions/--<cwd>--/) — the same transcript files the
 * pi CLI/TUI use — so every conversation of a folder shows up everywhere.
 *
 * Streaming model: the SDK emits AgentSessionEvents; we forward lightweight
 * `tool_delta` messages for live tool output and schedule throttled full-state
 * snapshots. The frontend is snapshot-driven (server is the source of truth),
 * so reconnects just re-request a snapshot.
 */
// MUST be the first import: rewrites the SDK's installed remote-catalog
// provider so built-in model lists follow the official pi.dev catalog
// wholesale (no union merge / no stale built-in leftovers).
import "./patch-remote-catalog.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	mkdirSync,
	watch,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createBashToolDefinition,
	createEditToolDefinition,
	createLocalBashOperations,
	createWriteToolDefinition,
	getAgentDir,
	SessionManager,
	VERSION,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionError,
	type SessionInfo,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BgServerTracker } from "./bg-servers.js";
import {
	ASK_USER_NO_CLIENT_ERROR,
	ASK_USER_NO_CLIENT_GRACE_MS,
	askDeliveryOnAsk,
	askDeliveryOnGraceExpiry,
	pickPendingQuestionForSnapshot,
	shouldCancelOnClientDispose,
} from "./ask-delivery.js";
import type { PendingQuestionEntry } from "./ask-delivery.js";
import {
	approvalAsk,
	approvalFrom,
	askHub,
	type AskMeta,
	dialogAsk,
	dialogValueFrom,
	FROM_BROWSER,
	NOT_WAITING,
	questionAnswersFrom,
	questionAsk,
	type AskResult,
	stuckAsk,
	stuckTextFrom,
	summarizeApproval,
	summarizeDialogValue,
	summarizeQuestionAnswers,
} from "./asks.js";
import { stuckGoneReason, stuckKey, stuckSig, stuckTarget, type StuckSource, wantedStuckAsks } from "./stuck-asks.js";
import { type AdoptCandidate, pickAdoptTarget } from "./attach-adopt.js";
import { describeError, errorMessage, planForLostActive } from "./crash-guard.js";
// list-freeze: message counts without getSessionStats() (which re-projects the whole context).
import { messageCountOf } from "./message-count.js";
import {
	checkAll as checkAllUpdates,
	collectTargets,
	compareVersions as compareSemver,
	detectPiSdkSplit,
	resolveNpmRegistry,
	sortUpdateItems,
	type UpdateItem,
} from "./update-check.js";
import { checkPluginUpdates } from "./plugin-updater.js";
import { isBundledInUse, sdkCopies } from "./sdk-origin.js";
import { hasActiveSubagentRun, hasPendingWaitSubscription, shouldRetainActive } from "./wait-subscription-scan.js";
import {
	type CarryOnPlan,
	newestInterrupted,
	planCarryOn,
	readRunningChatsFile,
	readTail,
	RESTART_REASON_FILE,
	RUNNING_CHATS_FILE,
	type RunningChat,
	RunningChats,
	stepFromTranscriptTail,
	takeRestartReason,
	toolDetail,
} from "./running-chats.js";
import {
	COMPACTION_PENDING_TYPE,
	looksLikeChainCorruption,
	makeCompactionMarkerId,
	repairSessionFile,
	type SessionFileRepair,
} from "./compaction-markers.js";
import {
	DANGLING_TOOL_RESULT_TEXT,
	DANGLING_TOOL_RESULT_TEXT_EN,
	findTailDanglingToolCalls,
	healDanglingToolCallFile,
} from "./dangling-tools.js";
import { contextMessagesOf, scanTranscriptFile, type TranscriptScan } from "./transcript-scan.js";
import { removeQueuedByIndexOrText } from "./queue-utils.js";
import type {
	PluginAgentTool,
	PluginChatRequest,
	PluginChatResult,
	PluginCommandDef,
	PluginConversationSnapshot,
	PluginRunEvent,
	PluginToolEvent,
} from "./plugins.js";
import { syncPluginToolsIntoSession } from "./plugins.js";
import {
	denialText,
	type GuardedToolName,
	type ToolPostEdit,
	type ToolPostRequest,
	type ToolPreRequest,
} from "./plugin-tool-guard.js";
import { SettingsService } from "./settings-service.js";
import { GoalService, buildDiffFingerprint } from "./goal-service.js";
import { MarkerService } from "./marker-service.js";
import { SlashCommandsService, parseSlash } from "./slash-commands.js";
import { ModelAdminService } from "./model-admin.js";
import { FilesService, MACHINE_ROOT, desktopDirWire, workspacePath } from "./files-service.js";
import {
	DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS,
	effectiveToolWatchdogMs,
	isExtensionDisabled,
	isExtensionEnabled,
	normalizeDisabledPluginTools,
	normalizePathKey,
	normalizeRetryMaxAttempts,
	normalizeSkillList,
	type PromptMode,
	ClientStateStore,
} from "./client-state.js";
import { resolveServerLang, type ServerLang } from "./i18n.js";
import { SubagentTemplatesStore, pickTemplatePrompt, type SubagentTemplate } from "./subagent-templates.js";
import { ApprovalRulesStore, extractTargetPath, type ApprovalRule } from "./approval-rules.js";
import { ComposerDraftsStore } from "./composer-drafts.js";
import { readPermissionFromSession } from "./permission-preset.js";
import {
	FAST_MODE_ENTRY,
	FAST_MODE_EXT_NAME,
	fastModeEntryData,
	fastModeExtension,
	fastModeRegistry,
} from "./fast-mode.js";
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot } from "./workspace-snapshot.js";
import { isPathInsideRoot } from "./approval-rules.js";
import {
	approvalSuppressionReason,
	checkDangerousToolCall,
	isApprovalPolicyEmpty,
	pluginApprovalCategory,
	type ApprovalPolicy,
	type PendingApprovalEntry,
	type ToolApprovalResolution,
} from "./tool-approval.js";

import {
	applyHeadTail,
	makePersistentTerminalTools,
	makeTerminalBashTool,
	stripAnsi,
	TERMINAL_TOOLS_GUIDANCE,
} from "./terminals.js";
import {
	applyAgentToolsGating,
	ASK_USER_QUESTION_TOOL_NAME,
	BROWSER_PAGE_TOOL_NAME,
	effectiveDisabledAgentTools,
	isAgentToolEnabled,
	isTerminalGuidanceOn,
	MARKERS_LIST_TOOL_NAME,
	PI_AGENT_PRESETS,
	PI_PERMISSION_OPTIONS,
	PRESENT_FILES_TOOL_NAME,
	presetAllowsPluginTools,
	presetHasQuestionnaire,
	presetShowsSkillCatalog,
} from "./tool-manager.js";
import { WebUIContext } from "./webui-context.js";
import { ChatDialogs, chatUiContext, type DialogWatcher } from "./chat-dialogs.js";
import {
	contextItems,
	droppedMessageCount,
	type EntryLike,
	findItemIndex,
	formatMb,
	measureTooBig,
	planRewind,
	REQUEST_LIMIT_BYTES,
	suggestRewindIndex,
	tooBigKind,
} from "./rewind.js";
import { DEFAULT_COMPACTION_RESERVE_TOKENS, effectiveSoftCap, softCapToReserve } from "./soft-cap.js";
import { pruneContextHierarchically } from "./context-budget.js";
import { decodeText } from "./text-sniff.js";
import { makeEditSoftTool } from "./edit-soft-tool.js";
// 覆盖 SDK 内置 read：路径是目录时列出目录条目（行为开关 readDirEnabled，默认开）。
// 覆盖定义与「与扩展同名工具共存」的注入辅助分在两个文件（后者的依据见 tool-overrides.ts）。
import { makeReadDirTool, withReadDirSupport, type ReadDirToolOptions } from "./read-tool.js";
import {
	installToolOverrides,
	type AnyToolDefinition,
	type OverrideSessionLike,
	type ToolOverrideSpec,
} from "./tool-overrides.js";
// 展示文件给用户（present_files）：图片/视频内联、文本开预览弹窗、本地打开按钮。
import { makePresentFilesTool } from "./present-files-tool.js";
// 主动压缩上下文工具（compact_context）：AI 主动根据当前问题精简上下文并自主控制范围。
import {
	makeCompactContextTool,
	buildCompactionInstructions,
	DEFAULT_KEEP_RECENT_TOKENS,
	type CompactContextHost,
	type PendingCompaction,
} from "./compact-context-tool.js";
// 持久代码求值沙箱（eval）：Python / Node.js 沙箱内核。
import { disposeAllEvalKernels, disposeEvalSession, makeEvalTool } from "./eval-tool.js";
// 工具定义说明的归一化（工具卡右键 → 「显示工具详细信息」，见 getToolInfo）。
import { normalizeToolInfo, type RawToolDefinition } from "./tool-info.js";
import {
	collectSubagentDescendantIds,
	makeSubagentTools,
	subagentTitle,
	withSubagentOwner,
	type SubagentSnapshot,
	type SubagentState,
	type SubagentToolHost,
} from "./subagents.js";
import { makeDelegateTaskTool } from "./delegate-task.js";
import {
	makeConversationReadTool,
	parseTranscriptLines,
	toTranscriptInput,
	type ConversationReadHost,
	type TranscriptInputMessage,
} from "./conversation-read-tool.js";
import { extractTouches, formatTouchesCompact, intersectTouches } from "./conversation-touches.js";
import { ClaimStore, matchClaims, mergeTouchSidecar, readTouchSidecar, removeTouchSidecar } from "./claim-store.js";
import { makeClaimFilesTool, type ClaimFilesHost } from "./claim-files-tool.js";
import { makeSkillTool, type SkillToolHost } from "./skill-tool.js";
import { makeScheduleTools, type ScheduleToolHost } from "./schedule-agent-tool.js";
import { makePatchTool } from "./patch-tool.js";
import { makeLspTool } from "./lsp-tool.js";
import { sameSessionFile, type SchedulerStore } from "./scheduler-tasks.js";
import { buildAttachmentMessages, parseModelSpec } from "./attachments.js";
import { buildVisionBridgePrompt, findVisionModels, transcribeImages } from "./vision-bridge.js";
import { isNotRepoError, scmCommitContext } from "./scm.js";
import { buildCommitMsgInput, buildCommitMsgPrompt, sanitizeCommitMessage } from "./scm-commitmsg.js";
import {
	BUILTIN_SOUL,
	DEFAULT_PROMPT_TEMPLATE,
	buildToolsSchemaText,
	estimatePromptTokens,
	renderPromptTemplate,
	resolveSectionTexts,
	type PromptComposerInputs,
} from "./prompt-composer.js";
import type {
	BgServer,
	CachedWindow,
	CommandDef,
	ConversationSummary,
	ElsewhereRunning,
	GoalStatus,
	MessageAnchor,
	ProjectSummary,
	QuestionAnswer,
	ServerMessage,
	SessionSummary,
	SwitchTarget,
	UiApprovalCategory,
	UiApprovalPolicyState,
	UiApprovalRule,
	UiChatIdentity,
	UiMessage,
	UiPluginUpdateInfo,
	UiQuestion,
	UiServiceInfo,
	UiState,
	UiSubagentTemplate,
	UiTldrLine,
	UiTaskQueue,
	UiDialog,
	UiTooBig,
} from "./protocol.js";
import {
	type PromptAckMsg,
	type PromptAdmission,
	type PromptReceipt,
	promptIds,
	takePromptAdmission,
} from "./prompt-ack.js";
import { buildQuestionIndex } from "./question-index.js";
import {
	isQueueTaskChatEntries,
	isQueueTaskChatFile,
	TASK_QUEUE_ENTRY_TYPE,
	taskQueueCommandLine,
	taskQueueFromEntries,
	taskQueueShareableFrom,
} from "./task-queue.js";
import { installQueueHost, makeChain, type QueueChatStart, waitUntil } from "./queue-host.js";
import { applyQueueHomes, type LoadedQueue, queueHomesFrom, queueLinksSig } from "./queue-groups.js";
import { idsHash } from "./window-hash.js";
import {
	isTldrReply,
	latestAwaitingReply,
	latestUnseenTldr,
	TLDR_COLLAPSE_TYPE,
	TLDR_ENTRY_TYPE,
	tldrCollapseData,
	tldrLinesFromEntries,
} from "./tldr-lines.js";
import {
	fileIdentityIds,
	IDENTITY_ENTRY_TYPE,
	identityCommandLine,
	identityIdOfEntry,
	identityRegistry,
	liveChatIdentityId,
	uiChatIdentity,
	type IdentityEntryLike,
} from "./identities.js";
import { digestsBefore, snapshotDigests, straddleDigest } from "./exchange-digest.js";
import { launchOrigin, toServiceInfo } from "./launch-origin.js";
import { imageIfVersion, type ChatImage } from "./chat-image.js";
import {
	findEntryByUiId,
	imageBlocksOf,
	isShownMessage,
	serializeMessage,
	serializeStreamingMessage,
	uiMessageId,
	type AgentMessage,
	type ImageUrlFor,
	type UiIdEntryLike,
} from "./serialize.js";
import { loadCommands, saveCommandsFile, TerminalManager } from "./terminals.js";

const SNAPSHOT_INTERVAL_MS = 60;
/** 服务进程所在机器的用户主目录（wire 格式）：进程内不变，模块加载时求值一次，
 *  快照热路径直接引用（右栏 🏠 一键直达，见 protocol.ts 的 UiState.homeDir）。 */
const HOME_WIRE = homedir().replace(/\\/g, "/");
/** 桌面目录（wire 格式）：进程内不变（见 files-service.ts 的 desktopDirWire），
 *  不存在则空串 → 前端不渲染 🖥️。 */
const DESKTOP_WIRE = desktopDirWire(HOME_WIRE);
/** While assistant deltas are flowing, live rendering is carried by
 *  message_delta — full snapshots become pure reconciliation checkpoints, so
 *  send them on a slow event-driven cadence (see flushSnapshot call-sites:
 *  agent_end / tool_execution_end always checkpoint immediately). */
const STREAMING_SNAPSHOT_INTERVAL_MS = 2000;
/** Deltas newer than this keep the streaming (low-frequency) snapshot cadence. */
const DELTA_ACTIVE_WINDOW_MS = 1500;
/**
 * `session.getSessionStats()` 会遍历整份转写，而 `message_delta` 曾经**每一帧**都调它
 * （只为了填 usage）。实测 6000 条转写 × 6002 帧时这一条链占了流式阶段 **27.6%** 的 CPU
 * （2123ms），而一个「最多旧 250ms」的读数对进度条/上下文指示器来说与实时值无法区分。
 * 加这层短缓存后实测流式 CPU 4.859s → 1.328s（3.7×），快照字节数完全不变（issue #259）。
 */
const STATS_CACHE_MS = 250;
const WIDGET_REFRESH_MS = 2000;
/** SCM「AI 生成提交信息」的单次补全超时——慢供应商不该让按钮转圈到天荒地老。 */
const SCM_COMMITMSG_TIMEOUT_MS = 60_000;
/** Model-stall watchdog: warn (don't abort — deep thinking can be legitimately
 *  quiet for minutes) when a streaming run produced NO SDK events for this long.
 *  Covers the failure class the per-tool watchdog cannot see: half-open API
 *  connections / hung proxies where no tool is running and no error is thrown.
 *  Override: PI_WEB_STALL_NOTIFY_MS (milliseconds; 0 disables). */
const STALL_NOTIFY_MS = (() => {
	const v = Number(process.env.PI_WEB_STALL_NOTIFY_MS);
	return Number.isFinite(v) && v >= 0 ? v : 180_000;
})();
/** Serialization-cache soft cap per conversation (see serializeCachedFor /
 *  pruneMessageCache). Cached UiMessage objects are pure-function results, so a
 *  miss only costs a recompute — but a miss on a message that is STILL in the
 *  transcript is not free: it hands back a fresh object identity, which fails
 *  emitSnapshotNow's identity walk and degrades every checkpoint to a full
 *  snapshot (issue #259). Eviction is therefore by "no longer in the
 *  transcript", never FIFO; this constant only says when that sweep runs. */
const UI_MESSAGE_CACHE_CAP = 4096;
/** 快照里带多少条消息（chat-window-pagination）。一个 8600 条的会话完整快照
 *  是 35MB（实测），尾部 100 条是 0.5MB——开对话的等待主要花在这些字节的
 *  传输 + 浏览器解析上（磁盘读+解析才 226ms）。更老的由 load_older 按需取回。
 *  覆盖：PI_WEB_MESSAGE_WINDOW（条数；<=0 = 不分页，回到老行为）。 */
const MESSAGE_WINDOW = (() => {
	const v = Number(process.env.PI_WEB_MESSAGE_WINDOW);
	if (!Number.isFinite(v)) return 100;
	return v <= 0 ? Number.POSITIVE_INFINITY : Math.floor(v);
})();
/** 快照至少让页面看得到最近几轮对话（exchange-digest，见 server/exchange-digest.ts）：
 *  窗口里开头的不够这个数，就把窗口之前的几轮按摘要补上（提问 + 回答 + 折叠行计数）。
 *  也是「显示更早的对话」一次多取几轮。覆盖：PI_WEB_EXCHANGE_DIGESTS（<=0 = 不发摘要，
 *  前端退回按条载入更早的消息）。 */
const EXCHANGE_DIGESTS = (() => {
	const v = Number(process.env.PI_WEB_EXCHANGE_DIGESTS);
	if (!Number.isFinite(v)) return 5;
	return v <= 0 ? 0 : Math.floor(v);
})();
/** chat-open-speed: send the newest messages of a chat opened from history before the open
 *  itself finishes (see ClientSession.scanAndPreview). PI_WEB_OPEN_PREVIEW=0 turns it off:
 *  the open then works exactly as it did before this patch (repair pre-scan and all). */
const OPEN_PREVIEW = process.env.PI_WEB_OPEN_PREVIEW !== "0";

/** Preview panel cap: only the first 512KB of a file is ever read/sent. */

/** Thrown when the service is quiesced (draining) and the request is NEW work
 *  the admission controller refuses: a brand-new client attach, a prompt,
 *  a fork, a session resume, or a goal wizard start. index.ts closes the
 *  WebSocket with 4403 so the browser reconnect loop can retry after the
 *  server reopens admission (see AgentService.quiesce). */
export class QuiesceRejectedError extends Error {
	readonly code = "QUIESCED";
	constructor(detail: string) {
		super(`Server is draining existing work (quiesce) — ${detail}`);
		this.name = "QuiesceRejectedError";
	}
}

// ---------------------------------------------------------------------------
// Preview kind classification. The preview panel only opens image / video /
// text-editable files; everything else (exe, jar, archives, …) is refused so
// it is never read or sent to the browser. Media files are served over the
// /api/file HTTP endpoint instead of the WebSocket, so they are classified
// here but never read into the snapshot path.
// ---------------------------------------------------------------------------

/** 自家内联扩展名（组合模板渲染，见 prompt-composer.ts）。SDK 以其
 *  "<inline:<name>>" 作为 path；扩展白名单/禁用过滤必须放行它。 */
const INLINE_PERSONA_EXT = "<inline:pi-webui-persona>";
/** fast-mode: the hidden extension that sends ChatGPT's fast tier (see fast-mode.ts). */
const INLINE_FAST_MODE_EXT = `<inline:${FAST_MODE_EXT_NAME}>`;

/** identities: the persona extension first. When the prompt is customized (a template, overrides, a
 *  preset, a tool turned off) it builds the whole system prompt from the template, without what the
 *  extensions before it added. The SDK runs before_agent_start in load order, each handler getting the
 *  prompt the one before returned, and loads inline extensions last: so pi-identity's about page and
 *  notebook (and any extension's addition) were dropped. First, it builds the base and the others add to it. */
export function personaFirst<T extends { path: string }>(extensions: T[]): T[] {
	const i = extensions.findIndex((e) => e.path === INLINE_PERSONA_EXT);
	if (i <= 0) return extensions;
	return [extensions[i], ...extensions.slice(0, i), ...extensions.slice(i + 1)];
}

/** Pi 包文档路径（composer 的 {{pi_docs}} 自动内容用）。随安装位置解析一次。 */
const PI_DOC_PATHS = (() => {
	try {
		const requireLocal = createRequire(import.meta.url);
		const root = dirname(requireLocal.resolve("@earendil-works/pi-coding-agent/package.json"));
		return { readme: join(root, "README.md"), docs: join(root, "docs"), examples: join(root, "examples") };
	} catch {
		return { readme: "", docs: "", examples: "" };
	}
})();

/** Windows persona appendix — appended to the SDK system prompt on win32 only.
 *  Two failure modes it guards against: (1) the SDK bash tool has NO default
 *  timeout, so a long-running command hangs the whole conversation forever;
 *  (2) the in-app terminal is an interactive TTY where heredocs / interactive
 *  programs wait for input that never comes. Legacy Chinese files are often
 *  GBK/GB2312 — read them with the right encoding, never paste mojibake into
 *  reasoning/answers. */
const WINDOWS_PERSONA = `You are a coding agent running on Windows. The bash tool runs Git Bash (bash.exe), not PowerShell. Follow these rules to avoid hanging the session:



- ALWAYS pass a timeout parameter to the bash tool (in seconds). There is NO default timeout — a command that never finishes (servers, watchers, infinite loops, slow downloads/installs) will hang the entire conversation indefinitely. Pick a generous timeout for long-running work, but never omit it.
- NEVER run interactive or foreground long-running commands through the bash tool (vi, less, top, python -, node -, npm run dev, sleep 10000). For servers/daemons use background execution with output redirected to a log file, then poll the log; stop them when done.
- In the interactive terminal (TTY) — which is Git Bash too, not PowerShell — NEVER use heredocs (<<'EOF' ... EOF) or here-strings, and NEVER start interactive programs (vi, less, python -, node -, npm init): they wait for keyboard input that never arrives and hang the terminal forever. Prefer writing a temp script file (e.g. .pi-tmp.sh) and running it non-interactively. ALWAYS pass a timeout to long-running commands (e.g. \`timeout 120 npm run dev\`).

Many legacy Chinese text files (.html/.txt/.md/.log, exported documents) are GBK/GB2312 encoded: the read tool decodes UTF-8 only and will show mojibake for them. If a file's content looks garbled, read it through the terminal instead: in Git Bash use \`cat file | iconv -f GBK -t UTF-8\` (or \`iconv -f GBK -t UTF-8 file\`); in cmd use \`chcp 65001 && type file\`; in PowerShell use \`Get-Content -Encoding Default file\`. Never paste mojibake into your reasoning or answer — describe the decoded content instead.`;

/**
 * Killable bash tool: wraps the SDK bash tool (native process spawn, NO terminal).
 * Used when the「默认 bash 覆盖」setting is OFF. Registers its own AbortController
 * into a client-level set (kills) so abortBash() kills only these commands while the
 * agent run and the conversation continue. Exposes persist (ignored — native has no
 * terminal) plus head/tail (post-processed on the returned output) so the parameter
 * schema stays consistent with the terminal-backed tool.
 */
export function makeKillableBashTool(
	cwd: string,
	kills: Set<AbortController>,
	/** per-call 返回文本的服务端语言（默认英文）；工具 definition 为纯英文。 */
	lang: () => ServerLang = () => "en",
): ToolDefinition {
	const base = createLocalBashOperations();
	const tool = createBashToolDefinition(cwd, {
		operations: {
			exec: async (command, c, opts) => {
				const ac = new AbortController();
				kills.add(ac);
				try {
					const signals = [opts.signal, ac.signal].filter((s): s is AbortSignal => s !== undefined);
					return await base.exec(command, c, {
						...opts,
						signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
					});
				} finally {
					kills.delete(ac);
				}
			},
		},
	});
	// Keep the SDK definition so execute receives the current session context.
	return {
		name: tool.name,
		label: tool.label,
		description:
			"Run a shell command natively (process spawn, no terminal); returns full output plus exit code. persist is ignored here; use head/tail to trim returned output.",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run" }),
			timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds" })),
			persist: Type.Optional(
				Type.Boolean({
					description: "Ignored in native mode (no terminal). Only meaningful when the terminal-backed bash is active.",
				}),
			),
			head: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5000,
					description: "Only return the FIRST N lines of output (like `| head -N`).",
				}),
			),
			tail: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5000,
					description: "Only return the LAST N lines of output (like `| tail -N`).",
				}),
			),
		}),
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const result = (await tool.execute(
				toolCallId,
				params as { command: string; timeout?: number },
				signal,
				onUpdate,
				ctx,
			)) as { content?: Array<{ type: string; text?: string }> };
			// head/tail 后处理（native 无终端，直接截返回行即可）。
			const p = params as { head?: number; tail?: number };
			if ((p?.head || p?.tail) && result?.content?.[0]?.text != null) {
				result.content![0].text = applyHeadTail(result.content![0].text!, p.head, p.tail, lang());
			}
			return result as never;
		},
	} as ToolDefinition;
}

/**
 * 动态分流 bash：按「默认 bash 覆盖」设置（terminalBash）在调用时决定走哪套——
 * 关 = 原生 SDK bash（纯进程、不开终端）；开 = 终端接管 bash（persist 决定一次性/
 * 持久）。开关因此即时生效（customTools 固定于 runtime 创建，不能在创建时二选一）。
 */
export function makeAdaptiveBashTool(
	killable: ToolDefinition,
	terminalBacked: ToolDefinition,
	useTerminal: () => boolean,
): ToolDefinition {
	return {
		...killable,
		description:
			'Run a shell command and return its full output plus exit code. Behavior depends on the "default bash override" setting (terminalBash):\n' +
			"OFF → runs natively (process spawn, no terminal); persist has no effect.\n" +
			"ON → runs in a visible terminal. persist=true keeps the 'ai-bash' terminal alive (shell state cd/venv/ssh retained across calls); persist=false (default) is a one-shot terminal whose output stays viewable.\n" +
			"Run the bare command — never pipe through head/tail/more/less (use the head/tail params; pipes hide live progress). For interactive commands (REPLs, y/n prompts) set persist=true and drive them with terminal_input / terminal_key.",
		promptSnippet: "run shell commands",
		execute: (id, params, signal, onUpdate, ctx) => {
			const p = params as { persist?: boolean };
			// Windows 下 ConPTY 架构限制（MSYS2 全局控制台上限 128，且高频创建销毁容易句柄耗尽/卡顿）：
			// 一次性命令（persist !== true）走原生 spawn（基于 pipe，无需分配控制台，速度快 60 倍且免死锁，issue #269）；
			// 只有明确需要持久交互（persist === true）才进可见终端 ai-bash。
			const shouldUseTerminal = useTerminal() && (process.platform !== "win32" || p?.persist === true);
			return (shouldUseTerminal ? terminalBacked : killable).execute(id, params as never, signal, onUpdate, ctx);
		},
	};
}

/**
 * 插件工具拦截钩子（P1-5）：index.ts 注入，把 bash/read 的 pre/post 决策委托给
 *  PluginManager（evaluateToolPre/evaluateToolPost）。未注入时零开销直通。
 */
export interface ToolGuardHook {
	pre: (
		req: ToolPreRequest,
		lang: string,
	) => Promise<{
		verdict:
			| { decision: "allow" }
			| { decision: "deny"; reason?: string; reasonEn?: string }
			| { decision: "ask"; reason?: string; reasonEn?: string };
		pluginId?: string;
	}>;
	post: (
		req: ToolPostRequest,
		lang: string,
	) => Promise<{ content?: Array<{ type: string; text?: string }>; pluginIds: string[] } | undefined>;
}

/** 人机协同审批回调（第 7 参数 = 命中的规则档位，供「允许同类」记忆）。 */
export type AskApprovalFn = (
	toolCallId: string,
	toolName: string,
	params: unknown,
	reason?: string,
	reasonEn?: string,
	conversationId?: string,
	category?: UiApprovalCategory,
) => Promise<ToolApprovalResolution>;

/**
 * 给已接管工具（bash/read）包上拦截守卫与人机协同审批：
 * 1. pre guard 命中 deny → 直接阻断；
 * 2. pre guard 命中 ask 或内置高危操作检测（rm -rf / 敏感文件覆盖等） →
 *    触发 tool_approval_pending 等待用户审批；
 *    - 用户选择 approve: 放行执行
 *    - 用户选择 edit: 使用用户修改后的参数执行（Edit & Run）
 *    - 用户选择 deny: 阻断并告知模型
 * 3. post guard 合并（脱敏/补上下文）。
 */
export function withToolGuard(
	def: ToolDefinition,
	opts: {
		toolName: GuardedToolName;
		guard?: ToolGuardHook;
		conversationId?: () => string | undefined;
		getLang: () => ServerLang;
		cwd?: string;
		getRoots?: () => string[];
		askApproval?: AskApprovalFn;
		getRules?: () => ApprovalRule[];
	},
): ToolDefinition {
	const guard = opts.guard;
	const toolName = opts.toolName;
	if (!guard && !opts.askApproval) return def;

	return {
		...def,
		execute: (async (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => {
			const lang = opts.getLang();
			const conversationId = opts.conversationId?.();
			let pre: Awaited<ReturnType<ToolGuardHook["pre"]>> | undefined;
			if (guard) {
				try {
					pre = await guard.pre({ toolName, params, conversationId }, lang);
				} catch {
					pre = { verdict: { decision: "allow" } };
				}
			}

			// 检查是否需要人工协同审批（Human-in-the-Loop）
			let needApproval = false;
			let approvalReason: string | undefined;
			let approvalReasonEn: string | undefined;
			let approvalCategory: UiApprovalCategory | undefined;

			// 1. 系统核心安全：内置高危操作检测与自定义审批规则先行（优先级最高，防短路）
			let danger: ReturnType<typeof checkDangerousToolCall> | undefined;
			if (opts.cwd && opts.askApproval) {
				danger = checkDangerousToolCall(toolName, params, opts.cwd, opts.getRoots?.() ?? [], opts.getRules?.());
				if (danger.denied) {
					const reasonTextEn = danger.reasonEn ? ` Reason: ${danger.reasonEn}` : "";
					const text = `[Tool execution blocked by approval rule]${reasonTextEn}`;
					return {
						content: [{ type: "text", text }],
						details: { guardDenied: true, ruleDenied: true, reason: danger.reason },
						isError: true,
					} as never;
				}
			}

			// 2. 插件前置守卫 deny 拦截（带 isError 标记）
			if (pre?.verdict.decision === "deny") {
				const text = denialText(pre.verdict, pre.pluginId ?? "plugin", lang);
				return {
					content: [{ type: "text", text }],
					details: { guardDenied: true, decision: pre.verdict.decision, pluginId: pre.pluginId },
					isError: true,
				} as never;
			}

			// 3. 决定是否需要弹窗审批（系统高危 ask 优先于插件通用 ask，防止恶意或低危插件掩盖高危告警）
			if (danger?.dangerous) {
				needApproval = true;
				approvalReason = danger.reason;
				approvalReasonEn = danger.reasonEn;
				approvalCategory = danger.category;
			} else if (pre?.verdict.decision === "ask") {
				needApproval = true;
				approvalReason = pre.verdict.reason ?? "Plugin requested confirmation for this operation";
				approvalReasonEn = pre.verdict.reasonEn ?? "Plugin requested confirmation for this operation";
				// 插件档位按插件 id 分：用户可以「允许同类」= 该插件的确认以后不再问。
				approvalCategory = pluginApprovalCategory(pre.pluginId ?? "plugin");
			}

			let effectiveParams = params;
			let userEdited = false;
			if (needApproval && opts.askApproval) {
				const res = await opts.askApproval(
					toolCallId,
					toolName,
					params,
					approvalReason,
					approvalReasonEn,
					conversationId,
					approvalCategory,
				);
				if (res.decision === "deny") {
					const reasonTextEn = res.reason ? ` Reason: ${res.reason}` : "";
					return {
						content: [
							{
								type: "text",
								text: `[Operation denied by user]${reasonTextEn}`,
							},
						],
						details: { guardDenied: true, userDenied: true, reason: res.reason },
						isError: true,
					} as never;
				} else if (res.decision === "edit") {
					effectiveParams = res.editedParams ?? params;
					userEdited = true;
				}
			} else if (pre?.verdict.decision === "ask") {
				// 无审批通道时回落至原先的阻断行为
				const text = denialText(pre.verdict, pre.pluginId ?? "plugin", lang);
				return {
					content: [{ type: "text", text }],
					details: { guardDenied: true, decision: pre.verdict.decision, pluginId: pre.pluginId },
				} as never;
			}

			const result = (await (def.execute as (...a: never[]) => Promise<unknown>)(
				toolCallId as never,
				effectiveParams as never,
				signal as never,
				onUpdate as never,
				ctx as never,
			)) as {
				content?: Array<{ type: string; text?: string }>;
				details?: Record<string, unknown>;
				[k: string]: unknown;
			};

			if (userEdited && result && typeof result === "object") {
				result.details = {
					...result.details,
					userEdited: true,
					originalParams: params,
					executedParams: effectiveParams,
				};
			}

			if (guard) {
				let post: ToolPostEdit | undefined | { content?: Array<{ type: string; text?: string }>; pluginIds: string[] };
				try {
					post = await guard.post({ toolName, params: effectiveParams, result, conversationId }, lang);
				} catch {
					post = undefined;
				}
				if (post?.content) return { ...result, content: post.content } as never;
			}
			return result as never;
		}) as never,
	} as ToolDefinition;
}

/** 校验目标路径是否在工作区（或多根工作区）内。严格规范化防止 ".." 逃逸与 Windows 盘符大小写不一致。 */
function isInsideWorkspaceRoots(targetPath: string, cwd: string, roots: string[] = []): boolean {
	const abs = resolve(cwd, targetPath);
	const allRoots = [resolve(cwd), ...roots.map((r) => resolve(r))];
	return allRoots.some((r) => isPathInsideRoot(abs, r));
}

/**
 * 为 write 工具包装会话级权限沙箱与人机协同审批。
 * `base` = 覆盖基底：第三方扩展注册的同名 write 优先（见 tool-overrides.ts），
 * 省略则是 SDK 内置实现 —— 于是权限门禁叠在扩展实现之上，而不是把它顶掉。
 */
function wrapWriteToolWithPermission(
	cwd: string,
	getPermission: () => string,
	getRoots: () => string[],
	getLang: () => ServerLang,
	askApproval?: AskApprovalFn,
	getConversationId?: () => string | undefined,
	getRules?: () => ApprovalRule[],
	base: AnyToolDefinition = createWriteToolDefinition(cwd),
): ToolDefinition {
	return {
		...base,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const perm = getPermission();
			if (perm === "read-only") {
				return {
					content: [
						{
							type: "text",
							text: "[Permission Denied] The current session is in 'read-only' mode; writing files is forbidden. Switch permission preset if needed.",
						},
					],
					isError: true,
				} as never;
			}
			if (perm === "workspace-write-never") {
				const p = extractTargetPath(params);
				if (!isInsideWorkspaceRoots(p, cwd, getRoots())) {
					return {
						content: [
							{
								type: "text",
								text: `[Permission Denied] The current session is in 'workspace-write-never' mode; writing files outside the workspace ("${p}") is forbidden. Switch to 'danger-full-access' if needed.`,
							},
						],
						isError: true,
					} as never;
				}
			}

			// 高危写操作人机协同审批拦截（如敏感配置修改）与规则匹配
			let effectiveParams = params;
			let userEdited = false;
			if (askApproval) {
				const danger = checkDangerousToolCall("write", params, cwd, getRoots(), getRules?.());
				if (danger.denied) {
					return {
						content: [
							{
								type: "text",
								text: `[File write blocked by approval rule]${danger.reason ? ` Reason: ${danger.reason}` : ""}`,
							},
						],
						details: { guardDenied: true, ruleDenied: true, reason: danger.reason },
						isError: true,
					} as never;
				}
				if (danger.dangerous) {
					const res = await askApproval(
						toolCallId,
						"write",
						params,
						danger.reason,
						danger.reasonEn,
						getConversationId?.(),
						danger.category,
					);
					if (res.decision === "deny") {
						return {
							content: [
								{
									type: "text",
									text: `[File write denied by user]${res.reason ? ` Reason: ${res.reason}` : ""}`,
								},
							],
							details: { guardDenied: true, userDenied: true, reason: res.reason },
							isError: true,
						} as never;
					} else if (res.decision === "edit") {
						effectiveParams = res.editedParams ?? params;
						userEdited = true;
					}
				}
			}

			const result = (await base.execute(toolCallId, effectiveParams as never, signal, onUpdate, ctx)) as unknown as {
				details?: Record<string, unknown>;
				[k: string]: unknown;
			};
			if (userEdited && result && typeof result === "object") {
				result.details = {
					...result.details,
					userEdited: true,
					originalParams: params,
					executedParams: effectiveParams,
				};
			}
			return result as never;
		},
	} as ToolDefinition;
}

/**
 * 为 edit 工具包装会话级权限沙箱与人机协同审批（基底语义同 write）。
 */
function wrapEditToolWithPermission(
	cwd: string,
	getPermission: () => string,
	getRoots: () => string[],
	getLang: () => ServerLang,
	askApproval?: AskApprovalFn,
	getConversationId?: () => string | undefined,
	getRules?: () => ApprovalRule[],
	base: AnyToolDefinition = createEditToolDefinition(cwd),
): ToolDefinition {
	return {
		...base,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const perm = getPermission();
			if (perm === "read-only") {
				return {
					content: [
						{
							type: "text",
							text: "[Permission Denied] The current session is in 'read-only' mode; editing files is forbidden. Switch permission preset if needed.",
						},
					],
					isError: true,
				} as never;
			}
			if (perm === "workspace-write-never") {
				const p = extractTargetPath(params);
				if (!isInsideWorkspaceRoots(p, cwd, getRoots())) {
					return {
						content: [
							{
								type: "text",
								text: `[Permission Denied] The current session is in 'workspace-write-never' mode; editing files outside the workspace ("${p}") is forbidden. Switch to 'danger-full-access' if needed.`,
							},
						],
						isError: true,
					} as never;
				}
			}

			// 高危修改人机协同审批拦截与规则匹配
			let effectiveParams = params;
			let userEdited = false;
			if (askApproval) {
				const danger = checkDangerousToolCall("edit", params, cwd, getRoots(), getRules?.());
				if (danger.denied) {
					return {
						content: [
							{
								type: "text",
								text: `[File edit blocked by approval rule]${danger.reason ? ` Reason: ${danger.reason}` : ""}`,
							},
						],
						details: { guardDenied: true, ruleDenied: true, reason: danger.reason },
						isError: true,
					} as never;
				}
				if (danger.dangerous) {
					const res = await askApproval(
						toolCallId,
						"edit",
						params,
						danger.reason,
						danger.reasonEn,
						getConversationId?.(),
						danger.category,
					);
					if (res.decision === "deny") {
						return {
							content: [
								{
									type: "text",
									text: `[File edit denied by user]${res.reason ? ` Reason: ${res.reason}` : ""}`,
								},
							],
							details: { guardDenied: true, userDenied: true, reason: res.reason },
							isError: true,
						} as never;
					} else if (res.decision === "edit") {
						effectiveParams = res.editedParams ?? params;
						userEdited = true;
					}
				}
			}

			const result = (await base.execute(toolCallId, effectiveParams as never, signal, onUpdate, ctx)) as unknown as {
				details?: Record<string, unknown>;
				[k: string]: unknown;
			};
			if (userEdited && result && typeof result === "object") {
				result.details = {
					...result.details,
					userEdited: true,
					originalParams: params,
					executedParams: effectiveParams,
				};
			}
			return result as never;
		},
	} as ToolDefinition;
}

/** 为 edit_soft 工具包装会话级权限沙箱与人机协同审批。 */
function wrapEditSoftToolWithPermission(
	tool: ToolDefinition,
	cwd: string,
	getPermission: () => string,
	getRoots: () => string[],
	getLang: () => ServerLang,
	askApproval?: AskApprovalFn,
	getConversationId?: () => string | undefined,
	getRules?: () => ApprovalRule[],
): ToolDefinition {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const perm = getPermission();
			if (perm === "read-only") {
				return {
					content: [
						{
							type: "text",
							text: "[Permission Denied] The current session is in 'read-only' mode; editing files is forbidden. Switch permission preset if needed.",
						},
					],
					isError: true,
				} as never;
			}
			if (perm === "workspace-write-never") {
				const p = (params as { path?: string })?.path ?? "";
				if (!isInsideWorkspaceRoots(p, cwd, getRoots())) {
					return {
						content: [
							{
								type: "text",
								text: `[Permission Denied] The current session is in 'workspace-write-never' mode; editing files outside the workspace ("${p}") is forbidden. Switch to 'danger-full-access' if needed.`,
							},
						],
						isError: true,
					} as never;
				}
			}

			// 高危修改人机协同审批拦截与规则匹配
			let effectiveParams = params;
			let userEdited = false;
			if (askApproval) {
				const danger = checkDangerousToolCall("edit_soft", params, cwd, getRoots(), getRules?.());
				if (danger.denied) {
					return {
						content: [
							{
								type: "text",
								text: `[File edit blocked by approval rule]${danger.reason ? ` Reason: ${danger.reason}` : ""}`,
							},
						],
						details: { guardDenied: true, ruleDenied: true, reason: danger.reason },
						isError: true,
					} as never;
				}
				if (danger.dangerous) {
					const res = await askApproval(
						toolCallId,
						"edit_soft",
						params,
						danger.reason,
						danger.reasonEn,
						getConversationId?.(),
						danger.category,
					);
					if (res.decision === "deny") {
						return {
							content: [
								{
									type: "text",
									text: `[File edit denied by user]${res.reason ? ` Reason: ${res.reason}` : ""}`,
								},
							],
							details: { guardDenied: true, userDenied: true, reason: res.reason },
							isError: true,
						} as never;
					} else if (res.decision === "edit") {
						effectiveParams = res.editedParams ?? params;
						userEdited = true;
					}
				}
			}

			const result = (await tool.execute(toolCallId, effectiveParams as never, signal, onUpdate, ctx)) as unknown as {
				details?: Record<string, unknown>;
				[k: string]: unknown;
			};
			if (userEdited && result && typeof result === "object") {
				result.details = {
					...result.details,
					userEdited: true,
					originalParams: params,
					executedParams: effectiveParams,
				};
			}
			return result as never;
		},
	};
}

/** 为 bash 工具包装只读拦截。 */
function wrapBashToolWithPermission(
	tool: ToolDefinition,
	getPermission: () => string,
	_getLang: () => ServerLang,
): ToolDefinition {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const perm = getPermission();
			if (perm === "read-only") {
				return {
					content: [
						{
							type: "text",
							text: "[Permission Denied] The current session is in 'read-only' mode; running shell commands is forbidden. Switch permission preset if needed.",
						},
					],
					isError: true,
				} as never;
			}
			return tool.execute(toolCallId, params as never, signal, onUpdate, ctx);
		},
	};
}

/**
 * 任务列表只读查询工具（todo_list）— 读操作仍走真工具。
 */
function makeMarkersListTool(
	getActiveId: () => string,
	markerSvc: {
		describe: (id: string, tool: string, inc?: boolean) => string;
		getRawState: (id: string, ns: string) => unknown;
	},
): ToolDefinition {
	return {
		name: MARKERS_LIST_TOOL_NAME,
		label: "List marker state",
		description:
			"Read-only query of inline marker state. All WRITE operations must use inline markers ([[todo:new:...]] etc.) in the reply body — never this tool.",
		parameters: Type.Object({
			action: Type.Unsafe<string>({ enum: ["list"] }),
			tool: Type.Optional(Type.Literal("todo")),
			includeDeleted: Type.Optional(
				Type.Boolean({
					description: "Include deleted tasks (tombstones, todo only).",
				}),
			),
		}),
		execute: async (_id: string, params: unknown) => {
			const p = params as { action: string; tool?: string; includeDeleted?: boolean };
			const convId = getActiveId();
			const text = markerSvc.describe(convId, "todo", !!p.includeDeleted);
			const state = markerSvc.getRawState(convId, "todo") as { tasks: unknown[]; nextId: number } | undefined;
			const visible = (state?.tasks ?? []).filter(
				(t: unknown) => p.includeDeleted || (t as { status: string }).status !== "deleted",
			);
			return {
				content: [{ type: "text", text }],
				details: { action: "list", todos: visible, nextId: state?.nextId },
			} as never;
		},
	} as unknown as ToolDefinition;
}

/**
 * 标准 pi 引擎的 ask_user_question 工具：模型调用时把问题桥到浏览器（复用 DSH
 * 引擎的 question_pending/question_answer 协议，前端 DshQuestionDialog 富渲染），
 * 阻塞 agent 循环直到用户在浏览器回答或取消。
 *
 * 标准 SDK 没有内建 ask_user_question，故由 pi-web-ui 以 customTool 注册（与
 * bash/edit 同机制）。DSH 引擎走 goal-rpc 的 userQuestions provider，两者互不
 * 冲突（各引擎各走各的）。
 *
 * askUser 签名带 {aborted} 快照而非完整 AbortSignal：customTool 的 execute 信号
 * 服务于整个 agent 生命周期，这里按「已中止即拒绝」的最小语义处理，避免与其它
 * 工具的取消逻辑纠缠。
 */
export function makeAskUserQuestionTool(
	clientSession: {
		askUser: (q: UiQuestion[], sig: { aborted?: boolean }, conversationId?: string) => Promise<QuestionAnswer[] | null>;
	},
	/** 本 runtime 所属会话：提问跟着对话走，快照只把当前对话的问卷推给客户端。 */
	ownerId?: string,
): ToolDefinition {
	const QuestionOptionSchema = Type.Object({
		label: Type.String({ description: "Display label for the option (1-5 words)" }),
		description: Type.Optional(
			Type.String({
				description: "One short sentence explaining the impact or tradeoff if selected.",
			}),
		),
		preview: Type.Optional(
			Type.String({
				description:
					"Optional preview rendered below when this option is selected (markdown or HTML — use for mockups/code/config).",
			}),
		),
	});
	const QuestionSchema = Type.Object({
		id: Type.String({ description: "Unique identifier for this question (snake_case)" }),
		question: Type.String({ description: "The full question text to display (markdown/HTML ok)" }),
		detail: Type.Optional(Type.String({ description: "Optional detail/context shown under the question" })),
		header: Type.Optional(Type.String({ description: "Optional short header for this question" })),
		options: Type.Optional(
			Type.Array(QuestionOptionSchema, {
				description: "2-4 mutually exclusive choices. Put the recommended option first when there is a clear default.",
				minItems: 2,
				maxItems: 4,
			}),
		),
		multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
		dependsOn: Type.Optional(
			Type.Object({
				questionId: Type.String({ description: "ID of the prior question this question depends on" }),
				value: Type.Optional(
					Type.Union([Type.String(), Type.Array(Type.String())], {
						description:
							"Show only when the prior answer equals this value (or is in the array). Omit to show whenever answered.",
					}),
				),
			}),
		),
		optionsMap: Type.Optional(
			Type.Record(Type.String(), Type.Array(QuestionOptionSchema), {
				description:
					"Dynamic options based on prior question's chosen value: e.g. { 'React': [opts...], 'Vue': [opts...] }",
			}),
		),
	});
	return {
		name: "ask_user_question",
		label: "Ask the user",
		description:
			"Ask the user focused questions to clarify ambiguous requirements (clarify the task, confirm decisions, get preferences). " +
			"Strictly ask 1 to 3 questions per call (prefer 1, max 3); provide 2 to 4 mutually exclusive options with the " +
			"recommended option first, and explain impact/tradeoff in each option description. " +
			"Each question renders a browser dialog with markdown/HTML rich text; options may carry a `preview`. Submit or cancel to resume.",
		promptSnippet: "ask the user 1-3 focused questions with recommended options and tradeoffs to clarify requirements",
		promptGuidelines: [
			"When requirements are ambiguous, use ask_user_question to clarify instead of guessing: " +
				"ask 1 to 3 focused questions (prefer 1, max 3), provide 2-4 mutually exclusive options with the " +
				"recommended option first, and explain impact/tradeoff in description",
			"A cancelled question comes back as a tool error — respect it and continue without re-asking immediately",
		],
		parameters: Type.Object({
			questions: Type.Array(QuestionSchema, {
				description: "Questions to ask the user (strictly 1 to 3 questions; prefer 1).",
				minItems: 1,
				maxItems: 3,
			}),
		}),
		execute: async (_id: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
			const qs = (params as { questions: UiQuestion[] }).questions;
			if (!Array.isArray(qs) || qs.length === 0) {
				throw new Error("ask_user_question requires at least one question");
			}
			if (qs.length > 3) {
				throw new Error("ask_user_question allows at most 3 questions per call to prevent question fatigue");
			}
			const answers = await clientSession.askUser(
				qs,
				{
					aborted: signal?.aborted,
				},
				ownerId,
			);
			if (answers === null) {
				throw new Error("User cancelled the question.");
			}
			// 工具结果：把每道题的回答拼成简洁文本给模型，同时留 details 供 UI 展示。
			const lines = answers.map((a) => {
				const q = qs.find((q) => q.id === a.id);
				const label = a.selected.join(", ");
				const custom = a.custom?.trim() ? ` (wrote: ${a.custom.trim()})` : "";
				return `${q?.header ?? q?.id ?? a.id}: ${label || "(no selection)"}${custom}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { answers },
			} as never;
		},
	} as unknown as ToolDefinition;
}

/** 判定是否应当即时向前端推送问卷弹窗（只推给当前前台会话，未指定会话按全局放行）。 */
export function shouldPopQuestion(conversationId: string | undefined, activeId: string): boolean {
	return conversationId === undefined || conversationId === activeId;
}

// ---------------------------------------------------------------------------
// 浏览器页面工具（标准 pi 引擎的 browser_page customTool）
//
// 模型调 browser_page → 服务端发 page_request 给浏览器 → 前端转 page-picker
// 扩展 → 扩展操作目标页面 → 前端回 page_response → 工具结果回到模型。
//
// op 的语义（read/click/type/…）属于**扩展侧**，服务端只透传，不解读也不校验
// ——所以参数说明写在 tool description 里让模型知道怎么用，不在这里分支处理。
// ---------------------------------------------------------------------------

/** timeoutMs 默认值。对面是扩展不是人，超时必须自己兜住。 */
const PAGE_CALL_DEFAULT_TIMEOUT_MS = 30_000;
/** 夹取区间：太小会误杀慢页面（拿不到结果还白跑一趟），太大就把模型拖到
 *  工具看门狗（20 分钟）附近了。 */
const PAGE_CALL_MIN_TIMEOUT_MS = 1_000;
const PAGE_CALL_MAX_TIMEOUT_MS = 120_000;

/** 客户端/扩展回来的页面调用结果（pageCall 的返回值）。失败一律带人话原因，
 *  由工具转成 Error 抛给模型（模型看到 error 才会改变策略）。 */
export type PageCallResult = { ok: true; result?: unknown } | { ok: false; error: string };

/** pageCall 的入参 = 协议 page_request 去掉 id/type（id 由 ClientSession 生成，
 *  type 由 emit 补上）。从 protocol.ts 派生而非手写：契约单源，协议改字段这里
 *  跟着报错。 */
export type PageCallRequest = Omit<Extract<ServerMessage, { type: "page_request" }>, "id" | "type">;

/** timeoutMs 归一：非有限数字/缺省 → 默认；其余夹在 [1000, 120000]。
 *  工具入口与页桥（pageCall）共用，防手写脏值绕过 schema。 */
export function normalizePageCallTimeoutMs(v: unknown): number {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : PAGE_CALL_DEFAULT_TIMEOUT_MS;
	return Math.min(PAGE_CALL_MAX_TIMEOUT_MS, Math.max(PAGE_CALL_MIN_TIMEOUT_MS, n));
}

/** 除 op/target/timeoutMs 外的扁平参数名（保持扩展侧原名：what/selector/…）。
 *  列表即 schema 里的可选字段——改 schema 忘改这里，单测会炸（见
 *  tests/unit/browser-page-tool.test.ts）。 */
const BROWSER_PAGE_ARG_KEYS = ["what", "selector", "text", "url", "code", "all", "index", "maxEdge"] as const;

/** 只收模型**确实传了**的参数：undefined 不入包，否则扩展拿到一堆
 *  `"selector": undefined` 会覆盖自己的默认值。 */
export function collectBrowserPageArgs(params: Record<string, unknown>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const k of BROWSER_PAGE_ARG_KEYS) {
		if (params[k] !== undefined) args[k] = params[k];
	}
	return args;
}

/** 页面调用结果 → 给模型的文本：字符串原样（read 的正文就是这样，别再加引号），
 *  其余 JSON 缩进；空结果给一句说明，免得模型以为工具没输出。 */
export function formatPageCallResult(result: unknown): string {
	if (typeof result === "string") return result.length > 0 ? result : "(empty)";
	if (result === undefined || result === null) return "(no result)";
	try {
		return JSON.stringify(result, null, 2) ?? String(result);
	} catch {
		// 循环引用/含大整数等不可序列化结果：别让格式化把工具调用炸掉。
		return String(result);
	}
}

/** 失败文本：带上 op 与原因，再补一句**可执行的**下一步（模型只有知道该让
 *  用户干什么，才不会再盲目重试同一个调用）。 */
export function formatBrowserPageError(op: string, error: string): string {
	return [
		`browser_page "${op}" failed: ${error}`,
		'Next: make sure a pi-web-ui page is open with the page-picker extension enabled and paired, then try op:"pages" to see which pages are available. If the target page is not allowed yet, ask the user to allow it in the extension.',
	].join("\n");
}

/**
 * 标准 pi 引擎的 browser_page 工具：模型调用时把请求桥到用户浏览器里的
 * pi-web-ui 页面（page_request/page_response 协议），由 page-picker 扩展真正
 * 操作用户授权的页面。
 *
 * 与 ask_user_question 同样以 customTool 注册（标准 SDK 没有这个工具；DSH 引擎
 * 走自己的运行时，也不经此）。写法严格比照 makeAskUserQuestionTool。
 *
 * pageCall 签名同样带 {aborted} 快照而非完整 AbortSignal（customTool 的 execute
 * 信号服务于整个 agent 生命周期，这里只要「已中止即失败」的最小语义）。
 */
export function makeBrowserPageTool(
	clientSession: {
		pageCall: (req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string) => Promise<PageCallResult>;
		/** 主模型能不能直接看图 —— 决定 `op:"shot"` 是「给图」还是「走视觉桥转写」。
		 *  两者都可选：老测试替身不实现时，截图退化成「看不到图 + 说明原因」。 */
		canSeeImages?: () => boolean;
		transcribeToolImage?: (
			image: { data: string; mimeType: string },
			signal?: AbortSignal,
		) => Promise<{ text?: string; reason?: string }>;
	},
	/** 本 runtime 所属会话（语义与 ask_user_question 的 ownerId 一致）。 */
	ownerId?: string,
): ToolDefinition {
	return {
		name: BROWSER_PAGE_TOOL_NAME,
		label: "Browser page",
		description: [
			'Read or act on a page in the USER\'S OWN browser via the pi-web-ui page-picker extension (the server only forwards). Only pages the user explicitly allowed/paired can be touched. Start with op:"pages" to list available pages, and use ONLY when the user asked you to read or operate a page — never click/type on their pages unprompted.',
			"ops (forwarded to the extension as-is):",
			"  pages  — no args; lists the pages you may act on",
			'  read   — { what?: "text" | "html" | "title" | "url" | "query", selector?, all? }',
			"  click  — { selector, index? }",
			"  type   — { selector, text, clear?, submit? } (submit: true presses Enter)",
			"  scroll — { selector?, to?: { x, y }, by?: { x, y } }",
			"  goto   — { url }",
			"  wait   — { selector?, text?, timeoutMs? } waits for the element/text to appear; that timeoutMs is the op's own",
			"  eval   — { code } runs JS inside the page (extension-side switch, off by default)",
			"Op options that are not fields of this tool (e.g. read's `limit`) fall back to the extension's defaults. `target` selects the page by origin when more than one is allowed; `timeoutMs` is how long the SERVER waits for the browser (1000-120000, default 30000) before failing the call.",
		].join("\n"),
		promptSnippet: "read or operate a page in the user's browser (page-picker extension; allowed pages only)",
		promptGuidelines: [
			"Only use browser_page when the user asked you to read or act on a page in their browser; " +
				"never click or type on their pages on your own initiative",
			'Start with op:"pages" to see which pages are available; ' +
				"the target page must already be allowed in the page-picker extension — when it fails, tell the user what to enable instead of retrying blindly",
		],
		parameters: Type.Object({
			op: Type.String({
				description:
					"Action name (extension-side): pages | read | click | type | scroll | goto | wait | eval | shot — see the tool description for each op and its options.",
			}),
			target: Type.Optional(
				Type.String({
					description: "Target page origin (e.g. https://example.com). Only needed when several pages are allowed.",
				}),
			),
			what: Type.Optional(
				Type.String({ description: 'For op:read — "text" | "html" | "title" | "url" | "query" (default: text).' }),
			),
			selector: Type.Optional(
				Type.String({ description: "CSS selector, for op:read / click / type / scroll / wait." }),
			),
			text: Type.Optional(
				Type.String({ description: "For op:type — the text to enter; for op:wait — the text to wait for." }),
			),
			url: Type.Optional(Type.String({ description: "For op:goto — the absolute URL to navigate to." })),
			code: Type.Optional(
				Type.String({
					description: "For op:eval — JavaScript to run inside the page (extension-side switch, disabled by default).",
				}),
			),
			all: Type.Optional(
				Type.Boolean({ description: "For op:read — return every match instead of only the first one." }),
			),
			index: Type.Optional(Type.Number({ description: "For op:click — which match to click (default: 0)." })),
			maxEdge: Type.Optional(
				Type.Number({
					description:
						"For op:shot — max size of the longer side in px (320-1568, default 1280). Bigger = more tokens.",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description: "How long the server waits for the browser before failing (1000-120000 ms, default 30000).",
				}),
			),
		}),
		execute: async (_id: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
			const p = (params ?? {}) as Record<string, unknown>;
			const op = typeof p.op === "string" ? p.op.trim() : "";
			if (!op) {
				throw new Error('browser_page requires a non-empty `op` (e.g. "pages", "read", "click").');
			}
			const resolved = await clientSession.pageCall(
				{
					op,
					args: collectBrowserPageArgs(p),
					target: typeof p.target === "string" && p.target.length > 0 ? p.target : undefined,
					timeoutMs: normalizePageCallTimeoutMs(p.timeoutMs),
				},
				{
					aborted: signal?.aborted,
				},
				ownerId,
			);
			if (!resolved.ok) {
				// 抛 Error 而不是回一段失败文本：模型需要看到「工具失败」才会改策略。
				throw new Error(formatBrowserPageError(op, resolved.error));
			}
			const shot = extractShotImage(resolved.result);
			if (!shot) {
				// 工具结果：read 的正文原样给模型，结构化结果 JSON 缩进；details 留 UI/轨迹。
				return {
					content: [{ type: "text", text: formatPageCallResult(resolved.result) }],
					details: { op, args: collectBrowserPageArgs(p), target: p.target, result: resolved.result },
				} as never;
			}
			// 截图：**主模型能看图就直接把图给回去**（当轮就能看到，不用等下一轮）；
			// 看不到图（纯文本模型）就交给视觉桥转写成文字证据 —— 与用户粘贴图片走同一套
			// 选择逻辑与提示词，设置里开着就自动生效，模型侧不需要任何额外配置。
			const where = `${p.target ?? "the page"}${shot.selector ? ` (element ${shot.selector})` : ""}`;
			const caption = [`Screenshot of ${where} — ${shot.width ?? "?"}×${shot.height ?? "?"} px.`].join("\n");
			const details = {
				op,
				args: collectBrowserPageArgs(p),
				target: p.target,
				result: { ...(resolved.result as Record<string, unknown>), image: "[image]" },
			};
			if (clientSession.canSeeImages?.() === true) {
				return {
					content: [
						{ type: "text", text: caption },
						{ type: "image", data: shot.data, mimeType: shot.mimeType },
					],
					details,
				} as never;
			}
			const bridged = await clientSession.transcribeToolImage?.(shot, signal);
			const note = bridged?.text
				? `

<vision-bridge>
${bridged.text}
</vision-bridge>`
				: [
						`

(The current model cannot see images: ${bridged?.reason ?? "vision bridge unavailable"} — ask the user to switch to an image-capable model, or add one in the model config)`,
					].join("\n");
			return {
				content: [{ type: "text", text: caption + note }],
				details,
			} as never;
		},
	} as unknown as ToolDefinition;
}

/**
 * 从扩展的截图结果里取出图片。
 *
 * 扩展回的是 `{ image: { dataUrl, mimeType, width, height }, selector?, rect?, viewport? }`；
 * dataUrl 带 `data:image/jpeg;base64,` 前缀，而模型 API 要的是**纯 base64** —— 剥前缀这一步
 * 很容易忘（忘了就是「图片解析失败」）。
 */
export function extractShotImage(
	result: unknown,
): { data: string; mimeType: string; width?: number; height?: number; selector?: string } | undefined {
	if (!result || typeof result !== "object") return undefined;
	const image = (result as { image?: unknown }).image;
	if (!image || typeof image !== "object") return undefined;
	const src = image as { dataUrl?: unknown; mimeType?: unknown; width?: unknown; height?: unknown };
	if (typeof src.dataUrl !== "string") return undefined;
	const match = /^data:([^;,]+);base64,(.+)$/s.exec(src.dataUrl);
	if (!match) return undefined;
	const selector = (result as { selector?: unknown }).selector;
	return {
		data: match[2],
		mimeType: typeof src.mimeType === "string" && src.mimeType ? src.mimeType : match[1],
		...(typeof src.width === "number" ? { width: src.width } : {}),
		...(typeof src.height === "number" ? { height: src.height } : {}),
		...(typeof selector === "string" && selector ? { selector } : {}),
	};
}

/**
 * 插件结构化工具 → SDK ToolDefinition。
 * execute 返回值宽容处理：{content,details} 原样收编；字符串/对象包成文本块。
 */
function pluginToolToDefinition(tool: PluginAgentTool): ToolDefinition {
	const normalize = (
		result: unknown,
	): {
		content: Array<{ type: "text"; text: string }>;
		details?: unknown;
	} => {
		if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
			return result as {
				content: Array<{ type: "text"; text: string }>;
				details?: unknown;
			};
		}
		const text = typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);
		return { content: [{ type: "text", text }] };
	};
	return {
		name: tool.name,
		label: tool.label ?? tool.name,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		parameters: (tool.parameters ?? {
			type: "object",
			properties: {},
		}) as ToolDefinition["parameters"],
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: unknown) => void) | undefined,
		) => {
			const raw = await tool.execute(
				toolCallId,
				params as Record<string, unknown>,
				signal,
				onUpdate ? (partial) => onUpdate(normalize(partial) as never) : undefined,
			);
			return normalize(raw) as never;
		},
	} as unknown as ToolDefinition;
}

/**
 * Cheap per-message discriminator for the serialization cache key. Persisted
 * message content never changes, so this is stable across snapshots, while
 * several same-role messages created within one millisecond (attachment
 * asides) get distinct keys. Text blocks are fingerprinted by a short hash of
 * their head (paths embedded in <file> tags can share long prefixes — e.g.
 * uploads created in the same millisecond differ only at the tail); image
 * payloads by data length (identical lengths within the same ms are far too
 * unlikely to matter).
 */
/** 消息在对话序号表（Conversation.msgIds）里的键：工具结果按 toolCallId，其余按角色 + 时间戳 + 内容指纹。 */
function uiKeyOf(m: AgentMessage): string {
	return m.role === "toolResult" ? `t:${m.toolCallId}` : `${m.role}:${m.timestamp}:${contentFingerprint(m)}`;
}

function contentFingerprint(m: AgentMessage): string {
	const content = (m as unknown as { content?: unknown }).content;
	if (!Array.isArray(content) || content.length === 0) return "empty";
	const first = content[0] as { type?: string; text?: string; data?: string };
	if (first?.type === "image") {
		return `img:${(first.data ?? "").length}`;
	}
	const text = typeof first?.text === "string" ? first.text : "";
	// djb2 — fast enough to run per snapshot, distinct enough for asides.
	let h = 5381;
	for (let i = 0; i < text.length && i < 512; i++) {
		h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
	}
	return `txt:${h.toString(36)}:${text.length}`;
}

/** lazy-images: a chat's shown messages, in the page's positions, as raw SDK messages plus their UI ids,
 *  cache keys and id suffixes. Building this is cheap (no display form, no picture data), so the server
 *  keeps it for the whole chat and builds the display form only of what it sends (fullAt).
 *  Valid while the message list is the same array with the same length and last message: pi appends in
 *  place, and a retry removes the failed reply before appending the new one. */
interface ChatIndex {
	src: readonly AgentMessage[];
	len: number;
	last: AgentMessage | undefined;
	retry: boolean;
	raw: AgentMessage[];
	keys: string[];
	ids: string[];
	seqs: number[];
}

/** uiMessageKey without a ClientSession (the picture endpoint looks chats up statically). */
function uiMessageKeyOf(conv: Conversation, m: AgentMessage): { cacheKey: string; n: number } {
	// toolResult messages are keyed by toolCallId; everything else by role+timestamp plus a content
	// fingerprint (several same-role messages can share a millisecond, e.g. attachment asides).
	const key = uiKeyOf(m);
	let n = conv.msgIds.get(key);
	if (n === undefined) {
		n = conv.nextMsgId++;
		conv.msgIds.set(key, n);
	}
	return { cacheKey: `${key}#${n}`, n };
}

/** The chat's index (see ChatIndex), rebuilt only when its message list changed. */
function chatIndexOf(conv: Conversation): ChatIndex {
	const src = conv.session.agent.state.messages;
	const retry = !!conv.retryState;
	const last = src[src.length - 1];
	const c = conv.chatIndex;
	if (c && c.src === src && c.len === src.length && c.last === last && c.retry === retry) return c;
	const raw: AgentMessage[] = [];
	const keys: string[] = [];
	const ids: string[] = [];
	const seqs: number[] = [];
	const userSeq = new Map<number, number>();
	for (const m of src) {
		// Hidden messages get a number too: n comes from a per-chat counter in first-seen order,
		// and the ids the page already holds were made that way.
		const k = uiMessageKeyOf(conv, m);
		if (!isShownMessage(m)) continue;
		// A user message's id suffix counts the user messages sharing its timestamp, in order
		// (what findEntryByUiId expects); every other role uses n.
		let seq = k.n;
		if (m.role === "user") {
			const ts = m.timestamp ?? 0;
			seq = (userSeq.get(ts) ?? 0) + 1;
			userSeq.set(ts, seq);
		}
		raw.push(m);
		keys.push(k.cacheKey);
		ids.push(uiMessageId(m, seq));
		seqs.push(seq);
	}
	// While an automatic retry waits, failed replies at the end are an intermediate state
	// (same rule as stripTransientRetryErrors).
	if (retry) {
		let end = raw.length;
		while (end > 0) {
			const m = raw[end - 1] as { role?: string; stopReason?: string };
			if (m.role === "assistant" && m.stopReason === "error") end--;
			else break;
		}
		raw.length = end;
		keys.length = end;
		ids.length = end;
		seqs.length = end;
	}
	const idx: ChatIndex = { src, len: src.length, last, retry, raw, keys, ids, seqs };
	conv.chatIndex = idx;
	return idx;
}

/** Where the page fetches picture n of a message (GET /api/chat-image, see chatImageOf). */
function chatImageUrl(conv: Conversation): ImageUrlFor {
	const sid = encodeURIComponent(conv.session.sessionId);
	return (msgId, n, v) => `/api/chat-image/${sid}/${encodeURIComponent(msgId)}/${n}?v=${v}`;
}

/** Display form of shown message i, built on first use and cached per chat. */
function fullAt(conv: Conversation, idx: ChatIndex, i: number): UiMessage {
	const key = idx.keys[i];
	const hit = conv.uiMessageCache.get(key);
	if (hit) return hit;
	const m = idx.raw[i];
	const msg: UiMessage = serializeMessage(m, idx.seqs[i], chatImageUrl(conv)) ?? {
		id: idx.ids[i],
		role: m.role,
		content: [],
		timestamp: m.timestamp,
	};
	conv.uiMessageCache.set(key, msg);
	return msg;
}

/** Display forms of shown messages [from, to). */
function fullRangeOf(conv: Conversation, idx: ChatIndex, from: number, to: number): UiMessage[] {
	const out: UiMessage[] = [];
	for (let i = Math.max(0, from); i < Math.min(to, idx.raw.length); i++) out.push(fullAt(conv, idx, i));
	return out;
}

/** Bytes of picture n of the message with UI id msgId, if its fingerprint is v; null otherwise. */
function chatImageIn(conv: Conversation, msgId: string, n: number, v: string): ChatImage | null {
	const idx = chatIndexOf(conv);
	const i = idx.ids.indexOf(msgId);
	if (i < 0) return null;
	return imageIfVersion(imageBlocksOf(idx.raw[i])[n], v);
}

// ---------------------------------------------------------------------------
// Web UI context adapter — bridges extension UI calls (setWidget/notify) to the
// browser. Extensions like rpiv-todo render a TUI widget via
// `ui.setWidget(key, (tui, theme) => comp)`; we capture the component, render it
// with a mock theme to plain text lines, and push them to the client.
// ---------------------------------------------------------------------------

function extractPartialText(partial: unknown): string | null {
	const content = (partial as { content?: unknown } | null | undefined)?.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c) => ((c as { type?: string; text?: string })?.type === "text" ? (c as { text: string }).text : ""))
			.join("");
		return text.length > 0 ? text : null;
	}
	return null;
}

function extractAssistantTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is { type: string; text: string } =>
				(c as { type?: string }).type === "text" && typeof (c as { text?: string }).text === "string",
		)
		.map((c) => c.text)
		.join("\n");
}

export { workspacePath };
// ---------------------------------------------------------------------------
// Per-client persisted UI state (<dataDir>/client-state.json)
// ---------------------------------------------------------------------------

/**
 * One open conversation (chat thread) of a client. Each conversation owns its
 * OWN AgentSessionRuntime, so starting a new chat or switching between chats
 * never interrupts another conversation's in-flight run.
 *
 * 导出给过户载荷类型（TakeoverPayload）用：对话对象本身在会话之间整体搬迁。
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
	/** 下一轮 agent_start 消费的用户任务文本（prompt() 暂存，轨迹插件的 run_start 用；
	 *  steer/内部续跑无暂存时为空，由插件回退为「继续执行」）。 */
	pendingTask?: string;
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
	/** optimistic-send: the receipt of the prompt whose user message is about to start a run. The
	 *  next user message_end of this chat is that message: its snapshot goes out, then this ack. */
	ackOnUserMessage?: PromptReceipt;
}

/** 轨迹事件 payload 封顶（可直接广播/持久化，不撑爆 storage.json）。 */
const RUN_TASK_CAP = 500;
const RUN_ARGS_CAP = 4000;
const RUN_RESULT_CAP = 4000;

function truncRun(s: string, cap: number): string {
	return s.length <= cap ? s : `${s.slice(0, cap)}\n… [truncated]`;
}

/** 从 SDK tool result 里抠可读文本预览（text 块拼接，图片/二进制占位，封顶）。 */
function previewToolResult(result: unknown): string {
	try {
		const content = (result as { content?: unknown })?.content;
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const c of content) {
				if (c && typeof c === "object" && (c as { type?: unknown }).type === "text") {
					parts.push(String((c as { text?: unknown }).text ?? ""));
				} else {
					parts.push("[…]");
				}
			}
			return truncRun(parts.join("\n"), RUN_RESULT_CAP);
		}
		if (typeof result === "string") return truncRun(result, RUN_RESULT_CAP);
		return truncRun(JSON.stringify(result ?? null), RUN_RESULT_CAP);
	} catch {
		return "[unserializable result]";
	}
}

/**
 * 转录整文件重写的原子落盘：先写同目录临时文件再 rename。转录是 append-only
 * 的唯一事实源，compaction 收尾/清理的整文件重写若中途被打断（进程被杀/断电），
 * 原地 writeFileSync 会留下截断的 JSONL；同目录 rename 是原子的，最坏情况是
 * 旧文件原样保留，绝不会出现半份转录。Windows 下目标被外部占用（阅读器/杀软
 * 锁）时 rename 可能 EPERM —— 退回原地写保住功能（旧行为），不因小概率锁失败丢更新。
 */
function atomicWriteFileSync(file: string, data: string): void {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmp, data);
		try {
			renameSync(tmp, file);
		} catch {
			writeFileSync(file, data);
		}
	} finally {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// 临时文件清不掉只能留给下次（同目录 .tmp，不影响转录本身）
		}
	}
}

/** Cap on simultaneously open NON-subagent conversations of ONE project (each keeps a full
 *  runtime alive; conversations of other projects keep their own lists).
 *  子代理不计入：子代理是 inMemory 后台任务，不参与此上限，既不占位也不被此上限拦截。 */
const MAX_OPEN_CONVERSATIONS = 8;

/** optimistic-send: how far one prompt() got, for its final answer (see ClientSession.prompt). */
interface PromptFlow {
	/** pi put the text off until the previous run has settled: its preflight callback answers later. */
	deferred: boolean;
	/** pi took the text (its preflight said yes). */
	handedOver: boolean;
	/** The prompt's place in the chat's line (a slash command gives it up and may take a new one). */
	admission: PromptAdmission;
}

/** optimistic-send: prompt_ack reasons (English, shown under a "Not sent" message). */
const TRANSCRIPT_BLOCKED_REASON =
	"This chat ends with a tool call that never got a result, so it can't take new messages. Open it again from history or start a new chat.";
const STOPPED_BEFORE_SEND_REASON = "Stopped before it was sent.";

/** carry-on: the process-wide live list of working chats (set by AgentService.prepareCarryOn). */
let runningChats: RunningChats | null = null;
/** carry-on: the pseudo client that reopens cut-off chats after a restart. */
const CARRY_ON_CLIENT_PREFIX = "carry-on:";
/** wake-reopen: the pseudo client (a carry-on one) that reopens a closed chat for its scheduled wake-up. */
const WAKE_REOPEN_CLIENT_ID = `${CARRY_ON_CLIENT_PREFIX}wake`;
const WAKE_REOPEN_SINK = (): void => {};
/** queue-lanes: the pseudo clients through which the queue host (queue-host.ts) opens chats: one
 *  starts the task chats, the other opens a chat to run a queue command in it. Carry-on ones: they
 *  get past the carry-on gate and start on a blank chat. */
const QUEUE_TASKS_CLIENT_ID = `${CARRY_ON_CLIENT_PREFIX}queue`;
const QUEUE_HOME_CLIENT_ID = `${CARRY_ON_CLIENT_PREFIX}queue-home`;
const QUEUE_HOST_SINK = (): void => {};

/** carry-on: the chat's transcript as the live list keys it (null for chats that don't count). */
function runningRef(conv: Conversation): { sessionFile: string; title: string; cwd: string } | null {
	if (conv.isSubagent || conv.isEphemeral) return null;
	try {
		const file = conv.session.sessionFile;
		return file ? { sessionFile: resolve(file), title: conv.title, cwd: conv.cwd } : null;
	} catch {
		return null; // runtime being replaced
	}
}

/** fast-mode: this run ended on a refused fast reply that the fast-mode extension retries at
 *  normal speed right away — the same turn going on, like the SDK's own auto-retry. */
function fastRetryAfter(conv: Conversation, messages: readonly unknown[]): boolean {
	try {
		return fastModeRegistry.retryPending(conv.session.sessionManager, messages);
	} catch {
		return false; // runtime being replaced
	}
}

/** carry-on: keep the live list of working chats up to date from the SDK events. */
function trackRunning(conv: Conversation, event: AgentSessionEvent): void {
	const list = runningChats;
	if (!list) return;
	if (
		event.type !== "agent_start" &&
		event.type !== "agent_end" &&
		event.type !== "tool_execution_start" &&
		event.type !== "tool_execution_end"
	)
		return;
	const ref = runningRef(conv);
	if (!ref) return;
	try {
		if (event.type === "agent_start") list.start(ref);
		else if (event.type === "agent_end") {
			// A failed call the SDK retries is the same turn going on (so is a refused fast reply).
			if (!event.willRetry && !fastRetryAfter(conv, event.messages)) list.finish(ref.sessionFile);
		} else if (event.type === "tool_execution_start")
			list.toolStart(ref, {
				id: event.toolCallId,
				name: event.toolName,
				detail: toolDetail(event.toolName, event.args),
			});
		else list.toolEnd(ref, event.toolCallId);
	} catch {
		// bookkeeping never breaks a run
	}
}
/** 同时存活的子代理上限（按客户端计，含嵌套派生的孙子辈）。每个子代理都是一个完整
 *  runtime + TerminalManager，无上限时 AI 一次并行派发几十个会把服务进程拖垮。
 *  主对话的 8 个上限是按项目计的，子代理按客户端全局计（wait_all 本来就是全局口径）。 */
const MAX_SUBAGENTS = 16;
/** SubagentSnapshot.prompt 下发上限：存的是全量 prompt，快照里只带前 N 字符，
 *  避免 subagent_list 一次把几个长 prompt 全推给模型烧 token。 */
const SUBAGENT_PROMPT_SNAPSHOT_CAP = 2000;
const DEFAULT_CONV_TITLE = "New chat";
/** Chats saved before pi-web-ui went English-only were titled 新对话: they still count as untitled. */
const LEGACY_CONV_TITLE = "新对话";
const isUntitledTitle = (title: string): boolean => title === DEFAULT_CONV_TITLE || title === LEGACY_CONV_TITLE;

/** First user text in a session, truncated for the conversation list. */
function conversationTitle(session: AgentSession): string {
	try {
		const named = session.sessionManager.getSessionName();
		if (named && named.trim()) return named.trim();
	} catch {
		// best-effort — fall through to first-message title
	}
	try {
		for (const m of session.agent.state.messages) {
			if (m.role !== "user") continue;
			const content = m.content as unknown;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				for (const p of content) {
					if (
						p &&
						typeof p === "object" &&
						(p as { type?: unknown }).type === "text" &&
						typeof (p as { text?: unknown }).text === "string"
					) {
						text = (p as { text: string }).text;
						break;
					}
				}
			}
			const trimmed = text.trim().replace(/\s+/g, " ");
			if (trimmed.length > 0) {
				return trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
			}
		}
	} catch {
		// best-effort
	}
	return DEFAULT_CONV_TITLE;
}

/** 全局搜索的会话匹配：大小写不敏感，命中任一项即算 ——
 *  显示名、当前项目内的文件名片段、首条消息，以及完整转录文本
 *  （SDK 的 allMessagesText 包含每一段 user 与 assistant 消息，AI 输出也在内）。 */
function sessionMatchesSearch(q: string, s: SessionInfo): boolean {
	if (s.name && s.name.toLowerCase().includes(q)) return true;
	if (basename(s.path).toLowerCase().includes(q)) return true;
	if (s.firstMessage.toLowerCase().includes(q)) return true;
	if (s.allMessagesText.toLowerCase().includes(q)) return true;
	return false;
}

/** 抽取一条 AgentMessage 的可搜索文本（user/assistant 的 text 块；
 *  镜像 SDK buildSessionInfo 的 allMessagesText 范围，保证搜索与定位一致）。 */
function messageSearchText(m: { content?: unknown }): string {
	const c = m.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	const parts: string[] = [];
	for (const b of c) {
		if (!b || typeof b !== "object") continue;
		const blk = b as { type?: unknown; text?: unknown };
		if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
	}
	return parts.join("\n");
}

/** 转录全文扫描/整读的大小上限（16MB，与 readHistorySession 一致）：
 *  超限文件同步 readFileSync 会卡事件循环数百毫秒起，搜索不值得。 */
const MAX_TRANSCRIPT_SCAN_BYTES = 16 * 1024 * 1024;

/** 扫描一个会话转录文件，收集文本命中查询的消息锚点（role + timestamp，
 *  按转录顺序，最多 cap 个）。仅 user/assistant 消息参与，与搜索范围一致。
 *  超过大小上限的转录直接跳过（stat 先行，不整读）—— 全局搜索逐会话同步
 *  扫描，无上限时一个大转录就能冻住整个事件循环。 */
function collectSessionAnchors(filePath: string, q: string, cap = 10): MessageAnchor[] {
	const anchors: MessageAnchor[] = [];
	if (!q) return anchors;
	try {
		if (statSync(filePath).size > MAX_TRANSCRIPT_SCAN_BYTES) return anchors;
		const lines = readFileSync(filePath, "utf8").split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			let e: {
				type?: unknown;
				message?: { role?: unknown; timestamp?: unknown; content?: unknown };
			};
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			if (e?.type !== "message") continue;
			const m = e.message;
			if (!m) continue;
			if (m.role !== "user" && m.role !== "assistant") continue;
			if (typeof m.timestamp !== "number") continue;
			const text = messageSearchText(m);
			if (!text || !text.toLowerCase().includes(q)) continue;
			anchors.push({ role: m.role, timestamp: m.timestamp });
			if (anchors.length >= cap) break;
		}
	} catch {
		// 单个转录损坏不影响其余会话
	}
	return anchors;
}

/**
 * pi 的会话存储根目录。设置了 `PI_CODING_AGENT_SESSION_DIR` 时，pi 将 transcript
 * 以**扁平布局**直接写在根目录顶层（`<root>/<timestamp>_<uuid>.jsonl`，所属 cwd 是
 * 文件内字段）；未设置时走 SDK 默认的 `<agentDir>/sessions/--<cwd>--/` 每-cwd
 * 子目录布局（此时必须**不传** sessionDir，让 SDK 落回默认路径）。
 *
 * 注意：未设置 env 时**不要**回退返回 `join(getAgentDir(), "sessions")`——那样会把
 * 根目录强塞给 SDK `list()/listAll()`，它们只会扫根目录**顶层** jsonl，默认子目录布局
 * 下顶层为空，历史对话/最近项目会全丢（回归风险，已在 0.84.4 实证）。
 */
export function piSessionsRoot(): string | undefined {
	return process.env.PI_CODING_AGENT_SESSION_DIR || undefined;
}

/** Guardrail: only transcripts under a sessions root may be opened/deleted/renamed
 *  — never arbitrary files. Two roots count as “a sessions root”, and they must stay
 *  the **same two** the history list reads from (`loadSessionInfos` →
 *  `SessionManager.list(cwd, piSessionsRoot())`):
 *
 *   1. `<agentDir>/sessions/`（SDK 默认的每-cwd 子目录布局）
 *   2. `PI_CODING_AGENT_SESSION_DIR`（扁平「额外会话根」，设了就以它为准扫盘）
 *
 *  只认第 1 条会让设了该变量的用户「历史列得出来、却点不开/删不掉/改不了名」
 *  （列表与打开两边口径不一致）。守卫的意图是「不许开任意文件」，不是「只许开
 *  默认目录下的文件」，所以放宽到两个根仍然成立。
 *  Shared by deleteSession/renameSession/switchSession so the open path cannot
 *  escape the confinement the write paths already enforce. */
export function isInsideSessionsDir(agentDir: string, targetPath: string): boolean {
	const abs = resolve(targetPath);
	const roots = [resolve(agentDir, "sessions")];
	const extra = piSessionsRoot();
	if (extra) roots.push(resolve(extra));
	return roots.some((root) => abs.startsWith(root + sep));
}

/** 会话当前模型的 "provider/id"（无模型时 null；软上限按模型覆盖用，issue #229）。 */
function modelKeyOf(session: { model?: { provider?: unknown; id?: unknown } | null }): string | null {
	const m = session?.model;
	if (!m || typeof m.provider !== "string" || typeof m.id !== "string") return null;
	return `${m.provider}/${m.id}`;
}

/** 会话当前模型的上下文窗口（未知时 0）：live 统计优先，模型定义回落。 */
function contextWindowOf(session: {
	getSessionStats?: () => { contextUsage?: { contextWindow?: unknown } | null };
	model?: { contextWindow?: unknown } | null;
}): number {
	try {
		const live = session?.getSessionStats?.()?.contextUsage?.contextWindow;
		if (typeof live === "number" && live > 0) return Math.floor(live);
	} catch {
		// 会话未就绪 → 回落模型定义。
	}
	const def = (session as { model?: { contextWindow?: unknown } | null })?.model?.contextWindow;
	return typeof def === "number" && def > 0 ? Math.floor(def) : 0;
}

/** issue #145：跨客户端同会话持有者（AgentService.clients 全局查重的结果）。
 *  connected=false = 对端已断开（标签页关了，ClientSession 残留）：
 *  streaming 照拦（后台 run 不随标签页消失），idle 警告不再打扰。 */
export interface SessionOwnerInfo {
	clientId: string;
	title: string;
	cwd: string;
	isStreaming: boolean;
	connected: boolean;
}

/** issue #145：别处在同一项目下正在跑的对话（同项目并行感知用）。 */
export interface ProjectRunnerInfo {
	clientId: string;
	title: string;
	sessionFile?: string;
}

/**
 * 浏览器重启认领（orphan adoption）的候选快照 —— 纯数据，决策逻辑见
 * pickAdoptableOrphan（纯函数，可单测）。live = 还有浏览器连着（sinkCount>0）；
 * pseudo = 插件/调度伪客户端（sink 常驻，不能按浏览器存活判断，永远不参与认领）。
 */
export interface OrphanCandidate {
	id: string;
	live: boolean;
	pseudo: boolean;
	/** 正在跑的对话数（主对话 + 子代理都算）。 */
	streaming: number;
	/** 是否有值得认领的内容（跑着 / 后台挂着 / 有消息历史；纯空白会话不算）。 */
	adoptable: boolean;
	/** 最近活跃时间（各对话 lastActiveAt/lastSdkEventAt 的最大值）。 */
	activity: number;
}

/**
 * 选一个断开的残留会话给新标签认领（纯函数）：
 * - 还有别的在线浏览器（非伪客户端且 live）→ 不认领（新标签是第二块屏，
 *   issue #10 的隔离必须保留，跑着的对话继续走 elsewhere 只读感知）。
 * - 否则在断开 + 非伪 + 有内容的候选中按（streaming 多 → 最近活跃）取最优；
 *   没有返回 null（调用方走正常新建流程）。
 */
export function pickAdoptableOrphan(cands: OrphanCandidate[]): string | null {
	if (cands.some((c) => !c.pseudo && c.live)) return null;
	let best: OrphanCandidate | null = null;
	for (const c of cands) {
		if (c.pseudo || c.live || !c.adoptable) continue;
		if (!best || c.streaming > best.streaming || (c.streaming === best.streaming && c.activity > best.activity)) {
			best = c;
		}
	}
	return best?.id ?? null;
}

/** 手动过户时跟着对话一起搬走的等答复问卷（id 在目标会话重排）. */
export interface TakeoverQuestion {
	resolve: (value: QuestionAnswer[] | null) => void;
	questions: UiQuestion[];
	conversationId: string;
	/** telegram-answers: its id in the list of asks, kept across the move. */
	askId?: string;
}

/** 手动过户时跟着对话一起搬走的页调用（id/计时器在目标会话重建）. */
export interface TakeoverPageCall {
	resolve: (r: PageCallResult) => void;
	req: PageCallRequest;
	timeoutMs: number;
	conversationId: string;
}

/** 手动过户时跟着对话一起搬走的待审批（id 在目标会话重排）. */
export interface TakeoverApproval {
	resolve: (res: ToolApprovalResolution) => void;
	toolCallId: string;
	toolName: string;
	params: Record<string, unknown> | unknown;
	reason?: string;
	reasonEn?: string;
	category?: UiApprovalCategory;
	conversationId: string;
	conversationTitle?: string;
	createdAt: number;
}

/** 手动过户载荷：对话对象（含 runtime/终端/队列/缓存）整体搬迁 + 桥接中的问卷/页调用/待审批. */
export interface TakeoverPayload {
	convs: Conversation[];
	questions: TakeoverQuestion[];
	pageCalls: TakeoverPageCall[];
	approvals: TakeoverApproval[];
}

/** 同项目判定（纯函数）：调度视口回退与 id 唤醒的 cwd 护栏用。
 *  Windows 大小写/分隔符差异归一，空串永不相等。 */
export function sameCwd(a: string, b: string): boolean {
	const x = String(a ?? "").trim();
	const y = String(b ?? "").trim();
	if (!x || !y) return false;
	const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	if (norm(x) === norm(y)) return true;
	try {
		return norm(resolve(x)) === norm(resolve(y));
	} catch {
		return false;
	}
}

/**
 * 超时杀进程树的决策（纯函数，可单测）。runAsync 的超时兜底用：
 * - win32：shell:true 实际起的是 cmd.exe，p.kill() 只杀 cmd 本身，npm/git 的
 *   孙进程照活 —— 必须走 `taskkill /PID <pid> /T /F` 才能整树带走；
 * - posix：配合 spawn 的 detached:true，向负 pid（整组）发 SIGTERM。
 * 返回决策而不是直接执行，执行留在调用方（便于注入/测试）。
 */
export function processTreeKillPlan(
	platform: NodeJS.Platform,
	pid: number | undefined,
):
	| { kind: "taskkill"; cmd: string; args: string[] }
	| { kind: "group-signal"; signal: NodeJS.Signals }
	| { kind: "none" } {
	if (!pid || pid <= 0) return { kind: "none" };
	if (platform === "win32") return { kind: "taskkill", cmd: "taskkill", args: ["/PID", String(pid), "/T", "/F"] };
	return { kind: "group-signal", signal: "SIGTERM" };
}

/**
 * /cwd 目标解析（纯函数，可单测）：
 * - 相对路径以**当前会话 cwd** 为基准（/cwd src = 当前项目的 src），不按 server
 *   进程 cwd 解析 —— 两者经常不同，按进程 cwd 切必错位。绝对路径不受基准影响
 *   （resolve 遇到绝对段会丢弃前面的基准）。
 * - win32 裸盘符（"C:"）：resolve 会按该盘当前目录解析，必须显式指到盘根；仅
 *   win32 生效——posix 下 "C:" 仍是普通相对路径，避免误伤同名目录。
 */
export function resolveCwdTarget(
	raw: string,
	sessionCwd: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const trimmed = String(raw ?? "").trim();
	if (platform === "win32" && /^[A-Za-z]:$/.test(trimmed)) {
		return `${trimmed.toUpperCase()}\\`;
	}
	return resolve(sessionCwd, trimmed);
}

/**
 * History 面板 / 会话搜索的范围（默认 `"all"`）。
 *
 *   `"all"`     — 共享会话根下**所有项目**的转录（各 cwd 的
 *                 `<agentDir>/sessions/--<cwd>--/`），按时间倒序。切工作目录
 *                 不再换掉列表；点开别的文件夹的对话会跟着切到**该对话自己的
 *                 cwd**（`switchSession()` 本来就这么做，工具要在它的目录里跑）。
 *   `"project"` — 只列当前 cwd 的转录（原来的按文件夹行为）。
 *
 * 环境变量 `PI_WEB_UI_HISTORY_SCOPE=project` 切回按文件夹。
 */
export function historyScope(): "all" | "project" {
	return process.env.PI_WEB_UI_HISTORY_SCOPE === "project" ? "project" : "all";
}

/**
 * 左栏「最近对话」里最多常驻多少条**已经不在运行的**历史对话（recent-chats
 * 补丁）。活着的对话不受此限（它们本来就全部入列）。
 * `PI_WEB_UI_RECENT_LIMIT=0` 关掉常驻行（退回上游的「只列运行中」行为）。
 */
/**
 * 打开别的文件夹的对话时，**工作区要不要跟着跳**（chat-cwd-pin 补丁）。
 *
 * 默认 `false` = 钉住：左栏「最近对话」是跨文件夹的，来回点几条就把文件树、
 * 最近项目排序、新建对话的落点来回抽 —— 而用户只是想看/继续那条对话。
 * 对话自己的 cwd（`conv.cwd`，工具真正跑的地方）不受影响：它绑在运行时上，
 * 跨文件夹的行在左栏有文件夹分组标题/徐章可认。工作区只由**显式**动作改变
 * （选项目 / set_cwd）。
 *
 * `PI_WEB_UI_CHAT_FOLLOWS_CWD=1` 恢复上游的「切对话就切工作区」。
 */
export function chatFollowsWorkspace(): boolean {
	const raw = (process.env.PI_WEB_UI_CHAT_FOLLOWS_CWD ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}

export function recentChatLimit(): number {
	const raw = Number.parseInt(process.env.PI_WEB_UI_RECENT_LIMIT ?? "", 10);
	if (Number.isFinite(raw) && raw >= 0) return Math.min(raw, 200);
	return 15;
}

/**
 * flat-recent-chats：从转录文件名解出**创建时间**。
 *
 * pi 的转录文件名长这样：`2026-09-14T01-39-55-678Z_<id>.jsonl` —— 前缀就是
 * 创建时刻，而且写完就不再变。用它而不用 mtime：mtime 是「最后活动」，继续
 * 聊一句就会变，那恰好是我们不想让列表重排的原因。
 *
 * 时间部分的分隔符是 `-`（文件名不能用 `:`），毫秒前也是 `-`，所以不能
 * 直接 Date.parse，得先拼回 ISO 形状。解不出来返回 undefined，由调用方退回 mtime。
 */
export function sessionCreatedAt(path: string): number | undefined {
	const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(
		path.replace(/\\/g, "/").split("/").pop() ?? "",
	);
	if (!m) return undefined;
	const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
	return Number.isFinite(ms) ? ms : undefined;
}

/** busy-endpoint：此刻在干活的一条对话（GET /api/busy 的一项）。
 *  doing：run = 正在跑一轮；compaction = 正在压缩；bash = 正在跑用户的 `!` 命令。 */
export interface BusyConversation {
	id: string;
	title: string;
	cwd: string;
	doing: "run" | "compaction" | "bash";
	subagent?: true;
}

export class ClientSession {
	readonly clientId: string;
	/** Set by AgentService.attach: reflects the SERVICE-wide quiesce flag
	 *  (server draining — new work rejected). Default false for direct use. */
	isQuiesced: () => boolean = () => false;
	cwd: string;
	/** 当前项目的额外工作区根（宿主侧多根，见 protocol 的 set_workspace_roots）——
	 *  按 cwd 存在 client-state 里，这里只存一份内存缓存给快照热路径读。 */
	private roots: string[] = [];
	/** pi config dir (auth/models/skills). */
	private readonly agentDir: string;
	/** Persisted per-client UI state (last workspace + recent projects). */
	private readonly stateStore: ClientStateStore;
	/** Open conversations — each owns its OWN runtime, so starting a new chat
	 *  or switching chats never interrupts an in-flight run. `runtime` and
	 *  `session` accessors below target the ACTIVE conversation.
	 *
	 *  **进程级共享**（server-owned-chats 补丁）：对话属于**服务端**，不属于某个
	 *  客户端。每个浏览器只是一个「视图」——自己选 activeId 看哪条，看同一条也行、
	 *  看不同条也行。这样就没有「持有者」这回事了：不再有第二个 writer 的风险
	 *  （一条对话永远只有一个 runtime），也不再需要拒绝/加入/另一处那一整套。 */
	private get convs(): Map<string, Conversation> {
		return ClientSession.sharedConvs;
	}
	/** 所有客户端共用的一份对话表（见上）。 */
	private static readonly sharedConvs = new Map<string, Conversation>();

	/** reload-adopt：共享表里已经开着的对话（只暴露判断所需的字段）。 */
	static openConversations(): AdoptCandidate[] {
		const out: AdoptCandidate[] = [];
		for (const c of ClientSession.sharedConvs.values()) {
			out.push({ id: c.id, cwd: c.cwd, lastActiveAt: c.lastActiveAt, isSubagent: c.isSubagent });
		}
		return out;
	}

	/** busy-endpoint：整个进程里此刻在干活的对话，不管哪个窗口开着它、有没有被换到后台。
	 *  `conversations` 推送是按窗口给的（shownInRunningList：后台对话 + 自己正在看的那条），
	 *  新连上的客户端看不到别的窗口前台里跑着的对话；pi-web-deploy 靠这份表判断现在能不能重启。
	 *  对话表是进程共享的（server-owned-chats），所以每条只出现一次。 */
	static busyConversations(): BusyConversation[] {
		const out: BusyConversation[] = [];
		for (const c of ClientSession.sharedConvs.values()) {
			let doing: BusyConversation["doing"] | undefined;
			try {
				const s = c.session;
				// (optimistic-send: a message still in the add-ons' "before the AI starts" step is a run starting.)
				doing =
					s.isStreaming || (c.sendsInFlight ?? 0) > 0
						? "run"
						: s.isCompacting
							? "compaction"
							: s.isBashRunning
								? "bash"
								: undefined;
			} catch {
				// 会话替换中——按没在干活算（同 conversationStreaming）
			}
			if (!doing) continue;
			out.push({ id: c.id, title: c.title, cwd: c.cwd, doing, ...(c.isSubagent ? { subagent: true as const } : {}) });
		}
		return out;
	}

	/** lazy-images: GET /api/chat-image. Picture n of the message with UI id msgId, if its content
	 *  fingerprint is v. Looks in the chat with this session id first, then in every open chat (a
	 *  placeholder can outlive its session id, e.g. after a fork), then by fingerprint alone (after a
	 *  rewind renumbers the messages). Only open chats, only memory: no file path is involved. */
	static chatImage(sessionId: string, msgId: string, n: number, v: string): ChatImage | null {
		const convs = [...ClientSession.sharedConvs.values()];
		const own = convs.filter((c) => c.session?.sessionId === sessionId);
		for (const c of [...own, ...convs.filter((c) => !own.includes(c))]) {
			try {
				const hit = chatImageIn(c, msgId, n, v);
				if (hit) return hit;
			} catch (err) {
				// A chat being replaced right now: try the others.
				console.warn("[chat-image] skipped a chat while looking up a picture:", err);
			}
		}
		for (const c of convs) {
			try {
				for (const m of c.session.agent.state.messages) {
					for (const b of imageBlocksOf(m)) {
						const hit = imageIfVersion(b, v);
						if (hit) return hit;
					}
				}
			} catch (err) {
				console.warn("[chat-image] skipped a chat while looking up a picture:", err);
			}
		}
		return null;
	}
	/** 本客户端**正在看**哪条对话（纯视图状态，不代表所有权）。 */
	private activeId = "";
	/** 对话表是**进程共享**的，所以它的键必须进程唯一 —— 计数器跟着改成 static。
	 *  （原来每个 ClientSession 自己数：两个窗口各自生成 `c1`，后来的那个
	 *   `convs.set("c1", …)` 会把前一个窗口的对话从共享表里静静换掉 ——
	 *   正是 server-owned-chats 声称在结构上不可能出现的那个第二个 writer。
	 *   同 questionSeq：共享注册表 + 私有序号 = 撞键。） */
	private static convSeq = 0;
	/** One ModelRuntime shared by all conversations — the model chosen in the
	 *  top bar applies to every chat, not just the one that set it. Seeded by
	 *  the first conversation and reused by later ones. */
	private sharedModelRuntime: Awaited<ReturnType<typeof createAgentSessionServices>>["modelRuntime"] | undefined;

	// -----------------------------------------------------------------------
	// Goal / review / wizard —— 自包含模块，见 goal-service.ts。每个对话有独立
	// 的 GoalStatus，审查可并发；宿主回调在构造函数里接入。
	// -----------------------------------------------------------------------
	private readonly goalSvc: GoalService;
	/** Settings-panel state (system prompt + disabled skills/extensions) —
	 *  自包含模块，见 settings-service.ts。resource-loader overrides 在每次
	 *  reload() 时读 current 的最新值，session.reload() 即可应用到运行中 runtime。 */
	private settingsSvc!: SettingsService; // 构造函数里创建（需要 clientId/stateStore）
	/** How long a hard abort waits for session.abort() to make the run idle
	 *  before force-resetting the conversation (model streams that ignore the
	 *  abort signal would otherwise leave the chat stuck forever). */
	private static readonly HARD_ABORT_TIMEOUT_MS = 15_000;
	/** Extra settle window after session.abort() returns: the run is only
	 *  considered stopped once its agent_end event arrives. If it doesn't
	 *  (model stream stuck before the run even started), force-reset. */
	private static readonly HARD_ABORT_SETTLE_MS = 8_000;
	/** Live AbortControllers of THIS client's running bash tool calls — aborting
	 *  them kills only the command (agent run and conversation continue). */
	private bashKills = new Set<AbortController>();
	/** Background-server tracking (port snapshots + 后台任务 panel state) —
	 *  自包含模块，见 bg-servers.ts。列表按 CLIENT 存活，不随对话切换/结束消失。 */
	/** 文件树 / 预览读写 / SCM 查询 / watcher —— 自包含模块，见 files-service.ts。 */
	private readonly files = new FilesService({
		emit: (msg) => this.emit(msg),
		isDisposed: () => this.disposed,
		getCwd: () => this.cwd,
		getActiveCwd: () => this.convs.get(this.activeId)?.cwd ?? this.cwd,
		// issue #91：文件服务错误文案按客户端 UI 语言出中英（英文默认）。
		getLang: () => this.getLang(),
	});
	private readonly bg = new BgServerTracker({
		emit: (msg) => this.emit(msg),
		flushSnapshot: () => this.flushSnapshot(),
		isDisposed: () => this.disposed,
		// 插件注册的常驻任务（host.registerBackgroundTask）并入同一「后台任务」面板。
		pluginTasks: () => this.pluginBgTasksProvider?.() ?? [],
	});

	/** index.ts 注入（经 AgentService 拷贝到每个新会话）：把 SDK 工具执行事件转发给
	 *  插件（PluginManager.emitToolEvent）。未设置时不做任何事。 */
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	/** index.ts 注入（P1-5，经 AgentService 拷贝到每个新会话）：bash/read 执行前后的
	 *  插件拦截（PluginManager.evaluateToolPre/evaluateToolPost）。未设置时直通。 */
	toolGuard: ToolGuardHook | undefined = undefined;
	/** index.ts 注入：把运行轨迹事件转发给插件（PluginManager.emitRunEvent，
	 *  轨迹视图插件靠它聚合时间线）。未设置时不做任何事。 */
	onRunEvent: ((ev: PluginRunEvent) => void) | undefined = undefined;
	/** index.ts 注入：当前打开对话变了（切历史会话/切 running 对话/新对话）时
	 *  通知插件（PluginManager.emitConversationChanged）——轨迹视图靠它重拉。 */
	onConversationChanged: (() => void) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的 AI 工具（attach 时拷贝到每个新会话）。 */
	pluginToolsProvider: (() => PluginAgentTool[]) | undefined = undefined;
	/** index.ts 经 AgentService 注入：内置调度存储（定时任务 Agent 工具用；未注入时工具直接报错）。 */
	schedulerStore: SchedulerStore | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的斜杠命令（目录展示 + prompt 拦截执行）。 */
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined = undefined;
	/** index.ts 注入：读取插件注册的常驻后台任务（并入 bg_servers 面板）。 */
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	/** index.ts 注入：停止插件任务（kill_background_server with taskId）。 */
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	/** 上一轮注入会话的插件工具名集合（用于检测注销/移除）。 */
	private appliedPluginToolNames = new Set<string>();

	/** The active conversation (all session operations target it). */
	private get conv(): Conversation {
		const conv = this.convs.get(this.activeId);
		if (!conv) throw new Error("no active conversation");
		return conv;
	}
	/** Runtime of the active conversation. */
	get runtime(): AgentSessionRuntime {
		return this.conv.runtime;
	}
	/** Session of the active conversation. */
	get session(): AgentSession {
		return this.conv.session;
	}

	/** PTYs are owned by individual conversations; this getter targets the active one
	 * for compatibility with the existing terminal-panel dispatch path. */
	get terminals(): TerminalManager {
		return this.conv.terminals;
	}

	getTerminalManager(conversationId?: string): TerminalManager | undefined {
		return (conversationId ? this.convs.get(conversationId) : this.convs.get(this.activeId))?.terminals;
	}

	getTerminalCwd(conversationId?: string): string {
		return (conversationId ? this.convs.get(conversationId) : this.convs.get(this.activeId))?.cwd ?? this.cwd;
	}

	private makeTerminalManager(conversationId: string, cwd: string): TerminalManager {
		const mgr = new TerminalManager(
			(msg) => this.emitTerminal(conversationId, msg),
			cwd,
			// issue #91：终端输入错误按客户端 UI 语言出中英（英文默认）。
			() => this.getLang(),
		);
		// 终端活力检测：AI 触碰过的终端静默 ≥ 阈值（PI_WEB_TERMINAL_IDLE_MS，
		// 默认 15s）且该对话正在运行时，注入一条 steer 消息唤醒 AI 去检查。
		mgr.onAgentIdle = (terminalId, idleMs, title, lastLines) =>
			this.notifyTerminalIdle(conversationId, terminalId, idleMs, title, lastLines);
		return mgr;
	}

	/** 终端活力提醒：仅在该对话正在流式运行时注入（sendUserMessage 在流式中
	 *  即 steer 语义——当前回合结算后送达，agent 立即响应）；空闲时不打扰。
	 *  一次性语义由 TerminalManager 保证（触发后解除武装，agent 再次触碰才
	 *  重新计时），不会反复刷屏。 */
	private notifyTerminalIdle(
		conversationId: string,
		terminalId: string,
		idleMs: number,
		title: string,
		lastLines = "",
	): void {
		const conv = this.convs.get(conversationId);
		if (!conv || this.disposed) return;
		if (!conv.runtime.session.isStreaming) return;
		const seconds = Math.max(1, Math.round(idleMs / 1000));
		void conv.runtime.session
			.sendUserMessage(
				`(System auto-reminder: the terminal "${title}" you started (id=${terminalId}) has had no new output for ${seconds} seconds. ` +
					`The process may be waiting for input, stuck or hung.\nRecent output:\n${lastLines || "(no output)"}\n` +
					`Use terminal_read(terminalId="${terminalId}") to check or search its current state; ` +
					`if it is waiting for input, answer with terminal_input / terminal_key; if it is no longer needed, close it with terminal_close.)`,
			)
			.catch(() => {
				// best effort —— 注入失败不影响终端本身
			});
	}

	/**
	 * 终端接管的 bash 静默转后台后的完成通知：命令真正结束时主动告诉 AI。
	 * 流式中 → sendUserMessage（steer，立即唤醒处理）；空闲时 → sendCustomMessage
	 * nextTurn 排队（不唤醒 agent、不耗 token，下次对话自动带上）。
	 */
	private notifyTerminalBashDone(
		terminals: TerminalManager,
		info: { terminalId: string; command: string; exitCode: number | null },
	): void {
		const conv = [...this.convs.values()].find((c) => c.terminals === terminals);
		if (!conv || this.disposed) return;
		let tail = "";
		try {
			const end = terminals.endCursor(info.terminalId);
			if (end !== null) {
				tail = terminals.read(info.terminalId, Math.max(0, end - 4000))?.data ?? "";
			}
		} catch {
			// 终端可能已被关闭
		}
		const exitText = info.exitCode === null ? "terminal closed" : `exit code ${info.exitCode}`;
		const cmdShort = info.command.length > 120 ? `${info.command.slice(0, 120)}…` : info.command;
		const text =
			`(System: the command you ran in the background in terminal ${info.terminalId} has finished (${exitText}): ${cmdShort}\n` +
			`Last output:\n${stripAnsi(tail).trim() || "(no output)"})`;
		const session = conv.runtime.session;
		if (session.isStreaming) {
			void session.sendUserMessage(text).catch(() => {});
		} else {
			// 空闲时不唤醒 agent——排队为 nextTurn 上下文，下次对话自动可见。
			void session
				.sendCustomMessage({
					customType: "terminal-bash-done",
					content: [{ type: "text", text }],
					display: true,
				})
				.catch(() => {});
		}
	}

	/** 创建子代理 conversation（inMemory runtime + 独立 terminals），listed 入左栏，
	 *  并在其上触发一次完整回合。返回 convId（= 工具 runId）。
	 *
	 *  `model`（可选）："provider/id"，显式指定子代理模型。不传时由调用方决定是否
	 *  回退到模板模型 / 设置面板默认模型；null = 跟随主对话当前模型（默认行为，
	 *  runtime 重建时会继承共享 ModelRuntime 的当前默认）。 */
	private async spawnSubagentConversation(
		prompt: string,
		type: string,
		cwd: string,
		apply?: SubagentTemplate,
		model?: string | null,
		parentId?: string,
		persist?: boolean,
	): Promise<string> {
		// 数量上限先行：每个子代理都是完整 runtime + TerminalManager，无上限时一次
		// 并行派发几十个会把服务进程拖垮。持久化普通对话则受项目会话上限限制。
		if (persist) {
			const baseCwdForLimit = parentId ? (this.convs.get(parentId)?.cwd ?? this.cwd) : this.cwd;
			const resolvedCwdForLimit = cwd ? resolve(baseCwdForLimit, cwd) : baseCwdForLimit;
			const openInProject = [...this.convs.values()].filter(
				(c) => c.cwd === resolvedCwdForLimit && !c.isSubagent && !c.isEphemeral,
			).length;
			if (openInProject >= MAX_OPEN_CONVERSATIONS) {
				throw new Error(
					`The project already has max open regular conversations (${MAX_OPEN_CONVERSATIONS}). Please close some or run as a lightweight subagent (persist=false)`,
				);
			}
		} else {
			const liveSubagents = [...this.convs.values()].filter((c) => c.isSubagent).length;
			if (liveSubagents >= MAX_SUBAGENTS) {
				throw new Error(
					`Subagent limit reached (${MAX_SUBAGENTS} live). Wait for some with subagent_wait_all or stop unneeded ones with subagent_stop before spawning more`,
				);
			}
		}
		// 真正的派发者（withSubagentOwner 按 runtime 归属填入）：cwd 基准 / 跟随模型 /
		// 跟随思考强度一律读它，而不是派发瞬间的 active——后台对话产出时用户可能正
		// 看着别的项目，读 active 会跟错模型、把相对 cwd 解析到错误的项目下。
		const spawner = parentId ? this.convs.get(parentId) : undefined;
		const spawnerSession = spawner?.session ?? this.session;
		const baseCwd = spawner?.cwd ?? this.cwd;
		// 相对 cwd 按派发者所在目录解析：直接透传会相对 server 进程 cwd 落到别处。
		const resolvedCwd = cwd ? resolve(baseCwd, cwd) : baseCwd;
		const conversationId = persist ? `conv-${randomUUID().slice(0, 8)}` : `sa-${randomUUID().slice(0, 8)}`;
		const terminals = this.makeTerminalManager(conversationId, resolvedCwd);
		const sessionManager = persist ? SessionManager.create(resolvedCwd) : SessionManager.inMemory(resolvedCwd);
		if (!persist) {
			// 为内存子代理提供隔离的临时运行目录（供 SoL-Pi 等依赖 getSessionDir 的扩展正常放置缓存），
			// 但保持 persist = false（不写 .jsonl 对话文件、不污染历史记录）
			const ephemeralDir = join(this.agentDir, "subagent-sessions", conversationId);
			try {
				mkdirSync(ephemeralDir, { recursive: true });
				(sessionManager as unknown as { sessionDir: string }).sessionDir = ephemeralDir;
			} catch {}
		}
		const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, apply, conversationId), {
			cwd: resolvedCwd,
			agentDir: this.agentDir,
			sessionManager,
		});
		const conv = this.makeConversation(runtime, conversationId, terminals);
		conv.isSubagent = !persist;
		// 父对话 = 真正派发它的会话（按会话归属的 host 包装填入）。直接用 active
		// 会错：后台对话运行时用户可能正看着别的项目对话，孩子会被记到无关
		// 对话名下、沉到别的项目组底部（issue #95）。缺省才回退到 active。
		conv.parentId = parentId ?? this.activeId ?? undefined;
		conv.subagentType = type;
		conv.subagentPrompt = prompt;
		// 模板快照留在对话上：forceReset 重建 runtime 时工厂要按同一模板组装
		// （system prompt/技能/扩展白名单），否则重建后回落主会话设置。
		conv.subagentTemplate = apply;
		// 插件工具门与模板扩展白名单对齐：白名单非空时插件/MCP 工具（无 SDK
		// extensionKey 身份）不进该会话。工厂期 customTools 不注册 + 下面的
		// syncPluginTools 不回补，模板热改不影响已运行的子代理（与 prompt/技能一致）。
		conv.subagentBarsPluginTools = !!apply && apply.enabledExtensions.length > 0;
		conv.listed = true;
		conv.title = subagentTitle(prompt);
		this.convs.set(conv.id, conv);
		// 子代理会话同样订阅 SDK 事件：否则 onEvent 永不触发，点开查看时没有
		// message_delta 流式增量、快照也不刷新，只能靠切走切回时的 flushSnapshot
		// 看到新内容（dismiss/释放流程本来就会 unsubscribe，不泄漏）。
		conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
		// 子代理不走 bindSession——这里同样注入面板的重试次数覆盖。
		this.applyRetryOverrides();
		// 软上限覆盖同样重放（子代理跟随主对话的压缩阈值，issue #229）。
		this.applyCompactionOverrides();
		// 扩展绑定（rpc 模式）；用 headless 的 Web UI context：
		// 扩展绑定时不会因缺方法崩，UI 输出也不下发（不会与主对话的 widget/status 冲突）。
		try {
			await conv.session.bindExtensions({
				mode: "rpc",
				// 子代理的扩展照常拿到完整 ExtensionUIContext（扩展调用新增方法不会因
				// 局部 mock 缺失而崩），但它是 headless 的：UI 输出全部丢弃、弹窗按取消返回，
				// 因此既不与主对话的 widget/status 串台，也不会让扩展卡在永远无人应答的弹窗上。
				uiContext: WebUIContext.headless(),
				onError: this.makeExtensionErrorReporter({
					text: `Subagent ${conversationId}: `,
					textEn: `Subagent ${conversationId}: `,
				}),
			});
		} catch {
			// 绑定失败不阻断运行。
		}
		// 指定模型（显式 model 参数 → 模板 model → 设置面板默认）时，在首回合前
		// 给子代理会话换模型；全都不给 = 跟随主对话：把发起会话当前的模型也
		// 显式搬过来（新 runtime 的默认模型未必等于主对话刚选的模型）。
		const resolvedModel =
			model ?? (apply?.model?.trim() || null) ?? (this.settingsSvc.current.subagentDefaultModel || null);
		const followModel = resolvedModel
			? resolvedModel
			: spawnerSession.model
				? `${spawnerSession.model.provider}/${spawnerSession.model.id}`
				: null;
		if (followModel) {
			const slash = followModel.indexOf("/");
			const m =
				slash > 0 && slash < followModel.length - 1
					? this.sharedModelRuntime?.getModel(followModel.slice(0, slash), followModel.slice(slash + 1))
					: undefined;
			if (m) {
				try {
					// 先恢复该 provider 的项目密钥（setModel 的鉴权检查要用），再换模型。
					// 按子代理自己的目录恢复（跨目录派发时派发者的密钥不一定适用）。
					await this.restoreKeyForModel(followModel, resolvedCwd);
					await conv.session.setModel(m);
				} catch (err) {
					// 换模型失败不阻断运行——沿用默认模型继续。
					this.emit({
						type: "notice",
						level: "warning",
						text: `Failed to set subagent model, running with default: ${followModel} (${(err as Error).message})`,
						textEn: `Failed to set subagent model, running with default: ${followModel} (${(err as Error).message})`,
					});
				}
			} else {
				this.emit({
					type: "notice",
					level: "warning",
					text: `Subagent model not found, running with default: ${followModel}`,
					textEn: `Subagent model not found, running with default: ${followModel}`,
				});
			}
		}
		// 思考强度：模板指定则固定用它，否则跟随派发者当前强度（与「跟随派发者模型」
		// 同一取数源：spawnerSession）。所以子代理默认与派发者一致，而不是默默回到
		// SDK 默认档位。放在换模型之后：setModel 会按模型能力重算强度，我们先让它
		// 算完再覆盖。不传 persist：只影响这个子代理会话，不动全局默认强度；模型不
		// 支持的档位由 SDK 自动收敛（reasoning:false 的模型只能是 off）。
		const thinkingLevel = apply?.thinkingLevel?.trim() || spawnerSession.thinkingLevel;
		if (thinkingLevel) {
			try {
				conv.session.setThinkingLevel(thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0]);
			} catch (err) {
				// 强度不合法/会话未就绪都不阻断运行（沿用当前档位）。
				this.emit({
					type: "notice",
					level: "warning",
					text: `Failed to set subagent thinking level, keeping the current one: ${thinkingLevel} (${(err as Error).message})`,
					textEn: `Failed to set subagent thinking level, keeping the current one: ${thinkingLevel} (${(err as Error).message})`,
				});
			}
		}
		// 触发回合（后台执行；失败转识为通知）。
		void conv.session.sendUserMessage(prompt).catch((err) => {
			this.emit({
				type: "notice",
				level: "error",
				text: `Subagent ${conversationId} failed to start: ${err instanceof Error ? err.message : String(err)}`,
				textEn: `Subagent ${conversationId} failed to start: ${err instanceof Error ? err.message : String(err)}`,
			});
		});
		if (persist) {
			this.pushProjects().catch(() => {});
		}
		this.emitConversations();
		return conv.id;
	}

	private getSubagentSnapshot(convId: string): SubagentSnapshot | undefined {
		const conv = this.convs.get(convId);
		if (!conv?.session) return undefined;
		return this.toSubagentSnapshot(conv);
	}

	private listSubagentSnapshots(scope?: "all" | "subagent" | "persistent"): SubagentSnapshot[] {
		return [...this.convs.values()]
			.filter((c) => {
				const isPersisted = !c.isSubagent;
				if (scope === "subagent") return c.isSubagent;
				if (scope === "persistent") return isPersisted;
				return c.isSubagent || Boolean(c.parentId) || Boolean(c.subagentPrompt);
			})
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((c) => this.toSubagentSnapshot(c));
	}

	private toSubagentSnapshot(conv: Conversation): SubagentSnapshot {
		const streaming = conv.session.isStreaming;
		const { error, canceled } = this.subagentRunOutcome(conv);
		// state 如实反映终态：之前 canceled 的子代理报的也是 done，只能靠独立 flag
		// 分辨。"queued" 保留给未来（排队调度），当前 spawn 即运行，无排队态。
		const state: SubagentState = streaming ? "running" : canceled ? "canceled" : "done";
		let messageCount = 0;
		try {
			messageCount = messageCountOf(conv.session);
		} catch {
			// session being replaced — report defaults
		}
		const fullPrompt = conv.subagentPrompt ?? "";
		const sm = (conv.session as unknown as { sessionManager?: { isPersisted?: () => boolean } }).sessionManager;
		const isPersisted = !conv.isSubagent || (typeof sm?.isPersisted === "function" && sm.isPersisted());
		return {
			convId: conv.id,
			type: conv.subagentType ?? "general",
			title: conv.title,
			prompt:
				fullPrompt.length > SUBAGENT_PROMPT_SNAPSHOT_CAP
					? `${fullPrompt.slice(0, SUBAGENT_PROMPT_SNAPSHOT_CAP)}\n… [truncated]`
					: fullPrompt,
			state,
			streaming,
			error,
			canceled,
			messageCount,
			model: conv.session.model?.id,
			output: conv.session.getLastAssistantText() ?? "",
			parentId: conv.parentId,
			persisted: isPersisted,
			handoffTo: conv.peerHandoffTo ? [...conv.peerHandoffTo] : undefined,
			handoffFrom: conv.peerHandoffFrom ? [...conv.peerHandoffFrom] : undefined,
		};
	}

	/** 子代理最近一次运行的结局：最后一条 assistant 消息的 errorMessage / stopReason。
	 *  报错 > 中止 > 正常，三者互斥；无 assistant 消息时返回空。 */
	private subagentRunOutcome(conv: Conversation): { error?: string; canceled?: boolean } {
		// 自动重试等待期结局未定：瞬时 error 不算失败，避免向主对话误报
		// 「子代理运行失败」（耗尽后 auto_retry_end 清旗，真正失败照常通知）。
		if (conv.retryState) return {};
		try {
			const msgs = conv.session.agent.state.messages;
			for (let i = msgs.length - 1; i >= 0; i--) {
				const m = msgs[i];
				if ((m as { role?: unknown }).role !== "assistant") continue;
				const err = (m as { errorMessage?: unknown }).errorMessage;
				if (typeof err === "string" && err.trim()) {
					return { error: err.trim() };
				}
				const stop = (m as { stopReason?: unknown }).stopReason;
				if (stop === "aborted" || stop === "cancelled") {
					return { canceled: true };
				}
				break;
			}
		} catch {
			// session being replaced — treat as no outcome yet
		}
		return {};
	}

	private emitTerminal(conversationId: string, msg: ServerMessage): void {
		// Background conversations keep collecting output in their own PTY buffer.
		// Do not stream it into the active xterm; push the retained window on switch.
		if (msg.type === "terminal_output" && conversationId !== this.activeId) return;
		if (msg.type === "terminal_output" || msg.type === "terminal_exit" || msg.type === "terminal_list") {
			this.emit({ ...msg, conversationId } as ServerMessage);
			return;
		}
		this.emit(msg);
	}

	private pushTerminals(conversation = this.conv): void {
		this.emit({
			type: "terminal_list",
			conversationId: conversation.id,
			terminals: conversation.terminals.list(),
		});
		for (const output of conversation.terminals.replay()) {
			this.emit({
				type: "terminal_output",
				conversationId: conversation.id,
				terminalId: output.terminalId,
				data: output.data,
			});
		}
	}

	/**
	 * Vision-bridge transcript cache (batch hash → text). A re-sent / re-asked
	 * prompt with the same images skips the vision API call entirely — editing
	 * a question doesn't re-burn tokens on re-transcribing identical screenshots.
	 */

	/** SYSTEM.md 文件内容（最近一次 loader reload 观察到的 base；组合模板下仅作
	 *  {{soul}} 自动内容，SDK 默认分支不受影响）。非空 = 用户有系统提示词文件。 */
	private lastBaseSystemPrompt = "";

	/** SDK APPEND_SYSTEM.md 内容（appendSystemPromptOverride 收到的 base）——
	 *  composer 的 {{append}} 自动内容。仅主会话（无模板）记录。 */
	private lastSdkAppendFiles: string[] = [];

	/** 当前活动会话的工具/资源快照 → composer 输入。cwd 取活动对话的。 */
	private composeInputs(src: {
		cwd: string;
		selectedTools: string[];
		toolSnippets: Record<string, string>;
		toolGuidelines: string[];
		contextFiles: { path: string; content: string }[];
		skills: { name: string; description: string; filePath: string }[];
		preset?: string;
	}): PromptComposerInputs {
		const preset = src.preset ?? this.conv?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
		// 技能名录指纹观测（只打日志，不干预组装；预览与 run 共用此入口，
		// 变化才记一行，首轮静默）。用未注文的目录（fill 前），全文注入不影响指纹。
		this.noteSkillCatalogDigest(src.skills);
		const showSkills = presetShowsSkillCatalog(preset);
		const effectiveSkills = showSkills ? this.fillSkillContents(src.skills) : [];
		return {
			cwd: src.cwd,
			systemPromptFile: this.lastBaseSystemPrompt || undefined,
			builtinSoul: BUILTIN_SOUL,
			selectedTools: src.selectedTools,
			toolSnippets: src.toolSnippets,
			toolGuidelines: src.toolGuidelines,
			piReadme: PI_DOC_PATHS.readme,
			piDocs: PI_DOC_PATHS.docs,
			piExamples: PI_DOC_PATHS.examples,
			appendFiles: this.lastSdkAppendFiles,
			windowsPersona: process.platform === "win32" ? WINDOWS_PERSONA : "",
			terminalGuidance: isTerminalGuidanceOn(effectiveDisabledAgentTools(this.settingsSvc.current), preset)
				? TERMINAL_TOOLS_GUIDANCE
				: "",
			markersGuidance: this.markerSvc.buildGuidance(),
			// issue #91：组合模板各来源段按客户端 UI 语言渲染（英文默认）。
			lang: this.getLang(),
			contextFiles: src.contextFiles,
			skills: effectiveSkills,
			skillsFullText: showSkills ? normalizeSkillList(this.settingsSvc.current.skillsFullText) : [],
		};
	}

	/** skill 全文注入（{{skills}} 全文模式）：最好努力读名单里技能的文件正文。
	 * 单文件 8KB、总量 32KB 封顶，失败/超限/不在名单回落名录（无 content）。
	 * 名单为空时零开销：原样返回，不碰磁盘。 */
	private fillSkillContents(
		skills: { name: string; description: string; filePath: string }[],
	): { name: string; description: string; filePath: string; content?: string }[] {
		const wanted = new Set(normalizeSkillList(this.settingsSvc.current.skillsFullText));
		if (wanted.size === 0) return skills;
		let budget = 32 * 1024;
		return skills.map((s) => {
			if (!wanted.has(s.name) || !s.filePath || budget <= 0) return s;
			try {
				const st = statSync(s.filePath);
				if (!st.isFile() || st.size <= 0 || st.size > 8192) return s;
				const raw = decodeText(readFileSync(s.filePath).subarray(0, Math.min(st.size, budget))).trim();
				budget -= raw.length;
				return raw ? { ...s, content: raw } : s;
			} catch {
				return s;
			}
		});
	}

	/** 渲染当前组合模板。当存在自定义模板/覆盖，或者当前会话预设非 standard（如 code/minimal/ask/reader），
	 *  或者存在被禁用的工具时，必须渲染完整系统提示词，保证工具门控、技能隐藏与 Guidelines 严格对齐当前预设；
	 *  仅在完全默认且全功能 standard 状态下返回 undefined 让 SDK 拼装。 */
	private renderMainCompose(src: {
		cwd: string;
		selectedTools: string[];
		toolSnippets: Record<string, string>;
		toolGuidelines: string[];
		contextFiles: { path: string; content: string }[];
		skills: { name: string; description: string; filePath: string }[];
		preset?: string;
	}): string | undefined {
		const tpl = (this.settingsSvc.current.promptTemplate ?? "").trim();
		const ovs = this.settingsSvc.current.promptOverrides ?? {};
		const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
		const preset = src.preset ?? this.conv?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
		const isCustomized =
			!!tpl || hasOverride || preset !== "standard" || effectiveDisabledAgentTools(this.settingsSvc.current).length > 0;
		if (!isCustomized) return undefined;
		const texts = resolveSectionTexts(this.composeInputs(src));
		return renderPromptTemplate(tpl || DEFAULT_PROMPT_TEMPLATE, texts, hasOverride ? ovs : undefined);
	}

	/** 从指定会话（缺省 = 活跃会话）收集工具/资源快照 → 一次算出 ①各来源默认(自动)
	 *  内容 ②实际生效的完整提示词。会话未就绪（或出错）返回 undefined，调用方给空值。
	 *  注意必须传目标 conv：preset/工具 schema 都是按会话走的，拿活跃会话的快照
	 *  算后台会话的基线会串账（lastTurnBaseTokens 跨会话污染）。 */
	private sessionPromptSnapshot(target?: Conversation):
		| {
				texts: Record<string, string>;
				full: string;
				toolsSchema: string;
		  }
		| undefined {
		try {
			const conv = target ?? this.convs.get(this.activeId);
			if (!conv) return undefined;
			const sess = conv.session;
			const cwd = conv.cwd;
			const active = sess.getActiveToolNames();
			const snippets: Record<string, string> = {};
			const guidelines: string[] = [];
			const schemaEntries: import("./prompt-composer.js").ToolSchemaEntry[] = [];
			for (const name of active) {
				const def = sess.getToolDefinition(name);
				if (!def) continue;
				if (def.promptSnippet && def.promptSnippet.trim()) snippets[name] = def.promptSnippet;
				if (def.promptGuidelines) guidelines.push(...def.promptGuidelines);
				schemaEntries.push({
					name,
					description: def.description,
					parameters: def.parameters,
				});
			}
			const loader = sess.resourceLoader;
			const preset = conv?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
			const texts = resolveSectionTexts(
				this.composeInputs({
					cwd,
					selectedTools: active,
					toolSnippets: snippets,
					toolGuidelines: guidelines,
					contextFiles: loader.getAgentsFiles().agentsFiles,
					skills: loader.getSkills().skills.map((s) => ({
						name: s.name,
						description: s.description ?? "",
						filePath: (s as { filePath?: string }).filePath ?? "",
					})),
					preset,
				}),
			);
			// 模板/覆盖渲染（无自定义模板时用默认模板渲染完整提示词，确保与真实 run 规则一致且包含预设过滤）。
			const tpl = (this.settingsSvc.current.promptTemplate ?? "").trim();
			const ovs = this.settingsSvc.current.promptOverrides ?? {};
			const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
			const rendered = renderPromptTemplate(tpl || DEFAULT_PROMPT_TEMPLATE, texts, hasOverride ? ovs : undefined);
			return { texts, full: rendered, toolsSchema: buildToolsSchemaText(schemaEntries) };
		} catch {
			// Session not ready yet.
			return undefined;
		}
	}

	/** 设置面板预览用的 host 回调（见 SettingsHost.promptSnapshot）：完整生效提示词
	 *  + 各来源默认（自动）内容。会话未就绪时给空值，面板保持可编辑但不预览。 */
	private promptSnapshot(): { full: string; texts: Record<string, string>; toolsSchema: string } {
		return this.sessionPromptSnapshot() ?? { full: "", texts: {}, toolsSchema: "" };
	}

	/** 会话级 Base Tokens 缓存（避免在节流快照热路径上重复计算正则）。 */
	private cachedBaseTokens: { at: number; convId: string; tokens: number } | null = null;

	/** 指定会话（缺省 = 活跃会话）系统提示词 + 工具 schema 的基础 token 开销
	 *  （与设置面板中的「合计」完全一致）。会话未就绪返回 null——调用方必须区分
	 *  null 与 0：把 0 写进 lastTurnBaseTokens 会让后续轮次双计全额 base。 */
	private currentBaseTokens(target?: Conversation): number | null {
		const conv = target ?? this.convs.get(this.activeId);
		if (!conv) return null;
		const now = Date.now();
		if (
			this.cachedBaseTokens &&
			this.cachedBaseTokens.convId === conv.id &&
			now - this.cachedBaseTokens.at < STATS_CACHE_MS
		) {
			return this.cachedBaseTokens.tokens;
		}
		const snap = this.sessionPromptSnapshot(conv);
		if (!snap) return null;
		const prompt = estimatePromptTokens(snap.full);
		const schema = estimatePromptTokens(snap.toolsSchema);
		const tokens = prompt + schema;
		this.cachedBaseTokens = { at: now, convId: conv.id, tokens };
		return tokens;
	}

	/** Web-facing extension UI context (widgets, notifications). */
	private webUi = new WebUIContext((msg) => this.emit(msg));

	/**
	 * 第一方子代理 host（见 subagents.ts 设计头注）。子代理 = 一个标记
	 * isSubagent 的普通 Conversation：inMemory runtime（不落盘、不进
	 * 历史/resume 列表）、listed=true 出现在左栏「运行的对话」并向用户可见——
	 * 切换查看 / 输入补充（steer）/ 中止（abort）/ 移出全部复用现有对话机制。
	 */
	private subagentHandoffs: Array<{ fromRunId: string; toRunId: string; timestamp: number }> = [];

	/**
	 * 多智能体同行协作与直接交接（Peer-to-Peer Subagents & Hand-off）：
	 * 将任务产物、分析结果或后续指令直接从一个子代理路由至另一个同行子代理，
	 * 无需主会话反复充当传声筒消耗双倍 token。
	 */
	async handoffSubagent(fromRunId: string, toRunId: string, payload: string): Promise<void> {
		if (fromRunId === toRunId) {
			throw new Error("Cannot hand off to oneself");
		}
		const toConv = this.convs.get(toRunId);
		if (!toConv) {
			throw new Error(`Target subagent ${toRunId} not found`);
		}
		const fromConv = this.convs.get(fromRunId);
		const fromType = fromConv?.subagentType ?? "peer";
		const toType = toConv.subagentType ?? "peer";

		const handoffMessage = `[Peer Hand-off from ${fromType} subagent (${fromRunId.slice(0, 8)})]:\n\n${payload}`;

		const record = { fromRunId, toRunId, timestamp: Date.now() };
		this.subagentHandoffs.push(record);
		if (!fromConv?.peerHandoffTo) {
			if (fromConv) fromConv.peerHandoffTo = [];
		}
		fromConv?.peerHandoffTo?.push(toRunId);
		if (!toConv.peerHandoffFrom) toConv.peerHandoffFrom = [];
		toConv.peerHandoffFrom.push(fromRunId);

		// 向目标子代理注入对等交接消息
		await toConv.session.sendUserMessage(
			handoffMessage,
			toConv.session.isStreaming ? { deliverAs: "steer" } : undefined,
		);

		// 广播交接事件
		this.emit({
			type: "subagent_handoff",
			fromRunId,
			toRunId,
			payload,
			timestamp: record.timestamp,
		});

		// 向主会话推送通知
		this.emit({
			type: "notice",
			level: "info",
			text: `Subagent ${fromRunId.slice(0, 8)} (${fromType}) handed off directly to ${toRunId.slice(0, 8)} (${toType})`,
			textEn: `Subagent ${fromRunId.slice(0, 8)} (${fromType}) handed off directly to ${toRunId.slice(0, 8)} (${toType})`,
		});

		this.emitConversations();
		this.flushSnapshot();
	}

	/**
	 * 多级分层上下文预算裁剪（Hierarchical Context Budgeting）：
	 * 当上下文达到预警水位（例如 70%）时，自动执行第一级（远期工具输出裁剪）和
	 * 第二级（已完成步骤折叠），推迟触发全量 LLM 压缩，保留近期关键代码的细节。
	 */
	applyContextBudgetPruning(conv: Conversation): void {
		if (!conv?.session) return;
		try {
			const contextWindow = contextWindowOf(conv.session);
			if (!contextWindow || contextWindow <= 0) return;
			const s = this.settingsSvc.current;
			const modelId = modelKeyOf(conv.session);
			const cap = effectiveSoftCap(s.softCapTokens, s.softCapByModel, modelId);
			const reserve = softCapToReserve(contextWindow, cap) ?? DEFAULT_COMPACTION_RESERVE_TOKENS;

			const messages = conv.session.agent.state.messages;
			if (!messages || messages.length === 0) return;

			const result = pruneContextHierarchically(messages, {
				contextWindow,
				reserveTokens: reserve,
				softCap: cap > 0 ? cap : null,
			});

			if (result.tier1.trimmedCount > 0 || result.tier2.foldedCount > 0) {
				conv.session.agent.state.messages = result.messages;
				const saved = result.tokensBefore - result.tokensAfter;
				this.emit({
					type: "notice",
					level: "info",
					text: `Hierarchical context pruning active: freed ~${saved.toLocaleString()} tokens (trimmed tool outputs / folded steps), deferring full compaction`,
					textEn: `Hierarchical context pruning active: freed ~${saved.toLocaleString()} tokens (trimmed tool outputs / folded steps), deferring full compaction`,
				});
				if (conv.id === this.conv.id) {
					this.flushSnapshot();
				}
			}
		} catch {
			/* 预算裁剪尽力而为，不阻断主流程 */
		}
	}

	private subagentHost: SubagentToolHost = {
		spawnSubagent: (prompt, type, cwd, templateName, model, parentId, persist) => {
			// 模板：存在且启用时应用；传了名字但不可用 → 抛错让工具转给 AI。
			const tpl = templateName ? this.subagentTemplates.get(templateName) : undefined;
			if (templateName && (!tpl || !tpl.enabled)) {
				throw new Error(`Subagent template unavailable: ${templateName} (missing or disabled)`);
			}
			// 模型优先级：显式 model 参数 > 模板自带模型 > 设置面板默认模型；都不给 = 跟随主对话。
			return this.spawnSubagentConversation(prompt, type, cwd, tpl, model, parentId, persist);
		},
		getSubagent: (convId) => this.getSubagentSnapshot(convId),
		listSubagents: (scope) => this.listSubagentSnapshots(scope),
		handoffSubagent: async (fromRunId, toRunId, payload) => {
			await this.handoffSubagent(fromRunId, toRunId, payload);
		},
		steerSubagent: async (convId, message) => {
			const conv = this.convs.get(convId);
			if (!conv?.session) return;
			await conv.session.sendUserMessage(message, conv.session.isStreaming ? { deliverAs: "steer" } : undefined);
		},
		stopSubagent: async (convId) => {
			const conv = this.convs.get(convId);
			if (conv && (conv.session.isStreaming || !conv.session.isIdle)) {
				await this.interruptRun(conv, "User stopped the subagent");
			}
		},
		getWatchdogTimeoutMs: () => this.getBaseToolWatchdogTimeoutMs(),
		// issue #91：子代理工具返回按客户端 UI 语言出中英（英文默认）。
		lang: () => this.getLang(),
		// 只向 AI 暴露 enabled 的模板（停用的对 AI 不可见）。
		listTemplates: () =>
			this.subagentTemplates
				.list()
				.filter((t) => t.enabled)
				.map((t) => ({
					name: t.name,
					description: t.description,
					descriptionEn: t.descriptionEn,
					model: t.model,
					thinkingLevel: t.thinkingLevel,
				})),
		isTemplateUsable: (name) => {
			const t = this.subagentTemplates.get(name);
			return !!t && t.enabled;
		},
	};

	/** schedule_* 工具的数据宿主：全局调度存储＋创建时刻 live 的 cwd/活动对话。
	 *  issue #231：同时快照 owner 对话的落盘会话文件（压缩/重启后稳定），触发时
	 *  先按 sessionFile 认同一会话（内存对话 id 重启即失效，不可单独做持久键）。 */
	private scheduleToolHost(): ScheduleToolHost {
		return {
			store: () => this.schedulerStore,
			cwd: () => this.cwd,
			activeConversationId: () => this.activeId,
			conversationInfo: (id?: string) => {
				try {
					const target = (id ?? "").trim() ? this.convs.get((id ?? "").trim()) : this.convs.get(this.activeId);
					if (!target) return undefined;
					let sessionFile = "";
					try {
						sessionFile = String(target.session.sessionFile ?? "");
					} catch {
						sessionFile = "";
					}
					return { cwd: target.cwd ?? this.cwd, sessionFile };
				} catch {
					return undefined;
				}
			},
		};
	}

	/** conversation_read 工具的数据宿主：读本客户端的 conversation 体系 +
	 *  落盘会话目录。运行中对话按 id（实时消息，含未落盘的）；历史按 path，
	 *  且必须是会话列表里的路径（任意文件不给读）。跨标签页的实时运行不在
	 *  this.convs 里——以落盘历史为准（工具 description 会告诉模型）。 */
	private conversationReadHost(): ConversationReadHost {
		return {
			listRunningConversations: () => {
				const out: {
					id: string;
					title: string;
					cwd: string;
					messageCount: number;
					isStreaming: boolean;
					isSubagent: boolean;
					parentId?: string;
				}[] = [];
				for (const c of this.convs.values()) {
					let messageCount = 0;
					let isStreaming = false;
					try {
						messageCount = messageCountOf(c.session);
						isStreaming = c.session.isStreaming;
					} catch {
						// 会话替换中——报默认值
					}
					out.push({
						id: c.id,
						title: c.title,
						cwd: c.cwd,
						messageCount,
						isStreaming,
						isSubagent: !!c.isSubagent,
						...(c.parentId ? { parentId: c.parentId } : {}),
					});
				}
				return out;
			},
			readRunningConversation: (id) => {
				const c = this.convs.get(id);
				if (!c) return undefined;
				// 取数与并行提醒的触碰集同一路径（convTranscript），不另起读取逻辑。
				return { title: c.title, cwd: c.cwd, isSubagent: !!c.isSubagent, messages: this.convTranscript(c) };
			},
			listHistorySessions: async (scope, cwd) => {
				const infos =
					scope === "all"
						? await SessionManager.listAll(piSessionsRoot())
						: await SessionManager.list(cwd || this.cwd, piSessionsRoot());
				return infos.map((s) => ({
					path: s.path,
					name: s.name,
					firstMessage: s.firstMessage,
					messageCount: s.messageCount,
					modified: s.modified.getTime(),
					cwd: s.cwd,
				}));
			},
			readTouchSidecar: (id, path) => {
				// sidecar 让 files/status 在压缩后仍有答案（additive 可选方法：
				// 读不到就回 undefined，调用方回落现算转录 —— 绝不抛错阻塞工具）。
				try {
					if (id) {
						const c = this.convs.get(id);
						let file: string | undefined;
						try {
							file = c?.session.sessionFile ?? undefined;
						} catch {
							file = undefined;
						}
						return readTouchSidecar(file);
					}
					if (path) return readTouchSidecar(path);
					return undefined;
				} catch {
					return undefined;
				}
			},
			readHistorySession: async (path) => {
				const all = await SessionManager.listAll(piSessionsRoot());
				// win32 路径大小写不敏感：客户端回传的盘符/目录大小写常与服务端
				// 列表不一致，严格相等会把合法请求误判为“不在白名单”。大小写
				// 归一后再比（posix 不受影响）。
				const norm = (p: string): string => {
					const r = resolve(p);
					return process.platform === "win32" ? r.toLowerCase() : r;
				};
				const hit = all.find((s) => norm(s.path) === norm(path));
				if (!hit) return undefined;
				try {
					if (statSync(hit.path).size > MAX_TRANSCRIPT_SCAN_BYTES) return undefined;
					const text = readFileSync(hit.path, "utf8");
					return {
						title: hit.name || hit.firstMessage,
						cwd: hit.cwd,
						sessionPath: hit.path,
						messages: parseTranscriptLines(text),
					};
				} catch {
					return undefined;
				}
			},
		};
	}

	/** claim_files 工具的数据宿主：owner 口径同 subagent/skill（本 runtime 所属会话）。
	 *  常驻注册、不进 AGENT_TOOL_CATALOG（例外：目录工具必须有设置页行，见
	 *  settings-tool-rows.test.ts，而 web/src 正被并行任务占用；advisory 工具常驻
	 *  默认开可接受，目录项 + 设置行等 web/src 空出来后补）。 */
	private claimToolHost(ownerId?: string): ClaimFilesHost {
		const target = (): Conversation | undefined => {
			try {
				return (ownerId ?? "").trim() !== "" ? this.convs.get(ownerId!.trim()) : this.convs.get(this.activeId);
			} catch {
				return undefined;
			}
		};
		return {
			cwd: () => target()?.cwd ?? this.cwd,
			self: () => {
				const t = target();
				return { convId: t?.id ?? this.activeId, title: t?.title ?? "" };
			},
			store: () => this.getClaimStore?.(),
		};
	}

	/** compact_context 工具的数据宿主：提供消息统计用于预检，以及注册 pending 压缩请求。
	 *  ownerId 语义同 skill / claimFiles（本 runtime 所属会话，不是派发瞬间 active）。 */
	private compactContextHost(ownerId?: string): CompactContextHost {
		const target = (): Conversation | undefined => {
			try {
				return (ownerId ?? "").trim() !== "" ? this.convs.get(ownerId!.trim()) : this.convs.get(this.activeId);
			} catch {
				return undefined;
			}
		};
		return {
			conversationId: () => target()?.id ?? this.activeId,
			getContextStats: () => {
				const conv = target();
				if (!conv) return { messageCount: 0, estimatedTokens: 0 };
				let messages: AgentMessage[] = [];
				try {
					messages = conv.session.messages;
				} catch {
					messages = [];
				}
				let totalChars = 0;
				for (const m of messages) {
					if (m && typeof m === "object" && "content" in m) {
						const content = (m as { content?: unknown }).content;
						if (Array.isArray(content)) {
							for (const c of content) {
								if (
									c &&
									typeof c === "object" &&
									"type" in c &&
									(c as { type: unknown }).type === "text" &&
									typeof (c as { text?: unknown }).text === "string"
								) {
									totalChars += (c as { text: string }).text.length;
								}
							}
						} else if (typeof content === "string") {
							totalChars += content.length;
						}
					}
				}
				return {
					messageCount: messages.length,
					estimatedTokens: Math.ceil(totalChars / 4),
				};
			},
			scheduleCompaction: (pending) => {
				const conv = target();
				if (conv) {
					conv.pendingCompaction = pending;
				}
			},
		};
	}

	/** 执行由 AI 调用 compact_context 安排的上下文压缩（在 agent_settled 阶段调用）。 */
	private async executePendingCompaction(conv: Conversation, pending: PendingCompaction): Promise<void> {
		const instructions = buildCompactionInstructions(pending.focus, pending.summary);
		const session = conv.session;
		const model = session.model;

		let originalKeepRecent: number | undefined;
		try {
			originalKeepRecent =
				(session.settingsManager.getCompactionSettings as unknown as (m?: unknown) => { keepRecentTokens?: number })(
					model,
				)?.keepRecentTokens ?? session.settingsManager.getCompactionSettings().keepRecentTokens;
		} catch {
			originalKeepRecent = undefined;
		}

		try {
			if (pending.keepRecentTokens && pending.keepRecentTokens > 0) {
				session.settingsManager.applyOverrides({
					compaction: {
						keepRecentTokens: pending.keepRecentTokens,
					},
				});
			}

			await session.compact(instructions || undefined);

			const retainTokens = pending.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
			this.emit({
				type: "notice",
				level: "info",
				text: `Context compacted proactively based on current issue (retained ~${retainTokens.toLocaleString()} tokens, focused on current task)`,
				textEn: `Context compacted proactively based on current issue (retained ~${retainTokens.toLocaleString()} tokens, focused on current task)`,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emit({
				type: "notice",
				level: "warning",
				text: `Proactive context compaction did not finish: ${msg}`,
				textEn: `Proactive context compaction did not finish: ${msg}`,
			});
		} finally {
			if (pending.keepRecentTokens && pending.keepRecentTokens > 0) {
				try {
					if (originalKeepRecent !== undefined) {
						session.settingsManager.applyOverrides({
							compaction: {
								keepRecentTokens: originalKeepRecent,
							},
						});
					}
				} catch {
					// best effort
				}
			}
			this.applyCompactionOverrides();
			this.flushSnapshot();
		}
	}

	/** skill 工具的数据宿主：读所属会话 loader 的实时技能表 + 主会话禁用集过滤
	 * （与 skillsOverride 主会话语义一致）。ownerId 语义同 browser_page（本
	 * runtime 所属会话，不是派发瞬间的 active）。失败回空目录，不抛错。 */
	private skillToolHost(ownerId?: string): SkillToolHost {
		return {
			listSkills: () => {
				try {
					const target =
						(ownerId ?? "").trim() !== "" ? this.convs.get(ownerId!.trim()) : this.convs.get(this.activeId);
					const all = target?.session.resourceLoader.getSkills().skills ?? [];
					const disabled = new Set(this.settingsSvc.current.disabledSkills);
					return all
						.filter((s) => !disabled.has(s.name))
						.map((s) => ({
							name: s.name,
							description: s.description ?? "",
							filePath: (s as { filePath?: string }).filePath ?? "",
						}));
				} catch {
					return [];
				}
			},
		};
	}

	/** 技能名录指纹（sha256 over name+description，非正文）：变化才打一行日志，
	 * 首轮静默。只观测不干预组装（digest 第一步：日志；复用以后再说）。 */
	private lastSkillCatalogDigest = "";

	private noteSkillCatalogDigest(skills: { name: string; description: string }[]): void {
		const d = createHash("sha256")
			.update(skills.map((s) => `${s.name}\n${s.description}`).join("\n"))
			.digest("hex")
			.slice(0, 16);
		if (d === this.lastSkillCatalogDigest) return;
		const prev = this.lastSkillCatalogDigest;
		this.lastSkillCatalogDigest = d;
		if (prev) console.log(`[skills] catalog digest ${prev}→${d} (${skills.length} skills)`);
	}
	private widgetsTimer: ReturnType<typeof setInterval> | null = null;
	/** Model-stall watchdog interval (see startStallTimer). */
	private stallTimer: ReturnType<typeof setInterval> | null = null;

	/** Connected sockets for this client (multiple tabs share the session). */
	// chat-open-speed: a sink may take an onSent callback (see emitAndFlush); most ignore it.
	private sinks = new Set<(msg: ServerMessage, onSent?: () => void) => void>();
	private pendingNotices: ServerMessage[] = [];
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	/** Timestamp of the most recent message_delta push — while fresh, snapshots
	 *  use the slower STREAMING_SNAPSHOT_INTERVAL_MS cadence. */
	private lastDeltaAt = 0;
	/** Short-lived `getSessionStats()` memo — see STATS_CACHE_MS. Keyed by the
	 *  session instance so a conversation switch never serves the previous one.
	 *  server-owned-chats：按会话各存一份（不是单槽）—— 订阅方会替别的窗口流式它自己
	 *  没在看的对话，两条对话同时在跑时单槽会被每一帧互相挤掉。 */
	private readonly sessionStatsCache = new WeakMap<
		AgentSession,
		{ at: number; value: ReturnType<AgentSession["getSessionStats"]> }
	>();
	private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
	private version = 0;
	/** Snapshot revision counter (see emitSnapshotNow / protocol snapshot_delta). */
	private snapRev = 0;
	/** Messages array as of the last emitted snapshot/delta — identity-walked
	 *  against the current array to detect append-only growth. */
	private emittedKeys: readonly string[] | null = null; // lazy-images: the index's cache keys, not built messages
	/** Conversation whose messages emittedMessages belongs to. A conversation
	 *  switch (set_cwd / new_chat / switch_*) must fall back to a FULL snapshot:
	 *  two empty conversations have identical (empty) arrays, so the identity
	 *  walk alone would misread the switch as "nothing changed" → delta. */
	private emittedConvId: string | null = null;
	/** snapRev value at which emittedMessages was captured. */
	private emittedRev = 0;
	/** 上一次发出去的 TL;DR 列表（引用）：delta 只在它变了时带 `tldr`。 */
	private emittedTldr: UiTldrLine[] | null = null;
	/** 上一次发出去的任务队列（引用）：delta 只在它变了时带 `taskQueue`。 */
	private emittedTaskQueue: UiTaskQueue | null = null;
	/** 上一次发出去的弹窗（引用）：delta 只在它变了时带 `dialog`。 */
	private emittedDialog: UiDialog | null = null;
	/** identities: the identity the last snapshot carried, as `id\u0001title` ("" = can't have one, "-" =
	 *  none): snapshot_delta carries `identity` only when this changed. */
	private emittedIdentity = "";
	/** switch-cache：这次切换客户端报上来的缓存窗口。只在 switchSession / switchConversation
	 *  进行中有值（它们的 finally 清掉），由目标对话的第一份整份快照用掉（resumeWindow）。 */
	private switchHave: CachedWindow | null = null;
	/**
	 * Per-conversation serialization caches (stable message ids, UiMessage
	 * object cache, message-array signature, queue counts) live inside each
	 * Conversation — see Conversation above.
	 */
	private disposed = false;
	/** pi-config readiness check, cached briefly so 60ms snapshots don't hit disk. */
	private piCheckCache: { at: number; configured: boolean } | null = null;

	/** fs.watch on the currently-listed directory — file changes push an instant
	 *  refresh (`file_changed`) so the tree updates without waiting for the 10s
	 *  poll. Only the listed directory is watched (one level); navigating
	 *  re-watches the new target. fs.watch isn't available on every platform /
	 *  filesystem — failures silently fall back to the poll. */
	private fsWatcher: ReturnType<typeof watch> | null = null;
	private watchPath: string | null = null;
	/** fs.watch on the active repo's git dir — external changes (CLI commit,
	 *  IDE branch switch) push `scm_changed` so the panel refreshes itself.
	 *  One watcher per client session, re-targeted when the queried cwd
	 *  changes; failures (bare repo, unsupported fs) silently disable it. */
	private gitWatcher: ReturnType<typeof watch> | null = null;
	private gitWatchCwd: string | null = null;
	private gitDirtyTimer: ReturnType<typeof setTimeout> | null = null;
	private watchTimer: ReturnType<typeof setTimeout> | null = null;

	/** 子代理模板库（全局共享，<dataDir>/subagent-templates.json）。 */
	private readonly subagentTemplates: SubagentTemplatesStore;
	/** 审批规则库（全局共享，<dataDir>/approval-rules.json）。 */
	private readonly approvalRules: ApprovalRulesStore;
	/** 未发送输入框草稿（全局共享，<dataDir>/composer-drafts.json，按 sessionId 键入，见 server/composer-drafts.ts）。 */
	private readonly drafts: ComposerDraftsStore;
	/** 内置标记服务（todo/notify/svc/rename 等，可全局/分组开关）。 */
	private readonly markerSvc: MarkerService;

	// -----------------------------------------------------------------------
	// 用户提问桥（标准 pi 引擎的 ask_user_question customTool）：与 DSH 引擎的
	// question_pending/question_answer 同协议。模型调 ask_user_question 工具 →
	// 本桥发 question_pending 给浏览器 → 等 question_answer → resolve/reject
	// 工具结果（agent 循环阻塞）。一次只展示一个提问（agent 阻塞在工具执行）。
	// -----------------------------------------------------------------------
	/** 序号也必须共享：注册表共享之后，两个客户端各自生成 `q-1` 会撞键。 */
	private static questionSeq = 0;
	/** 待答提问（id → 载荷 + resolve）。一次正常只有一个（agent 阻塞在工具执行）；
	 *  conversationId 记录谁问的：看门狗豁免、快照恢复都靠它。
	 *
	 *  **进程共享**（与 sharedConvs 同构）：server-owned-chats 把对话归给了服务端，
	 *  问卷同理 —— 它属于**对话**而不是某个客户端。所以每台在线设备都能看到、
	 *  都能回答，第一个答的生效（见 ask-delivery.ts）。 */
	private static readonly sharedQuestions = new Map<string, PendingQuestionEntry>();
	private get pendingQuestions(): Map<string, PendingQuestionEntry> {
		return ClientSession.sharedQuestions;
	}

	/** 待审批高危工具调用（Human-in-the-Loop: Edit & Run）。
	 *
	 *  telegram-answers: process-wide, like questions. A permission prompt belongs to its chat, not
	 *  to the window that happened to open it: every window shows it (named after its chat), any of
	 *  them or a plugin (Telegram) can answer, and the first answer wins. Before, it waited only in
	 *  the opening window's own list, so a chat whose window had been refreshed or closed, or one
	 *  run by the queue or the scheduler, waited for an answer nobody could see or give. */
	private static approvalSeq = 0;
	private static readonly sharedApprovals = new Map<string, PendingApprovalEntry>();
	private get pendingApprovals(): Map<string, PendingApprovalEntry> {
		return ClientSession.sharedApprovals;
	}

	// -----------------------------------------------------------------------
	// 浏览器页面桥（标准 pi 引擎的 browser_page customTool）：模型调工具 → 发
	// page_request 给浏览器 → 前端转 page-picker 扩展 → page_response 回到这里
	// resolve 工具结果。
	//
	// 与用户提问桥的关键差别：对面是**程序**（扩展）而不是人，所以必须有超时——
	// 前端没开/扩展没装时不会有人来答，无限等只会把模型卡死；也因此它**不进**
	// 看门狗豁免（见 tool_execution_start 的注释），就是一件普通工具。
	// -----------------------------------------------------------------------
	private pageSeq = 0;
	/** 待回页面请求（id → resolve 与计时器）。同上，一次正常只有一个
	 *  （agent 阻塞在工具执行）；conversationId 仅存档用于诊断（页请求不进快照，
	 *  协议 page_request 也没有这个字段）。 */
	private pendingPageCalls = new Map<
		string,
		{
			resolve: (r: PageCallResult) => void;
			timer: ReturnType<typeof setTimeout>;
			conversationId?: string;
			/** 过户重发 page_request 用（op/args/target）. */
			req: PageCallRequest;
			timeoutMs: number;
		}
	>();

	private constructor(clientId: string, cwd: string, agentDir: string, stateStore: ClientStateStore) {
		this.clientId = clientId;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.stateStore = stateStore;
		// server-owned-chats：参与跨客户端扇出（见 fanOutToViewers）。
		ClientSession.liveSessions.add(this);
		this.roots = stateStore.getWorkspaceRoots(clientId, cwd);
		this.subagentTemplates = new SubagentTemplatesStore(join(stateStore.dataDir, "subagent-templates.json"));
		this.approvalRules = new ApprovalRulesStore(join(stateStore.dataDir, "approval-rules.json"));
		this.drafts = new ComposerDraftsStore(join(stateStore.dataDir, "composer-drafts.json"));
		this.markerSvc = new MarkerService({
			clientId,
			stateStore,
			emit: (msg) => this.emit(msg),
			isDisposed: () => this.disposed,
			getActiveConversationId: () => this.activeId,
			getSessionManager: (id) => {
				const c = this.convs.get(id);
				return c
					? (c.session.sessionManager as unknown as {
							getBranch: () => unknown[];
							appendCustomEntry?: (t: string, d: unknown) => unknown;
						})
					: undefined;
			},
			renameConversation: (convId, title) => {
				// 复用现有重命名路径（内存标题 + 磁盘 session_info）
				void this.renameConversation(convId, title);
			},
			// 标记 widget 合并进扩展 widget 里，跟随当前活动会话渲染（切换会话即刷新）。
			refreshMarkers: () => this.webUi.refresh(),
			// issue #91：标记引导/错误按客户端 UI 语言出中英（英文默认）。
			lang: () => this.getLang(),
		});
		// 标记 widget 动态渲染「当前活动会话」的 todo/overlay：切换会话时只要刷新
		// webUi（见 switchConversation/setCwd/newChat）就会显示对应会话的标记，
		// 且与扩展 widget 合并下发、不会互相覆盖。
		this.webUi.setDynamicWidget("markers", () => this.markerSvc.overlayLines(this.activeId));
		this.settingsSvc = new SettingsService(
			{
				clientId,
				stateStore,
				emit: (msg) => this.emit(msg),
				flushSnapshot: () => this.flushSnapshot(),
				isDisposed: () => this.disposed,
				getSession: () => this.session,
				cwd: () => this.cwd,
				agentDir: () => this.agentDir,
				isStreaming: () => this.session.isStreaming,
				reloadSession: async () => {
					await this.session.reload();
					// reload() 重读磁盘 settings.json，会丢掉内存 applyOverrides
					// （含重试次数覆盖）——依次重放：重试覆盖 → 软上限覆盖 → 终端门控。
					this.applyRetryOverrides();
					this.applyCompactionOverrides();
					// reload() 会把 custom 工具重新加回活跃集——重放当前会话归属预设门控。
					this.applyToolGating(this.session, this.conv?.agentPreset);
					await this.pushSlashCommands();
				},
				applyRetryOverrides: () => this.applyRetryOverrides(),
				applyCompactionOverrides: () => this.applyCompactionOverrides(),
				applyToolGating: () => this.applyToolGating(this.session, this.conv?.agentPreset),
				promptSnapshot: () => this.promptSnapshot(),
				getMarkerState: () => ({
					markersEnabled: this.markerSvc.current.markersEnabled,
					disabledMarkers: [...this.markerSvc.current.disabledMarkers],
					markers: this.markerSvc.listForUi(),
				}),
				getApprovalPolicy: () => this.approvalPolicyState(),
			},
			this.subagentTemplates,
			this.approvalRules,
		);
		this.goalSvc = new GoalService({
			clientId,
			agentDir,
			stateStore,
			webUi: this.webUi,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			quiesceBlocked: () => this.quiesceBlocked(),
			// issue #91：目标/审查文案按客户端 UI 语言出中英（英文默认）。
			lang: () => this.getLang(),
			// 目标模式总开关（设置面板「目标审查」页）：关 → 目标入口一律拒绝。
			goalModeEnabled: () => this.settingsSvc.current.goalModeEnabled !== false,
			activeConvId: () => this.activeId,
			activeConv: () => this.conv,
			getConv: (id) => this.convs.get(id),
			cwd: () => this.cwd,
			reviewSettings: () => this.settingsSvc.reviewPrefs,
			gitDiff: (dir) => this.gitDiff(dir),
		});

		this.modelAdmin = new ModelAdminService({
			agentDir,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			modelRuntime: () => this.runtime.services.modelRuntime,
			invalidatePiConfig: () => {
				this.piCheckCache = null;
			},
			pushModels: async () => this.listModels(),
			onOAuthActivated: (provider) => this.stateStore.deleteProviderEverywhere(provider),
		});
		// Prune dead background tasks every 30s (only spawns netstat/lsof while
		// the list is non-empty). unref: must not keep the process alive.
		this.bg.start();
	}

	static async create(
		clientId: string,
		cwd: string,
		stateStore: ClientStateStore,
		opts?: { blank?: boolean },
	): Promise<ClientSession> {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
		// queue-grouping: the queue links are kept in the server's client state (one store per server).
		ClientSession.queueHomesStore = stateStore;

		const cs = new ClientSession(clientId, cwd, agentDir, stateStore);
		const conversationId = cs.nextConversationId();
		const terminals = cs.makeTerminalManager(conversationId, cwd);
		// Resume the most recent session for this project — the SDK default
		// per-project dir (<agentDir>/sessions/--<cwd>--/, shared with the
		// pi CLI/TUI) — or start a fresh one on first visit.
		// reload-adopt: opts.blank = 跳过磁盘恢复（调用方要接管共享表里已开的那条）。
		// issue #235：坏转录（重复压缩标记成环）修一次再试，否则整项目首屏
		// "Failed to initialize session"。
		const opened = await cs.openManagerAndRuntime(
			() => (opts?.blank ? SessionManager.create(cwd) : SessionManager.continueRecent(cwd)),
			(m) =>
				createAgentSessionRuntime(cs.makeRuntimeFactory(terminals, undefined, conversationId), {
					cwd,
					agentDir,
					sessionManager: m,
				}),
			async () => (await SessionManager.list(cwd))[0]?.path,
		);
		const runtime = opened.runtime;
		if (opened.repair) {
			for (const n of cs.transcriptRepairNotices(opened.repair)) cs.pendingNotices.push(n);
		}
		// First conversation = the resumed session; it also seeds the shared
		// ModelRuntime that every later conversation reuses.
		cs.sharedModelRuntime = runtime.services.modelRuntime;
		const conv = cs.makeConversation(runtime, conversationId, terminals);
		cs.convs.set(conv.id, conv);
		cs.activeId = conv.id;
		for (const d of runtime.diagnostics) {
			if (d.type !== "info") {
				cs.pendingNotices.push({
					type: "notice",
					level: d.type,
					text: d.message,
					textEn: d.message,
				});
			}
		}
		await cs.bindSession();
		// 同步全局默认模型至 SDK settingsManager（若 settings.json 尚未写入），防底层 session 创建时 findInitialModel 兜底回退硬编码模型
		const globalDefault = stateStore.getDefaultModel();
		if (globalDefault) {
			const slash = globalDefault.indexOf("/");
			if (slash > 0 && slash < globalDefault.length - 1) {
				const p = globalDefault.slice(0, slash);
				const id = globalDefault.slice(slash + 1);
				try {
					if (!cs.session.settingsManager.getDefaultModel()) {
						cs.session.settingsManager.setDefaultModelAndProvider(p, id);
					}
				} catch {
					/* 会话未就绪时忽略 */
				}
			}
		}
		await cs.restoreProjectProviderKeysForCwd(cwd);
		await cs.restoreProjectModelForCwd(cwd);
		return cs;
	}

	/**
	 * Factory for cwd-bound runtimes. All conversations share ONE ModelRuntime
	 * (the model choice is client-wide), so later conversations reuse the
	 * instance created with the first one.
	 *
	 * `apply`（可选）：子代理模板 —— 会话的 system prompt / 技能 / 扩展按模板
	 * 应用（prompt replace/append + 白名单），其余（终端接管、Windows persona
	 * 等）仍跟随主会话设置。undefined = 按主会话设置（普通对话/不选模板的子代理）。
	 */
	private makeRuntimeFactory(
		terminals: TerminalManager,
		apply?: SubagentTemplate,
		ownerId?: string,
		initialModel?: Parameters<AgentSession["setModel"]>[0],
		targetPreset?: string,
	): CreateAgentSessionRuntimeFactory {
		return async ({ cwd: effectiveCwd, sessionManager }) => {
			const services = await createAgentSessionServices({
				cwd: effectiveCwd,
				modelRuntime: this.sharedModelRuntime,
				// 设置面板钩子（官方 SDK 的 resourceLoader overrides）：三个 override
				// 在每次 resourceLoader.reload() 时重放，且读取 this.settings 的当前
				// 值——因此 session.reload() 即可让系统提示词 / 技能 / 插件开关生效，
				// 新对话（新 runtime）也会自动带上当前设置。
				// 子代理带模板（apply）时：prompt/skills/extensions 改读模板视图——
				// replace 模式：无 SYSTEM.md 时把灵魂段替换为模板提示词（见下方
				// pi-webui-persona 内联扩展）；有 SYSTEM.md 时仍由 systemPromptOverride
				// 整体替换 base。append 模式把模板提示词追加到
				// 末尾（此时主会话的自定义 prompt 不再叠加，角色由模板定义）；非空
				// 白名单取代主会话开关（只启用这些），空白名单 = 跟随主会话。
				resourceLoaderOptions: {
					// 系统提示词 base：主会话（组合模板）恒返回 undefined → SDK 走默认分支，
					// 工具列表/Guidelines/文档指引等自动段照常拼装；SYSTEM.md 内容仅在
					// 此处捕获（lastBaseSystemPrompt）作 {{soul}} 自动内容。子代理模板
					// replace 在存在 SYSTEM.md base 时整体替换该 base。
					systemPromptOverride: (base?: string) => {
						if (typeof base === "string" && base) {
							this.lastBaseSystemPrompt = base;
							if (apply && apply.promptMode === "replace" && pickTemplatePrompt(apply, this.getLang()).trim()) {
								return pickTemplatePrompt(apply, this.getLang());
							}
						}
						return undefined;
					},
					appendSystemPromptOverride: (base: string[]) => {
						// 记录 SDK APPEND_SYSTEM.md base（composer {{append}} 自动内容）。
						if (!apply) this.lastSdkAppendFiles = base.slice();
						const out = [...base];
						if (apply && apply.promptMode === "append" && pickTemplatePrompt(apply, this.getLang()).trim()) {
							out.push(pickTemplatePrompt(apply, this.getLang()));
						}
						// 主会话自定义「追加」已并入组合模板的 {{append}} 覆盖，不再在此注入。
						if (process.platform === "win32") {
							// Windows 专属 persona：bash 工具跑 Git Bash 且无默认超时、终端
							// 是交互式 TTY——注入约束避免 heredoc/交互/长驻命令挂死整个会话；
							// GBK 老中文文件让模型改用终端按正确编码读（iconv/chcp/Get-Content）。
							out.push(WINDOWS_PERSONA);
						}
						// 终端引导只教「开关开着且预设下仍可用」的工具（见 tool-manager.ts 语义总表）。
						const presetForGuidance =
							this.convs.get(ownerId ?? "")?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
						if (isTerminalGuidanceOn(effectiveDisabledAgentTools(this.settingsSvc.current), presetForGuidance)) {
							// 终端工具使用引导（全平台）：告诉模型什么场景该用持久终端
							// 而不是一次性 bash——没有这段模型几乎从不主动选终端工具。
							// 组内工具全关时不注入（不教 AI 用不存在的工具）。
							out.push(TERMINAL_TOOLS_GUIDANCE);
						}
						// bash 管道限制已并入 bash 工具自身的 description，不再作为独立提示段注入。
						// 内置标记工具引导（按总开关/分组开关过滤）
						const markerGuidance = this.markerSvc.buildGuidance();
						if (markerGuidance) out.push(markerGuidance);
						return out;
					},
					// 技能：模板非空白名单时只启用白名单里的（显式配置优先于预设）；
					// 否则按主会话禁用集过滤。预设拿掉 skill 加载器时（minimal/code/ask）
					// 名录同步隐藏——列出来但调不动只是噪音（见 tool-manager.ts 语义总表）。
					skillsOverride: (res) => {
						if (apply && apply.enabledSkills.length > 0) {
							const set = new Set(apply.enabledSkills);
							return { ...res, skills: res.skills.filter((s) => set.has(s.name)) };
						}
						const preset =
							this.convs.get(ownerId ?? "")?.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
						if (!presetShowsSkillCatalog(preset)) return { ...res, skills: [] };
						return {
							...res,
							skills: res.skills.filter((s) => !this.settingsSvc.current.disabledSkills.includes(s.name)),
						};
					},
					// 插件：模板非空扩展白名单时只加载白名单里的；否则按主会话禁用集过滤。
					// 注意 SDK 在 extensionsOverride 之后才补 sourceInfo，包扩展此处只能靠路径
					// 匹配 —— isExtensionDisabled / isExtensionEnabled 同时比对 npm:<pkg> 候选键。
					extensionsOverride: (res) => {
						// 自家内联扩展（灵魂替换）是基础设施，不参与白名单/禁用过滤。
						const keepOwn = (e: { path: string }) =>
							e.path === INLINE_FAST_MODE_EXT || !e.path.startsWith(INLINE_PERSONA_EXT);
						if (apply && apply.enabledExtensions.length > 0) {
							const set = new Set(apply.enabledExtensions);
							return {
								...res,
								extensions: personaFirst(res.extensions.filter((e) => keepOwn(e) || isExtensionEnabled(e, [...set]))),
							};
						}
						return {
							...res,
							extensions: personaFirst(
								res.extensions.filter(
									(e) => keepOwn(e) || !isExtensionDisabled(e, this.settingsSvc.current.disabledExtensions),
								),
							),
						};
					},
					// 组合模板渲染（主会话）+ 模板灵魂替换（子代理）：before_agent_start 在每个
					// agent run 前触发，SDK 此时已用最新工具/资源拼好基础提示词；若配置了模板或
					// 覆盖，则用 composer 把 {{token}} 展开为各来源文本（工具列表/项目上下文/技能
					// 等都取自本次 run 的 systemPromptOptions，永远最新）。
					extensionFactories: [
						{
							name: "pi-webui-persona",
							hidden: true,
							factory: (pi) => {
								pi.on("before_agent_start", (event) => {
									// 子代理模板 replace（无 SYSTEM.md 时）：默认分支拼好的提示词里
									// 把灵魂段换成模板提示词，自动段保留；SYSTEM.md 情形已在
									// systemPromptOverride 整体替换，此处边界不存在会自然跳过。
									if (apply) {
										const tplPrompt = pickTemplatePrompt(apply, this.getLang()).trim();
										if (apply.promptMode !== "replace" || !tplPrompt) return undefined;
										const boundary = event.systemPrompt.indexOf("\n\nAvailable tools:");
										// 边界串是 SDK 提示词的内部格式：版本一变就可能对不上。
										// 对不上时不再静默回退默认 persona（模板等于没生效），而是把模板
										// 提示词前置拼接——角色约束仍在，只是灵魂段没被精确替换。
										if (boundary === -1) {
											const fallback = `${tplPrompt}\n\n${event.systemPrompt}`;
											return fallback === event.systemPrompt ? undefined : { systemPrompt: fallback };
										}
										const swapped = tplPrompt + event.systemPrompt.slice(boundary);
										return swapped === event.systemPrompt ? undefined : { systemPrompt: swapped };
									}
									// 主会话：按当前会话归属预设与真正活跃的工具列表组装系统提示词
									const conv = this.convs.get(ownerId ?? this.activeId) ?? this.conv;
									const sess = conv?.session;
									const activeToolNames = sess ? sess.getActiveToolNames() : [];
									const activeSet = new Set(activeToolNames);
									const activeSnippets: Record<string, string> = {};
									const activeGuidelines: string[] = [];
									if (sess) {
										for (const name of activeSet) {
											const def = sess.getToolDefinition(name);
											if (!def) continue;
											if (def.promptSnippet && def.promptSnippet.trim()) {
												activeSnippets[name] = def.promptSnippet.trim();
											}
											if (def.promptGuidelines) {
												activeGuidelines.push(...def.promptGuidelines);
											}
										}
									}
									const currentPreset =
										conv?.agentPreset ?? targetPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
									const opts = event.systemPromptOptions as
										| {
												cwd?: string;
												selectedTools?: string[];
												toolSnippets?: Record<string, string>;
												promptGuidelines?: string[];
												contextFiles?: { path: string; content: string }[];
												skills?: { name: string; description?: string; filePath?: string }[];
										  }
										| undefined;
									const rendered = this.renderMainCompose({
										cwd: typeof opts?.cwd === "string" ? opts.cwd : (conv?.cwd ?? effectiveCwd ?? this.cwd),
										selectedTools: activeToolNames.length > 0 ? activeToolNames : (opts?.selectedTools ?? []),
										toolSnippets: activeSnippets,
										toolGuidelines: activeGuidelines,
										contextFiles: opts?.contextFiles ?? [],
										skills: (opts?.skills ?? []).map((s) => ({
											name: s.name,
											description: s.description ?? "",
											filePath: s.filePath ?? "",
										})),
										preset: currentPreset,
									});
									return rendered ? { systemPrompt: rendered } : undefined;
								});
							},
						},
						// fast-mode: ChatGPT's fast tier for chats with "⚡ Fast" on (openai-codex only),
						// normal speed for 15 minutes after a refusal. State lives in fastModeRegistry.
						{ name: FAST_MODE_EXT_NAME, hidden: true, factory: fastModeExtension() },
					],
				},
			});
			// 桥接工具目标（问卷 / 页面）：每次调用都解析「现在谁持有这条对话」，
			// 而不是认这个 runtime 是在哪个 ClientSession 里建出来的（过户会换主）。
			// anchor 在拿到 created.session 后回填（SDK 的 runtime.session 就是它）。
			const bridgeAnchor: { session?: AgentSession } = {};
			const bridge = this.bridgeTarget(bridgeAnchor, ownerId);

			// 为全新会话（0 条消息的空白对话/新对话）提前解析目标模型并注入，
			// 避免 SDK findInitialModel 在无 model 时回退到内置硬编码默认（如 deepseek-v4-pro）：
			let sessionModel: Parameters<AgentSession["setModel"]>[0] | undefined = initialModel;
			if (!sessionModel) {
				const isBlank = sessionManager.buildSessionContext().messages.length === 0;
				if (isBlank) {
					const savedModelId =
						this.stateStore.getProjectModel(this.clientId, effectiveCwd) ?? this.stateStore.getDefaultModel();
					if (savedModelId) {
						const slash = savedModelId.indexOf("/");
						if (slash > 0 && slash < savedModelId.length - 1) {
							const p = savedModelId.slice(0, slash);
							const id = savedModelId.slice(slash + 1);
							const found = services.modelRuntime.getModel(p, id);
							if (found) {
								try {
									await this.restoreKeyForModel(savedModelId, effectiveCwd);
									if (services.modelRuntime.hasConfiguredAuth(p)) {
										sessionModel = found;
									}
								} catch {
									/* 密钥恢复失败则由 SDK 自行解析 */
								}
							}
						}
					}
				}
			}

			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: sessionModel,
				// 覆盖 SDK 内置 bash（customTools 按 name 覆盖）。双实现分流：
				// 「默认 bash 覆盖」开关（terminalBash）关 → 原生 SDK bash（纯进程、不开终端）；
				// 开 → 终端接管 bash（persist 决定一次性/持久，可静默自动转后台）。
				customTools: [
					// P1-5：bash/read 包插件拦截（pre 拒/问即拦、post 脱敏补上下文；
					// 未注入 toolGuard 时 withToolGuard 原样返回，零开销）。
					// 权限沙箱拦截（只读模式拦截终端执行）。
					wrapBashToolWithPermission(
						withToolGuard(
							makeAdaptiveBashTool(
								// issue #91：bash 返回按客户端 UI 语言出中英（英文默认）。
								makeKillableBashTool(effectiveCwd, this.bashKills, () => this.getLang()),
								makeTerminalBashTool(terminals, {
									cwd: effectiveCwd,
									// 设置开 = 用终端；此分支里 persist 未显式给时默认一次性（false）。
									defaultPersist: () => false,
									idleMs: () => Math.max(0, Math.floor(this.settingsSvc.current.terminalBashIdleMs) || 0),
									maxForegroundMs: () =>
										Math.max(0, Math.floor(this.settingsSvc.current.terminalBashMaxForegroundMs) || 0),
									kills: this.bashKills,
									notifyBackgroundDone: (info) => this.notifyTerminalBashDone(terminals, info),
									// issue #91：bash 返回按客户端 UI 语言出中英（英文默认）。
									lang: () => this.getLang(),
								}),
								// 设置关 → 原生 bash；开 → 终端 bash。
								() => this.settingsSvc.current.terminalBash,
							),
							{
								toolName: "bash",
								guard: this.toolGuard,
								conversationId: () => ownerId,
								getLang: () => this.getLang(),
								cwd: effectiveCwd,
								getRoots: () => this.roots,
								askApproval: (toolCallId, toolName, params, reason, reasonEn, convId, category) =>
									this.askApproval(toolCallId, toolName, params, reason, reasonEn, convId, category),
								getRules: () => this.approvalRules.list(),
							},
						),
						() =>
							(ownerId ? this.convs.get(ownerId)?.permissionPreset : undefined) ??
							this.settingsSvc.current.defaultPermissionPreset ??
							"workspace-write-never",
						() => this.getLang(),
					),
					...makePersistentTerminalTools(terminals, effectiveCwd, () => this.getLang(), {
						checkSafety: (cmd) => {
							const perm =
								(ownerId ? this.convs.get(ownerId)?.permissionPreset : undefined) ??
								this.settingsSvc.current.defaultPermissionPreset ??
								"workspace-write-never";
							if (perm === "read-only") {
								const danger = checkDangerousToolCall(
									"bash",
									{ command: cmd },
									effectiveCwd,
									this.roots,
									this.approvalRules.list(),
								);
								if (danger.denied || danger.dangerous) {
									return {
										blocked: true,
										reason: danger.reason || "Read-only mode forbids dangerous or destructive commands",
									};
								}
							}
							const danger = checkDangerousToolCall(
								"bash",
								{ command: cmd },
								effectiveCwd,
								this.roots,
								this.approvalRules.list(),
							);
							if (danger.denied) {
								return { blocked: true, reason: danger.reason || "Blocked by a system rule" };
							}
							return {};
						},
					}),
					// read / write / edit 三处覆盖**不在这里注册**：创建时的 customTools 恒胜、与
					// 扩展加载顺序无关，直接塞进来会静默顶掉第三方扩展注册的同名工具（见
					// tool-overrides.ts）；它们改在会话建好后由 installToolOverrides 注入。
					// 不覆盖内置 edit 的独立宽松编辑工具（缩进不敏感匹配；开关看设置；带权限沙箱拦截与人机协同）。
					wrapEditSoftToolWithPermission(
						makeEditSoftTool(effectiveCwd, () => this.getLang()),
						effectiveCwd,
						() =>
							(ownerId ? this.convs.get(ownerId)?.permissionPreset : undefined) ??
							this.settingsSvc.current.defaultPermissionPreset ??
							"workspace-write-never",
						() => this.roots,
						() => this.getLang(),
						(toolCallId, toolName, params, reason, reasonEn, convId, category) =>
							this.askApproval(toolCallId, toolName, params, reason, reasonEn, convId, category),
						() => ownerId,
						() => this.approvalRules.list(),
					),
					// 插件注册的 AI 工具（创建时刻的实时快照，已按 disabledPluginTools 过滤；
					// 后续注册经 refreshPluginTools 动态补入已有会话）。
					// 子代理模板带非空扩展白名单时不注入：插件/MCP 工具没有 SDK extensionKey
					// 身份、无法参与白名单匹配，全放行等于白名单没关门，全收编才符合「只加载这些」。
					// 空白名单 = 跟随主会话（插件工具照常进入子代理）。
					...(apply && apply.enabledExtensions.length > 0 ? [] : this.enabledPluginToolDefs()),
					// 第一方子代理工具（spawn/get_result/steer/list/stop）。子代理会话
					// 也注册了它们，因此可自然嵌套派发。host 按 ownerId 包装：子代理的
					// 父对话 = 真正调用 spawn 的那个会话（本 runtime 所属会话），而不是
					// 派发瞬间的 active——后台对话继续产出时用户可能已切到别的项目，用
					// activeId 会把孩子记到无关会话名下、沉到别的组/底部（issue #95）。
					// ownerId 即本 runtime 所属会话（创建时就已知，见各调用点），一身二任：
					// spawn 的 parentId（子代理记到真正的派发会话名下）+ wait_all 的
					// selfConvId（调用者自身永不计入等待，防 self-wait deadlock）。
					...(ownerId
						? makeSubagentTools(withSubagentOwner(this.subagentHost, ownerId), undefined, ownerId)
						: makeSubagentTools(this.subagentHost)),
					// 结构化派单（六段式 + 服务端校验；执行体复用子代理 spawn 通道）。
					// owner 包装与上面同理：子代理记到真正的派发会话名下。
					...(ownerId
						? [makeDelegateTaskTool(withSubagentOwner(this.subagentHost, ownerId))]
						: [makeDelegateTaskTool(this.subagentHost)]),
					// 内置标记只读查询工具（todo/svc 状态查询，写操作走内联标记）。
					// todo-list-owner：读本 runtime 所属对话（ownerId，标记就写在 conv.id 下），不是建它的
					// 那个窗口此刻正开着的对话——对话在后台跑时两者不同，以前会拿到前台对话的任务。
					makeMarkersListTool(() => ownerId ?? this.activeId, this.markerSvc),
					// 标准引擎的 ask_user_question：模型调用 → 浏览器富渲染问卷（复用 DSH
					// 的 question_pending/question_answer 协议，前端 DshQuestionDialog）。
					// DSH 引擎不经此（它走 goal-rpc 的 userQuestions provider）。
					makeAskUserQuestionTool(bridge, ownerId),
					// 浏览器页面工具：模型调用 → page_request 给浏览器 → page-picker 扩展
					// 操作用户授权的页面 → page_response 回来。ownerId 语义同上（本 runtime
					// 所属会话，不是派发瞬间的 active）。
					makeBrowserPageTool(bridge, ownerId),
					// 别的对话读取（运行中含子代理 + 历史转录，只读）：用户引用了别的
					// 对话（引用 chip / 粘过来的 id / “看看之前那个对话”）时用。子代理
					// 会话同样注册了它，可自然嵌套读取。不需要 ownerId——读的是本
					// 客户端的 conversation 体系与落盘历史，与派发者无关。
					// extras 认领表：files/status 顺带展示（AgentService 级共享）。
					makeConversationReadTool(this.conversationReadHost(), () => this.getLang(), {
						listClaims: (cwd) =>
							(this.getClaimStore?.().list(cwd) ?? []).map((c) => ({
								path: c.path,
								ownerTitle: c.ownerTitle,
								...(c.note ? { note: c.note } : {}),
							})),
					}),
					// 文件认领（claim_files）：开关走统一工具 tab（ActiveSet 门控）。
					// ownerId 语义同 subagent/skill（本 runtime 所属会话）。
					// DSH 引擎无 customTool 注册面，不接（提醒里照样能看到认领）。
					makeClaimFilesTool(this.claimToolHost(ownerId), () => this.getLang()),
					// 展示文件给用户（present_files，issue #231）：模型给路径清单，服务端
					// 只做只读探测（stat + 未知扩展嗅探 + 文本摘录），结构化 items 走 tool
					// result 的 details 下发，前端渲染成图片/视频内联 + 预览/本地打开/
					// 在文件夹中显示/下载/复制路径的卡片。不打开任何窗口，系统级动作
					// 一律由用户点卡片触发（file_open_default / file_reveal）。
					// 开关走统一工具 tab（ActiveSet 门控；enabled 兜底只做报错文案）。
					// DSH 引擎无 customTool 注册面，不接。
					makePresentFilesTool(effectiveCwd, {
						enabled: () =>
							isAgentToolEnabled(PRESENT_FILES_TOOL_NAME, effectiveDisabledAgentTools(this.settingsSvc.current)),
						getLang: () => this.getLang(),
					}),
					// 技能全文按名加载（名录在 {{skills}} 段）：模型不再拼路径调 read。
					// 子代理会话同样注册（owner 即真正派发的父对话，读该会话 loader）。
					// DSH 引擎无 customTool 注册面，不接。开关走统一工具 tab。
					makeSkillTool(this.skillToolHost(ownerId), () => this.getLang()),
					// 主动压缩上下文工具（compact_context）：AI 主动根据当前问题精简上下文。
					// 开关走统一工具 tab（ActiveSet 门控）。DSH 引擎无 customTool 注册面，不接。
					makeCompactContextTool(this.compactContextHost(ownerId), () => this.getLang()),
					// 定时唤醒三件套（schedule_task/list/cancel，issue #193）：默认绑定
					// 发起对话（ownerId，无则活动对话），到期 steer 语义唤醒它；子代理
					// 会话同样注册（owner 即真正派发的父对话）。开关走统一工具 tab。
					// DSH 引擎无 customTool 注册面，不接。
					...makeScheduleTools(this.scheduleToolHost(), ownerId, () => this.getLang()),
					// 持久代码求值沙箱（eval）：开关走统一工具 tab（ActiveSet 门控，默认关）。
					// ownerId 绑定当前会话；DSH 引擎无 customTool 注册面，不接。
					makeEvalTool({
						cwd: effectiveCwd,
						ownerId,
						lang: () => this.getLang(),
					}),
					// 高可靠行补丁工具（patch，基于内容哈希与语法块级替换）。
					makePatchTool({ cwd: effectiveCwd, ownerId }),
					// 原生语言服务器工具（lsp，定义跳转/引用/悬停/诊断）。
					makeLspTool({ cwd: effectiveCwd, ownerId }),
				],
			});
			// 桥接工具归属锚点：SDK 会话对象在本 runtime 生命周期内稳定，过户只搬对话
			// 不改它（见 ClientSession.findConversationHome）。
			bridgeAnchor.session = created.session;
			// read / write / edit 三处覆盖在会话建好后注入（见 tool-overrides.ts）：SDK 的合并链是
			// [...扩展工具, ...customTools] 后写赢 ⇒ 创建时塞进 customTools 会**恒定顶掉**第三方
			// 扩展注册的同名工具（官方 docs/extensions.md 明写扩展可覆盖 read/write/edit）。
			installToolOverrides(
				created.session as unknown as OverrideSessionLike,
				this.toolOverrideSpecs(ownerId, effectiveCwd),
			);
			// 终端工具开关与预设门控从创建起就生效（工具始终注册进注册表，只调活跃集）。
			this.applyToolGating(created.session, targetPreset);
			return {
				...created,
				services,
				diagnostics: services.diagnostics,
			};
		};
	}

	/** Create independent goal state for one conversation. Preferences are
	 * client-wide defaults, while goal text/review progress is not shared. */
	private makeGoalStatus(): GoalStatus {
		return this.goalSvc.makeGoalStatus();
	}

	/** Allocate a stable conversation id before constructing its runtime/tools. */
	private nextConversationId(): string {
		return `c${++ClientSession.convSeq}`;
	}

	/** Wrap a fresh runtime as a new conversation record. */
	private makeConversation(runtime: AgentSessionRuntime, id: string, terminals: TerminalManager): Conversation {
		const conv: Conversation = {
			id,
			title: conversationTitle(runtime.session),
			isSubagent: false,
			runtime,
			session: runtime.session,
			cwd: runtime.cwd,
			createdAt: Date.now(),
			agentPreset: this.settingsSvc.current.defaultAgentPreset ?? "standard",
			presetLocked: false,
			permissionPreset:
				readPermissionFromSession(runtime.session.sessionManager) ??
				this.settingsSvc.current.defaultPermissionPreset ??
				"workspace-write-never",
			// A brand-new conversation is not yet LISTED — it enters the running
			// list only when it is displaced to the background while still
			// streaming (its runtime is what `listed` protects). A blank chat is
			// also kept out of the left panel's running list; it shows up there as
			// soon as it has content while it is the active chat — see
			// shownInRunningList (#140).
			listed: false,
			promptedSinceActive: false,
			lastActiveAt: Date.now(),
			lastSdkEventAt: Date.now(),
			stallNoticed: false,
			goal: this.makeGoalStatus(),
			goalGeneration: 0,
			goalReviewGeneration: 0,
			wizardRunning: false,
			deltaSeq: 0,
			terminals,
			msgIds: new Map(),
			nextMsgId: 1,
			uiMessageCache: new Map(),
			lastMessagesSig: "",
			lastMessagesArray: [],
			queueSteering: [],
			queueFollowUp: [],
			toolStartTimes: new Map(),
			toolWatchdogs: new Map(),
			workspaceSnapshots: [],
			// 弹窗多了或少了 → 看着它的窗口补快照，所有窗口的左栏重推。
			dialogs: new ChatDialogs(
				() => ClientSession.chatDialogsChanged(conv),
				ClientSession.dialogWatcher(() => conv),
			),
		};
		return conv;
	}

	/**
	 * carry-on: reopen a chat that a restart cut off and send it the carry-on note, so it
	 * checks where it stopped and carries on by itself. Returns once its run has started
	 * (or the note got in), so the caller can move on to the next chat without the switch
	 * disposing this one: a running chat is kept (and listed) when it is switched away from.
	 * false = it couldn't be opened or the note didn't get in.
	 */
	async carryOn(sessionFile: string, note: string): Promise<boolean> {
		await this.switchSession(sessionFile);
		const id = this.conversationIdBySessionFile(sessionFile);
		if (!id) return false;
		const conv = this.convs.get(id);
		if (!conv) return false;
		const before = conv.session.messages.length;
		void this.promptResumedConversation(sessionFile, note).catch(() => {});
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			if (conv.session.isStreaming || conv.session.messages.length > before) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const started = conv.session.isStreaming || conv.session.messages.length > before;
		// In the running list of every window, and kept open when switched away from.
		if (started) conv.listed = true;
		return started;
	}

	/**
	 * queue-lanes: open a fresh chat for a queued task (this client is the queue's pseudo client, see
	 * AgentService.installQueueHost). It is named, gets the task's entries, the model and thinking
	 * level, and its first message. Returns once its run has started; throws otherwise. It is listed
	 * in every window's running list and stays open when this client moves on, until the queue
	 * closes it (releaseQueueChat) once its task is done.
	 */
	async openTaskChat(o: QueueChatStart): Promise<{ sessionFile: string; conversationId: string }> {
		if (this.quiesceBlocked()) throw new Error("the server is shutting down");
		const conversationId = this.nextConversationId();
		const terminals = this.makeTerminalManager(conversationId, o.cwd);
		let runtime: AgentSessionRuntime;
		try {
			runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, undefined, conversationId), {
				cwd: o.cwd,
				agentDir: this.agentDir,
				sessionManager: SessionManager.create(o.cwd),
			});
		} catch (err) {
			terminals.killAll();
			throw err;
		}
		const displaced = this.queueLetGo();
		const conv = this.makeConversation(runtime, conversationId, terminals);
		conv.openedByQueue = true;
		this.applyToolGating(conv.session, conv.agentPreset);
		this.convs.set(conv.id, conv);
		this.activeId = conv.id;
		if (displaced) this.removeConversation(displaced.id);
		await this.bindSession();
		this.invalidateSessionInfos();
		const session = conv.session;
		// Named before its first message, so it shows up as "Queue #n: ..." right away.
		session.setSessionName(o.name);
		conv.title = o.name;
		for (const e of o.entries) session.sessionManager.appendCustomEntry(e.customType, e.data);
		let modelSet = false;
		if (o.model) {
			const slash = o.model.indexOf("/");
			const model = conv.runtime.services.modelRuntime.getModel(o.model.slice(0, slash), o.model.slice(slash + 1));
			if (model) {
				try {
					// Key first, then the model (checkAuth). Not setModel(): that remembers the model for the
					// project, which is the user's choice to make.
					await this.restoreKeyForModel(o.model, o.cwd);
					await session.setModel(model);
					modelSet = true;
				} catch {
					// the model can't be used: fall back to the project's
				}
			}
		}
		if (!modelSet) {
			try {
				await this.restoreProjectModelForCwd(o.cwd);
			} catch {
				// keep the default
			}
		}
		if (o.thinking) {
			try {
				session.setThinkingLevel(o.thinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
			} catch {
				// the model has no such level
			}
		}
		const before = session.messages.length;
		void this.prompt(o.prompt).catch(() => {});
		const started = await waitUntil(() => session.isStreaming || session.messages.length > before, 20_000);
		if (!started) {
			try {
				await session.abort();
			} catch {
				// nothing running
			}
			// Let go at this client's next open (it never got going; nothing is written until it answers).
			conv.listed = false;
			conv.promptedSinceActive = false;
			throw new Error("the chat didn't start");
		}
		conv.listed = true;
		conv.promptedSinceActive = true;
		ClientSession.emitConversationsToAll();
		return { sessionFile: String(session.sessionFile ?? ""), conversationId: conv.id };
	}

	/**
	 * queue-lanes: open the chat with this transcript to run a queue command in it (this client is the
	 * queue's pseudo client for commands). A task chat whose task is still open stays listed and
	 * loaded (its waits run there); any other chat is let go again at this client's next open.
	 * null = it couldn't be opened.
	 */
	async openChatForQueue(file: string): Promise<AgentSession | null> {
		await this.switchSession(file);
		const id = this.conversationIdBySessionFile(file);
		const conv = id ? this.convs.get(id) : undefined;
		if (!conv || id !== this.activeId) return null;
		conv.openedByQueue = true;
		let keep = false;
		try {
			const q = taskQueueFromEntries(conv.session.sessionManager.getBranch(), true);
			keep = !!q.from && q.tasks.some((t) => t.status !== "done");
		} catch {
			// unreadable: treat it as a plain chat
		}
		conv.listed = keep || conv.listed;
		conv.promptedSinceActive = keep;
		return conv.session;
	}

	/** queue-lanes: the session of the chat with this transcript, when this client has it open. */
	queueSessionFor(file: string): AgentSession | null {
		const id = this.conversationIdBySessionFile(file);
		return (id && this.convs.get(id)?.session) || null;
	}

	/**
	 * queue-lanes: a task chat whose task is done leaves the running list. It is freed right away,
	 * or, when it is this client's active chat or a window is looking at it, as soon as that moves on.
	 * It stays in the history (queue-done-hidden: but not in Recent chats, see queueCloseChat).
	 * false = this client doesn't have it open.
	 */
	releaseQueueChat(file: string): boolean {
		const id = this.conversationIdBySessionFile(file);
		const conv = id ? this.convs.get(id) : undefined;
		if (!conv) return false;
		conv.listed = false;
		conv.promptedSinceActive = false;
		if (conv.id !== this.activeId && !this.viewedElsewhere(conv.id)) this.removeConversation(conv.id);
		ClientSession.sessionsChangedForAll();
		return true;
	}

	/**
	 * queue-lanes: the queue's pseudo client moves on to another chat. Returns the chat it leaves when
	 * that one should be closed: only a chat the queue opened (or a blank one), never a user's chat
	 * this client was moved onto (recoverLostActive can do that). The running-list rules still keep a
	 * chat that is working or holds an open task (displaceActive).
	 */
	private queueLetGo(): Conversation | null {
		const conv = this.convs.get(this.activeId);
		if (!conv) return null;
		let blank = false;
		try {
			blank = messageCountOf(conv.session) === 0;
		} catch {
			// session being replaced: leave it alone
		}
		if (!conv.openedByQueue && !blank) return null;
		return this.displaceActive();
	}

	/** 找持有指定转录文件的本地对话 id（找不到 = 已被关闭/搬走/还没建好）。 */
	private conversationIdBySessionFile(file: string): string | null {
		let abs: string;
		try {
			abs = resolve(file);
		} catch {
			return null;
		}
		for (const c of this.convs.values()) {
			try {
				const f = c.session.sessionFile;
				if (f && resolve(f) === abs) return c.id;
			} catch {
				// session 被替换中 —— 跳过
			}
		}
		return null;
	}

	/**
	 * 恢复流程的「继续」投递（resumeInterrupted 专用）。
	 * 读码结论：prompt() 在**调用时刻**同步捕获 active 对话（进入函数第一行取
	 * this.conv，先于任何 await），调用之后发生的切换不影响投递目标。唯一的错投
	 * 窗口在 switchSession 内部：activeId 置位后还要 await bindSession/恢复模型，
	 * 期间用户的并发切换会把 active 挪走 —— 恢复循环接着调 prompt 就会把「继续」
	 * 投进用户当前对话。因此投递前把目标对话修回 active，并在同一同步执行段内
	 * （上一个 await 恢复点之后、无新 await 处）核对 activeId 后才调用 prompt；
	 * 修不回（再次被抢）就放弃自动继续 —— 宁可少投，不投错对话。
	 */
	private async promptResumedConversation(sessionFile: string, text: string): Promise<void> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const targetId = this.conversationIdBySessionFile(sessionFile);
			if (!targetId) return; // 目标对话已没了（被关/被过户），不投
			if (this.activeId === targetId) {
				await this.prompt(text);
				return;
			}
			await this.switchConversation(targetId);
		}
		// 两次都没能稳定拿回 active：放弃自动继续，用户可手动点开那条对话。
	}

	/** Add a socket to this client's broadcast set; flushes buffered startup notices. */
	attachSink(send: (msg: ServerMessage, onSent?: () => void) => void): void {
		this.sinks.add(send);
		for (const msg of this.pendingNotices) send(msg);
		this.pendingNotices = [];
		// Replay current extension widgets (setWidget may have fired during
		// session creation, before any socket was attached).
		const widgets = this.webUi.snapshot();
		if (widgets.length > 0) send({ type: "widgets", widgets });
		const statuses = this.webUi.statusSnapshot();
		if (statuses.length > 0) send({ type: "statuses", statuses });
		// Reconnect: push the current project's running-conversation list so the
		// left panel shows every background chat (a fresh socket never got the
		// newChat/switch pushes).
		this.emitConversations();
		// Reconnect: same for the slash-command catalog (the picker needs it even
		// before the client asks).
		void this.pushSlashCommands();
		// Reconnect: push the remembered goal prefs (model choice, rounds cap,
		// locked) so the goal bar restores them on reload — "全局记忆".
		this.goalSvc.emitGoalStatus();
		// Reconnect: push the settings panel state (prompt text/mode, skill &
		// extension toggles, saved presets).
		this.pushSettings();
		// Reconnect: push the background-task list — it must survive reconnects
		// and outlive the conversation that started the tasks.
		this.bg.push();
		// Reconnect: push the built-in provider key list (multi-key grouping in the
		// model picker needs it even before the client asks).
		this.modelAdmin.listProviderKeys();
		this.modelAdmin.listProviderOAuthFlows();
		// Reconnect: push the global default model (the picker's ★ marker +
		// "set as global default" button state).
		this.pushDefaultModel();
		// Reconnect: push agent presets and permission presets (align with DSH).
		this.refreshAgentPresets();
		this.refreshPermission();
		// PTYs are conversation-owned and survive a socket reconnect.
		this.pushTerminals();
	}

	detachSink(send: (msg: ServerMessage, onSent?: () => void) => void): void {
		this.sinks.delete(send);
		// PTYs intentionally survive a socket drop: they are owned by the
		// conversation and can be inspected after reconnecting. Only conversation
		// disposal or server shutdown kills them.
		if (this.sinks.size === 0) {
			this.files.unwatchDir();
		}
	}

	/** Broadcast to every connected socket of this client. */
	private emit(msg: ServerMessage): void {
		if (this.disposed) return;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const sink of [...this.sinks]) sink(msg);
		this.fanOutToViewers(msg);
	}

	/** chat-open-speed: emit and wait until the windows really have it (at most `capMs`).
	 *
	 *  A frame over 16 KB is squeezed before it goes out (`perMessageDeflate`), and the squeezing
	 *  answers on the event loop — so a big frame sent right before a second of blocking work
	 *  (reading a 267 MB chat) sits in the queue until that work is done, which is exactly what the
	 *  preview is there to avoid. Waiting for the socket costs a few ms. */
	private emitAndFlush(msg: ServerMessage, capMs = 250): Promise<void> {
		if (this.disposed) return Promise.resolve();
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		const sinks = [...this.sinks];
		this.fanOutToViewers(msg);
		if (sinks.length === 0) return Promise.resolve();
		return new Promise<void>((done) => {
			let left = sinks.length;
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				done();
			};
			// A window that never answers (or a sink that ignores the callback) must not hold the
			// open up: the wait is capped.
			const timer = setTimeout(finish, capMs);
			timer.unref?.();
			for (const sink of sinks) {
				let answered = false;
				const once = (): void => {
					if (answered) return;
					answered = true;
					if (--left <= 0) finish();
				};
				try {
					sink(msg, once);
				} catch {
					once();
				}
			}
		});
	}

	/** 扩展错误上报器：同一会话内「扩展 + 事件 + 错误文本」只提示一次，且全量落服务端日志。
	 *
	 *  SDK 的 `ExtensionRunner.emitContext()` 在**每次 provider 请求**前都会跑一遍
	 *  扩展的 `context` hook，并对每个 handler 的报错回调 `onError`。in-memory 会话
	 *  （子代理 / 无痕会话）取不到会话目录（`SessionManager.inMemory(cwd)` 的
	 *  `getSessionDir()` 返回空串），于是「会话目录依赖型」扩展（如 SoL-Pi 的
	 *  `runtimeRoot()`）每轮都抛同一个错——原样广播就等于按轮数刷屏（issue #298）。
	 *
	 *  `prefix` 给 notice 带上会话归属：用户一眼能看出是后台会话的问题，
	 *  而不是当前对话坏了（与同函数内其它子代理通知的口径一致）。 */
	private makeExtensionErrorReporter(prefix?: { text: string; textEn: string }): (err: ExtensionError) => void {
		const seen = new Set<string>();
		return (err) => {
			const message = err?.error ?? String(err);
			const where = [err?.extensionPath, err?.event].filter(Boolean).join(" · ");
			console.error(
				`[extension] ${prefix?.text ?? "current chat"}${where ? ` (${where})` : ""}: ${message}${err?.stack ? `\n${err.stack}` : ""}`,
			);
			const key = `${err?.extensionPath ?? ""}|${err?.event ?? ""}|${message}`;
			if (seen.has(key)) return;
			seen.add(key);
			this.emit({
				type: "notice",
				level: "error",
				text: prefix ? `${prefix.textEn}Extension error: ${message}` : message,
				textEn: prefix ? `${prefix.textEn}Extension error: ${message}` : message,
			});
		};
	}

	/** 本地投递（不再扇出，避免两个客户端互相转发形成回路）。 */
	private emitLocal(msg: ServerMessage): void {
		if (this.disposed) return;
		// eslint-disable-next-line unicorn/no-useless-spread
		for (const sink of [...this.sinks]) sink(msg);
	}

	/**
	 * server-owned-chats：对话属于服务端，谁都能看。**带 conversationId 的实时消息**
	 * （message_delta / tool_delta）要送给**所有正在看这条对话**的客户端，而不只是
	 * 当初开它的那个。
	 *
	 * 只转发增量、不转发快照：快照带着每个客户端自己的 rev 链（`snapshot_delta` 的
	 * baseRev 必须接得上收件人的上一份快照），跨客户端转发会把 rev 链弄断。转发增量
	 * 之后顺手 nudge 一下对方的快照调度器 —— 它用的是**共享注册表里同一个 conv**，
	 * 所以它自己就能生成一份对得上的快照来对账。
	 */
	private fanOutToViewers(msg: ServerMessage): void {
		if (msg.type !== "message_delta" && msg.type !== "tool_delta") return;
		const convId = msg.conversationId;
		if (!convId) return;
		for (const other of ClientSession.liveSessions) {
			// 没 socket 的会话跳过：送不出去，noteForeignDelta 还会替它白算快照（见 checkpointViewers）。
			if (other === this || other.disposed || other.sinkCount() === 0) continue;
			if (other.activeId !== convId) continue;
			other.emitLocal(msg);
			other.noteForeignDelta();
		}
	}

	/** 别的客户端推进了我正在看的对话 —— 安排一次自己的快照来对账。 */
	private noteForeignDelta(): void {
		this.lastDeltaAt = Date.now();
		this.scheduleSnapshot();
	}

	/** server-owned-chats：订阅这条对话的会话替**别的正看着它的窗口**安排对账快照。
	 *  快照仍由收件人自己生成（各自的 rev 链，见 fanOutToViewers），这里只替它们拍板
	 *  「现在就发」还是「按节奏发」，口径跟订阅方自己的一致。以前只有订阅方自己对账，
	 *  看客只能靠 noteForeignDelta 的慢节奏（流式中 2 秒一次），连自己刚发的问题都要等 2 秒
	 *  才出现。没 socket 的会话（client-per-load 之后每次刷新都留下一个）跳过：没人收，
	 *  白算；它重连时 get_state 会拿整份快照。 */
	/** optimistic-send: an ok receipt for the chat this window shows carries the rev of the window's
	 *  latest snapshot (it already shows the message; see prompt_ack in protocol.ts). */
	private withAckRev(msg: PromptAckMsg): PromptAckMsg {
		return msg.ok && msg.conversationId === this.activeId ? { ...msg, rev: this.emittedRev } : msg;
	}

	/** optimistic-send: sends a chat's state now to every window showing it, this one included (so a
	 *  receipt sent right after can't overtake the message it confirms). */
	private flushConvSnapshots(conv: Conversation): void {
		this.checkpointViewers(conv.id, true);
		if (conv.id === this.activeId) this.flushSnapshot();
	}

	private checkpointViewers(convId: string, now: boolean): void {
		for (const other of ClientSession.liveSessions) {
			if (other === this || other.disposed || other.sinkCount() === 0) continue;
			if (other.activeId !== convId) continue;
			if (now) other.flushSnapshot();
			else other.scheduleSnapshot();
		}
	}

	/** 活着的客户端会话（扇出用；attach/dispose 维护）。 */
	private static readonly liveSessions = new Set<ClientSession>();

	/** 全进程在线（有活 socket）的客户端数。`except` 用于 dispose 路径：数的是
	 *  「除我之外还剩几台」。ClientSession 会比它的 socket 活得久，所以必须看
	 *  sinkCount 而不是会话是否存在（同 viewedElsewhere 的教训）。 */
	private static connectedClientCount(except?: ClientSession): number {
		let n = 0;
		for (const cs of ClientSession.liveSessions) {
			if (cs === except || cs.disposed) continue;
			if (cs.sinkCount() > 0) n++;
		}
		return n;
	}

	/** 问卷登记/解决后刷新**所有**在线客户端的对话列表（上游的「?」角标）。
	 *  问卷是进程共享的（sharedQuestions），只刷本客户端的话，别的设备上的角标要等它
	 *  下一次自己推列表才更新 —— 在台式机上答完，笔记本上的「?」还挂着。
	 *  没有 socket 的会话跳过：重连时 attach 会整份重推。 */
	private static emitConversationsToAll(): void {
		// telegram-answers: chats opened, closed or changed: their queues may wait on the user.
		ClientSession.scheduleStuckReconcile();
		for (const cs of ClientSession.liveSessions) {
			if (cs.disposed || cs.sinkCount() === 0) continue;
			cs.emitConversations();
		}
	}

	/** identities: a chat's identity changed. Every window's running list now, and its History list (read
	 *  again, so the labels of saved chats follow) a moment later: one read for several changes in a row. */
	private static identityChangedForAll(): void {
		ClientSession.emitConversationsToAll();
		if (ClientSession.identitySessionsTimer) return;
		ClientSession.identitySessionsTimer = setTimeout(() => {
			ClientSession.identitySessionsTimer = null;
			ClientSession.sessionsChangedForAll();
		}, 300);
		ClientSession.identitySessionsTimer.unref?.();
	}
	private static identitySessionsTimer: ReturnType<typeof setTimeout> | null = null;

	/** queue-done-hidden: a saved chat left Recent chats (a finished queued task's chat that wasn't open):
	 *  every window's chat list again. */
	static recentChangedForAll(): void {
		ClientSession.emitConversationsToAll();
	}

	/** queue-lanes: a chat was let go to its transcript (a queued task finished). Every window reads its
	 *  list of saved chats again, so History shows the chat as it is now. queue-done-hidden: it doesn't
	 *  come back under Recent chats, because queueCloseChat took it out of there first (the ✕ tombstone).
	 *  Windows that never asked for the list just get the new running list. */
	private static sessionsChangedForAll(): void {
		for (const cs of ClientSession.liveSessions) {
			if (cs.disposed || cs.sinkCount() === 0) continue;
			cs.invalidateSessionInfos();
			if (cs.sessionsRequested) void cs.refreshSessions().catch(() => {});
			else cs.emitConversations();
		}
	}

	/** per-chat-dialogs：某条对话的扩展弹窗多了或少了。正看着它的窗口马上补一份快照（弹窗随
	 *  UiState.dialog 走），所有窗口的左栏重推（「?」角标）。没 socket 的会话跳过：重连时整份重推。 */
	private static chatDialogsChanged(conv: Conversation): void {
		for (const cs of ClientSession.liveSessions) {
			if (cs.disposed || cs.sinkCount() === 0) continue;
			if (cs.activeId === conv.id) cs.flushSnapshot();
			cs.emitConversations();
		}
	}

	/** 广播给**所有**在线客户端（不管它在看哪条对话）。目前只用于问卷：
	 *  问卷是阻塞整个 agent 循环的，漏给一台就可能永远等下去，所以不走
	 *  fanOutToViewers 那套 activeId 过滤。用 emitLocal 避免再次扇出成环。 */
	private static broadcastToAllClients(msg: ServerMessage): void {
		for (const cs of ClientSession.liveSessions) {
			if (cs.disposed) continue;
			cs.emitLocal(msg);
		}
	}

	/** telegram-answers: a permission prompt came or went. Every window's snapshot carries the one it
	 *  shows (see pendingApprovalForSnapshot), so each gets a fresh one; sockets-less ones skip it. */
	private static approvalsChanged(): void {
		for (const cs of ClientSession.liveSessions) {
			if (cs.disposed || cs.sinkCount() === 0) continue;
			cs.flushSnapshot();
		}
	}

	/** telegram-answers: the question's id now (a takeover gives it a new one; its ask id stays). */
	private static questionIdOfAsk(askId: string): string | undefined {
		for (const [qid, p] of ClientSession.sharedQuestions) if ((p.askId ?? qid) === askId) return qid;
		return undefined;
	}

	/** telegram-answers: which chat an ask comes from, for whoever shows it elsewhere. */
	private static askMetaOf(conv: Conversation | undefined): AskMeta {
		if (!conv) return {};
		let sessionFile: string | undefined;
		try {
			const f = conv.session?.sessionFile;
			sessionFile = f ? resolve(f) : undefined;
		} catch {
			sessionFile = undefined; // runtime being replaced
		}
		return {
			conversationId: conv.id,
			...(conv.title ? { conversationTitle: conv.title } : {}),
			...(conv.cwd ? { cwd: conv.cwd } : {}),
			...(sessionFile ? { sessionFile } : {}),
		};
	}

	/** telegram-answers: the queued tasks that wait on the user, as asks (stuck-asks.ts), by key. */
	private static readonly stuckAsks = new Map<string, { askId: string; sig: string; target: string }>();
	private static stuckSeq = 0;
	/** telegram-answers: answers given from elsewhere (Telegram, the Queue tab) on their way into the
	 *  chat, by ask id: what was answered and who answered, for when the task moves on. */
	private static readonly stuckAnswers = new Map<string, { summary: string; from: string }>();
	private static stuckReconcileTimer: ReturnType<typeof setTimeout> | null = null;
	/** telegram-answers: sends a stuck task's answer into the chat with this transcript, as the user's
	 *  reply (AgentService sets it: the wake-up client opens the chat, or switches to it, and sends). */
	static stuckAnswerSender: ((file: string, text: string) => Promise<AskResult>) | null = null;

	/** queue-grouping: open queued tasks' chats (transcripts), each with the queue chat it came from (queue-groups.ts),
	 *  as known so far; read from the client state the first time it's needed. */
	private static queueHomes: ReadonlyMap<string, string> | null = null;
	/** queue-grouping: where the links are kept across restarts (the server's client state). */
	private static queueHomesStore: ClientStateStore | null = null;
	private static queueHomesTimer: ReturnType<typeof setTimeout> | null = null;

	/** queue-grouping: the links known so far. Only memory after the first call: building the chat list
	 *  looks them up and nothing else (no chat file, no chat's history). */
	private static knownQueueHomes(): ReadonlyMap<string, string> {
		if (!ClientSession.queueHomes) {
			const saved = ClientSession.queueHomesStore?.getQueueHomes() ?? {};
			ClientSession.queueHomes = new Map(Object.entries(saved).filter(([, v]) => typeof v === "string"));
		}
		return ClientSession.queueHomes;
	}

	/** queue-grouping: work the links out again from the open chats' queues as cached (never re-read here);
	 *  when they changed, keep them and send every window its chat list again. */
	static refreshQueueHomes(): void {
		const loaded: LoadedQueue[] = [];
		for (const conv of ClientSession.sharedConvs.values()) {
			if (conv.isSubagent) continue;
			let file: string | undefined;
			try {
				file = conv.session.sessionFile;
			} catch {
				continue;
			}
			if (file) loaded.push({ file, queue: conv.taskQueueCache?.queue });
		}
		const known = ClientSession.knownQueueHomes();
		const next = queueHomesFrom(loaded, known);
		if (next === known) return;
		ClientSession.queueHomes = next;
		ClientSession.queueHomesStore?.setQueueHomes(Object.fromEntries(next));
		ClientSession.emitConversationsToAll();
	}

	/** queue-grouping: a chat's queue changed what it says about the links: look again soon, once. */
	private static scheduleQueueHomesRefresh(): void {
		if (ClientSession.queueHomesTimer) return;
		ClientSession.queueHomesTimer = setTimeout(() => {
			ClientSession.queueHomesTimer = null;
			try {
				ClientSession.refreshQueueHomes();
			} catch (err) {
				console.error("[queue-grouping]", err);
			}
		}, 50);
		ClientSession.queueHomesTimer.unref?.();
	}

	/** telegram-answers: look at the open chats' queues again soon (several changes come at once). */
	private static scheduleStuckReconcile(): void {
		if (ClientSession.stuckReconcileTimer) return;
		ClientSession.stuckReconcileTimer = setTimeout(() => {
			ClientSession.stuckReconcileTimer = null;
			try {
				ClientSession.reconcileStuckAsks();
			} catch (err) {
				console.error("[asks] stuck tasks:", err);
			}
		}, 100);
		ClientSession.stuckReconcileTimer.unref?.();
	}

	/** telegram-answers: every open chat's queue, read again: a task that needs the user becomes an
	 *  ask; one that moved on (answered, done, its chat closed) settles its ask, saying why. */
	static reconcileStuckAsks(): void {
		const sources: StuckSource[] = [];
		for (const conv of ClientSession.sharedConvs.values()) {
			if (conv.isSubagent) continue;
			const queue = ClientSession.taskQueueOfConv(conv);
			if (queue.tasks.length === 0) continue;
			const meta = ClientSession.askMetaOf(conv);
			if (meta.sessionFile) sources.push({ file: meta.sessionFile, queue, meta });
		}
		const { wanted, seen } = wantedStuckAsks(sources);
		for (const [key, have] of [...ClientSession.stuckAsks]) {
			const w = wanted.get(key);
			if (w && stuckSig(w) === have.sig) continue;
			ClientSession.stuckAsks.delete(key);
			const given = ClientSession.stuckAnswers.get(have.askId);
			ClientSession.stuckAnswers.delete(have.askId);
			if (given) {
				askHub.settle(have.askId, { how: "answered", summary: given.summary, from: given.from });
				continue;
			}
			const why = stuckGoneReason(w ? "stuck" : seen.get(key));
			if (why.answered) {
				askHub.settle(have.askId, {
					how: "answered",
					summary: ClientSession.lastPromptOf(have.target) ?? why.reason,
					from: FROM_BROWSER,
				});
			} else {
				askHub.settle(have.askId, { how: "gone", reason: why.reason });
			}
		}
		for (const [key, w] of wanted) {
			if (ClientSession.stuckAsks.has(key)) continue;
			const askId = `stuck-${++ClientSession.stuckSeq}`;
			ClientSession.stuckAsks.set(key, { askId, sig: stuckSig(w), target: w.target });
			askHub.add(
				stuckAsk(askId, { taskId: w.taskId, taskTitle: w.taskTitle, question: w.question, choices: w.choices }, w.meta),
				(answers, from) => ClientSession.answerStuck(askId, w.target, stuckTextFrom(answers), from),
			);
		}
	}

	/** telegram-answers: what was just sent into the chat with this transcript (the last 5 minutes). */
	private static lastPromptOf(file: string): string | undefined {
		for (const conv of ClientSession.sharedConvs.values()) {
			if (ClientSession.askMetaOf(conv).sessionFile !== file) continue;
			const p = conv.lastPrompt;
			if (!p || Date.now() - p.at > 5 * 60_000) return undefined;
			const text = p.text.replace(/\s+/g, " ").trim();
			return text ? (text.length > 200 ? `${text.slice(0, 199)}\u2026` : text) : undefined;
		}
		return undefined;
	}

	/** telegram-answers: answer a stuck task from elsewhere: the text goes into its chat as the user's
	 *  reply, and pi-queue carries the task on. It is noted first, so the task moving on settles the ask
	 *  as answered by `from`; a failed send takes the note back and the ask keeps waiting. */
	private static async answerStuck(askId: string, target: string, text: string, from: string): Promise<AskResult> {
		if (!text) return { ok: false, error: "no answer" };
		if (ClientSession.stuckAnswers.has(askId)) return { ok: false, error: "an answer is already on its way" };
		const send = ClientSession.stuckAnswerSender;
		if (!send) return { ok: false, error: "answers can't be sent into chats here" };
		ClientSession.stuckAnswers.set(askId, { summary: text, from });
		let r: AskResult;
		try {
			r = await send(target, text);
		} catch (err) {
			r = { ok: false, error: (err as Error)?.message ?? String(err) };
		}
		if (!r.ok) {
			ClientSession.stuckAnswers.delete(askId);
			return r;
		}
		ClientSession.scheduleStuckReconcile();
		return { ok: true };
	}

	/** telegram-answers: the Queue tab answers a stuck task (a choice, or typed words). */
	async taskQueueAnswer(conversationId: string, taskId: number, text: string): Promise<void> {
		const conv = this.convs.get(conversationId);
		const file = ClientSession.askMetaOf(conv).sessionFile;
		const task = conv && file ? ClientSession.taskQueueOfConv(conv).tasks.find((t) => t.id === taskId) : undefined;
		const target = file && task ? stuckTarget(file, task) : undefined;
		const words = String(text ?? "").trim();
		let r: AskResult = { ok: false, error: NOT_WAITING };
		if (target && task?.status === "stuck" && words) {
			const key = stuckKey(target, taskId);
			if (!ClientSession.stuckAsks.has(key)) ClientSession.reconcileStuckAsks();
			const have = ClientSession.stuckAsks.get(key);
			if (have) r = await askHub.answer(have.askId, [{ id: "answer", selected: [], text: words }], FROM_BROWSER);
		}
		if (!r.ok) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `\u6ca1\u80fd\u56de\u7b54\u4efb\u52a1 #${taskId}\uff1a${r.error ?? ""}`,
				textEn: `Couldn't answer task #${taskId}: ${r.error ?? "unknown error"}`,
			});
		}
	}

	/** telegram-answers: the pop-ups of a chat, seen from the list of asks. `chat` is a getter: the
	 *  watcher is made while the chat object itself is still being built. */
	private static dialogWatcher(chat: () => Conversation): DialogWatcher {
		const askId = (ui: UiDialog): string => `dlg-${ui.id}`;
		return {
			opened: (ui) => {
				const conv = chat();
				askHub.add(dialogAsk(askId(ui), ui, ClientSession.askMetaOf(conv)), (answers, from) => {
					const value = dialogValueFrom(ui, answers);
					if (value === undefined) return { ok: false, error: "not one of the choices" };
					return conv.dialogs.answer(ui.id, value, from) ? { ok: true } : { ok: false, error: NOT_WAITING };
				});
			},
			closed: (ui, value, how) => {
				if (value === null) askHub.settle(askId(ui), { how: "gone", reason: how.reason ?? "cancelled" });
				else
					askHub.settle(askId(ui), {
						how: "answered",
						summary: summarizeDialogValue(ui, value),
						from: how.from ?? FROM_BROWSER,
					});
			},
		};
	}

	/** (Re)attach event plumbing to the ACTIVE conversation's session. */
	private async bindSession(): Promise<void> {
		const conv = this.conv;
		conv.unsubscribe?.();
		conv.session = conv.runtime.session;
		// per-chat-dialogs：换了会话（/new、/resume、强制重建）→ 旧会话问的弹窗作废。
		conv.dialogs.cancelExcept(conv.session);
		await conv.session.bindExtensions({
			mode: "rpc",
			// 弹窗（select/confirm/input）归这条对话，其余 ctx.ui 照旧给本窗口（见 chat-dialogs.ts）。
			uiContext: chatUiContext(this.webUi, conv.dialogs, conv.session),
			onError: this.makeExtensionErrorReporter(
				conv.isEphemeral ? { text: `Ephemeral chat ${conv.id}: `, textEn: `Ephemeral chat ${conv.id}: ` } : undefined,
			),
		});
		conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
		// 新会话 / 切换会话 / 强杀重建的必经之路：刚创建的 runtime 用的是 SDK
		// 默认重试 3 次——这里把面板的 retryMaxAttempts 覆盖注入，否则“设了 6
		// 次还是按 3 次重试”。已存在会话重复注入是幂等的（同值覆盖）。
		this.applyRetryOverrides();
		// 软上限覆盖同路重放（新 runtime 的 SettingsManager 是干净的，issue #229）。
		this.applyCompactionOverrides();
		this.scheduleSnapshot();
		this.webUi.refresh();
		this.startWidgetsTimer();
		this.startStallTimer();
	}

	/** Poll extension widgets so TUI-only overlays (e.g. rpiv-todo) stay live.
	 *  Skips the refresh when no widgets are mounted — the common case. */
	private startWidgetsTimer(): void {
		if (this.widgetsTimer) return;
		this.widgetsTimer = setInterval(() => {
			if (!this.disposed && this.webUi.hasWidgets()) this.webUi.refresh();
		}, WIDGET_REFRESH_MS);
	}

	/** Model-stall watchdog: warn when a streaming run went completely silent
	 *  (no SDK events at all) for STALL_NOTIFY_MS. Deliberately does NOT abort:
	 *  deep-thinking models can legitimately be quiet for minutes — the notice
	 *  just tells the user the run looks stuck so they can Stop it themselves. */
	private startStallTimer(): void {
		if (this.stallTimer || STALL_NOTIFY_MS === 0) return;
		this.stallTimer = setInterval(() => {
			if (this.disposed) return;
			const now = Date.now();
			for (const conv of this.convs.values()) {
				// 正在等用户回答的对话本就该「无声」——那是人在想，不是失联。
				if (
					!conv.stallNoticed &&
					conv.session.isStreaming &&
					!this.isWaitingOnUser(conv.id) &&
					now - conv.lastSdkEventAt > STALL_NOTIFY_MS
				) {
					conv.stallNoticed = true;
					const mins = Math.round((now - conv.lastSdkEventAt) / 60_000);
					this.emit({
						type: "notice",
						level: "warning",
						text: `Conversation "${conv.title}" has been silent for ${mins} min — possibly disconnected (network or hung server). Stop it and retry.`,
						textEn: `Conversation "${conv.title}" has been silent for ${mins} min — possibly disconnected (network or hung server). Stop it and retry.`,
					});
				}
			}
		}, 30_000);
	}

	/** 当前生效的基础工具看门狗超时（毫秒）。0 = 禁用看门狗。
	 *  Hard cap on how long ONE tool call may run before the watchdog aborts the
	 *  session. The SDK bash tool has NO default timeout, so a command that never
	 *  finishes (servers, watchers, infinite loops) would otherwise hang the whole
	 *  conversation indefinitely. 优先取设置面板「工具」页的
	 *  ClientSettings.toolWatchdogTimeoutMs（逐 run 实时读取，无需 reload）；
	 *  未设时回落 PI_WEB_TOOL_TIMEOUT_MS 环境变量，再回落默认 20 分钟。 */
	getBaseToolWatchdogTimeoutMs(): number {
		const fromSettings = this.settingsSvc.current.toolWatchdogTimeoutMs;
		if (typeof fromSettings === "number" && Number.isFinite(fromSettings) && fromSettings >= 0) {
			return fromSettings;
		}
		return DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS;
	}

	/** Arm the hang-guard for a tool call: if it is still running after
	 *  TOOL_WATCHDOG_TIMEOUT_MS, abort the session instead of letting the
	 *  conversation hang forever (the SDK bash tool has no default timeout).
	 *  若工具调用显式指定了更长超时（如 bash args.timeout），看门狗自动顺延。 */
	private armToolWatchdog(conv: Conversation, toolCallId: string, toolName?: string, args?: unknown): void {
		const timeoutMs = effectiveToolWatchdogMs(this.getBaseToolWatchdogTimeoutMs(), toolName, args);
		// 0 = 用户显式禁用看门狗（设置面板填 0）。
		if (timeoutMs <= 0) return;
		this.rearmToolWatchdog(conv, toolCallId, timeoutMs, timeoutMs);
	}

	/** （重）布工具挂死看门狗：delayMs 后仍在跑则 abort 整轮。过户时用剩余时间重布
	 *  （已逾期的立即触发，语义不变）. */
	private rearmToolWatchdog(conv: Conversation, toolCallId: string, delayMs: number, totalTimeoutMs?: number): void {
		const totalMs = totalTimeoutMs ?? delayMs;
		const t = setTimeout(
			() => {
				conv.toolWatchdogs.delete(toolCallId);
				// The tool finished before the deadline — nothing to do.
				if (!conv.toolStartTimes.has(toolCallId)) return;
				const durationMin = Math.round(totalMs / 60_000);
				const durationDescEn = durationMin >= 1 ? `${durationMin} min` : `${Math.round(totalMs / 1000)}s`;
				this.emit({
					type: "notice",
					level: "warning",
					text: `Tool ran over ${durationDescEn} and was auto-terminated (hang guard). Tune via Settings -> Tools or PI_WEB_TOOL_TIMEOUT_MS env var.`,
					textEn: `Tool ran over ${durationDescEn} and was auto-terminated (hang guard). Tune via Settings -> Tools or PI_WEB_TOOL_TIMEOUT_MS env var.`,
				});
				conv.toolStartTimes.delete(toolCallId);
				// Abort the run (kills the process tree via the SDK's abort signal);
				// agent_end will fire with stopReason "aborted" and existing logic
				// clears any goal / review loop. interruptRun adds a force-reset
				// fallback in case the model stream ignores the abort signal.
				void this.interruptRun(conv, "Tool timed out");
			},
			Math.max(0, delayMs),
		);
		t.unref?.();
		conv.toolWatchdogs.set(toolCallId, t);
	}

	/** Cancel a tool's watchdog — called when the tool finishes normally. */
	private clearToolWatchdog(conv: Conversation, toolCallId: string): void {
		const t = conv.toolWatchdogs.get(toolCallId);
		if (t) {
			clearTimeout(t);
			conv.toolWatchdogs.delete(toolCallId);
		}
	}

	/** Cancel every watchdog of a conversation (removeConversation / dispose). */
	private clearAllToolWatchdogs(conv: Conversation): void {
		for (const t of conv.toolWatchdogs.values()) clearTimeout(t);
		conv.toolWatchdogs.clear();
	}

	/** 发一条运行轨迹事件给插件（host.onRunEvent 订阅者，如轨迹视图插件）。
	 *  异常隔离——序列化/插件坏了只记日志，绝不影响主流程。 */
	private emitRun(conv: Conversation, ev: Omit<PluginRunEvent, "conversationId" | "at">): void {
		if (!this.onRunEvent) return;
		try {
			this.onRunEvent({ ...ev, conversationId: conv.id, at: Date.now() });
		} catch (err) {
			console.error("[agent-service] onRunEvent failed:", err);
		}
	}

	/** 当前打开对话变了 → 通知插件重拉（切历史会话/切 running 对话/新对话）。
	 *  异常隔离——插件坏了只记日志，绝不影响切换流程。 */
	private notifyConversationChanged(): void {
		if (!this.onConversationChanged) return;
		try {
			this.onConversationChanged();
		} catch (err) {
			console.error("[agent-service] onConversationChanged failed:", err);
		}
	}

	/** 插件用：本客户端最近活跃对话的快照（轨迹视图直接显示打开对话的时间线）。
	 *  messages/streamingMessage 为引用稳定的只读缓存对象——调用方只读、不得修改。 */
	readConversationForPlugins(): PluginConversationSnapshot | null {
		try {
			let target: Conversation | null = null;
			for (const c of this.convs.values()) {
				if (!target || c.lastActiveAt > target.lastActiveAt) target = c;
			}
			if (!target) return null;
			const state = target.session.agent.state;
			let stats: PluginConversationSnapshot["stats"] = {
				totalMessages: 0,
				tokens: { input: 0, output: 0, total: 0 },
				cost: 0,
			};
			try {
				const s = target.session.getSessionStats();
				stats = { totalMessages: s.totalMessages, tokens: s.tokens, cost: s.cost };
			} catch {
				/* stats 尽力而为 */
			}
			let streamingMessage: UiMessage | null = null;
			try {
				streamingMessage = state.streamingMessage ? serializeStreamingMessage(state.streamingMessage) : null;
			} catch {
				/* 尽力而为 */
			}
			const curModel = target.session.model;
			const modelId = curModel ? `${curModel.provider}/${curModel.id}` : undefined;
			return {
				conversationId: target.id,
				title: target.title,
				model: modelId,
				at: target.lastActiveAt,
				isStreaming: target.session.isStreaming,
				messages: this.messagesOf(target),
				streamingMessage,
				stats,
			};
		} catch (err) {
			console.error("[agent-service] readConversationForPlugins failed:", err);
			return null;
		}
	}

	/** 插件扩展点 v2（只读组装，供 index.ts 注入给 PluginManager 的 conversationLister）。
	 *  本客户端运行中对话（kind:"running"）+ 当前项目历史会话摘要（kind:"history"，最多 50 条）。
	 *  纯数据组装，不 emit、不改任何状态；历史会话读失败时只回运行中部分。 */
	listRunningForPlugins(): { id: string; title: string; cwd: string; kind: "running"; isStreaming: boolean }[] {
		const out: { id: string; title: string; cwd: string; kind: "running"; isStreaming: boolean }[] = [];
		for (const conv of this.convs.values()) {
			let isStreaming = false;
			try {
				isStreaming = conv.session.isStreaming;
			} catch {
				// 会话替换中——按未跑处理
			}
			out.push({ id: conv.id, title: conv.title, cwd: conv.cwd, kind: "running", isStreaming });
		}
		return out;
	}

	/** 插件扩展点 v2（conversationLister 的历史一半）：当前项目历史会话摘要，最多 50 条。
	 *  复用 refreshSessions/searchSessions 共用的 loadSessionInfos 缓存（3s TTL，不扫两遍盘）。 */
	async listHistoryForPlugins(
		limit = 50,
	): Promise<{ id: string; title: string; cwd: string; kind: "history"; isStreaming: false }[]> {
		try {
			const infos = await this.loadSessionInfos();
			return infos.slice(0, Math.max(0, limit)).map((s) => ({
				id: s.path,
				title: (s.name?.trim() || s.firstMessage.trim() || basename(s.path)).slice(0, 60),
				cwd: this.cwd,
				kind: "history" as const,
				isStreaming: false as const,
			}));
		} catch {
			return [];
		}
	}

	/** 插件扩展点 v2（供 conversationSearcher）：运行中对话标题 + 历史会话全文匹配，返回前 N 个 {id,title}。
	 *  复用 searchSessions 的 sessionMatchesSearch 判定（含转录全文），只读不 emit。 */
	async searchForPlugins(query: string, limit = 20): Promise<{ id: string; title: string }[]> {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const out: { id: string; title: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.title.toLowerCase().includes(q)) out.push({ id: conv.id, title: conv.title });
			if (out.length >= limit) return out;
		}
		try {
			const infos = await this.loadSessionInfos();
			for (const s of infos) {
				if (!sessionMatchesSearch(q, s)) continue;
				out.push({
					id: s.path,
					title: (s.name?.trim() || s.firstMessage.trim() || basename(s.path)).slice(0, 60),
				});
				if (out.length >= limit) break;
			}
		} catch {
			// 读盘失败只回运行中部分
		}
		return out;
	}

	/** 插件扩展点 v2（供 conversationWriter）：向指定对话投递 prompt，复用现有 prompt 投递路径。
	 *  目标非当前对话时先 switchConversation（复用跨项目切换副作用），再走 this.prompt
	 *  （斜杠拦截/排空门禁/并行提醒/首条命名全在里面）；找不到对话返回 {ok:false,error}。 */
	async writeForPlugins(id: string, text: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const conv = this.convs.get(id);
			if (!conv) return { ok: false, error: `Unknown conversation: ${id}` };
			if (!text.trim()) return { ok: false, error: "Text to deliver is empty" };
			if (id !== this.activeId) await this.switchConversation(id);
			await this.prompt(text);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** 插件扩展点 v2（供 runAborter）：中止指定对话的运行，复用 abort 的 interruptRun 路径
	 *  （abort 卡住/空转时的强制重置语义一并继承）。未在跑时直接 {ok:true}（幂等）。 */
	async abortForPlugins(id: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const conv = this.convs.get(id);
			if (!conv) return { ok: false, error: `Unknown conversation: ${id}` };
			if (this.conversationStreaming(conv)) {
				await this.interruptRun(conv, "Stopped by a plugin");
				this.flushSnapshot();
			}
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** 插件扩展点（供 runSteerer 跨客户端兜底复用）：只在本客户端 conversations 里找对话，
	 *  持有则执行 steer 并返回结果，未持有回 undefined（不碰钩子，无递归）。 */
	async steerOwnConversation(id: string, text: string): Promise<{ ok: boolean; error?: string } | undefined> {
		const conv = this.convs.get(id);
		if (!conv?.session) return undefined;
		await conv.session.sendUserMessage(text, conv.session.isStreaming ? { deliverAs: "steer" } : undefined);
		return { ok: true };
	}

	/** issue #231：本客户端内按稳定键定位调度唤醒目标。
	 *  sessionFile 优先（压缩/重启后内存对话 id 已变，落盘会话文件才是同一会话）；
	 *  只有没给 sessionFile 时才按内存 id 找，且 id 必须附带 cwd 一致才认 ——
	 *  各客户端计数器都从 c1 开始，跨项目同 id 必然撞车，不校验 cwd 会把巡检
	 *  报告投进完全无关的项目对话。
	 *  excludeIds 用于视口回退时跳过已知的忙对话。 */
	resolveSchedulerTarget(opts: {
		conversationId?: string;
		sessionFile?: string;
		cwd?: string;
		excludeIds?: Set<string>;
	}): Conversation | null {
		const wantFile = String(opts.sessionFile ?? "").trim();
		const wantId = String(opts.conversationId ?? "").trim();
		const wantCwd = String(opts.cwd ?? "").trim();
		const excluded = opts.excludeIds;
		if (wantFile) {
			let best: Conversation | null = null;
			for (const c of this.convs.values()) {
				if (!c?.session || (excluded && excluded.has(c.id))) continue;
				let f = "";
				try {
					f = String(c.session.sessionFile ?? "");
				} catch {
					continue;
				}
				if (!sameSessionFile(f, wantFile)) continue;
				if (!best || c.lastActiveAt > best.lastActiveAt) best = c;
			}
			if (best) return best;
		}
		if (wantId) {
			const c = this.convs.get(wantId);
			if (!c?.session || (excluded && excluded.has(c.id))) return null;
			if (wantCwd && !sameCwd(c.cwd, wantCwd)) return null;
			return c;
		}
		return null;
	}

	/** issue #231：本客户端内同项目的最近活跃对话（视口回退目标）。
	 *  主对话优先（用户正看着的面），没有主对话时才考虑子代理行；
	 *  最近活跃者即用户当前的视口。 */
	findViewportInCwd(cwd: string, excludeIds?: Set<string>): Conversation | null {
		const want = String(cwd ?? "").trim();
		if (!want) return null;
		let best: Conversation | null = null;
		let bestSub: Conversation | null = null;
		for (const c of this.convs.values()) {
			if (!c?.session || (excludeIds && excludeIds.has(c.id))) continue;
			if (!sameCwd(c.cwd, want)) continue;
			if (c.isSubagent) {
				if (!bestSub || c.lastActiveAt > bestSub.lastActiveAt) bestSub = c;
			} else if (!best || c.lastActiveAt > best.lastActiveAt) {
				best = c;
			}
		}
		return best ?? bestSub;
	}

	/** issue #231：带压缩忙检测的调度 steer。压缩进行中时 SDK 直接抛错
	 *  （Cannot submit a prompt while compaction is in progress），调用方据 busy
	 *  另寻视口兄弟或稍后重试，而不是当成“对话不在”静默转无头。 */
	async trySteerScheduler(
		conv: Conversation,
		text: string,
	): Promise<{ ok: true } | { ok: false; busy: boolean; error?: string }> {
		try {
			try {
				if ((conv.session as unknown as { isCompacting?: boolean }).isCompacting === true) {
					return { ok: false, busy: true, error: "Context compaction in progress, retry shortly" };
				}
			} catch {
				/* 读不到压缩态就直接投递，失败按异常走 */
			}
			await conv.session.sendUserMessage(text, conv.session.isStreaming ? { deliverAs: "steer" } : undefined);
			return { ok: true };
		} catch (err) {
			const msg = String((err as Error)?.message ?? err);
			if (/compaction is in progress/i.test(msg)) return { ok: false, busy: true, error: msg };
			return { ok: false, busy: false, error: msg };
		}
	}

	/** 插件扩展点（供 runSteerer）：向指定对话插队一条用户消息，复用子代理 steer 的
	 *  sendUserMessage + deliverAs:'steer' 路径（运行时插队；未跑时按普通消息投递）。
	 *  先找本客户端 conversations，找不到再经 steerConversationElsewhere 问其他客户端；
	 *  空文本回 {ok:false}；异常 catch 透传 message。 */
	async steerForPlugins(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }> {
		try {
			if (!text.trim()) return { ok: false, error: "Empty message" };
			const own = await this.steerOwnConversation(conversationId, text);
			if (own) return own;
			if (typeof this.steerConversationElsewhere === "function") {
				const r = await this.steerConversationElsewhere(conversationId, text);
				if (r) return r;
			}
			return { ok: false, error: `Unknown conversation: ${conversationId}` };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** 插件扩展点（供 llmProvider）：孤立补全的环境（cwd/agentDir/回落模型）。
	 *  取最近活跃的主对话（跳过子代理）；model 读不到就只给 cwd（调用方再回落默认模型）。
	 *  纯数据组装，不 emit、不改状态。 */
	llmEnvForPlugins(): { cwd: string; agentDir: string; fallbackModel?: { provider: string; id: string } } {
		let target: Conversation | null = null;
		try {
			for (const c of this.convs.values()) {
				if (c.isSubagent) continue;
				if (!target || c.lastActiveAt > target.lastActiveAt) target = c;
			}
			if (!target) {
				for (const c of this.convs.values()) {
					if (!target || c.lastActiveAt > target.lastActiveAt) target = c;
				}
			}
		} catch {
			target = null;
		}
		const cwd = target?.cwd ?? this.cwd;
		let fallbackModel: { provider: string; id: string } | undefined;
		try {
			const m = target?.session?.model as { provider?: string; id?: string } | undefined;
			if (m?.provider && m.id) fallbackModel = { provider: m.provider, id: m.id };
		} catch {
			/* model 读不到就回落默认 */
		}
		return { cwd, agentDir: this.agentDir, ...(fallbackModel ? { fallbackModel } : {}) };
	}

	/** 插件扩展点 v2（供 modelLister）：复用 listModels 的模型列表映射 {id,provider,vision}。
	 *  与 listModels 唯一差别：不做网络 refresh（插件列表走缓存目录，15s 超时也不等），只读不 emit。 */
	async listModelsForPlugins(): Promise<{ id: string; provider: string; vision: boolean }[]> {
		try {
			const available = await this.runtime.services.modelRuntime.getAvailable();
			return available.map((m) => ({
				id: `${m.provider}/${m.id}`,
				provider: m.provider,
				vision: m.input?.includes("image") ?? false,
			}));
		} catch {
			return [];
		}
	}

	/** crash-guard: SDK event errors already logged (key → when), so a handler that throws on every
	 *  streaming delta logs once a minute, not hundreds of times a second. */
	private eventErrorLoggedAt = new Map<string, number>();

	/**
	 * crash-guard: pi calls this listener inside its run loop and doesn't catch listener errors, so a
	 * throw here broke the run of a chat or escaped as an unhandled error. Log it with its stack (the
	 * same error at most once a minute) and go on; the next snapshot brings the windows up to date.
	 */
	private onEvent(conv: Conversation, event: AgentSessionEvent): void {
		try {
			this.onEventNow(conv, event);
		} catch (err) {
			const key = `${conv.id}\u0000${event.type}\u0000${errorMessage(err)}`;
			const now = Date.now();
			if (now - (this.eventErrorLoggedAt.get(key) ?? 0) < 60_000) return;
			this.eventErrorLoggedAt.set(key, now);
			console.error(
				`[crash-guard] window ${this.clientId}: handling ${event.type} in chat ${conv.id} failed (the same error is logged at most once a minute):\n${describeError(err)}`,
			);
		} finally {
			// optimistic-send: the user message of a prompt that just started a run has ended. onEventNow
			// has already sent the snapshot that holds it (to this window if it shows the chat, and to
			// every other window that shows it), so now its sender gets the receipt. (Also after a failure
			// above: the message is in the chat either way, and the next snapshot brings it.)
			if (
				conv.ackOnUserMessage &&
				event.type === "message_end" &&
				(event.message as { role?: string } | undefined)?.role === "user"
			) {
				const receipt = conv.ackOnUserMessage;
				conv.ackOnUserMessage = undefined;
				receipt.ok();
			}
		}
	}

	private onEventNow(conv: Conversation, event: AgentSessionEvent): void {
		// Any SDK event proves the run is alive — feeds the stall watchdog below.
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		trackRunning(conv, event);
		switch (event.type) {
			case "bash_execution_update": {
				if (event.id) {
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.id,
						toolName: "bash",
						delta: event.delta,
					});
				}
				break;
			}
			case "tool_execution_start": {
				// Record the moment the tool actually starts so tool_status can
				// report real execution time (vs. time spent waiting on the model).
				conv.toolStartTimes.set(event.toolCallId, Date.now());
				// Snapshot listeners before a bash run — the post-run diff catches
				// servers the agent started in the background.
				if (event.toolName === "bash") {
					this.bg.snapshotBefore();
				}
				// 看门狗豁免：ask_user_question 阻塞等的是「人类回答」，不是挂死的工具
				// （默认 20 分钟会把还在思考的用户连对话一起剁掉）。它的收场自有路子：
				// 用户回答/取消、会话 dispose（cancelPendingQuestions），不限时。
				if (event.toolName !== ASK_USER_QUESTION_TOOL_NAME) {
					this.armToolWatchdog(conv, event.toolCallId, event.toolName, event.args);
				}
				// 插件扩展点：工具开始执行（异常由 emitToolEvent 隔离）。
				this.onToolEvent?.({
					phase: "start",
					toolName: event.toolName,
					conversationId: conv.id,
					toolCallId: event.toolCallId,
				});
				// 轨迹事件：带参数预览（JSON 封顶；超大参数只记截断）。
				let argsText = "null";
				try {
					argsText = truncRun(JSON.stringify(event.args ?? null), RUN_ARGS_CAP);
				} catch {
					argsText = "[unserializable args]";
				}
				this.emitRun(conv, {
					type: "tool_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					argsText,
				});
				break;
			}
			case "tool_execution_end": {
				const startedAt = conv.toolStartTimes.get(event.toolCallId);
				conv.toolStartTimes.delete(event.toolCallId);
				this.clearToolWatchdog(conv, event.toolCallId);
				// Bash finished — wait briefly for background servers to bind their
				// ports, then diff against the pre-run snapshot and record them.
				if (event.toolName === "bash") void this.bg.trackAfterBash();
				const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
				// 插件扩展点：工具结束执行（带耗时与错误标志）。
				this.onToolEvent?.({
					phase: "end",
					toolName: event.toolName,
					conversationId: conv.id,
					toolCallId: event.toolCallId,
					...(durationMs !== undefined ? { durationMs } : {}),
					isError: event.isError,
				});
				// 轨迹事件：带结果预览（封顶）+ 耗时/错误标志。
				this.emitRun(conv, {
					type: "tool_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					resultText: previewToolResult(event.result),
					...(durationMs !== undefined ? { durationMs } : {}),
					isError: event.isError,
				});
				// The bash tool does not put its exit code in result.details — on
				// failure it throws "Command exited with code N" and the agent
				// wraps that into the error result text. Try details first (future
				// tools / SDK changes), then parse the error text.
				const details = (event.result as { details?: unknown })?.details;
				let exitCode: number | undefined;
				if (
					typeof details === "object" &&
					details !== null &&
					typeof (details as { exitCode?: unknown }).exitCode === "number"
				) {
					exitCode = (details as { exitCode: number }).exitCode;
				} else if (event.isError) {
					const content = (event.result as { content?: unknown })?.content;
					const text = Array.isArray(content)
						? content
								.map((c) =>
									typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text"
										? ((c as { text?: unknown }).text ?? "")
										: "",
								)
								.join("\n")
						: "";
					const m = text.match(/exited with code (\d+)/);
					if (m) exitCode = Number(m[1]);
				}
				this.emit({
					type: "tool_status",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					exitCode,
					durationMs,
				});
				break;
			}
			case "tool_execution_update": {
				const text = extractPartialText(event.partialResult);
				if (text) {
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						delta: text,
					});
				}
				break;
			}
			case "queue_update":
				conv.queueSteering = [...event.steering];
				conv.queueFollowUp = [...event.followUp];
				break;
			// 手动 /compact 或阈值/溢出自动压缩开始——常驻进度条（快照 compaction
			// 字段），而不是一次性 toast（toast 几秒就消失，而摘要生成可能持续
			// 数十秒，用户会以为「没反应」）。立即 flush 让进度条第一时间出现。
			// 服务端重启会杀死压缩中的 LLM 调用且 compaction_end 永远不会到：
			// 把带时间戳的待处理标记写进会话文件（与 SDK 条目同格式、可追加），
			// 重启后打开该会话时检测到它即报「上次压缩被中断，可重试」，而不是
			// 静默丢失。标记在 compaction_end 到达时删除（正常完成不留痕）。
			case "compaction_start": {
				conv.compactionState = { reason: event.reason, startedAt: Date.now() };
				conv.lastCompactionTokens = null;
				this.markCompactionPending(conv);
				// 进度条只有正看着这条对话的窗口看得到（见 onEvent 末尾）。
				this.checkpointViewers(conv.id, true);
				// crash-guard: compare ids, not `this.conv` — that getter throws when this window's chat was
				// closed elsewhere, and a throw here lands inside the SDK's event loop.
				if (conv.id === this.activeId) this.flushSnapshot();
				break;
			}
			case "compaction_end": {
				this.clearCompactionPending(
					conv,
					event.errorMessage
						? { status: "failed", error: event.errorMessage }
						: event.aborted
							? { status: "cancelled" }
							: event.result
								? {
										status: "completed",
										tokensBefore: event.result.tokensBefore,
										tokensAfter: event.result.estimatedTokensAfter ?? event.result.tokensBefore,
									}
								: undefined,
				);
				conv.compactionState = null;
				if (event.errorMessage) {
					this.emit({
						type: "notice",
						level: "error",
						text: `Context compaction failed: ${event.errorMessage}`,
						textEn: `Context compaction failed: ${event.errorMessage}`,
					});
				} else if (event.aborted) {
					this.emit({
						type: "notice",
						level: "warning",
						text: "Context compaction cancelled",
						textEn: "Context compaction cancelled",
					});
				} else if (event.result) {
					const { tokensBefore, estimatedTokensAfter } = event.result;
					const after = estimatedTokensAfter ?? tokensBefore;
					// 记住压缩后大小：SDK 在下轮响应前报 null，快照用此回填底栏。
					conv.lastCompactionTokens = estimatedTokensAfter ?? null;
					this.emit({
						type: "notice",
						level: "info",
						text: `Context compacted: ${tokensBefore.toLocaleString()} → ${after.toLocaleString()} tokens (summary inserted into the message list)`,
						textEn: `Context compacted: ${tokensBefore.toLocaleString()} → ${after.toLocaleString()} tokens (summary inserted into the message list)`,
					});
				}
				break;
			}
			case "auto_retry_start": {
				// 大模型 API 瞬时报错，SDK 退避重试：填实重试信息。末尾 error
				// 消息已被（或即将被）SDK 从 state 摘掉，currentMessages() 凭此旗
				// 过滤，快照只显示温和的重试条。落盘由底部检查点立即 flush。
				conv.retryState = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				};
				break;
			}
			case "auto_retry_end": {
				// 重试结束：成功 → 新内容照常显示；耗尽 → error 消息留驻，
				// 快照永久标红。落盘由底部检查点立即 flush。
				conv.retryState = null;
				break;
			}
			// A run finished or a new entry was persisted — keep the session list fresh
			// (new chat + first message, completed turns, compaction, etc.).
			case "agent_end": {
				// 可重试错误：SDK 随后发 auto_retry_start 并把末尾 error 消息从
				// state 摘掉。这里先立占位，让本次立即 flush 的快照就不含瞬时红错
				// ——否则快照先画红、摘掉后又消失，即「红色报错一闪而过」。
				// fast-mode: a refused fast reply is retried at normal speed right after this (the fast-mode
				// extension's agent_before_settle) — the same turn going on, treated like the SDK's retry.
				const fastRetry = !event.willRetry && fastRetryAfter(conv, event.messages);
				const willRetry = event.willRetry || fastRetry;
				conv.fastRetrying = fastRetry;
				if (willRetry) {
					let errorMessage = "";
					for (let i = event.messages.length - 1; i >= 0; i--) {
						const m = event.messages[i] as { role?: unknown; errorMessage?: unknown };
						if (m.role === "assistant" && typeof m.errorMessage === "string") {
							errorMessage = m.errorMessage;
							break;
						}
					}
					if (fastRetry) {
						const reason = fastModeRegistry.view(conv.session.sessionManager, conv.session.agent.state.model)?.reason;
						errorMessage = `${reason ?? "ChatGPT refused fast mode"}; normal speed for now`;
					}
					conv.retryState = { attempt: 0, maxAttempts: 0, delayMs: 0, errorMessage };
				} else {
					// 本轮结束且无后续重试：任何残留占位都是过期的（会话替换、
					// 结束信号丢失等），清掉，否则横幅会卡住不消失。
					conv.retryState = null;
				}
				// 轨迹事件：本轮结束（放最前——aborted 中断路径也会 break，
				// 轨迹里必须留下「已停止」而不是凭空消失）。
				try {
					const lastAssistant = [...(event.messages as unknown[])].reverse().find((m) => {
						const a = m as { role?: string; stopReason?: string };
						return a.role === "assistant" && typeof a.stopReason === "string";
					}) as { stopReason?: string } | undefined;
					this.emitRun(
						conv,
						lastAssistant?.stopReason ? { type: "run_end", stopReason: lastAssistant.stopReason } : { type: "run_end" },
					);
				} catch {
					/* 轨迹尽力而为 */
				}
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				// 本轮真的结束了（不是重试中间态）：没在看的对话点绿灯（「轮到你了」）。
				if (!willRetry) this.markRecentWaiting(conv);
				// 内联标记不在此兜底扫最后一条 assistant：每条气泡结束已走 message_end
				// 即时解析（含中间文本块）；这里再扫会把最后一条标记重复执行（todo 重复建号）。

				// Manual interrupt (Stop button / abort): the last assistant message
				// carries stopReason "aborted". A half-finished run should NOT be
				// reviewed (it would fail and inject a revision, only to be stopped
				// again → an endless review loop). Clear the goal so the review loop
				// stops too, then let the user give a fresh instruction.
				const aborted = (event.messages as unknown[]).some((m) => {
					const a = m as { role?: string; stopReason?: string };
					return a.role === "assistant" && a.stopReason === "aborted";
				});
				if (aborted) {
					const stopNotice = this.goalSvc.onAgentEnd(conv, true);
					if (stopNotice) {
						this.emit({ type: "notice", level: "warning", text: stopNotice.text, textEn: stopNotice.textEn });
					}
					this.emitConversations();
					break;
				}
				// 子代理运行报错（provider 400 / 超时等）→ 通知主对话，让用户/AI 知道
				// 拿回的结果可能是空或无意义的（否则子代理只是安静地停在「done」，
				// 主对话永远收不到失败信号）。错误文本变化时允许再次通知（去重）。
				// fast-mode: not while a refused fast reply is being retried (it is not the run's outcome).
				if (conv.isSubagent && !fastRetry) {
					const { error } = this.subagentRunOutcome(conv);
					if (error && error !== conv.subagentErrorNotified) {
						conv.subagentError = error;
						conv.subagentErrorNotified = error;
						this.emit({
							type: "notice",
							level: "error",
							text: `Subagent ${conv.id.slice(0, 8)} (${conv.subagentType ?? "general"}) failed: ${error}`,
							textEn: `Subagent ${conv.id.slice(0, 8)} (${conv.subagentType ?? "general"}) failed: ${error}`,
						});
					} else if (error) {
						conv.subagentError = error;
					}
					this.emitConversations();
				}
				// Goal review hook lives in GoalService.onAgentEnd(conv, false).
				if (!fastRetry) this.goalSvc.onAgentEnd(conv, false);
				// Deferred settings reload: settings (system prompt / skills /
				// extensions) changed while the run was streaming — applying now
				// would have torn down the in-flight run.
				if (this.settingsSvc.hasPendingReload() && !this.disposed) {
					this.settingsSvc.consumePendingReload();
					void this.applySettingsReload();
				}
				// 触碰 sidecar 落盘：压缩后旧消息被摘要替代，files 回落现算会丢历史；
				// 条数没涨就不写（不在热路径）；子代理 inMemory 无转录文件，merge 内 no-op。
				try {
					let count = conv.touchSidecarCount ?? -1;
					try {
						count = messageCountOf(conv.session);
					} catch {
						// 会话替换中 —— 按上次条数处理（多半直接跳过）
					}
					if (count !== (conv.touchSidecarCount ?? -1)) {
						conv.touchSidecarCount = count;
						let file: string | undefined;
						try {
							file = conv.session.sessionFile ?? undefined;
						} catch {
							file = undefined;
						}
						void mergeTouchSidecar(file, extractTouches(this.convTranscript(conv)));
					}
				} catch {
					// sidecar 只是加速 + 防压缩丢失，失败了下次重算
				}
				// AI 主动上下文压缩：若本轮调过 compact_context，在回合结算后异步执行压缩
				if (!willRetry && !aborted && conv.pendingCompaction && !this.disposed) {
					const pending = conv.pendingCompaction;
					conv.pendingCompaction = null;
					setTimeout(() => {
						if (!this.disposed) {
							void this.executePendingCompaction(conv, pending);
						}
					}, 50);
				}
				// 本轮真正结束且不再重试：立即向客户端广播最新会话状态（流式状态及时复位）
				if (!willRetry) {
					this.emitConversations();
				}
				break;
			}
			case "agent_settled": {
				// fast-mode: the refused fast reply was not retried after all (stopped, or pi retried it
				// itself) — drop its "retrying" placeholder so the error and the Retry button show.
				if (conv.fastRetrying) {
					conv.fastRetrying = false;
					conv.retryState = null;
				}
				// 记录本会话自己的 Base 基线：currentBaseTokens 必须传 conv（否则串成
				// 活跃会话的基线）；快照未就绪时保持 undefined，宁可少补偿也不把 0 钉死。
				const settledBaseTokens = this.currentBaseTokens(conv);
				if (settledBaseTokens != null) conv.lastTurnBaseTokens = settledBaseTokens;
				if (conv.pendingCompaction && !this.disposed) {
					const pending = conv.pendingCompaction;
					conv.pendingCompaction = null;
					void this.executePendingCompaction(conv, pending);
				}
				// done-any-chat：这一刻 session.isStreaming 才变回 false（agent_end 时还在收尾：
				// 排队的追问、自动压缩都算这一轮）。以前没人在这时推列表，「在跑」要等 agent_end
				// 之后 800ms 那次刷新碰运气（收尾慢就还显示在跑），而且只推给订阅方。
				// 同步 v0.96.1：上游自己加了这个 case，这行并进来；两个同名 case 时后一个永远不跑。
				ClientSession.emitConversationsToAll();
				break;
			}
			case "entry_appended": {
				// SDK 仅在扩展 appendEntry 时发 entry_appended（entry 恒为 custom），
				// assistant 消息不会走这里——气泡级解析见 case "message_end"。
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				// tldr-sidebar：agent 写了一行 TL;DR → 所有窗口的左栏马上换上这一行（后台对话也是）。
				// 上面的刷新要等 800ms，而且只推订阅这条对话的这一个窗口。
				if ((event.entry as { customType?: string } | undefined)?.customType === TLDR_ENTRY_TYPE) {
					ClientSession.emitConversationsToAll();
				}
				// telegram-answers: a queued task may need the user now, or no longer.
				if ((event.entry as { customType?: string } | undefined)?.customType === TASK_QUEUE_ENTRY_TYPE) {
					ClientSession.scheduleStuckReconcile();
				}
				// identities: pi-identity set or cleared this chat's identity -> every window's labels change now
				// (the refresh above waits 800 ms, reaches only this window, and not at all once it's gone).
				if ((event.entry as { customType?: string } | undefined)?.customType === IDENTITY_ENTRY_TYPE) {
					ClientSession.identityChangedForAll();
				}
				break;
			}
			case "message_end": {
				// 轨迹事件：一条消息定稿（user/assistant 都收；custom display:false
				// 的 serializeMessage 返回 null 时跳过）。
				try {
					const ui = serializeMessage(event.message as AgentMessage, 0);
					if (ui) this.emitRun(conv, { type: "message", message: ui });
				} catch {
					/* 轨迹尽力而为 */
				}
				// tldr-answered：最新一行 TL;DR 在等用户（左栏高亮着），用户回话了 → 所有窗口的左栏马上去掉高亮，
				// 正看着这条对话的窗口也马上发快照（TL;DR tab 的高亮跟着快照走；不发的话要等模型下一步的检查点）。
				// SDK 先通知监听方、后把消息写进会话，两步在同一个同步段里：这时分支上还没有这条回话，
				// 所以放到微任务里推（落盘之后）。
				if (isTldrReply(event.message) && latestAwaitingReply(this.tldrOf(conv))) {
					queueMicrotask(() => {
						if (this.disposed) return;
						ClientSession.emitConversationsToAll();
						if (this.activeId === conv.id) this.flushSnapshot();
						this.checkpointViewers(conv.id, true);
					});
				}
				// 每条 assistant 气泡流式结束 → 立即解析其中的内联标记：每个气泡各自
				// 生效（不再等整轮 agent_end），同一轮里先前消息的标记也不再丢。
				const mm = event.message as { role?: string; stopReason?: unknown; content?: unknown };
				if (mm?.role !== "assistant") break;
				// 非 error 的 assistant 定稿 = 重试周期结束（与 SDK 重置
				// _retryAttempt 的条件一致）：即使 auto_retry_end 丢失，横幅也不会卡住。
				if (mm.stopReason !== "error") conv.retryState = null;
				// rewind-to-here：请求因为对话太大被拒 → 记下卡片数据（大小、图片数、回退建议）；
				// 好好回复了一条就清掉。pi 会把这条 413 当成上下文溢出、从当前消息里摘掉并去压缩，
				// 压缩被上下文插件取消时页面上就只剩这张卡片。
				if (mm.stopReason === "error") {
					const errorText = String((event.message as { errorMessage?: unknown }).errorMessage ?? "");
					const kind = tooBigKind(errorText);
					if (kind) this.noteTooBig(conv, kind, errorText, (event.message as { timestamp?: number }).timestamp);
				} else if (conv.tooBig) {
					conv.tooBig = null;
				}
				const text = extractAssistantTextFromContent(mm.content);
				if (text && text.includes("[[")) void this.markerSvc.handleAssistantText(conv.id, text);
				break;
			}
			case "agent_start": {
				// 轨迹事件：新一轮开始（任务文本由 prompt() 暂存；steer/内部续跑
				// 无暂存时省略，插件回退为「继续执行」）。
				const task = conv.pendingTask;
				conv.pendingTask = undefined;
				// rewind-to-here：新一轮开跑，上一次「对话太大」的卡片作废（这轮再被拒会重新记上）。
				conv.tooBig = null;
				this.emitRun(conv, task ? { type: "run_start", task } : { type: "run_start" });
				// #140：本轮真的开跑了（session.isStreaming 此刻已为 true）—— 左栏
				// 那行的「流式中」标识要立刻亮起来：首条提示词的入列 emit 早于本轮
				// 启动，那时它还是 false；后台对话被唤醒重跑也靠这里刷新。
				// done-any-chat：推给**所有**窗口，不只订阅这条对话的这一个。对话是服务端的，
				// 每个窗口的左栏都列着它；没看到它开跑的窗口，也就看不出它什么时候跑完
				// （前端靠列表里 isStreaming 从 true 变 false 响「完成」，见 web/src/streaming-cues.ts）。
				ClientSession.emitConversationsToAll();
				break;
			}
			case "turn_start": {
				this.emitRun(conv, { type: "turn_start" });
				break;
			}
			case "turn_end": {
				this.emitRun(conv, { type: "turn_end" });
				break;
			}
			case "message_update": {
				// Live assistant-message increment, deliberately OUTSIDE the snapshot
				// channel: send() drops snapshots under backpressure (big sessions),
				// but this small message must always get through or the UI freezes on
				// stale state. Only the ACTIVE conversation streams to the browser —
				// background conversations would clobber the streaming view; their
				// state arrives via snapshot when switched to.
				// server-owned-chats：「激活」要按**每个窗口**算。订阅这条对话的会话（this）是
				// 当初开它的那次页面加载，它可能早就切到别的对话、甚至页面都刷新没了，而别的
				// 窗口正看着这条。以前这里只看 this —— 它没在看就谁都收不到增量，看客的界面
				// 要刷新才动。现在：自己在看 → emit（顺带扇出）；自己没在看但别人在看 → 只扇出。
				// crash-guard: ids, not `this.conv` (see compaction_start above).
				const selfViewing = conv.id === this.activeId;
				if (!selfViewing && !this.viewedElsewhere(conv.id)) break;
				const ame = event.assistantMessageEvent;
				const m = event.message as { timestamp?: number };
				if (selfViewing) this.lastDeltaAt = Date.now();
				const delta: ServerMessage = {
					type: "message_delta",
					conversationId: conv.id,
					seq: ++conv.deltaSeq,
					// Must match serializeStreamingMessage()'s stable id so deltas
					// patch onto the snapshot's streamingMessage and reconcile.
					messageId: `stream-${m?.timestamp ?? 0}`,
					usage: (() => {
						try {
							const t = this.sessionStats(conv.session).tokens;
							return t ? { input: t.input, output: t.output, total: t.total } : null;
						} catch {
							return null;
						}
					})(),
					// Strip `partial` (the cumulative message): re-serializing it per
					// token is exactly what we're trying to avoid. The next snapshot
					// carries the authoritative full message anyway.
					assistantMessageEvent: {
						type: ame.type,
						contentIndex: "contentIndex" in ame ? ame.contentIndex : undefined,
						delta: "delta" in ame ? ame.delta : undefined,
					},
				};
				if (selfViewing) this.emit(delta);
				else this.fanOutToViewers(delta);
				break;
			}
			default:
				break;
		}
		// Snapshot checkpoint policy: deltas carry live rendering during streaming;
		// full snapshots are reconciliation checkpoints taken immediately at
		// run/tool boundaries and on a slow timer otherwise.
		//
		// 只服务**激活对话**（口径同上面的 message_update）：flushSnapshot /
		// scheduleSnapshot 推的都是 this.conv 的整份状态，而这里的事件可能来自后台
		// 对话——运行中的子代理每次 tool_execution_end / agent_end 都会走到这一点。
		// 不按 conv.id 分流 = 子代理的每一次工具调用都替激活对话做一次快照：issue
		// #259 实测 8 子代理 × 5 次 bash → 8 条全量快照共 39.5MB，而激活对话一个
		// 字节都没变。后台对话的内容在切过去时取（switch_session / get_state 强制
		// 全量），它在左栏的运行态由 emitConversations 走另一条通道。
		//
		// server-owned-chats：「激活」按每个窗口算（见 message_update）—— 正看着这条对话的
		// 别的窗口按同样的口径对账，各自生成自己的快照（checkpointViewers）。只涉及正看着
		// **这条**对话的窗口，所以 #259 的「子代理替激活对话刷快照」不会回来。
		//
		// 用户的问题落进转录（role=user 的 message_end，首条提问或中途 steer）也算边界，
		// 立即对账，问题和 isStreaming=true 一起到。以前要等定时器（上一轮刚结束时 <1.5s，
		// 看客是 2 秒）：提问的人要等一会儿才看到自己的问题，这期间流式的思考/工具卡也
		// 没有所属的提问（exchange-fold 的折叠行靠这个从第一帧就在）。
		const boundary =
			event.type === "agent_end" ||
			event.type === "tool_execution_end" ||
			event.type === "compaction_end" ||
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end" ||
			(event.type === "message_end" && (event.message as { role?: string } | undefined)?.role === "user") ||
			// 任务队列变了（queue-panel）：队列 tab 的按钮、agent 跑完后 pi-queue 的推进都只写条目、
			// 不产生消息，跑着的时候定时器要 2 秒才到。队列一个任务才变几次，立即对账。
			(event.type === "entry_appended" &&
				(event.entry as { customType?: string } | undefined)?.customType === TASK_QUEUE_ENTRY_TYPE) ||
			// identities: the chat's identity changed -> the header tag / the picker change now.
			(event.type === "entry_appended" &&
				(event.entry as { customType?: string } | undefined)?.customType === IDENTITY_ENTRY_TYPE);
		this.checkpointViewers(conv.id, boundary);
		// crash-guard: ids, not `this.conv` (see compaction_start above).
		if (conv.id !== this.activeId) return;
		if (boundary) {
			this.flushSnapshot();
		} else {
			this.scheduleSnapshot();
		}
	}

	/** Debounced push of the persisted session list + open conversations. */
	private scheduleSessionsRefresh(): void {
		if (this.sessionsTimer) return;
		this.sessionsTimer = setTimeout(() => {
			this.sessionsTimer = null;
			if (this.disposed) return;
			this.emitConversations();
			// A refresh is scheduled because a transcript on disk just changed (turn end, appended
			// entry). Drop the 3 s listing cache first: a turn that ends within 3 s of opening the
			// history list would otherwise re-push the old list, and a brand-new chat stayed missing
			// from history until the next turn (found by title-jsonl-test with a fast mock model).
			this.invalidateSessionInfos();
			void this.pushSessions();
		}, 800);
		// pushSessions no-ops unless the client opted in via list_sessions.
	}

	/** Refresh a conversation's title from its persisted first user message
	 *  while it is still unnamed. Runs off the event stream (entry_appended /
	 *  agent_end) rather than the prompt() call site, so ANY entry path that
	 *  lands a message names the chat the moment it is persisted — a rename
	 *  skipped by the prompt-start fast path (e.g. a concurrent switch) is
	 *  recovered here instead of leaving a permanent “新对话”. */
	private refreshConversationTitle(conv: Conversation): void {
		if (!isUntitledTitle(conv.title)) return;
		const title = conversationTitle(conv.session);
		if (isUntitledTitle(title)) return;
		conv.title = title;
		this.emitConversations();
	}

	/** 稳定缓存键 + 该消息的序号种子 n（见 serializeCachedFor）。
	 *
	 *  messagesOf 一次扫描里同时要 key（建 live 集合）与 n（算 user seq），所以
	 *  两者一起返回、只算一次；单独调用的路径不传 key，按需现算。 */
	private uiMessageKey(conv: Conversation, m: AgentMessage): { cacheKey: string; n: number } {
		// toolResult messages are keyed by toolCallId; everything else by
		// role+timestamp. A single prompt can emit several same-role messages
		// within the SAME millisecond (multiple attachment asides), so the
		// timestamp alone collides in the cache and only the first one renders
		// — append a cheap content fingerprint to keep them distinct while
		// staying stable across snapshots (content never changes once persisted).
		// lazy-images: the logic lives in uiMessageKeyOf (the picture endpoint needs it without a session).
		return uiMessageKeyOf(conv, m);
	}

	/** 这条对话的 TL;DR 行（tldr-panel）：当前分支上 pi-tldr 存的 `tldr` 条目。
	 *  快照流式期间 60ms 一条，所以只在会话树动了（叶子变了）时才重扫分支；行没变就返回
	 *  同一个数组。缓存挂在 Conversation 上：同一条对话的所有窗口共用。 */
	private tldrOf(conv: Conversation): UiTldrLine[] {
		try {
			const sm = conv.session.sessionManager;
			const key = `${sm.getSessionId()}\u0001${sm.getLeafId() ?? ""}`;
			const c = conv.tldrCache;
			if (c && c.key === key) return c.lines;
			const lines = tldrLinesFromEntries(sm.getBranch());
			// 折叠状态也算进签名（tldr-collapse）：只折叠了一行时行 id 没变，数组也得换，delta 才会带上。
			// 「用户回过话」同理（tldr-answered）。
			const sig = lines.map((l) => `${l.id}${l.collapsed ? "+" : ""}${l.answered ? "=" : ""}`).join("\u0001");
			conv.tldrCache = { key, sig, lines: c && c.sig === sig ? c.lines : lines };
			return conv.tldrCache.lines;
		} catch {
			return conv.tldrCache?.lines ?? [];
		}
	}

	/** identities: this chat's identity label (server/identities.ts). The last `identity` entry pi-identity
	 *  wrote on the current branch; with none ever written, the identity whose home chat this is. The walk
	 *  goes back from the leaf and stops at the first identity entry or at the leaf it saw last time, so an
	 *  ordinary append looks only at the new entries. The cache lives on the Conversation (all windows). */
	private identityOf(conv: Conversation): UiChatIdentity | undefined {
		const { identities } = identityRegistry();
		if (identities.length === 0) return undefined;
		let onBranch = conv.identityCache?.onBranch;
		let file: string | undefined;
		try {
			const sm = conv.session.sessionManager;
			file = sm.getSessionFile() ?? undefined;
			const sessionId = sm.getSessionId();
			const leafId = sm.getLeafId();
			const c = conv.identityCache;
			if (!c || c.sessionId !== sessionId || c.leafId !== leafId) {
				onBranch = undefined;
				let id = leafId;
				while (id) {
					if (c && c.sessionId === sessionId && id === c.leafId) {
						onBranch = c.onBranch;
						break;
					}
					const entry = sm.getEntry(id);
					if (!entry) break;
					const found = identityIdOfEntry(entry as IdentityEntryLike);
					if (found !== undefined) {
						onBranch = found;
						break;
					}
					id = entry.parentId;
				}
				conv.identityCache = { sessionId, leafId, onBranch };
			}
		} catch {
			// the session is being replaced: keep what was known
		}
		return uiChatIdentity(liveChatIdentityId(onBranch, file, identities), identities);
	}

	/** identities: the open chat's identity for the snapshot (the header tag, a blank chat's picker). null =
	 *  none yet; undefined = this chat can't have one: a subagent, no identities, or pi-identity isn't loaded
	 *  in it (then `/identity` would go to the model as a question). */
	private snapshotIdentityOf(conv: Conversation): UiChatIdentity | null | undefined {
		if (conv.isSubagent) return undefined;
		if (identityRegistry().identities.length === 0) return undefined;
		try {
			if (!conv.session.extensionRunner?.getCommand?.("identity")) return undefined;
		} catch {
			return undefined;
		}
		return this.identityOf(conv) ?? null;
	}

	/** 这条对话的任务队列（queue-panel）：当前分支上 pi-queue 存的 `queue` 条目重放出来的。
	 *  缓存同 tldrOf（树没动就不重扫，队列没变就返回同一个对象）。没装 pi-queue 的对话也返回一份
	 *  （available=false），tab 拿它说怎么装。 */
	private taskQueueOf(conv: Conversation): UiTaskQueue {
		return ClientSession.taskQueueOfConv(conv);
	}

	/** telegram-answers: taskQueueOf for any open chat (it needs no window), for the stuck asks. */
	private static taskQueueOfConv(conv: Conversation): UiTaskQueue {
		const empty: UiTaskQueue = { running: false, available: false, tasks: [] };
		try {
			const sm = conv.session.sessionManager;
			const available = !!conv.session.extensionRunner?.getCommand?.("queue");
			// queue-side-by-side: pi-queue's shareable list (its settings file) decides the lanes too.
			const shareable = taskQueueShareableFrom(join(process.env.PI_CODING_AGENT_DIR ?? getAgentDir(), "pi-queue.json"));
			const key = `${sm.getSessionId()}\u0001${sm.getLeafId() ?? ""}\u0001${available}\u0001${shareable.stamp}`;
			const c = conv.taskQueueCache;
			if (c && c.key === key) return c.queue;
			const queue = taskQueueFromEntries(sm.getBranch(), available, undefined, shareable.patterns);
			const sig = JSON.stringify(queue);
			// queue-grouping: a chat opened, or its queue moved a task chat in or out of a queue's group.
			if (!c || queueLinksSig(queue) !== queueLinksSig(c.queue)) ClientSession.scheduleQueueHomesRefresh();
			conv.taskQueueCache = { key, sig, queue: c && c.sig === sig ? c.queue : queue };
			return conv.taskQueueCache.queue;
		} catch {
			return conv.taskQueueCache?.queue ?? empty;
		}
	}

	/** The whole chat's display forms, for plugins (readConversationForPlugins). The page only ever gets
	 *  what it shows (lazy-images, see emitSnapshotNow); pictures here are placeholders as well. */
	private messagesOf(conv: Conversation): UiMessage[] {
		const idx = chatIndexOf(conv);
		const messages = fullRangeOf(conv, idx, 0, idx.raw.length);
		this.pruneMessageCache(conv, idx);
		// Same array as last time when nothing changed (a stable reference for callers that memoize).
		const sig = idx.keys.join("\u0001");
		if (conv.lastMessagesSig === sig) return conv.lastMessagesArray;
		conv.lastMessagesSig = sig;
		conv.lastMessagesArray = messages;
		return messages;
	}

	/** 序列化缓存上界：**先按「还在转写里」淘汰，绝不为省内存淘汰仍在转写里的条目**。
	 *
	 *  为什么不能 FIFO 淘汰（issue #259 实测的机理）：缓存上限一旦低于转写长度，
	 *  每次快照扫描前缀条目全部 miss → 重新序列化出**新对象**，emitSnapshotNow 的
	 *  identity walk 在 i=0 就失配 ⇒ 每个 checkpoint 都退化成整份全量快照，且每次
	 *  都要重算整份转写（颠簸，成本随转写线性甚至更差）。实测 6000 条转写的激活
	 *  对话 + 8 子代理 × 5 次 bash：40 次工具调用换来 8 条全量快照共 39.5MB，
	 *  `snapshot_delta` 一条都没有。
	 *
	 *  按 live 集合淘汰后：仍在转写里的消息对象恒定（identity walk 命中，增量通路
	 *  恢复），被回收的只有 fork / 压缩 / 换会话留下的死条目 —— 内存上界仍等于
	 *  「当前转写」本身（这份数组本来就要常驻），不再随历史累积。 */
	private pruneMessageCache(conv: Conversation, idx: ChatIndex): void {
		const cache = conv.uiMessageCache;
		// lazy-images: only what was sent (or read by a plugin) is built, so this cache stays small unless a
		// plugin reads a whole chat. Live entries still stay: the scheduler re-reads a chat every 2 s, and
		// evicting them would rebuild the whole chat each time.
		if (cache.size <= UI_MESSAGE_CACHE_CAP || cache.size <= idx.keys.length) return;
		const live = new Set(idx.keys);
		for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
	}

	/** Build every UiState field EXCEPT messages (the expensive part). */
	private buildLightState(rev: number, withDraft = false): Omit<UiState, "messages" | "rev"> & { rev: number } {
		const conv = this.conv;
		const state = conv.session.agent.state;
		const model = state.model;
		let stats: UiState["stats"] = {
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
		};
		try {
			const s = this.sessionStats();
			stats = {
				totalMessages: s.totalMessages,
				tokens: s.tokens,
				cost: s.cost,
				contextUsage: (() => {
					const cu = s.contextUsage;
					if (!cu) return stats.contextUsage;
					// 压缩刚结束、下轮响应未到：SDK 报 null，用压缩结果回填约数。
					if (cu.tokens == null && conv.lastCompactionTokens != null && cu.contextWindow > 0) {
						return {
							tokens: conv.lastCompactionTokens,
							contextWindow: cu.contextWindow,
							percent: (conv.lastCompactionTokens / cu.contextWindow) * 100,
							estimated: false,
							softCap: this.activeSoftCap(cu.contextWindow),
						};
					}
					// 展示用兜底 0（会话未就绪时旧行为也是 0）；落账 lastTurnBaseTokens 的路径
					// 在 agent_settled 处对 null 跳过，不受此兜底影响。
					const baseTokens = this.currentBaseTokens(conv) ?? 0;
					// 空白会话（尚未发言，SDK 报 0 或 null）：真实反映当前模式/工具配置下的 Base 开销。
					if (cu.contextWindow > 0 && (this.isBlankConversation(conv) || cu.tokens == null || cu.tokens === 0)) {
						return {
							tokens: baseTokens,
							contextWindow: cu.contextWindow,
							percent: (baseTokens / cu.contextWindow) * 100,
							estimated: false,
							softCap: this.activeSoftCap(cu.contextWindow),
						};
					}
					// 首轮对话中（尚未有定稿 assistant 消息，SDK cu.tokens 仅为当前消息估算）：叠加 Base 开销
					if (conv.lastTurnBaseTokens == null && cu.contextWindow > 0) {
						const total = baseTokens + (cu.tokens ?? 0);
						return {
							tokens: total,
							contextWindow: cu.contextWindow,
							percent: (total / cu.contextWindow) * 100,
							estimated: false,
							softCap: this.activeSoftCap(cu.contextWindow),
						};
					}
					// 已有多轮对话历史：若在对话间歇切预设或开关工具，叠加当前 Base 开销相比上一轮定稿时的差额
					const baseDelta = baseTokens - (conv.lastTurnBaseTokens ?? baseTokens);
					const effectiveTokens = Math.max(0, (cu.tokens ?? 0) + baseDelta);
					return {
						tokens: effectiveTokens,
						contextWindow: cu.contextWindow,
						percent: cu.contextWindow > 0 ? (effectiveTokens / cu.contextWindow) * 100 : cu.percent,
						estimated: false,
						softCap: this.activeSoftCap(cu.contextWindow),
					};
				})(),
			};
		} catch {
			// stats are best-effort
		}
		// 流式 error 同样是中间态（定稿走 message_end/agent_end）：先藏起
		// errorMessage，避免红色在 streaming 气泡里闪一下。最终失败会经由
		// messages 永久标红，不影响告警。
		// rewind-to-here：重开的对话（比如服务重启后）最后一条就是「太大发不出去」的报错 → 补量一次卡片数据。
		// undefined = 这条对话还没查过；查过就是对象或 null，不再重复。
		if (conv.tooBig === undefined) {
			conv.tooBig = null;
			const last = state.messages[state.messages.length - 1] as
				{ role?: string; stopReason?: string; errorMessage?: string; timestamp?: number } | undefined;
			const kind = last?.role === "assistant" && last.stopReason === "error" ? tooBigKind(last.errorMessage) : null;
			if (kind && !state.isStreaming) this.noteTooBig(conv, kind, last?.errorMessage ?? "", last?.timestamp);
		}
		let streamingMessage = state.streamingMessage ? serializeStreamingMessage(state.streamingMessage) : null;
		if (streamingMessage?.stopReason === "error") {
			streamingMessage = { ...streamingMessage, errorMessage: undefined };
		}
		return {
			clientId: this.clientId,
			cwd: this.cwd,
			// 判重：直接读缓存字段，不在快照热路径上重读 client-state。
			workspaceRoots: this.roots,
			// 用户主目录（右栏 🏠）：进程内不变，模块级求值一次，不在热路径调 homedir()。
			homeDir: HOME_WIRE,
			desktopDir: DESKTOP_WIRE,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			conversationId: this.activeId,
			// 临时对话标记（issue #285）：提示条/转正按钮跟当前对话走。
			// 不能只靠 conversations 列表 —— 空白的临时对话不在运行列表里（shownInRunningList
			// 只列有内容的），刚新建时列表里查不到它，提示条就永远不出现。
			// 必须**恒存在**（不能只在 true 时展开）：转正后它由 true→false，而增量快照是
			// `{...ui, ...d.state}` 浅合并，缺字段会把 true 残留下来。
			isEphemeral: !!this.conv?.isEphemeral,
			rev,
			streamingMessage,
			isStreaming: this.session.isStreaming,
			model: model
				? {
						id: model.id,
						name: model.name,
						provider: model.provider,
						vision: model.input?.includes("image") ?? false,
					}
				: null,
			thinkingLevel: state.thinkingLevel,
			// Only the levels the current model actually supports — the SDK clamps
			// anything else, so the UI must not offer (or must disable) the rest.
			availableThinkingLevels: this.session.getAvailableThinkingLevels(),
			queue: { steering: conv.queueSteering, followUp: conv.queueFollowUp },
			errorMessage: state.errorMessage,
			retry: conv.retryState ?? null,
			compaction: conv.compactionState ?? null,
			rewinding: conv.rewinding ?? null,
			tooBig: conv.tooBig ?? null,
			pendingQuestion: this.pendingQuestionForSnapshot(),
			pendingApproval: this.pendingApprovalForSnapshot(),
			subagentHandoffs: this.subagentHandoffs.length > 0 ? [...this.subagentHandoffs] : undefined,
			agentPreset: conv
				? {
						id: conv.agentPreset ?? "standard",
						name: PI_AGENT_PRESETS.find((p) => p.id === conv.agentPreset)?.name ?? "Full",
						locked: conv.presetLocked || !this.isBlankConversation(conv),
					}
				: null,
			permission: conv
				? (conv.permissionPreset ?? this.settingsSvc.current.defaultPermissionPreset ?? "workspace-write-never")
				: null,
			// fast-mode: the "⚡ Fast" button (null = this model has no fast mode, no button). Always present:
			// snapshot deltas are merged shallowly, a missing key would leave the last chat's button behind.
			fastMode: conv ? fastModeRegistry.view(conv.session.sessionManager, model) : null,
			// 未发送草稿只跟全量快照走（切会话/new_chat/get_state）：增量 delta 里
			// 这个 key 必须整个缺席（不能是显式的 undefined——前端 delta 合并是
			// {...ui, ...d.state} 整批覆盖，显式 undefined 会把上次全量带回的草稿洗掉）。
			...(withDraft ? { draft: this.draftForSnapshot() } : {}),
			tools: state.tools.map((t) => t.name),
			version: ++this.version,
			piConfigured: this.isPiConfigured(),
			piAgentInstalled: this.isPiCliInstalled(),
			stats,
		};
	}

	/** Emit one snapshot update — incremental when possible, full otherwise.
	 *
	 *  Persisted messages are content-immutable with reference-stable objects
	 *  (serializeCached), so an IDENTITY WALK over the previous array detects
	 *  append-only growth in O(n) pointer compares. Appends travel as
	 *  snapshot_delta carrying only the new tail + light fields; any mid-array
	 *  change/truncation (switch session, edit fork, compaction) or a forced
	 *  resync falls back to a full snapshot. The 10MB-stringify-per-checkpoint
	 *  cost of big sessions collapses to a few hundred bytes for the common
	 *  "nothing but stats/version changed" checkpoint. */
	private emitSnapshotNow(forceFull = false): void {
		if (this.disposed) return;
		// crash-guard: this window's chat may have been closed by another window (see
		// recoverLostActive). Move to an open chat, or skip this snapshot instead of throwing
		// "no active conversation" (that throw once took the whole server down).
		if (!this.convs.has(this.activeId) && !this.recoverLostActive("snapshot")) return;
		const conv = this.conv;
		// lazy-images: the index is cheap (raw messages and ids); display forms are built only for what goes out.
		const idx = chatIndexOf(conv);
		this.pruneMessageCache(conv, idx);
		const total = idx.keys.length;
		const full = (i: number) => fullAt(conv, idx, i);
		const windowStart = Math.max(0, total - MESSAGE_WINDOW);
		const prev = this.emittedKeys;
		let incremental = !forceFull && prev !== null && this.emittedConvId === this.activeId && prev.length <= total;
		if (incremental && prev && prev !== idx.keys) {
			for (let i = 0; i < prev.length; i++) {
				if (prev[i] !== idx.keys[i]) {
					incremental = false;
					break;
				}
			}
		}
		const rev = ++this.snapRev;
		const tldr = this.tldrOf(this.conv);
		const tldrChanged = tldr !== this.emittedTldr;
		this.emittedTldr = tldr;
		const taskQueue = this.taskQueueOf(this.conv);
		const taskQueueChanged = taskQueue !== this.emittedTaskQueue;
		this.emittedTaskQueue = taskQueue;
		const dialog = this.conv.dialogs.current;
		const dialogChanged = dialog !== this.emittedDialog;
		this.emittedDialog = dialog;
		const identity = this.snapshotIdentityOf(this.conv);
		const identitySig = identity === undefined ? "" : identity ? `${identity.id}\u0001${identity.title}` : "-";
		const identityChanged = identitySig !== this.emittedIdentity;
		this.emittedIdentity = identitySig;
		if (incremental && prev) {
			const baseRev = this.emittedRev;
			this.emittedKeys = idx.keys;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			const appended = fullRangeOf(conv, idx, prev.length, total);
			this.emit({
				type: "snapshot_delta",
				rev,
				baseRev,
				conversationId: this.activeId,
				appended,
				state: {
					...this.buildLightState(rev, false),
					// 提问索引只在真的多了提问时重发：流式期间 delta 每 60ms 一条，
					// 十几 KB 的索引跟着走就是纯浪费。缺省时客户端沿用上一份。
					// 窗口起点不跟 delta 发：追加只长末尾，客户端的 start 不变。
					...(appended.some((m) => m.role === "user")
						? { questionIndex: buildQuestionIndex(idx.raw, (i) => idx.ids[i]) }
						: {}),
					// TL;DR 行同理：只在列表变了时带（tldrOf 在行没变时返回同一个数组）。
					...(tldrChanged ? { tldr } : {}),
					// 任务队列同理（taskQueueOf 在队列没变时返回同一个对象）。
					...(taskQueueChanged ? { taskQueue } : {}),
					// 弹窗同理（没变时 current 是同一个对象）。
					...(dialogChanged ? { dialog } : {}),
					// identities: the chat's identity, only when it changed (a delta can't say "can't have one"; that
					// changes only with a new session or a reload, which send a full snapshot).
					...(identityChanged && identity !== undefined ? { identity } : {}),
				},
			});
		} else {
			this.emittedKeys = idx.keys;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			// switch-cache：切回来的这条对话，客户端缓存里那一截对得上就只发后面新增的。
			// 客户端的窗口起点照旧（和 delta 一样只往后长），摘要按这个起点算。
			const resume = this.resumeWindow(idx.ids);
			const start = resume ? resume.start : windowStart;
			this.emit({
				type: "snapshot",
				...(resume ? { reuse: resume } : {}),
				// 全量快照一律带草稿（切会话/new_chat/改写分支/重连 get_state 全走这里）；
				// 60ms 热帧是上面的 snapshot_delta，本来就不带。
				state: {
					...this.buildLightState(rev, true),
					// 只发最新的一截：一个 8600 条的会话完整快照是 35MB，尾部 100 条
					// 是 0.5MB（实测 1.5%）。更老的由 load_older 按需取回。
					messages: fullRangeOf(conv, idx, resume ? resume.start + resume.count : windowStart, total),
					messagesStart: start,
					questionIndex: buildQuestionIndex(idx.raw, (i) => idx.ids[i]),
					// 窗口之前最近几轮的摘要（exchange-digest）：窗口常常全落在最后一轮里，
					// 没有它页面上就只剩一行。delta 不带：窗口前面的历史只随整份快照变。
					...(EXCHANGE_DIGESTS > 0 ? { exchanges: snapshotDigests(idx.raw, start, EXCHANGE_DIGESTS, full) } : {}),
					// 整份快照总带 TL;DR（没有就是 []）：切对话时要把上一条的行换掉。
					tldr,
					// 任务队列同理：切对话时换成这一条的。
					taskQueue,
					// 弹窗也是（没有就是 null）：切回来、刷新都靠这里把它带回来。
					dialog,
					// identities: the chat's identity (null = none); left out = this chat can't have one.
					...(identity !== undefined ? { identity } : {}),
				},
			});
		}
	}

	/** switch-cache：客户端这次切换报上来的缓存窗口（switchHave）还和现在的消息对得上吗？
	 *  对得上就返回它（整份快照只带 [start+count, 末尾)），否则 null（照常发最新一截）。
	 *
	 *  只认目标对话已经是当前对话的那一份整份快照（会话 id 对得上），用过即清：从历史打开
	 *  要先 await 建 runtime，这期间旧对话的整份快照（get_state 之类）不能把它吃掉。
	 *  新增的超过一个窗口就不续了：发整份最新一截更小，客户端的窗口也不至于越长越大。
	 *  从历史重开后助手消息的 id 可能换号（序号是每条对话自己的计数器，压缩过就对不上），
	 *  那样指纹不一致，就是一份正常的整份快照。 */
	private resumeWindow(ids: readonly string[]): CachedWindow | null {
		const have = this.switchHave;
		if (!have || typeof have !== "object" || have.sessionId !== this.session.sessionId) return null;
		this.switchHave = null;
		const { start, count, hash } = have;
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 1) return null;
		if (typeof hash !== "string") return null;
		const end = start + count;
		if (end > ids.length || ids.length - end > MESSAGE_WINDOW) return null;
		if (idsHash(ids, start, end) !== hash) return null;
		return { sessionId: have.sessionId, start, count, hash };
	}

	/** 服务 load_older：把 [start, beforeIndex) 这一段历史消息发回去。
	 *  越界一律夹到合法区间；空区间直接不发（客户端自己会因为 start=0
	 *  收起按钮）。 */
	loadOlder(beforeIndex: number, count?: number): void {
		if (this.disposed) return;
		const conv = this.conv;
		const idx = chatIndexOf(conv);
		const end = Math.min(Math.max(0, Math.floor(beforeIndex)), idx.keys.length);
		const take = Math.max(1, Math.floor(count ?? MESSAGE_WINDOW));
		const start = Math.max(0, end - take);
		if (end <= start) return;
		// 新起点落在一轮中间：附上这一轮开头那一截的摘要（exchange-digest），客户端手里的那份
		// 计数覆盖到旧起点，和这次载入的消息重复了。
		const straddle = EXCHANGE_DIGESTS > 0 ? straddleDigest(idx.raw, start, (i) => fullAt(conv, idx, i)) : undefined;
		this.emit({
			type: "older_messages",
			conversationId: this.activeId,
			start,
			messages: fullRangeOf(conv, idx, start, end),
			...(straddle ? { straddle } : {}),
		});
	}

	/** 服务 load_exchanges（exchange-digest）：beforeIndex 之前的几轮摘要。默认取最近的
	 *  count 轮（缺省 EXCHANGE_DIGESTS），给了 fromIndex 就取开头在 [fromIndex, beforeIndex) 里的每一轮。
	 *  空结果也回（客户端靠它知道到顶了）。 */
	loadExchanges(beforeIndex: number, count?: number, fromIndex?: number): void {
		if (this.disposed) return;
		const conv = this.conv;
		const idx = chatIndexOf(conv);
		const before = Math.min(Math.max(0, Math.floor(beforeIndex)), idx.keys.length);
		const n = typeof count === "number" && Number.isFinite(count) ? count : EXCHANGE_DIGESTS || 5;
		const pick =
			typeof fromIndex === "number" && Number.isFinite(fromIndex)
				? { from: fromIndex }
				: { count: Math.max(1, Math.floor(n)) };
		this.emit({
			type: "older_exchanges",
			conversationId: this.activeId,
			beforeIndex: before,
			exchanges: digestsBefore(idx.raw, before, pick, undefined, (i) => fullAt(conv, idx, i)),
		});
	}

	/** 服务 tldr_collapse：用户在 TL;DR tab 里折叠（collapsed=true）或重新展开了这些行。
	 *  记成会话里的一条自定义条目（TLDR_COLLAPSE_TYPE），跟行本身一样随会话走：刷新、重启、
	 *  别的窗口和设备看到的都一样。只记状态真的变了的行（重复点击不写文件）；
	 *  对话已经换了（conversationId 对不上）就不记。 */
	setTldrCollapsed(ids: unknown, collapsed: unknown, conversationId?: unknown): void {
		if (this.disposed) return;
		if (typeof conversationId === "string" && conversationId && conversationId !== this.activeId) return;
		const want = tldrCollapseData(ids, collapsed);
		if (!want) return;
		const conv = this.conv;
		const now = new Map(this.tldrOf(conv).map((l) => [l.id, l.collapsed === true]));
		const changed = want.ids.filter((id) => now.has(id) && now.get(id) !== want.collapsed);
		if (changed.length === 0) return;
		try {
			conv.session.sessionManager.appendCustomEntry(TLDR_COLLAPSE_TYPE, { ...want, ids: changed });
		} catch (err) {
			console.warn(`[tldr-collapse] not saved: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		// 写条目不发会话事件：自己马上发快照（叶子变了，tldrOf 重算），正看着这条对话的别的窗口也马上对账。
		this.flushSnapshot();
		this.checkpointViewers(conv.id, true);
		// tldr-sidebar：折叠 / 展开了最新一行 → 所有窗口的左栏在这一行和「N 条消息」之间切换。
		ClientSession.emitConversationsToAll();
	}

	/** 服务 queue_command（queue-panel）：队列 tab 的按钮。转成 `/queue …` 交给 pi-queue 的命令执行：
	 *  扩展命令即时执行（agent 在跑也行）、不进消息列表；pi-queue 写的条目走 entry_appended，
	 *  立即对账（见 onEvent 的 boundary）。pi-web-ui 自己不写队列条目。
	 *  对话已经换了（conversationId 对不上）、参数不对、这条对话没装 pi-queue 就不做：没有 /queue
	 *  命令时 prompt 会把这行字当成普通提问发给模型。 */
	async taskQueueCommand(action: unknown, id: unknown, conversationId?: unknown): Promise<void> {
		if (this.disposed) return;
		if (typeof conversationId === "string" && conversationId && conversationId !== this.activeId) return;
		const line = taskQueueCommandLine(action, id);
		if (!line) return;
		const session = this.conv.session;
		try {
			if (!session.extensionRunner?.getCommand?.("queue")) return;
			await session.prompt(line);
		} catch (err) {
			console.warn(`[queue-panel] ${line}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** identities: set_chat_identity (the chat menu, the header label, the blank-chat picker). Runs
	 *  pi-identity's own `/identity <id>` / `/identity none` in that chat, so the rules live in one place: the
	 *  command writes the `identity` entry (entry_appended -> every window's labels) and says what changed.
	 *  A loaded chat is found by conversationId or by its file; a chat only on disk (a History row) is opened
	 *  first, like clicking it. Nothing happens for an unknown identity, or a chat without pi-identity (then
	 *  `/identity` would go to the model as a question), which gets a notice instead. */
	async setChatIdentity(conversationId: unknown, sessionPath: unknown, identity: unknown): Promise<void> {
		if (this.disposed) return;
		const line = identityCommandLine(identity, identityRegistry(true).identities);
		if (!line) return;
		const find = (): Conversation | undefined => {
			if (typeof conversationId === "string" && conversationId) {
				const byId = this.convs.get(conversationId);
				if (byId) return byId;
			}
			if (typeof sessionPath !== "string" || !sessionPath) return undefined;
			const want = resolve(sessionPath);
			for (const c of this.convs.values()) {
				const f = c.session.sessionFile;
				if (f && resolve(f) === want) return c;
			}
			return undefined;
		};
		let conv = find();
		if (!conv && typeof sessionPath === "string" && sessionPath) {
			await this.switchSession(sessionPath);
			if (this.disposed) return;
			conv = find();
		}
		if (!conv) return;
		const session = conv.session;
		if (!session.extensionRunner?.getCommand?.("identity")) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "This chat can't take an identity: the pi-identity extension isn't loaded in it.",
				textEn: "This chat can't take an identity: the pi-identity extension isn't loaded in it.",
			});
			return;
		}
		try {
			await session.prompt(line);
		} catch (err) {
			console.warn(`[identities] ${line}: ${err instanceof Error ? err.message : String(err)}`);
		}
		// The entry is in memory now (a blank chat writes its file with the first reply): the labels change
		// here, not at the next disk refresh.
		ClientSession.emitConversationsToAll();
	}

	/** Resolve a browser-bridged dialog (select/confirm/input) for this session. */
	resolveDialog(id: number, value: string | boolean | null): void {
		// per-chat-dialogs：先找对话的弹窗（哪个窗口看着那条对话都能答），不是的话才是本窗口自己的（目标向导）。
		for (const conv of this.convs.values()) if (conv.dialogs.answer(id, value)) return;
		this.webUi.resolveDialog(id, value);
	}

	// -----------------------------------------------------------------------
	// 用户提问桥（标准 pi 引擎 ask_user_question customTool）
	// -----------------------------------------------------------------------

	/**
	 * 桥接工具目标（ask_user_question / browser_page）：**调用瞬间**按 runtime 身份
	 *  解析当前持有它的会话与对话 id，而不是用建 runtime 时捕获的 `this` + ownerId
	 *  （过户会把 runtime 搬到另一个 ClientSession，闭包里的会话引用与 id 都不跟着
	 *  搬 —— 详见 findConversationHome）。
	 *
	 *  工厂（makeAskUserQuestionTool / makeBrowserPageTool）是鸭子类型，只要求这几个
	 *  方法，所以这里给的是一个按需转发的小适配器：工厂传进来的 convId 是**建时**的
	 *  旧 id（过户撞车改名后它要么查不到、要么撞到别的对话），一律以解析结果为准。
	 *  解析不到（未接线 / 会话被替换 / 对话已关闭）时兜底建时的会话与 id —— 与改动前
	 *  行为一致。anchor 由 runtime 创建处在拿到 `created.session` 后回填。
	 */
	private bridgeTarget(anchor: { session?: AgentSession }, ownerId?: string) {
		const home = (): { session: ClientSession; convId: string | undefined } => {
			const found = anchor.session ? this.findConversationHome?.(anchor.session) : undefined;
			return found ?? { session: this, convId: ownerId };
		};
		return {
			askUser: (questions: UiQuestion[], sig: { aborted?: boolean }) => {
				const h = home();
				return h.session.askUser(questions, sig, h.convId);
			},
			pageCall: (req: PageCallRequest, sig: { aborted?: boolean }) => {
				const h = home();
				return h.session.pageCall(req, sig, h.convId);
			},
			// 截图「给图还是走视觉桥」按当前持有方的模型与设置判定（过户后由它驱动）。
			canSeeImages: () => home().session.canSeeImages(),
			transcribeToolImage: (image: { data: string; mimeType: string }, signal?: AbortSignal) =>
				home().session.transcribeToolImage(image, signal),
		};
	}

	/** 标准引擎模型调 ask_user_question：发 question_pending 给浏览器并阻塞等待
	 *  question_answer。sig 为工具执行信号的当前状态（aborted → 立即 reject）。
	 *  返回 answers（用户选中/自定义），或 null（用户取消）。
	 *
	 *  不设超时：等的是「人类回答」，不是挂死的工具。因此也不进工具挂死看门狗
	 *  （见 tool_execution_start）、不算 stall 失联（见 startStallTimer）。 */
	askUser(
		questions: UiQuestion[],
		sig: { aborted?: boolean },
		conversationId?: string,
	): Promise<QuestionAnswer[] | null> {
		return new Promise((resolve, reject) => {
			if (sig?.aborted || this.disposed) {
				reject(new Error("ask_user_question aborted"));
				return;
			}
			// 问卷开关（默认开）：关 → 不弹对话框，立即报错让模型得知已禁用。
			// 与统一工具门控双保险：工具 tab 里单独关掉 ask_user_question 也一样拒收。
			if (
				this.settingsSvc.current.questionnaireEnabled === false ||
				(this.settingsSvc.current.disabledAgentTools ?? []).includes(ASK_USER_QUESTION_TOOL_NAME)
			) {
				reject(new Error("Questionnaires are turned off; turn them back on in Settings"));
				return;
			}
			const id = `q-${++ClientSession.questionSeq}`;
			const conversationTitle = conversationId ? this.convs.get(conversationId)?.title : undefined;
			const entry: PendingQuestionEntry = { resolve, questions, conversationId, conversationTitle, askId: id };
			this.pendingQuestions.set(id, entry);
			// telegram-answers: also in the list of asks, so a plugin (Telegram) can show and answer it.
			askHub.add(
				questionAsk(
					id,
					questions,
					ClientSession.askMetaOf(conversationId ? this.convs.get(conversationId) : undefined),
				),
				(answers, from) => {
					const qid = ClientSession.questionIdOfAsk(id);
					const current = qid ? this.pendingQuestions.get(qid) : undefined;
					if (!qid || !current) return { ok: false, error: NOT_WAITING };
					const ok = this.resolveQuestion(qid, questionAnswersFrom(current.questions, answers), false, from);
					return ok ? { ok: true } : { ok: false, error: NOT_WAITING };
				},
			);
			// 运行列表的「?」角标靠 conversations 推送（问卷登记/解决不经过快照通道）。
			ClientSession.emitConversationsToAll();
			// ask-question-delivery：不走上游的 shouldPopQuestion（只推给正开着该对话的页面）。
			// 别的对话在问也照样弹，对话框标出是哪条对话在问 —— 问卷阻塞整个 agent 循环，
			// 比起角标更不能漏看（用户 2026-09-23 的选择）。
			// 没有任何页面连着时不能直接 emit —— emit 会静默丢弃，而 askUser 不设
			// 超时，这轮就永远回不来了（问卷「不弹」的根因）。判定见 ask-delivery.ts。
			if (askDeliveryOnAsk(ClientSession.connectedClientCount()) === "emit") {
				// multi-device：广播给**所有**在线设备，而不只是发起提问的那一台——
				// 在笔记本上被问、走到台式机上回答。conversationTitle 让正在看别
				// 的对话的那台知道这是谁在问。
				ClientSession.broadcastToAllClients({
					type: "question_pending",
					id,
					questions,
					...(conversationId !== undefined ? { conversationId } : {}),
					...(conversationTitle ? { conversationTitle } : {}),
				});
				return;
			}
			// 刷新/重连的空窗：等一会儿。期间页面回来了 → 快照把对话框补出来
			// （pendingQuestionForSnapshot 不再按对话过滤），不必补发即时消息。
			// telegram-answers: while a plugin (Telegram) shows asks, it waits for an answer from there
			// or from a page that comes back, instead of being refused because no page is open.
			if (askHub.listening) return;
			entry.graceTimer = setTimeout(() => {
				if (askHub.listening) return;
				const stillPending = this.pendingQuestions.get(id) === entry;
				const clientCount = ClientSession.connectedClientCount();
				if (askDeliveryOnGraceExpiry({ clientCount, stillPending }) !== "reject") return;
				this.pendingQuestions.delete(id);
				askHub.settle(id, { how: "gone", reason: "no browser was open" });
				// The "?" on the chat list goes away too (as in resolveQuestion).
				ClientSession.emitConversationsToAll();
				reject(new Error(ASK_USER_NO_CLIENT_ERROR));
			}, ASK_USER_NO_CLIENT_GRACE_MS);
			// 别让这个计时器拖住进程退出（dispose 时也会清，见 cancelPendingQuestions）。
			entry.graceTimer.unref?.();
		});
	}

	/** 前端回答模型提问（question_answer → 恢复 askUser 的 Promise）。id 需匹配
	 *  pendingQuestions 中键；未匹配（对方刚回答/取消、页面刷新重发）静默忽略。
	 *  成功 resolve 后同步推 question_retracted + conversations：本页 live 对话框
	 *  靠前者收起（跨页作答时源页就靠它），别处的「?」角标靠后者即时消失。
	 *  ask-question-delivery：两者都推给**所有**在线设备（问卷进程共享，每台都可能开着）。
	 *  返回是否真的恢复了一个挂起提问（跨页作答的送达回执用）。 */
	resolveQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean, from: string = FROM_BROWSER): boolean {
		const pending = this.pendingQuestions.get(id);
		if (!pending) return false;
		this.pendingQuestions.delete(id);
		if (pending.graceTimer) clearTimeout(pending.graceTimer);
		pending.resolve(cancelled ? null : answers);
		// telegram-answers: whoever shows it elsewhere learns the answer and where it came from.
		if (pending.askId) {
			if (cancelled) askHub.settle(pending.askId, { how: "gone", reason: `cancelled in the ${from}` });
			else
				askHub.settle(pending.askId, {
					how: "answered",
					summary: summarizeQuestionAnswers(pending.questions, answers),
					from,
				});
		}
		// multi-device：别的设备上还开着同一张问卷 —— 广播收起，第一个答的生效。
		// 前端只收「正好是这个 id」的那张，紧接着弹出的下一张不会被误关。
		ClientSession.broadcastToAllClients({ type: "question_retracted", id });
		// 同上：角标消失也要即时推送（否则要等到 run 结束别处才知道问完了）。
		ClientSession.emitConversationsToAll();
		return true;
	}

	/** 快照侧的待答提问（UiState.pendingQuestion）：**不分对话一律带上**——问卷
	 *  的唯一入口就是对话框，按 activeId 过滤会让「提问时没人在线」的问卷只在用户
	 *  恰好回到那条对话时才复活，否则永远丢失而服务端还阻塞着（见 ask-delivery.ts）。
	 *  conversationId 随快照一起给前端，用于标注这张问卷属于哪条对话。 */
	private pendingQuestionForSnapshot(): UiState["pendingQuestion"] {
		const picked = pickPendingQuestionForSnapshot(this.pendingQuestions);
		if (!picked) return null;
		// 标题按对话现名取（改过名也跟上，同上游）；取不到时用提问时记下的（picked 已带）。
		// 不回落到「本客户端当前对话」：问卷进程共享，那会给别的设备标错来源。
		const liveTitle = picked.conversationId !== undefined ? this.convs.get(picked.conversationId)?.title : undefined;
		return liveTitle ? { ...picked, conversationTitle: liveTitle } : picked;
	}

	/** 对话是否阻塞在等用户回答上（用于 stall 失联判定豁免）。 */
	private isWaitingOnUser(conversationId: string): boolean {
		for (const p of this.pendingQuestions.values()) {
			if (p.conversationId === undefined || p.conversationId === conversationId) return true;
		}
		for (const a of this.pendingApprovals.values()) {
			if (a.conversationId === undefined || a.conversationId === conversationId) return true;
		}
		return false;
	}

	/** 标准引擎的 question_answer 路由入口（index.ts 经 cs.answerQuestion?. 转发）。
	 *  DSH 引擎的 AgentService 也实现了同名方法，此处为 ClientSession 的转发。 */
	answerQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean): Promise<void> {
		this.resolveQuestion(id, answers, cancelled);
		return Promise.resolve();
	}

	/** 取某对话的等答复问卷原文（跨页作答的 peek 用；只读，不改变状态）。 */
	peekPendingQuestion(convId: string): { id: string; questions: UiQuestion[]; conversationTitle?: string } | undefined {
		for (const [id, p] of this.pendingQuestions) {
			if (p.conversationId === convId) {
				const conv = this.convs.get(convId);
				return { id, questions: p.questions, conversationTitle: conv?.title };
			}
		}
		return undefined;
	}

	/** 取某对话的等答复问卷简要信息（用于会话列表与横幅展示）。 */
	private getPendingQuestionForConv(convId: string): { id: string; title?: string } | undefined {
		for (const [id, p] of this.pendingQuestions) {
			if (p.conversationId === undefined || p.conversationId === convId) {
				const q0 = p.questions[0];
				const title = q0?.header?.trim() || q0?.question?.trim() || undefined;
				return { id, title };
			}
		}
		return undefined;
	}

	/** 跨页作答：把别处问卷的原文推给本页弹框（回答经 answerElsewhereQuestion 回去）。 */
	pushElsewhereQuestion(
		owner: string,
		convId: string,
		q: { id: string; questions: UiQuestion[]; conversationTitle?: string },
	): void {
		this.emit({
			type: "elsewhere_question",
			owner,
			convId,
			id: q.id,
			questions: q.questions,
			...(q.conversationTitle ? { conversationTitle: q.conversationTitle } : {}),
		});
	}

	// -----------------------------------------------------------------------
	// 人机协同工具审批桥（Tool Approval: Human-in-the-Loop Edit & Run）
	// -----------------------------------------------------------------------

	/**
	 * 弹审批（Human-in-the-Loop）。**三档放行门禁在入口**（策略纯函数见
	 * server/tool-approval.ts 的 approvalSuppressionReason）：
	 * - 全局开关关（设置 →「工具」页）→ 直接批准（不弹）；
	 * - 本对话「全部允许」/ 已记住该同类 → 直接批准（不弹）。
	 * 门禁都返回已 resolve 的 Promise，调用方（withToolGuard / 三个权限包装）
	 * 无需关心是否真的弹过窗。
	 */
	askApproval(
		toolCallId: string,
		toolName: string,
		params: unknown,
		reason?: string,
		reasonEn?: string,
		conversationId?: string,
		category?: UiApprovalCategory,
	): Promise<ToolApprovalResolution> {
		return new Promise((resolve) => {
			// telegram-answers: the window that opened the chat may be gone (refreshed, closed, a queue or
			// scheduler run); the prompt still waits, since every window and a plugin (Telegram) can
			// answer it. It is refused only when nothing is left that could (the server shutting down).
			if (this.disposed && ClientSession.liveSessions.size === 0 && !askHub.listening) {
				resolve({ decision: "deny", reason: "Session closed" });
				return;
			}
			const id = `appr-${++ClientSession.approvalSeq}`;
			const conv = conversationId ? this.convs.get(conversationId) : this.conv;
			const suppression = approvalSuppressionReason(
				conv?.approvalPolicy,
				this.settingsSvc.current.toolApprovalEnabled !== false,
				category?.id,
			);
			if (suppression) {
				// 放行但不弹窗：不记 pending，不发消息，模型继续跑。
				resolve({ decision: "approve" });
				return;
			}
			const conversationTitle = conv?.title;
			const entry: PendingApprovalEntry = {
				id,
				toolCallId,
				toolName,
				params: params as Record<string, unknown>,
				reason,
				reasonEn,
				...(category ? { category } : {}),
				conversationId,
				conversationTitle,
				resolve,
				createdAt: Date.now(),
			};
			this.pendingApprovals.set(id, entry);
			askHub.add(
				approvalAsk(id, { toolName, params, reason, reasonEn, category }, ClientSession.askMetaOf(conv)),
				(answers, from) => {
					const a = approvalFrom(answers);
					if (!a) return { ok: false, error: "not one of the choices" };
					return this.resolveToolApproval(id, a.decision, undefined, undefined, a.scope, from)
						? { ok: true }
						: { ok: false, error: NOT_WAITING };
				},
			);
			// Every window shows it, named after its chat (like questions).
			ClientSession.broadcastToAllClients({
				type: "tool_approval_pending",
				id,
				toolCallId,
				toolName,
				params: params as Record<string, unknown>,
				reason,
				reasonEn,
				...(category ? { category } : {}),
				...(conversationId !== undefined ? { conversationId } : {}),
				...(conversationTitle ? { conversationTitle } : {}),
			});
			ClientSession.approvalsChanged();
		});
	}

	/**
	 * 审批答复。scope（仅 approve 有效）是「不再问」的两档记忆：
	 * - "category"：记住本对话的该同类档位；
	 * - "all"：本对话后续全部允许。
	 * 记住后，同一对话里**已被覆盖的其它待审批项一并放行**（否则用户点了
	 * 「全部允许」却还有几张弹窗挂着等点），并推一次设置面板（撤销区）。
	 */
	resolveToolApproval(
		id: string,
		decision: "approve" | "deny" | "edit",
		editedParams?: unknown,
		reason?: string,
		scope?: "once" | "category" | "all",
		from: string = FROM_BROWSER,
	): boolean {
		const pending = this.pendingApprovals.get(id);
		if (!pending) return false;
		const convId = pending.conversationId ?? this.activeId;
		const conv = this.convs.get(convId);
		this.pendingApprovals.delete(id);
		pending.resolve({ decision, editedParams, reason });
		// telegram-answers: every window may show it, and a plugin (Telegram) may too.
		askHub.settle(id, { how: "answered", summary: summarizeApproval(decision, scope), from });
		ClientSession.broadcastToAllClients({ type: "tool_approval_resolved", id });
		if (decision === "approve" && scope && scope !== "once" && conv) {
			const policy = this.ensureApprovalPolicy(conv);
			if (scope === "all") policy.allowAll = true;
			else if (pending.category) policy.categories.set(pending.category.id, pending.category);
			this.emitApprovalPolicyNotice(scope, pending.category, this.approveCoveredPending(convId, policy, from));
			this.settingsSvc.push();
		}
		ClientSession.approvalsChanged();
		return true;
	}

	/** 取出（或建出）对话的审批策略对象。 */
	private ensureApprovalPolicy(conv: Conversation): ApprovalPolicy {
		if (!conv.approvalPolicy) conv.approvalPolicy = { allowAll: false, categories: new Map() };
		return conv.approvalPolicy;
	}

	/** 把某对话里已被策略覆盖的其它待审批项一并放行，返回放行条数。 */
	private approveCoveredPending(convId: string, policy: ApprovalPolicy, from: string = FROM_BROWSER): number {
		let n = 0;
		// eslint-disable-next-line unicorn/no-useless-spread -- 快照：循环里会从 map 删项（迭代中改集合）
		for (const [oid, o] of [...this.pendingApprovals]) {
			if ((o.conversationId ?? this.activeId) !== convId) continue;
			if (!approvalSuppressionReason(policy, true, o.category?.id)) continue;
			this.pendingApprovals.delete(oid);
			o.resolve({ decision: "approve" });
			askHub.settle(oid, { how: "answered", summary: "Approved (covered by an earlier choice)", from });
			ClientSession.broadcastToAllClients({ type: "tool_approval_resolved", id: oid });
			n++;
		}
		return n;
	}

	/** 记住策略后给用户一句回执（文本双语，前端按 locale 自选）。 */
	private emitApprovalPolicyNotice(scope: "category" | "all", category?: UiApprovalCategory, auto = 0): void {
		const tailEn = auto > 0 ? ` (auto-approved ${auto} other pending request(s))` : "";
		if (scope === "all") {
			this.emit({
				type: "notice",
				level: "info",
				text: `All tool approvals are now allowed in this conversation${tailEn}; revoke it under Settings → Tools.`,
				textEn: `All tool approvals are now allowed in this conversation${tailEn}; revoke it under Settings → Tools.`,
			});
			return;
		}
		const labelEn = category?.labelEn ?? "this category";
		this.emit({
			type: "notice",
			level: "info",
			text: `Allowed "${labelEn}" in this conversation${tailEn}; revoke it under Settings → Tools.`,
			textEn: `Allowed "${labelEn}" in this conversation${tailEn}; revoke it under Settings → Tools.`,
		});
	}

	/** 全局审批开关被关掉时：挂着的待审批全部按批准放行（否则弹窗还在等人点）。 */
	autoApprovePendingApprovals(reasonZh: string, reasonEn: string): void {
		if (this.pendingApprovals.size === 0) return;
		let n = 0;
		// eslint-disable-next-line unicorn/no-useless-spread -- 快照：循环里会从 map 删项（迭代中改集合）
		for (const [oid, o] of [...this.pendingApprovals]) {
			this.pendingApprovals.delete(oid);
			o.resolve({ decision: "approve" });
			askHub.settle(oid, { how: "answered", summary: "Approved (approvals were turned off)", from: FROM_BROWSER });
			ClientSession.broadcastToAllClients({ type: "tool_approval_resolved", id: oid });
			n++;
		}
		this.emit({
			type: "notice",
			level: "info",
			text: `${reasonEn} — auto-approved ${n} pending request(s).`,
			textEn: `${reasonEn} — auto-approved ${n} pending request(s).`,
		});
		ClientSession.approvalsChanged();
	}

	/**
	 * 设置面板撤销区用：当前对话的审批策略（allowAll + 已记住的同类档位）。
	 * 只回当前对话——撤销本来就是「在这里关掉这里的东西」，别的对话要撤销
	 * 就切过去（策略跟对话走，见 Conversation.approvalPolicy）。
	 */
	approvalPolicyState(): UiApprovalPolicyState {
		const conv = this.convs.get(this.activeId);
		const policy = conv?.approvalPolicy;
		return {
			conversationId: this.activeId,
			allowAll: policy?.allowAll ?? false,
			categories: policy ? [...policy.categories.values()] : [],
		};
	}

	/**
	 * 设置某对话的审批策略（设置面板撤销用）。只应用给出的字段：allowAll 直接赋值；
	 * categories 给出时作为保留名单整体替换（空数组 = 清掉全部同类记忆）。
	 */
	setApprovalPolicy(partial: { conversationId?: string; allowAll?: boolean; categories?: string[] }): void {
		const convId = partial.conversationId ?? this.activeId;
		const conv = this.convs.get(convId);
		if (!conv) return;
		const cur = conv.approvalPolicy;
		const next: ApprovalPolicy = {
			allowAll: partial.allowAll ?? cur?.allowAll ?? false,
			categories: new Map(cur?.categories ?? []),
		};
		if (partial.categories) {
			const keep = new Set(partial.categories);
			// eslint-disable-next-line unicorn/no-useless-spread -- 快照：循环里会从 map 删项（迭代中改集合）
			for (const key of [...next.categories.keys()]) if (!keep.has(key)) next.categories.delete(key);
		}
		conv.approvalPolicy = isApprovalPolicyEmpty(next) ? undefined : next;
		this.settingsSvc.push();
		this.flushSnapshot();
	}

	/** telegram-answers: the permission prompt this window shows. They are process-wide now: the
	 *  window's own chat's comes first, else the oldest of any chat (named after its chat, like
	 *  questions), so a prompt from a chat nobody has open still reaches every window. */
	private pendingApprovalForSnapshot(): UiState["pendingApproval"] {
		let picked: [string, PendingApprovalEntry] | undefined;
		for (const e of this.pendingApprovals) {
			if (e[1].conversationId === undefined || e[1].conversationId === this.activeId) {
				picked = e;
				break;
			}
			picked ??= e;
		}
		if (!picked) return null;
		const [id, p] = picked;
		const liveTitle = p.conversationId !== undefined ? this.convs.get(p.conversationId)?.title : undefined;
		return {
			id,
			toolCallId: p.toolCallId,
			toolName: p.toolName,
			params: p.params,
			reason: p.reason,
			reasonEn: p.reasonEn,
			...(p.category ? { category: p.category } : {}),
			conversationId: p.conversationId,
			conversationTitle: liveTitle ?? p.conversationTitle,
		};
	}

	/** 关闭所有挂起提问（dispose 时清理）：以「取消」解析，避免模型挂死。
	 *
	 *  multi-device：问卷属于对话不属于客户端，所以只有「除我之外一台都不剩」时
	 *  才真取消；否则留给还连着的设备去答。不这么做的话，client-per-load 之后
	 *  每次刷新都会 dispose 一个旧会话，等于每次刷新都把自己的问卷打掉。 */
	cancelPendingQuestions(): void {
		// telegram-answers: a plugin (Telegram) that shows asks counts as a device that can still answer.
		const left = ClientSession.connectedClientCount(this) + (askHub.listening ? 1 : 0);
		if (shouldCancelOnClientDispose({ connectedClientsLeft: left }) === "keep") return;
		for (const [qid, p] of this.pendingQuestions) {
			if (p.graceTimer) clearTimeout(p.graceTimer);
			p.resolve(null);
			askHub.settle(p.askId ?? qid, { how: "gone", reason: "no browser is open any more" });
		}
		this.pendingQuestions.clear();
	}

	/** telegram-answers: a chat is closing: its waiting questions end as cancelled. Questions are
	 *  process-wide, so nothing else would end them; every window closes its dialog, and whoever
	 *  shows them elsewhere hears they are gone. */
	private cancelChatQuestions(convId: string, why: string): void {
		let n = 0;
		for (const [qid, p] of this.pendingQuestions) {
			if (p.conversationId !== convId) continue;
			this.pendingQuestions.delete(qid);
			if (p.graceTimer) clearTimeout(p.graceTimer);
			p.resolve(null);
			askHub.settle(p.askId ?? qid, { how: "gone", reason: why });
			ClientSession.broadcastToAllClients({ type: "question_retracted", id: qid });
			n++;
		}
		if (n > 0) ClientSession.emitConversationsToAll();
	}

	/** 关闭所有挂起审批（dispose 时清理）：以「拒绝」解析，避免等答复的
	 *  Promise 与对应 runtime 泄漏（会话没了，审批弹窗永远不会有人点）。 */
	cancelPendingApprovals(onlyConversationId?: string, why = "pi is shutting down"): void {
		for (const [id, a] of this.pendingApprovals) {
			if (onlyConversationId !== undefined && a.conversationId !== onlyConversationId) continue;
			this.pendingApprovals.delete(id);
			askHub.settle(id, { how: "gone", reason: why });
			try {
				a.resolve({ decision: "deny", reason: "Session closed" });
			} catch {
				// 单个 resolve 异常不影响其余清理
			}
			ClientSession.broadcastToAllClients({ type: "tool_approval_resolved", id });
		}
	}

	// -----------------------------------------------------------------------
	// 浏览器页面桥（标准 pi 引擎 browser_page customTool）
	// -----------------------------------------------------------------------

	/** 标准引擎模型调 browser_page：发 page_request 给浏览器并等 page_response。
	 *
	 *  与 askUser 的不同点都在超时上：对面是扩展不是人，没人回答时必须自己收场
	 *  （否则就是挂死的工具）。因此 timeoutMs 到点即按失败 resolve，并且：
	 *  - sig.aborted / disposed → 立即失败（会话已中止，发出去也没意义）；
	 *  - 没有前端在线 → 立即给出**可执行**的错误（page_request 不进快照，浏览器
	 *    刷新也不会补发，硬等一个超时对模型毫无信息量）。 */
	/** 当前对话模型能不能直接看图 —— 决定截图是「给图」还是「走视觉桥」。 */
	canSeeImages(): boolean {
		return this.session?.model?.input?.includes("image") === true;
	}

	/**
	 * 把**工具里的截图**交给视觉桥转写（主模型看不到图时）。
	 *
	 * 与用户粘贴图片走同一套选择逻辑（设置里指定的视觉模型 → 自动探测）与同一套提示词，
	 * 所以「视觉桥开着就自动生效」对工具截图同样成立 —— 这里只是多了一个入口，
	 * 不是另立一套判定。
	 *
	 * 失败**不抛**：返回 `{reason}`，由工具把它写进结果文本（模型至少知道「图没看到，为什么」）。
	 */
	async transcribeToolImage(
		image: { data: string; mimeType: string },
		signal?: AbortSignal,
	): Promise<{ text?: string; reason?: string }> {
		const settings = this.settingsSvc.current;
		if (settings.visionBridgeEnabled === false) {
			return { reason: "The vision bridge is turned off in Settings (Settings → Vision bridge)" };
		}
		const runtime = this.session?.modelRuntime;
		if (!runtime) return { reason: "Model runtime unavailable" };
		const lang = this.getLang?.() ?? "en";
		let chosen = findVisionModels(runtime)[0] ?? null;
		const pref = settings.visionBridgeModel;
		if (pref) {
			const spec = parseModelSpec(pref);
			if (spec) {
				const pm = runtime.getModel(spec.provider, spec.id);
				if (pm?.input?.includes("image")) {
					chosen = { provider: spec.provider, id: spec.id, label: `${pm.name ?? pm.id} (${spec.provider})` };
				}
			}
		}
		if (!chosen) return { reason: "No vision model available (add an image-capable model in the model config)" };
		const model = runtime.getModel(chosen.provider, chosen.id);
		if (!model) return { reason: "The vision model is no longer available" };
		try {
			const text = await transcribeImages(
				runtime,
				[{ data: image.data, mimeType: image.mimeType, name: "page-shot.jpg" }],
				{
					model,
					...(signal ? { signal } : {}),
					lang,
					systemPrompt: buildVisionBridgePrompt(settings.visionBridgePromptMode, settings.visionBridgePrompt, lang),
				},
			);
			return text.trim() ? { text } : { reason: "The vision bridge returned an empty transcription" };
		} catch (err) {
			return { reason: `Vision bridge transcription failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	/** 页调用超时计时器：到点按失败 resolve（晚到的 page_response 在
	 *  resolvePageCall 里找不到 id 会静默忽略）。过户重建时复用（计时重走）. */
	private armPageCallTimeout(
		id: string,
		resolve: (r: PageCallResult) => void,
		timeoutMs: number,
	): ReturnType<typeof setTimeout> {
		return setTimeout(() => {
			// 到点：先删再 resolve——晚到的 page_response 在 resolvePageCall 里找
			// 找不到 id，会静默忽略（见那里的注释）。
			if (this.pendingPageCalls.delete(id)) {
				resolve({
					ok: false,
					error: `No browser response within ${Math.round(timeoutMs / 1000)}s (timeout ${timeoutMs}ms). Make sure a pi-web-ui page is open and the page-picker extension is enabled.`,
				});
			}
		}, timeoutMs);
	}

	pageCall(req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string): Promise<PageCallResult> {
		return new Promise((resolve) => {
			if (sig?.aborted || this.disposed) {
				resolve({ ok: false, error: "The page call was aborted (browser_page aborted)." });
				return;
			}
			if (this.sinks.size === 0) {
				resolve({
					ok: false,
					error:
						"No pi-web-ui page is connected (no browser connected). Open a pi-web-ui page and make sure the page-picker extension is enabled and paired with it.",
				});
				return;
			}
			const id = `p-${++this.pageSeq}`;
			// 夹取与工具入口同一套规则（防手写脏值/其它调用方绕过 schema）。
			const timeoutMs = normalizePageCallTimeoutMs(req.timeoutMs);
			const timer = this.armPageCallTimeout(id, resolve, timeoutMs);
			// 先登记再发：同步回包（同进程假客户端）也不能漏掉。
			this.pendingPageCalls.set(id, { resolve, timer, conversationId, req, timeoutMs });
			this.emit({ type: "page_request", id, op: req.op, args: req.args, target: req.target, timeoutMs });
		});
	}

	/** 前端回页面调用结果（index.ts 的 page_response → cs.resolvePageCall）。
	 *  找不到 id 就静默忽略：那是正常竞态（超时后才迟到、页面刷新后重发、旧链接
	 *  残留），不是错误，也没人能处理。 */
	resolvePageCall(id: string, ok: boolean, result?: unknown, error?: string): void {
		const pending = this.pendingPageCalls.get(id);
		if (!pending) return;
		this.pendingPageCalls.delete(id);
		clearTimeout(pending.timer);
		pending.resolve(
			ok
				? { ok: true, result }
				: { ok: false, error: error?.trim() || "Browser action failed (no error message from the page)" },
		);
	}

	/** 关闭所有挂起页面调用（dispose 时）：以失败解析，避免模型/工具挂死。 */
	cancelPendingPageCalls(): void {
		for (const [, p] of this.pendingPageCalls) {
			clearTimeout(p.timer);
			p.resolve({
				ok: false,
				error: "Conversation closed; the pending page call was cancelled (conversation closed).",
			});
		}
		this.pendingPageCalls.clear();
	}

	/**
	 * Whether the pi agent has at least one usable model. ModelRuntime's
	 * available snapshot already accounts for models.json, auth.json, env-var
	 * credentials, OAuth, and runtime API-key overrides. Cached for 2s because
	 * this is called while building frequent snapshots.
	 */
	isPiConfigured(): boolean {
		const now = Date.now();
		const cached = this.piCheckCache;
		if (cached && now - cached.at < 2000) return cached.configured;
		const configured = (this.sharedModelRuntime?.getAvailableSnapshot().length ?? 0) > 0;
		this.piCheckCache = { at: now, configured };
		return configured;
	}

	/**
	 * Whether the pi CLI binary is installed and runnable (`pi --version`
	 * probe). Cached machine-wide (same binary for every client) for 10s —
	 * the check is only rerun after install or when the cache expires.
	 *
	 * The probe is FORK-FREE: it scans PATH for the pi executable instead of
	 * spawning `pi --version`. Do not reintroduce a spawn here — ANY fork on
	 * the main thread of this multi-threaded server can deadlock the whole
	 * process on Android/Termux (issue #78): libuv's uv_spawn blocks its
	 * caller reading the child's error pipe, and that pipe never closes when
	 * the forked child deadlocks between fork and exec. This applies to
	 * asynchronous spawns too — the previous async probe reproduced the hang.
	 */
	private static piCliProbe: { at: number; installed: boolean } | null = null;
	private static readonly PI_CLI_PROBE_TTL_MS = 10_000;

	private isPiCliInstalled(): boolean {
		const now = Date.now();
		const cached = ClientSession.piCliProbe;
		if (cached && now - cached.at < ClientSession.PI_CLI_PROBE_TTL_MS) return cached.installed;
		const installed = ClientSession.piCliOnPath();
		ClientSession.piCliProbe = { at: now, installed };
		return installed;
	}

	private static piCliOnPath(): boolean {
		const dirs = (process.env.PATH ?? "").split(delimiter);
		for (const dir of dirs) {
			if (dir && existsSync(join(dir, "pi"))) return true;
		}
		return false;
	}

	private static invalidatePiCliProbe(): void {
		ClientSession.piCliProbe = null;
	}

	/**
	 * Run a command async, collecting stdout+stderr; kills on timeout.
	 * Never throws / never crashes the server: spawn errors (ENOENT etc.)
	 * resolve with code -1 so callers can report them as notices.
	 */
	private runAsync(
		cmd: string,
		args: string[],
		timeoutMs: number,
		cwd?: string,
	): Promise<{ code: number | null; out: string }> {
		return new Promise((resolve) => {
			let p;
			try {
				p = spawn(cmd, args, {
					...(cwd ? { cwd } : {}),
					stdio: ["ignore", "pipe", "pipe"],
					// Windows: npm and friends are .cmd shims — Node can only exec
					// them through the shell (otherwise spawn npm → ENOENT).
					shell: process.platform === "win32",
					// posix 下让子进程自成进程组：超时时能整组杀掉（孙进程不残留）。
					// 代价是父进程退出后子进程可能短暂存活——这些都是带超时的短命令，
					// 可接受；win32 不需要（走 taskkill /T）。
					detached: process.platform !== "win32",
				});
			} catch (err) {
				resolve({ code: -1, out: String(err) });
				return;
			}
			let out = "";
			let settled = false;
			const done = (code: number | null, text?: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(t);
				resolve({ code, out: text ?? out });
			};
			const t = setTimeout(() => {
				// 只 p.kill() 杀不掉整棵树（win32 下杀的是 cmd.exe 壳，posix 下
				// 杀不到孙进程）—— 按平台走整树杀，失败再退回 p.kill 兜底。
				const plan = processTreeKillPlan(process.platform, p.pid);
				try {
					if (plan.kind === "taskkill") {
						// taskkill 独立进程执行：父 cmd 死活不影响命中目标树。
						spawn(plan.cmd, plan.args, { stdio: "ignore", windowsHide: true });
					} else if (plan.kind === "group-signal") {
						process.kill(-p.pid!, plan.signal);
					} else {
						p.kill();
					}
				} catch {
					// 进程组已不在（正常退出竞态）等 —— 退回直接杀。
					p.kill();
				}
			}, timeoutMs);
			p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
			p.stderr?.on("data", (d: Buffer) => (out += d.toString()));
			p.on("error", (err) => done(-1, String(err)));
			p.on("close", (code) => done(code));
		});
	}

	/**
	 * Auto-install the pi agent: ensure the config dir exists and install the
	 * pi CLI globally (npm i -g). Auth is configured afterwards via the API key
	 * form or by running `pi` in a terminal.
	 */

	/**
	 * Version of the RUNNING pi-web-ui package (read from its own package.json,
	 * resolved from this compiled module: <pkg>/dist/server → <pkg>).
	 */
	private static currentAppVersion(): string {
		try {
			const here = dirname(fileURLToPath(import.meta.url));
			const pkgRoot = resolve(here, "..", "..");
			const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version?: string };
			return pkg.version ?? "0.0.0";
		} catch {
			return "0.0.0";
		}
	}

	/** Simple numeric semver compare: >0 means a newer than b. */
	private static compareVersions(a: string, b: string): number {
		return compareSemver(a, b);
	}

	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** 本客户端成功切换工作区（set_cwd）后触发，参数为新绝对路径 + 该项目的额外
	 *  工作区根（多根由用户/插件经 set_workspace_roots 设置，见 protocol）。
	 *  attach 时由 AgentService 接到全局 onClientCwdChanged —— 编辑器等
	 *  工作区跟随型插件借此把根目录切到用户当前项目。 */
	onCwdChanged: ((abs: string, roots: string[]) => void) | undefined = undefined;
	/** 过户后的桥接投递解析（attach 时由 AgentService 接线）：给一个 SDK 会话（＝
	 *  一个 runtime 的身份），返回**当前**持有它的客户端会话 + 该对话**当前** id。
	 *
	 *  为什么需要它：runtime 创建时把 `this`（当时的 ClientSession）与当时的
	 *  conversationId 闭包进桥接工具（ask_user_question / browser_page），而
	 *  `take_over_conversation` 只搬对话（runtime/终端/订阅/看门狗/在途问卷与页
	 *  调用），搬不动闭包里的会话引用。过户后模型再提问/截图，用捕获的 `this` 就会把
	 *  question_pending / page_request 推给过户前那台设备 —— 持有方收不到，问卷还会
	 *  挂在老设备的注册表里（且不进它的快照：该 conv 已不在它名下）→ 刷新即丢，
	 *  而 pi 引擎问卷不超时，那一轮 run 就永远挂住。
	 *
	 *  用 SDK 会话对象（稳定标识）而不是建时的 conversationId：过户遇到 id 撞车会把
	 *  对话改名（c1→c2），那时旧 id 要么查不到、要么查到老会话里的另一条对话，都会
	 *  投错。（注意不能用 runtime 对象比：SDK 会把工厂返回值包成新的 AgentSessionRuntime
	 *  实例，而 `runtime.session` 与本工厂的 `created.session` 是同一个对象。） */
	findConversationHome:
		((sdkSession: AgentSession) => { session: ClientSession; convId: string } | undefined) | undefined = undefined;
	/** issue #145 跨客户端同会话感知 —— attach 时由 AgentService 接线：
	 *  - findSessionOwner：别处是否已持有同一 session 文件（查重建第二个 writer 用）；
	 *  - listProjectRunners：别处在同一 cwd 下正在跑的对话（同项目并行感知用）；
	 *  - listExternalRunning：别处所有正在跑的对话（左栏「另一处正在运行」用）；
	 *  - notifyExternalClients：向其他客户端广播一条 notice（并行打开时互相通告）；
	 *  - onRunningChanged：本实例流式集合变化时触发，AgentService 借此让其他
	 *    客户端重推 conversations（elsewhere 列表近实时）。 */
	findSessionOwner: ((targetPath: string) => SessionOwnerInfo | null) | undefined = undefined;
	/** 插件 steer 跨客户端兜底钩子：attach 时由 AgentService 接线（见 steerElsewhere），
	 *  在其他客户端的 conversations 里找对话并由持有方执行 steer，未持有回 undefined。 */
	steerConversationElsewhere:
		((id: string, text: string) => Promise<{ ok: boolean; error?: string } | undefined>) | undefined = undefined;
	/** issue #145：除本客户端外是否有人在跑（扫目录查重前置的无 I/O 判断）。 */
	hasStreamingElsewhere: (() => boolean) | undefined = undefined;
	listProjectRunners: ((cwd: string) => ProjectRunnerInfo[]) | undefined = undefined;
	/** issue #145 同款接线：全局认领表（AgentService 级单例，attach 时由 AgentService 接线）。 */
	getClaimStore: (() => ClaimStore) | undefined = undefined;
	listExternalRunning: (() => ElsewhereRunning[]) | undefined = undefined;
	notifyExternalClients:
		| ((msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }) => void)
		| undefined = undefined;
	onRunningChanged: (() => void) | undefined = undefined;

	/** Ask the npm registry for the latest pi-web-ui version and report it. */
	async checkUpdate(): Promise<void> {
		const current = ClientSession.currentAppVersion();
		try {
			// registry 遵从 <agentDir>/npm/.npmrc（与 `pi update` 经 npm 的行为一致，
			// issue #151）；私有源的 token 也一并带上，否则直接 401。
			const { registry, authHeader } = resolveNpmRegistry(this.agentDir);
			// Fetch the full package doc (not /latest): it carries the per-version
			// publish timestamps so the UI can hint when a version was JUST
			// published and the registry/CDN caches may not have caught up yet.
			const res = await fetch(`${registry}/pi-web-ui`, {
				signal: AbortSignal.timeout(8_000),
				...(authHeader ? { headers: { authorization: authHeader } } : {}),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				"dist-tags"?: { latest?: string };
				time?: Record<string, string>;
			};
			const latest = data["dist-tags"]?.latest ?? null;
			const latestPublishedAt = latest && data.time ? (data.time[latest] ?? null) : null;
			const upToDate = latest === null || ClientSession.compareVersions(current, latest) >= 0;
			this.emit({
				type: "update_status",
				current,
				latest,
				latestPublishedAt,
				upToDate,
			});
		} catch (err) {
			this.emit({
				type: "update_status",
				current,
				latest: null,
				latestPublishedAt: null,
				upToDate: false,
				error: `Update check failed: ${(err as Error).message}`,
			});
		}
	}

	/** Cache window for the all-source check: 30 minutes. */
	static UPDATE_ALL_CACHE_MS = 30 * 60_000;
	private updatesAllCache: { at: number; items: UpdateItem[] } | null = null;
	private notifiedPluginUpdates = new Set<string>();
	private lastPluginUpdates: UiPluginUpdateInfo[] = [];

	/**
	 * 主动检查已安装界面插件（<dataDir>/plugins）的更新状态并向客户端推送。
	 */
	async checkPluginUpdates(manual = false): Promise<void> {
		const lang = () => this.getLang();
		try {
			const updates = await checkPluginUpdates(this.stateStore.dataDir, undefined, lang);
			const list: UiPluginUpdateInfo[] = updates.map((p) => ({
				id: p.id,
				name: p.name,
				version: p.version,
				latestVersion: p.latestVersion ?? null,
				source: p.source,
				localSha: p.localSha,
				remoteSha: p.remoteSha,
				updatable: p.updatable,
				builtin: p.builtin,
				error: p.error,
			}));
			this.lastPluginUpdates = list;
			this.emit({ type: "plugin_updates", updates: list });

			const updatableBuiltins = list.filter((p) => p.builtin && p.updatable);
			if (manual) {
				if (updatableBuiltins.length > 0) {
					const names = updatableBuiltins.map((p) => p.name || p.id).join(", ");
					this.emit({
						type: "notice",
						level: "info",
						text: `Update available for ${updatableBuiltins.length} built-in plugin(s): ${names}`,
						textEn: `Update available for ${updatableBuiltins.length} built-in plugin(s): ${names}`,
					});
				} else {
					const allUpdatable = list.filter((p) => p.updatable);
					if (allUpdatable.length > 0) {
						const names = allUpdatable.map((p) => p.name || p.id).join(", ");
						this.emit({
							type: "notice",
							level: "info",
							text: `Update available for ${allUpdatable.length} plugin(s): ${names}`,
							textEn: `Update available for ${allUpdatable.length} plugin(s): ${names}`,
						});
					} else {
						this.emit({
							type: "notice",
							level: "info",
							text: "All plugins are up to date.",
							textEn: "All plugins are up to date.",
						});
					}
				}
			} else {
				const newUpdatables = updatableBuiltins.filter((p) => {
					const key = `${p.id}@${p.latestVersion || p.remoteSha || "upd"}`;
					if (this.notifiedPluginUpdates.has(key)) return false;
					this.notifiedPluginUpdates.add(key);
					return true;
				});
				if (newUpdatables.length > 0) {
					const names = newUpdatables.map((p) => p.name || p.id).join(", ");
					this.emit({
						type: "notice",
						level: "info",
						text: `Update available for ${newUpdatables.length} built-in plugin(s): ${names}. You can update in Settings or the Updates panel.`,
						textEn: `Update available for ${newUpdatables.length} built-in plugin(s): ${names}. You can update in Settings or the Updates panel.`,
					});
				}
			}
		} catch (err) {
			if (manual) {
				this.emit({
					type: "notice",
					level: "error",
					text: `Failed to check plugin updates: ${(err as Error).message}`,
					textEn: `Failed to check plugin updates: ${(err as Error).message}`,
				});
			}
		}
	}

	/**
	 * All-source update check: pi-web-ui + the pi core + direct pi extensions
	 * from the agent manifest (fallback: raw walk) + installed UI plugins. Re-emits the cached list
	 * within UPDATE_ALL_CACHE_MS; pass force=true (explicit refresh) to bypass.
	 */
	async checkUpdatesAll(force = false): Promise<void> {
		// issue #321：pi SDK 副本状态随结果下发（运行中是哪份 / 是否自带 / 机器上有没有
		// 更新的），UI 据此在更新面板亮「重启跟上」与「安装全局引擎并切换」入口。
		// 缓存命中也现算：用户升级全局 pi 不经本服务，缓存的 items 不影响这个判据，
		// 探针本身有 10s memoize，重算便宜。
		const piSdk = {
			running: VERSION,
			bundledInUse: isBundledInUse(sdkCopies(), VERSION),
			newerInstalled: detectPiSdkSplit(VERSION)?.installed ?? null,
		};
		if (!force && this.updatesAllCache && Date.now() - this.updatesAllCache.at < ClientSession.UPDATE_ALL_CACHE_MS) {
			this.emit({
				type: "update_status_all",
				items: this.updatesAllCache.items,
				piSdk,
			});
			if (this.lastPluginUpdates.length > 0) {
				this.emit({ type: "plugin_updates", updates: this.lastPluginUpdates });
			}
			return;
		}
		try {
			const targets = collectTargets(this.agentDir, ClientSession.currentAppVersion(), undefined, {
				projectCwd: this.convs.get(this.activeId)?.cwd ?? this.cwd,
			});
			const items = await checkAllUpdates(targets, undefined, () => this.getLang(), resolveNpmRegistry(this.agentDir));

			let pluginItems: UpdateItem[] = [];
			try {
				const pluginUpdates = await checkPluginUpdates(this.stateStore.dataDir, undefined, () => this.getLang());
				const list: UiPluginUpdateInfo[] = pluginUpdates.map((p) => ({
					id: p.id,
					name: p.name,
					version: p.version,
					latestVersion: p.latestVersion ?? null,
					source: p.source,
					localSha: p.localSha,
					remoteSha: p.remoteSha,
					updatable: p.updatable,
					builtin: p.builtin,
					error: p.error,
				}));
				this.lastPluginUpdates = list;
				this.emit({ type: "plugin_updates", updates: list });

				pluginItems = pluginUpdates.map((p) => ({
					name: p.name ? `${p.name} (${p.id})` : p.id,
					kind: "plugin" as const,
					current: p.version ? `v${p.version}` : (p.localSha ?? "unknown"),
					latest: p.latestVersion ? `v${p.latestVersion}` : (p.remoteSha ?? null),
					latestPublishedAt: null,
					upToDate: !p.updatable,
					error: p.error,
					source: p.source,
					pluginId: p.id,
					builtin: p.builtin,
				}));

				const newUpdatables = pluginUpdates
					.filter((p) => p.builtin && p.updatable)
					.filter((p) => {
						const key = `${p.id}@${p.latestVersion || p.remoteSha || "upd"}`;
						if (this.notifiedPluginUpdates.has(key)) return false;
						this.notifiedPluginUpdates.add(key);
						return true;
					});
				if (newUpdatables.length > 0) {
					const names = newUpdatables.map((p) => p.name || p.id).join(", ");
					this.emit({
						type: "notice",
						level: "info",
						text: `Update available for ${newUpdatables.length} built-in plugin(s): ${names}. You can update in Settings or the Updates panel.`,
						textEn: `Update available for ${newUpdatables.length} built-in plugin(s): ${names}. You can update in Settings or the Updates panel.`,
					});
				}
			} catch (err) {
				console.warn("[agent-service] plugin update check failed:", err);
			}

			const allItems = sortUpdateItems([...items, ...pluginItems]);
			this.updatesAllCache = { at: Date.now(), items: allItems };
			this.emit({ type: "update_status_all", items: allItems, piSdk });
		} catch (err) {
			// checkAll degrades per-item; only local enumeration blowing up lands
			// here — still report a usable (webui-only) error item.
			const items: UpdateItem[] = [
				{
					name: "pi-web-ui",
					kind: "webui",
					current: ClientSession.currentAppVersion(),
					latest: null,
					latestPublishedAt: null,
					upToDate: false,
					error: `Update check failed: ${(err as Error).message}`,
				},
			];
			this.emit({ type: "update_status_all", items });
		}
	}

	async installPiAgent(): Promise<void> {
		try {
			mkdirSync(this.agentDir, { recursive: true });
			this.emit({
				type: "notice",
				level: "info",
				text: "Installing pi agent CLI (npm i -g @earendil-works/pi-coding-agent)…",
				textEn: "Installing pi agent CLI (npm i -g @earendil-works/pi-coding-agent)…",
			});
			const { code, out } = await this.runAsync("npm", ["i", "-g", "@earendil-works/pi-coding-agent"], 180_000);
			if (code === 0) {
				this.emit({
					type: "notice",
					level: "info",
					text: "✅ pi agent CLI installed. Enter an API key to start, or run pi in a terminal to log in.",
					textEn: "✅ pi agent CLI installed. Enter an API key to start, or run pi in a terminal to log in.",
				});
				this.emit({ type: "install_result", ok: true, detail: "" });
			} else {
				this.emit({
					type: "notice",
					level: "error",
					text: `pi agent install failed (${code ?? "timeout"}): ${out.slice(0, 400)}`,
					textEn: `pi agent install failed (${code ?? "timeout"}): ${out.slice(0, 400)}`,
				});
				this.emit({
					type: "install_result",
					ok: false,
					detail: out.slice(0, 600),
				});
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `pi agent install failed: ${(err as Error).message}`,
				textEn: `pi agent install failed: ${(err as Error).message}`,
			});
		}
		// The CLI may just have landed on PATH (or the install may have failed) —
		// drop the probe cache so the next snapshot re-checks.
		ClientSession.invalidatePiCliProbe();
		this.flushSnapshot();
	}

	/** Send a snapshot immediately (cancels any pending throttled one).
	 *  forceFull skips the incremental path — used by get_state so a (re)
	 *  connecting or desynced client always receives an authoritative full
	 *  state it can rebuild from. */
	flushSnapshot(forceFull = false): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		this.emitSnapshotNow(forceFull);
	}

	/**
	 * Cached `session.getSessionStats()` — the SDK computes it by walking the whole
	 * transcript, and the message_delta path used to call it per streaming frame
	 * (measured: 27.6% of streaming CPU at 6000 messages, see STATS_CACHE_MS).
	 * Callers that need the authoritative value can still call the session
	 * directly; every cache hit here is at most STATS_CACHE_MS stale.
	 */
	private sessionStats(session: AgentSession = this.session): ReturnType<AgentSession["getSessionStats"]> {
		const now = Date.now();
		const hit = this.sessionStatsCache.get(session);
		if (hit && now - hit.at < STATS_CACHE_MS) return hit.value;
		const value = session.getSessionStats();
		this.sessionStatsCache.set(session, { at: now, value });
		return value;
	}

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.disposed) return;
		// During active streaming the deltas carry live rendering — full snapshots
		// are just a periodic reconciliation checkpoint, so send them far less
		// often (they serialize the whole session; big sessions made this path OOM).
		const interval =
			Date.now() - this.lastDeltaAt < DELTA_ACTIVE_WINDOW_MS ? STREAMING_SNAPSHOT_INTERVAL_MS : SNAPSHOT_INTERVAL_MS;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			this.emitSnapshotNow();
		}, interval);
	}

	/** Slash-command catalog + native command execution — 自包含模块，见
	 *  slash-commands.ts（内置命令拦截 + 扩展/模板/技能目录推送）。 */
	private readonly slash = new SlashCommandsService({
		emit: (msg) => this.emit(msg),
		cwd: () => this.cwd,
		getSession: () => this.session,
		newChat: () => this.newChat(),
		// /new <prompt>: deliver the text as the new session's first prompt.
		prompt: (text) => this.prompt(text),
		setModel: (id) => this.setModel(id),
		setCwd: (path) => this.setCwd(path),
		setThinking: (level) => this.setThinking(level),
		renameSession: async (name) => {
			this.session.setSessionName(name);
			this.conv.title = name;
			this.invalidateSessionInfos();
			this.emitConversations();
			await this.pushSessions();
			this.emit({
				type: "notice",
				level: "info",
				text: `Renamed current session to "${name}"`,
				textEn: `Renamed current session to "${name}"`,
			});
			this.flushSnapshot();
		},
		refreshSessions: () => this.refreshSessions(),
		afterReload: () => {
			// /reload 同样重读磁盘 settings.json——重放重试覆盖 + 软上限覆盖 + 终端门控。
			this.applyRetryOverrides();
			this.applyCompactionOverrides();
			this.applyToolGating(this.session, this.conv?.agentPreset);
		},
		pluginCommands: () => this.pluginCommandsProvider?.() ?? [],
		execPluginCommand: async (name, args) => {
			const def = this.pluginCommandsProvider?.().find((c) => c.name === name);
			if (!def) return false;
			try {
				const result = await def.run(args, { clientId: this.clientId });
				// 字符串返回值 → 通知条回显给发起人；富展示用 broadcast/sendTo。
				if (typeof result === "string" && result.trim()) {
					this.emit({ type: "notice", level: "info", text: result, textEn: result });
				}
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `Plugin command /${name} failed: ${(err as Error).message}`,
					textEn: `Plugin command /${name} failed: ${(err as Error).message}`,
				});
			}
			return true;
		},
		onQuit: () => this.onQuit?.() ?? false,
	});

	/** Catalog push — index.ts get_commands / attach / cwd 切换等都会调用。 */
	pushSlashCommands(): Promise<void> {
		return this.slash.push();
	}

	/**
	 * 取一条工具的**定义说明**（工具卡右键 → 「显示工具详细信息」）→ `tool_info`。
	 *
	 * 定义从活动会话现取（`getAllTools` 是目录全集，含被禁用的工具），
	 * `getActiveToolNames` 只用来标记「当前是否启用」—— 禁用名单里的工具仍在目录里，
	 * 用户点开看定义是合理的，只是模型看不到它。
	 *
	 * 失败（会话未就绪 / 引擎抛错）一律回 `found: false`：这是只读的展示请求，
	 * 不该因为拿不到定义就在 UI 上报警。
	 */
	getToolInfo(name: string): void {
		let raw: RawToolDefinition | undefined;
		try {
			const defs = this.session.getAllTools();
			const found = defs.find((d) => d.name === name);
			if (found) raw = { ...found, active: this.session.getActiveToolNames().includes(name) };
		} catch {
			// Session not ready (or the engine threw) — fall through to found:false.
		}
		this.emit({ type: "tool_info", ...normalizeToolInfo(name, raw) });
	}

	/** 模型/服务商配置管理 —— 自包含模块，见 model-admin.ts。 */
	private readonly modelAdmin!: ModelAdminService;

	/** Persist an api-key credential for a provider (auth.json). */
	setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		return this.modelAdmin.setProviderApiKey(provider, apiKey);
	}
	async clearProviderApiKey(provider: string): Promise<void> {
		const usingOAuth = this.runtime.services.modelRuntime.isUsingOAuth(provider.trim());
		await this.modelAdmin.clearProviderApiKey(provider);
		// The provider is back to unconfigured — drop its key preference in
		// EVERY project, otherwise each project switch re-tries a restore.
		if (!usingOAuth) {
			this.stateStore.deleteProviderEverywhere(provider.trim());
			const defKey = this.stateStore.getDefaultProviderKey(provider.trim());
			if (defKey) this.stateStore.repointDeletedKeyInDefault(provider.trim(), defKey, null);
		}
	}
	startProviderOAuth(provider: string): void {
		this.modelAdmin.startProviderOAuth(provider);
	}
	replyProviderOAuth(flowId: string, promptId: string, value: string): void {
		this.modelAdmin.replyProviderOAuth(flowId, promptId, value);
	}
	cancelProviderOAuth(flowId: string): void {
		this.modelAdmin.cancelProviderOAuth(flowId);
	}
	listProviderOAuthFlows(): void {
		this.modelAdmin.listProviderOAuthFlows();
	}
	logoutProviderOAuth(provider: string): Promise<void> {
		return this.modelAdmin.logoutProviderOAuth(provider);
	}
	listProviders(): Promise<void> {
		return this.modelAdmin.listProviders();
	}
	listModelsConfig(): Promise<void> {
		return this.modelAdmin.listModelsConfig();
	}
	reloadModelsConfig(): Promise<void> {
		return this.modelAdmin.reloadModelsConfig();
	}
	fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void> {
		return this.modelAdmin.fetchModelsList(reqId, baseUrl, apiKey, authHeader, api, () => this.getLang(), providerId);
	}

	testModelConnection(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void> {
		return this.modelAdmin.testConnection(reqId, baseUrl, apiKey, authHeader, api, () => this.getLang(), providerId);
	}
	refreshProviderModels(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.refreshProviderModels(providerId, reqId, () => this.getLang());
	}
	/** Force-refresh built-in providers' official pi.dev catalogs (bypass the
	 *  SDK's 4h freshness window) — refresh_builtin_result. */
	refreshBuiltinModels(reqId: number): Promise<void> {
		return this.modelAdmin.refreshBuiltinModels(reqId);
	}
	/** Append one model to a built-in provider's models.json overlay entry. */
	appendBuiltinModel(providerId: string, model: unknown, reqId: number): Promise<void> {
		return this.modelAdmin.appendBuiltinModel(providerId, model as never, reqId);
	}
	/** Copy a built-in provider into an editable custom-provider draft
	 *  (clone_provider_result) — lets the user run a second API key without
	 *  overwriting the built-in one. */
	cloneProvider(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.cloneProvider(providerId, reqId);
	}
	/** Enrich custom-provider draft rows from public catalogs (enrich_models_result). */
	enrichModels(reqId: number, ids: string[], hints?: Record<string, string>): Promise<void> {
		return this.modelAdmin.enrichModels(reqId, ids, hints, () => this.getLang());
	}
	/** Abort in-flight enrich_models request. */
	abortEnrichModels(reqId?: number): void {
		this.modelAdmin.abortEnrichModels(reqId);
	}
	saveModelConfig(providerId: string, config: unknown): Promise<void> {
		return this.modelAdmin.saveModelConfig(providerId, config as never);
	}
	deleteModelConfig(providerId: string): Promise<void> {
		return this.modelAdmin.deleteModelConfig(providerId);
	}
	listProviderKeys(): void {
		return this.modelAdmin.listProviderKeys();
	}
	async addProviderKey(provider: string, apiKey: string, name?: string): Promise<void> {
		await this.modelAdmin.addProviderKey(provider, apiKey, name);
		const active = this.modelAdmin.getActiveKeyName(provider);
		if (active) this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, active);
	}
	async activateProviderKey(provider: string, keyName: string): Promise<void> {
		const ok = await this.modelAdmin.activateProviderKey(provider, keyName);
		// Only remember existing keys — a failed switch (deleted key) must not
		// plant a stale reference that errors on every later project switch.
		if (ok) this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, keyName);
		else this.stateStore.deleteProjectProviderKey(this.clientId, this.cwd, provider);
	}
	async removeProviderKey(provider: string, keyName: string): Promise<void> {
		await this.modelAdmin.removeProviderKey(provider, keyName);
		// The deletion may have been made from another project: every project
		// still pinned to the deleted key must follow the key that took over
		// (or drop the pin when no keys remain), not just the current one.
		const active = this.modelAdmin.getActiveKeyName(provider);
		this.stateStore.repointDeletedKeyEverywhere(provider, keyName, active);
		this.stateStore.repointDeletedKeyInDefault(provider, keyName, active);
	}

	/** Restore per-project provider keys when entering a project. For each
	 *  provider that has a saved key for `cwd`, activate it if it differs from
	 *  the current global active. Silent + self-healing: a saved key deleted
	 *  elsewhere is dropped without notifying (a noisy error here is what
	 *  haunted project switches after a key deletion). */
	private async restoreProjectProviderKeysForCwd(cwd: string): Promise<void> {
		const saved = this.stateStore.getProjectProviderKeys(this.clientId, cwd);
		if (!saved) return;
		for (const [provider, keyName] of Object.entries(saved)) {
			const cur = this.modelAdmin.getActiveKeyName(provider);
			if (cur === keyName) continue;
			if (!this.modelAdmin.hasProviderKey(provider, keyName)) {
				this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
				continue;
			}
			const ok = await this.modelAdmin.activateProviderKey(provider, keyName, { silent: true });
			if (!ok) this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
		}
	}

	/** When a model is set, ensure its provider's per-project key is restored.
	 *  Silent + self-healing like the bulk restore above. Falls back to the
	 *  GLOBAL default key when the project has no pin for this provider (new
	 *  project following the global default model). */
	private async restoreKeyForModel(modelId: string, cwd: string): Promise<void> {
		const slash = modelId.indexOf("/");
		if (slash <= 0) return;
		const provider = modelId.slice(0, slash);
		const projectPin = this.stateStore.getProjectProviderKey(this.clientId, cwd, provider);
		if (projectPin) {
			const cur = this.modelAdmin.getActiveKeyName(provider);
			if (cur === projectPin) return;
			if (!this.modelAdmin.hasProviderKey(provider, projectPin)) {
				this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
				return;
			}
			const ok = await this.modelAdmin.activateProviderKey(provider, projectPin, { silent: true });
			if (!ok) this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
			return;
		}
		// No project pin — follow the global default key (if any). No
		// self-healing deletes here: the ref belongs to the global default,
		// not this project (key deletions already repoint it, see
		// repointDeletedKeyInDefault).
		const globalPin = this.stateStore.getDefaultProviderKey(provider);
		if (!globalPin) return;
		if (this.modelAdmin.getActiveKeyName(provider) === globalPin) return;
		if (!this.modelAdmin.hasProviderKey(provider, globalPin)) return;
		await this.modelAdmin.activateProviderKey(provider, globalPin, { silent: true });
	}

	/** Remember the just-selected model (and the key that was active for its
	 *  provider) for the current project. Called IMMEDIATELY on model selection —
	 *  not only after a turn — so switching back to the project restores the exact
	 *  {model, key} left behind, even for a fresh conversation with no assistant
	 *  message yet (the SDK only flushes a model_change to disk once one exists). */
	private rememberProjectModel(modelId: string): void {
		const cwd = this.cwd;
		this.stateStore.saveProjectModel(this.clientId, cwd, modelId);
		const slash = modelId.indexOf("/");
		if (slash <= 0) return;
		const provider = modelId.slice(0, slash);
		const active = this.modelAdmin.getActiveKeyName(provider);
		if (active) this.stateStore.saveProjectProviderKey(this.clientId, cwd, provider, active);
	}

	/** Restore the project's remembered model (and its provider's key) onto the
	 *  ACTIVE conversation — but ONLY for a conversation the user hasn't really
	 *  started (no messages yet). A conversation that already has content keeps its
	 *  own per-session model: switching back to a RUNNING / completed chat must not
	 *  silently overwrite its model with the project default. So a fresh chat in the
	 *  project gets the remembered model; an in-progress one keeps what it had and
	 *  the user switches via the picker. Silent on failure (model no longer in catalog).
	 *  Fallback chain: project memory > GLOBAL default model > SDK default (no-op). */
	private async restoreProjectModelForCwd(cwd: string): Promise<void> {
		const savedModel = this.stateStore.getProjectModel(this.clientId, cwd) ?? this.stateStore.getDefaultModel();
		if (!savedModel) return;
		try {
			if (messageCountOf(this.conv.session) > 0) return;
		} catch {
			return;
		}
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = savedModel.indexOf("/");
			if (slash <= 0 || slash === savedModel.length - 1) return;
			const model = mr.getModel(savedModel.slice(0, slash), savedModel.slice(slash + 1));
			if (!model) return;
			const cur = this.session.model;
			const curId = cur ? `${cur.provider}/${cur.id}` : null;
			// Restore the model's provider key first so setModel's auth check passes.
			await this.restoreKeyForModel(savedModel, cwd);
			if (curId === savedModel) {
				// 即使模型已是目标模型，也确保恢复其专属思考强度或全局默认思考强度
				const sm = this.session.settingsManager;
				const targetThinking = sm.getModelThinkingLevel(model.provider, model.id) ?? sm.getDefaultThinkingLevel();
				if (targetThinking && this.session.thinkingLevel !== targetThinking) {
					try {
						this.session.setThinkingLevel(targetThinking);
					} catch {
						/* 模型可能不支持该强度 */
					}
				}
				return;
			}
			await this.session.setModel(model);
		} catch {
			// model no longer resolvable / key gone — keep the conversation default
		}
	}

	// ---------------------------------------------------------------------------
	// Settings (system prompt / skills / extensions / presets)
	// ---------------------------------------------------------------------------

	/** Push the full settings state (current settings + loaded skills/extensions
	 *  with enabled flags + saved presets). Pushed on attach and after every
	 *  settings change. */
	pushSettings(): void {
		this.settingsSvc.push();
	}

	/** 把设置面板的出错重试次数注入全部存活会话的 SDK SettingsManager。
	 *  applyOverrides 只改内存合并视图（不碰 ~/.pi/agent/settings.json），
	 *  且 SDK 每次退避前都重读 getRetrySettings()——即时生效、无需 reload。
	 *  但 session.reload() 会重读磁盘丢掉覆盖，每次 reload 后必须重放
	 *  （reloadSession / afterReload / 标记开关直载路径均已接）。 */
	applyRetryOverrides(): void {
		const n = normalizeRetryMaxAttempts(this.settingsSvc.current.retryMaxAttempts);
		for (const c of this.convs.values()) {
			try {
				c.session.settingsManager.applyOverrides({ retry: { maxRetries: n } });
			} catch {
				// 会话未就绪或已释放 → 其 runtime 创建时统一注入。
			}
		}
	}

	/** 把压缩软上限换算成各存活会话的 compaction reserveTokens 覆盖
	 *  （issue #229）。与重试覆盖同一 live 机制：applyOverrides 只改内存
	 *  合并视图，SDK 每次自动压缩检查前都重读 getCompactionSettings()，
	 *  无需 reload；软上限关闭时回填 SDK 默认 reserve（不让旧覆盖泄漏）。
	 *  窗口未知（会话未就绪/无模型）的会话跳过——创建/就绪/换模型路径
	 *  会重放（见各 applyRetryOverrides 调用点）。 */
	applyCompactionOverrides(): void {
		const s = this.settingsSvc.current;
		for (const c of this.convs.values()) {
			try {
				const modelId = modelKeyOf(c.session);
				const contextWindow = contextWindowOf(c.session);
				const cap = effectiveSoftCap(s.softCapTokens, s.softCapByModel, modelId);
				const reserve = softCapToReserve(contextWindow, cap);
				c.session.settingsManager.applyOverrides({
					compaction: { reserveTokens: reserve ?? DEFAULT_COMPACTION_RESERVE_TOKENS },
				});
			} catch {
				// 会话未就绪或已释放 → 其 runtime 创建时统一注入。
			}
		}
	}

	/** 当前活动对话的生效软上限（快照底栏标记线用；null = 关闭/未知）。 */
	activeSoftCap(contextWindow: number): number | null {
		try {
			const s = this.settingsSvc.current;
			const cap = effectiveSoftCap(s.softCapTokens, s.softCapByModel, modelKeyOf(this.session));
			return softCapToReserve(contextWindow, cap) === null ? null : cap;
		} catch {
			return null;
		}
	}

	/** Extensions/skills changed externally (e.g. `pi remove` finished in the
	 *  terminal): re-run session.reload() and re-push state. Streaming-safe —
	 *  deferred to agent_end, same as settings reloads. */
	async reloadExtensions(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** Persist + apply a partial settings update (prompt text/mode, toggles). */
	async setSettings(partial: {
		promptMode?: PromptMode;
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledAgentTools?: string[];
		disabledPluginTools?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		terminalBashMaxForegroundMs?: number;
		toolWatchdogTimeoutMs?: number;
		/** read 工具读目录开关（默认开；见 server/read-tool.ts）。 */
		readDirEnabled?: boolean;
		editSoftEnabled?: boolean;
		questionnaireEnabled?: boolean;
		parallelReminderEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		toolImagesEnabled?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: PromptMode;
		visionBridgePrompt?: string;
		scmCommitMsgPromptMode?: PromptMode;
		scmCommitMsgPrompt?: string;
		subagentDefaultModel?: string | null;
		retryMaxAttempts?: number;
		softCapTokens?: number;
		softCapByModel?: Record<string, number>;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		disabledPlugins?: string[];
		/** 插件顶栏条目的隐藏/排序偏好（纯 UI，per-client）。 */
		pluginTopbarHidden?: string[];
		pluginTopbarOrder?: string[];
		markersEnabled?: boolean;
		disabledMarkers?: string[];
		quickPhrases?: string[];
		quickPhrasesEnabled?: boolean;
	}): Promise<void> {
		const { markersEnabled, disabledMarkers, quickPhrasesSeeded, ...rest } = partial as {
			markersEnabled?: boolean;
			disabledMarkers?: string[];
			quickPhrasesSeeded?: boolean;
		} & typeof partial;
		// 快捷短语「已 seed」是全局标记（非 per-clientId）：置位一次后永久生效。
		if (quickPhrasesSeeded) this.stateStore.markQuickPhrasesSeeded();
		let markerChanged = false;
		if (markersEnabled !== undefined || disabledMarkers !== undefined) {
			this.markerSvc.setAll({
				...(markersEnabled !== undefined ? { markersEnabled } : {}),
				...(disabledMarkers !== undefined ? { disabledMarkers } : {}),
			});
			markerChanged = true;
		}
		await this.settingsSvc.set(rest as never);
		// 审批总开关被关掉 → 挂着的待审批全部按批准放行（否则弹窗还在等人点，
		// 而用户已经明确表示「不要再问我了」）。
		if ((rest as { toolApprovalEnabled?: unknown }).toolApprovalEnabled === false) {
			this.autoApprovePendingApprovals("Tool approval was disabled globally", "Tool approval was disabled globally");
		}
		if ((rest as { disabledPluginTools?: unknown }).disabledPluginTools !== undefined) {
			this.refreshPluginTools();
			this.flushSnapshot();
		}
		if (markerChanged) {
			// 标记开关影响 system prompt 引导，需重载生效（流式中则延迟）
			this.pushSettings();
			this.flushSnapshot();
			// 尝试立即重载，若流式中会由 SettingsService 延迟到 agent_end
			if (!this.session.isStreaming) {
				try {
					await this.session.reload();
					this.applyRetryOverrides();
					this.applyCompactionOverrides();
					this.applyToolGating(this.session, this.conv?.agentPreset);
					await this.pushSlashCommands();
					this.pushSettings();
				} catch (err) {
					console.error(`[settings] marker reload failed (conv ${this.activeId}):`, err);
					this.emit({
						type: "notice",
						level: "error",
						text: `Failed to apply settings: ${(err as Error).message}`,
						textEn: `Failed to apply settings: ${(err as Error).message}`,
					});
				}
			}
		}
	}

	/** Save the CURRENT settings as a named preset (overwrites if exists). */
	async savePreset(name: string): Promise<void> {
		return this.settingsSvc.savePreset(name);
	}

	/** Replace the current settings with the named preset and apply it. */
	async applyPreset(name: string): Promise<void> {
		return this.settingsSvc.applyPreset(name);
	}

	/** Remove a named preset. */
	async deletePreset(name: string): Promise<void> {
		return this.settingsSvc.deletePreset(name);
	}

	/** Upsert 一个子代理模板（全局共享）。 */
	async saveSubagentTemplate(template: UiSubagentTemplate): Promise<void> {
		return this.settingsSvc.saveTemplate(template);
	}

	/** 保存一条审批规则（全局共享）。 */
	async saveApprovalRule(rule: UiApprovalRule): Promise<void> {
		return this.settingsSvc.saveApprovalRule(rule);
	}

	/** 批量保存审批规则（全局共享）。 */
	async saveApprovalRules(rules: UiApprovalRule[]): Promise<void> {
		return this.settingsSvc.saveApprovalRules(rules);
	}

	/** 删除一条自定义审批规则。 */
	async deleteApprovalRule(id: string): Promise<void> {
		return this.settingsSvc.deleteApprovalRule(id);
	}

	/** 恢复某条内置审批规则到系统默认。 */
	async resetBuiltinApprovalRule(id: string): Promise<void> {
		return this.settingsSvc.resetBuiltinApprovalRule(id);
	}

	/** 删除一个子代理模板。 */
	async deleteSubagentTemplate(name: string): Promise<void> {
		return this.settingsSvc.deleteTemplate(name);
	}

	/** Make settings effective in the running runtime（流式中则延迟到 agent_end）。 */
	private async applyRuntimeSettings(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** 按会话对象反查所属对话的预设（创建早期对话还没进 map 时返回 undefined，
	 *  调用方回落默认预设；比按 activeId 猜更准——后台对话的门控不再吃当前页的预设）。 */
	private presetOfSession(session: AgentSession): string | undefined {
		for (const c of this.convs.values()) if (c.session === session) return c.agentPreset;
		return undefined;
	}

	/**
	 * read / write / edit 三处覆盖的注入规格：基底 = 扩展注册的同名工具优先，否则 SDK 内置实现
	 * （见 tool-overrides.ts —— 这三处覆盖不能塞进创建时的 `customTools`，那会静默顶掉扩展的
	 * 同名工具，而官方 docs/extensions.md 明写扩展可覆盖 read/write/edit）。
	 */
	private toolOverrideSpecs(ownerId: string | undefined, cwd: string): ToolOverrideSpec[] {
		const currentPermission = (): string =>
			(ownerId ? this.convs.get(ownerId)?.permissionPreset : undefined) ??
			this.settingsSvc.current.defaultPermissionPreset ??
			"workspace-write-never";
		const approve: AskApprovalFn = (toolCallId, toolName, params, reason, reasonEn, convId, category) =>
			this.askApproval(toolCallId, toolName, params, reason, reasonEn, convId, category);
		// 行为开关（read 本体不可关）：每次调用实时读设置 —— 不进 tool-manager 的 ActiveSet 目录。
		const readDirOptions: ReadDirToolOptions = {
			dirEnabled: (): boolean => this.settingsSvc.current.readDirEnabled !== false,
			getLang: (): ServerLang => this.getLang(),
		};
		const readGuardOptions: Parameters<typeof withToolGuard>[1] = {
			toolName: "read",
			guard: this.toolGuard,
			conversationId: () => ownerId,
			getLang: () => this.getLang(),
			cwd,
			getRoots: () => this.roots,
			askApproval: approve,
			getRules: () => this.approvalRules.list(),
		};
		// 写/编的权限沙箱包装：同一个函数，有扩展同名工具时把它的定义当基底（末参）。
		const composeWrite = (base?: AnyToolDefinition): ToolDefinition =>
			wrapWriteToolWithPermission(
				cwd,
				currentPermission,
				() => this.roots,
				() => this.getLang(),
				approve,
				() => ownerId,
				() => this.approvalRules.list(),
				base,
			);
		const composeEdit = (base?: AnyToolDefinition): ToolDefinition =>
			wrapEditToolWithPermission(
				cwd,
				currentPermission,
				() => this.roots,
				() => this.getLang(),
				approve,
				() => ownerId,
				() => this.approvalRules.list(),
				base,
			);
		return [
			{
				name: "read",
				// 没有扩展 read：完整覆盖（内置基底 + 英文描述 + file_path 别名）。
				fallback: () => withToolGuard(makeReadDirTool(cwd, readDirOptions), readGuardOptions),
				// 有扩展 read：只叠「目录列条目」，它的锚协议/独有参数/渲染全保留（行为委托它）。
				composeWith: (base) => withToolGuard(withReadDirSupport(base, cwd, readDirOptions), readGuardOptions),
			},
			{ name: "write", fallback: () => composeWrite(), composeWith: (base) => composeWrite(base) },
			{ name: "edit", fallback: () => composeEdit(), composeWith: (base) => composeEdit(base) },
		];
	}

	/** 统一工具门控（tool_manage 唯一落点）：按 disabledAgentTools 把目录内工具
	 *  逐个加回/剔除活跃集（工具仍留在注册表，重开可直接加回；live 生效无需
	 *  reload）。支持按当前会话预设（preset）进行工具过滤。
	 *  session.reload() 与新会话创建都会把 custom 工具加回活跃集，
	 *  所以这两条路径之后都要重放本方法（见 reloadSession/创建处）。 */
	private applyToolGating(session: AgentSession, preset?: string): void {
		const targetPreset =
			preset ?? this.presetOfSession(session) ?? this.settingsSvc.current.defaultAgentPreset ?? "standard";
		applyAgentToolsGating(session, effectiveDisabledAgentTools(this.settingsSvc.current), targetPreset);
		this.syncPluginTools(session, targetPreset);
		this.sessionStatsCache.delete(session);
		this.cachedBaseTokens = null;
		// SDK 的 setActiveToolsByName 只改 agent.state.tools，不派发任何事件——门控后
		// 主动推一次快照，否则快照里的 tools 要等下一个 SDK 事件才对齐（会话空闲时永远
		// 等不到；回归：tests/terminal-smoke-test.mjs「agent exposes persistent terminal tools」）。
		// 只在被门控的就是活跃会话时推（创建早期活跃对话可能还没绑定；创建流程自带快照）。
		const active = this.convs.get(this.activeId);
		if (active && active.session === session) this.flushSnapshot();
	}

	/** 判断是否为空白对话（无消息、无队列、未在流式生成）。 */
	isBlankConversation(c: Conversation): boolean {
		try {
			return (
				c.session.state.messages.length === 0 &&
				c.queueSteering.length === 0 &&
				c.queueFollowUp.length === 0 &&
				!c.session.isStreaming
			);
		} catch {
			return false;
		}
	}

	/** 推送 Agent 预设名录（UI 预设条用）。 */
	async refreshAgentPresets(): Promise<void> {
		this.emit({
			type: "dsh_presets",
			presets: PI_AGENT_PRESETS,
			defaultPreset: this.settingsSvc.current.defaultAgentPreset ?? "standard",
		});
	}

	/** 切换当前空白会话的预设。 */
	async selectAgentPreset(preset: string): Promise<void> {
		const conv = this.conv;
		if (conv.presetLocked || !this.isBlankConversation(conv)) {
			conv.presetLocked = true;
			this.emit({
				type: "notice",
				level: "warning",
				text: `Session already started; preset locked to "${conv.agentPreset}" (only blank sessions can switch)`,
				textEn: `Session already started; preset locked to "${conv.agentPreset}" (only blank sessions can switch)`,
			});
			this.flushSnapshot();
			return;
		}
		const hit = PI_AGENT_PRESETS.find((p) => p.id === preset);
		if (!hit) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `Unknown preset "${preset}"`,
				textEn: `Unknown preset "${preset}"`,
			});
			return;
		}
		conv.agentPreset = hit.id;
		this.applyToolGating(conv.session, hit.id);
		this.sessionStatsCache.delete(conv.session);
		this.cachedBaseTokens = null;
		// 技能名录段/终端引导是按 run 组装的提示词：重载 resourceLoader 让新预设
		// 即时生效（只有空白会话能切到这里，无历史可丢）。
		try {
			await conv.session.resourceLoader.reload();
		} catch {
			// loader 未就绪——首轮 run 组装时自然读到新预设。
		}
		this.emit({
			type: "notice",
			level: "info",
			text: `Switched to preset "${hit.name}"`,
			textEn: `Switched to preset "${hit.name}"`,
		});
		// 先快照后设置（见 switchConversationNow 末尾；带预设的新建对话也走这里）。
		this.flushSnapshot();
		this.pushSettings();
	}

	/** 设置新会话默认预设。 */
	async setDefaultAgentPreset(preset: string): Promise<void> {
		const hit = PI_AGENT_PRESETS.find((p) => p.id === preset);
		if (!hit) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `Unknown preset "${preset}"; default preset unchanged`,
				textEn: `Unknown preset "${preset}"; default preset unchanged`,
			});
			return;
		}
		this.settingsSvc.current.defaultAgentPreset = hit.id;
		this.stateStore.saveSettings(this.clientId, { defaultAgentPreset: hit.id });
		this.pushSettings();
		this.refreshAgentPresets();
		this.flushSnapshot();
	}

	/** 推送权限选项表 + 默认权限。 */
	async refreshPermission(): Promise<void> {
		this.emit({
			type: "dsh_permission",
			options: PI_PERMISSION_OPTIONS,
			defaultPreset: this.settingsSvc.current.defaultPermissionPreset ?? "workspace-write-never",
		});
	}

	/** 切换当前会话的权限预设（热生效）。 */
	async setPermissionPreset(preset: string): Promise<void> {
		const hit = PI_PERMISSION_OPTIONS.find((p) => p.value === preset);
		if (!hit) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `Unknown permission preset "${preset}"`,
				textEn: `Unknown permission preset "${preset}"`,
			});
			return;
		}
		if (this.conv.permissionPreset === hit.value) {
			return;
		}
		this.conv.permissionPreset = hit.value;
		try {
			// 持久会话：将权限变更写入会话转录日志，切会话/切项目重载时不丢失
			const sm = this.conv.session.sessionManager as unknown as {
				appendCustomEntry?: (customType: string, data: unknown) => void;
			};
			sm?.appendCustomEntry?.("permission/preset", { preset: hit.value });
		} catch {
			// best effort for in-memory sessions
		}
		this.emit({
			type: "notice",
			level: "info",
			text: `Current session permission switched to "${hit.name}"`,
			textEn: `Current session permission switched to "${hit.name}"`,
		});
		this.flushSnapshot();
	}

	/** 设置新会话默认权限预设。 */
	async setDefaultPermissionPreset(preset: string): Promise<void> {
		const hit = PI_PERMISSION_OPTIONS.find((p) => p.value === preset);
		if (!hit) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `Unknown permission preset "${preset}"; default unchanged`,
				textEn: `Unknown permission preset "${preset}"; default unchanged`,
			});
			return;
		}
		this.settingsSvc.current.defaultPermissionPreset = hit.value;
		this.stateStore.saveSettings(this.clientId, { defaultPermissionPreset: hit.value });
		this.refreshPermission();
		this.flushSnapshot();
	}

	/** 当前启用的插件 AI 工具定义（provider 快照按 disabledPluginTools 过滤；
	 *  未知/已卸载插件的禁用条目保留但不影响现有工具）。
	 *  预设是第二层门控（见 tool-manager.ts 语义总表）：非 standard 预设下插件工具
	 *  一律不可用（读写未知，保守处理），此时返回空表，调用方负责从会话移除。 */
	private enabledPluginToolDefs(preset?: string): ToolDefinition[] {
		if (!presetAllowsPluginTools(preset)) return [];
		const off = new Set(normalizeDisabledPluginTools(this.settingsSvc.current.disabledPluginTools));
		return (this.pluginToolsProvider?.() ?? []).filter((t) => !off.has(t.name)).map(pluginToolToDefinition);
	}

	/** 把插件 AI 工具同步进一个已存在的会话（新增/更新/移除；禁用工具同步移除）。
	 *  实际 diff 逻辑在 plugins.ts 的 syncPluginToolsIntoSession（可单测）。
	 *  模板白名单的子代理（subagentBarsPluginTools）跳过：工厂期就没注册，这里
	 *  不回补，否则白名单等于没关门。 */
	private syncPluginTools(session: AgentSession, preset?: string): void {
		let targetPreset = preset;
		for (const conv of this.convs.values()) {
			if (conv.session !== session) continue;
			if (conv.subagentBarsPluginTools) return;
			targetPreset ??= conv.agentPreset;
		}
		try {
			const defs = this.enabledPluginToolDefs(targetPreset);
			// 移除口径 = 已同步过的 ∪ 全量插件宇宙：创建时工厂直接注册进
			// _customTools 的工具不在 applied 表里，首轮同步（defs 为空时）否则删不掉。
			const universe = new Set([
				...this.appliedPluginToolNames,
				...(this.pluginToolsProvider?.() ?? []).map((t) => t.name),
			]);
			const next = syncPluginToolsIntoSession(
				session as unknown as Parameters<typeof syncPluginToolsIntoSession>[0],
				defs as unknown as Parameters<typeof syncPluginToolsIntoSession>[1],
				universe,
			);
			if (next) this.appliedPluginToolNames = new Set(next);
		} catch (err) {
			console.error("[plugins] sync tools to session failed:", err);
		}
	}

	/** index.ts 经 pluginMgr.onAgentToolsChanged 触发：把插件 AI 工具推入全部会话。 */
	refreshPluginTools(): void {
		for (const conv of this.convs.values()) this.syncPluginTools(conv.session);
	}

	private async applySettingsReload(): Promise<void> {
		// 兼容旧入口：reload + 刷目录在宿主回调里完成
		return this.settingsSvc.applyRuntime();
	}

	/** Server language for this client (issue #91): resolved LIVE from the
	 *  persisted UI locale — "zh" only for zh*; everything else (including
	 *  never-reported) is English. Per-call tool return values read this on
	 *  every invocation, so they follow language switches with no rebuild. */
	getLang(): ServerLang {
		return resolveServerLang(this.stateStore.get(this.clientId).locale);
	}

	/** Persist the browser UI locale (hello.locale / set_locale) and refresh
	 *  lang-aware prompt segments. Reuses the settings reload path, so it is
	 *  streaming-safe (deferred to agent_end mid-run, same as settings). */
	async setLocale(locale: string): Promise<void> {
		const code = locale.trim().slice(0, 16);
		if (!code) return;
		const prev = this.getLang();
		this.stateStore.saveLocale(this.clientId, code);
		if (this.getLang() === prev) return; // same server language — nothing to re-render
		await this.applySettingsReload();
	}

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

	/** True when the service is draining (quiesced): emits a rejection notice
	 *  and returns true. Guards every NEW-work entry point (prompt / new chat /
	 *  edit-resend / session resume / goal wizard) — existing runs keep going.
	 *  Called BEFORE any LLM/token work starts so quiesce is a hard admission
	 *  gate, not a best-effort hint. */
	private quiesceBlocked(): boolean {
		if (!this.isQuiesced()) return false;
		this.emit({
			type: "notice",
			level: "error",
			text: "Server is draining (quiesce) and rejected the new chat/message/edit. Existing runs continue; resume with pi-web-ui server unquiesce.",
			textEn:
				"Server is draining (quiesce) and rejected the new chat/message/edit. Existing runs continue; resume with pi-web-ui server unquiesce.",
		});
		this.flushSnapshot();
		return true;
	}

	/** Conversations with an in-flight run — active work for quiesce status. */
	activeConversations(): number {
		let n = 0;
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) n += 1;
			} catch {
				// session being replaced — not running
			}
		}
		return n;
	}

	/** Messages queued in the SDK (steer + follow-up) — pending work for
	 *  quiesce status. Quiesce refuses to add more, so this only drains. */
	pendingMessages(): number {
		let n = 0;
		for (const c of this.convs.values()) n += c.queueFollowUp.length + c.queueSteering.length;
		return n;
	}

	/** issue #145：本实例连接的 socket 数（0 = 标签页全关了，ClientSession 残留）。 */
	/** 当前对话标题（会话替换中给 undefined）。 */
	currentTitle(): string | undefined {
		try {
			return this.conv.title;
		} catch {
			return undefined;
		}
	}

	sinkCount(): number {
		return this.sinks.size;
	}

	/** issue #145：按下 session 文件找本实例持有的对话（跨客户端查重的本机一半）。 */
	findConversationBySessionFile(targetPath: string): Conversation | undefined {
		for (const conv of this.convs.values()) {
			try {
				const sessionFile = conv.session.sessionFile;
				if (sessionFile && resolve(sessionFile) === targetPath) return conv;
			} catch {
				// session being replaced — skip
			}
		}
		return undefined;
	}

	/** issue #145：某对话是否正在流式运行（替换中按未跑处理，不误拦）。 */
	conversationStreaming(conv: Conversation): boolean {
		try {
			return conv.session.isStreaming;
		} catch {
			return false;
		}
	}

	/** 某对话的转录最小结构（内存实时消息，含未落盘的；与 conversationReadHost
	 *  的 readRunningConversation 同一取数逻辑 —— 并行提醒算触碰集时复用，
	 *  不另起读取路径）。 */
	convTranscript(conv: Conversation): TranscriptInputMessage[] {
		let raw: AgentMessage[] = [];
		try {
			raw = ((conv.session as unknown as { messages?: AgentMessage[] }).messages ??
				conv.session.agent.state.messages ??
				[]) as AgentMessage[];
		} catch {
			raw = [];
		}
		return raw.map(toTranscriptInput);
	}

	/** issue #145：当前活动对话的 session 文件（resolved），无则 undefined。 */
	activeSessionFileResolved(): string | undefined {
		try {
			const conv = this.convs.get(this.activeId);
			const f = conv?.session.sessionFile;
			return f ? resolve(f) : undefined;
		} catch {
			return undefined;
		}
	}

	/** issue #145：本实例在某 cwd 下正在跑的对话摘要（同项目并行感知用）。 */
	streamingInCwd(cwd: string): { convId: string; title: string; sessionFile?: string }[] {
		const out: { convId: string; title: string; sessionFile?: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.cwd !== cwd || conv.isSubagent) continue;
			if (!this.conversationStreaming(conv)) continue;
			let sessionFile: string | undefined;
			try {
				sessionFile = conv.session.sessionFile ?? undefined;
			} catch {
				sessionFile = undefined;
			}
			out.push({ convId: conv.id, title: conv.title, sessionFile });
		}
		return out;
	}

	/** issue #145：本实例别处可见的对话摘要（elsewhere 列表的本机一半 +
	 *  手动过户的目标定位：convId + 是否有等答复问卷）。
	 *
	 *  口径 = 运行中 + 已结束但本会话仍持有的可见对话（shownInRunningList：
	 *  listed 或当前有内容的对话；空白新对话不入列）。只推 running 时，对话
	 *  一结束 elsewhere 行就消失，另一处想过户查看只能趁运行中动手 —— 跑完
	 *  即失联。空闲行带 isStreaming:false + sessionFile，照样可过户（搬 runtime
	 *  本体，单 writer 不变；takeoverBriefs 本来就含空闲对话）。子代理不单列
	 *  （随主对话一起搬）。 */
	streamingSummariesAll(): {
		title: string;
		cwd: string;
		isStreaming: boolean;
		convId: string;
		hasQuestion: boolean;
		questionTitle?: string;
		sessionFile?: string;
	}[] {
		const out: {
			title: string;
			cwd: string;
			isStreaming: boolean;
			convId: string;
			hasQuestion: boolean;
			questionTitle?: string;
			sessionFile?: string;
		}[] = [];
		for (const conv of this.convs.values()) {
			if (conv.isSubagent) continue;
			const streaming = this.conversationStreaming(conv);
			if (!streaming && !this.shownInRunningList(conv)) continue;
			const pq = this.getPendingQuestionForConv(conv.id);
			let sessionFile: string | undefined;
			try {
				sessionFile = conv.session.sessionFile ?? undefined;
			} catch {
				sessionFile = undefined;
			}
			out.push({
				title: conv.title,
				cwd: conv.cwd,
				isStreaming: streaming,
				convId: conv.id,
				hasQuestion: !!pq,
				...(pq?.title ? { questionTitle: pq.title } : {}),
				...(sessionFile ? { sessionFile } : {}),
			});
		}
		return out;
	}

	/**
	 * 浏览器重启认领用：本会话是否有值得新标签接管的内容。
	 * 跑着的（主对话/子代理都算）、后台挂着的（listed）、有消息历史的都算；
	 * 纯空白会话（刚建就关了标签）不算 —— 认领它与新建无异，不如走新建流程。
	 * 零 token 冒烟测试的残留会话永远是空白的，因此认领逻辑不会改变它们的行为。
	 */
	hasAdoptableContent(): boolean {
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) return true;
			} catch {
				// 会话替换中 —— 按未跑处理
			}
			if (c.isSubagent) continue;
			if (c.listed) return true;
			try {
				if (messageCountOf(c.session) > 0) return true;
			} catch {
				// 会话替换中 —— 按无消息处理
			}
		}
		return false;
	}

	/** 各对话最近活跃时间的最大值（认领时多个残留按此排序，新的优先）。 */
	latestActivity(): number {
		let at = 0;
		for (const c of this.convs.values()) {
			at = Math.max(at, c.lastActiveAt || 0, c.lastSdkEventAt || 0);
		}
		return at;
	}

	/** 被新标签认领后首帧即被告之（pendingNotices 随 attachSink 下发）。 */
	noteAdopted(): void {
		this.pendingNotices.push({
			type: "notice",
			level: "info",
			text: "Restored the workspace session from before the browser was closed, including its running conversations — pick up right where you left off.",
			textEn:
				"Restored the workspace session from before the browser was closed, including its running conversations — pick up right where you left off.",
		});
	}

	/** issue #145：让其他客户端重推 conversations（elsewhere 刷新用；
	 *  流式集合签名驱动，外层循环安全）。 */
	refreshExternalRunning(): void {
		if (this.disposed) return;
		this.emitConversations();
	}

	/** issue #145：AgentService 代其他客户端向本客户端广播 notice（并行通告用）。 */
	sendNotice(msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }): void {
		this.emit(msg);
	}

	async prompt(
		text: string,
		attachments?: {
			path: string;
			/** "inline" is a legacy alias of "reference"（见 protocol.ts 的 PromptAttachment）。 */
			mode?: "inline" | "reference" | "lines";
			lines?: { start: number; end: number };
			/** Raw pasted/dropped/uploaded image (base64) — bypasses workspace path. */
			imageData?: string;
			/** Raw uploaded file bytes (base64) — persisted, attached as reference. */
			fileData?: string;
			mimeType?: string;
			name?: string;
			size?: number;
		}[],
		/**
		 * true = followUp: while streaming, queue the prompt and deliver it only
		 * after the WHOLE run finishes (补充 button — "AI 生成结束才发送").
		 * false/undefined = steer: the pi CLI Enter semantic — injected right
		 * after the current turn settles, skipping remaining planned tool calls.
		 */
		queue = false,
		/** optimistic-send: the window's id for this send, answered with one prompt_ack (prompt-ack.ts). */
		id?: string,
	): Promise<void> {
		let conv: Conversation;
		try {
			conv = this.conv;
		} catch (err) {
			if (id) this.emit({ type: "prompt_ack", id, conversationId: "", ok: false, reason: "No chat is open." });
			throw err;
		}
		// optimistic-send: the window drew this message at once and waits for exactly one receipt.
		// The same id sent again (Retry after a reconnect) stops here when it is already in the chat
		// or still being handled, so it can never land twice.
		const receipt = promptIds.begin(id, conv.id, (msg) => this.emit(this.withAckRev(msg)));
		if (!receipt) return;
		// optimistic-send: this message's place in the chat's line, taken before any await so the
		// places follow the order the messages came in (see takePromptAdmission).
		const flow: PromptFlow = { deferred: false, handedOver: false, admission: takePromptAdmission(conv) };
		try {
			await this.promptInLine(conv, receipt, flow, text, attachments, queue);
		} finally {
			// A prompt pi put off until the previous run settled is answered by its preflight callback.
			if (!flow.deferred) {
				flow.admission.release();
				// Every exit answers. The refusals answer for themselves; what is left here is a text pi
				// took without a user message of its own (an add-on handled it: sent), or an unexpected
				// throw before pi got the text (not sent).
				if (!receipt.answered) {
					if (conv.ackOnUserMessage === receipt) conv.ackOnUserMessage = undefined;
					if (flow.handedOver) receipt.ok();
					else receipt.fail("The message could not be sent.");
				}
			}
		}
	}

	/** prompt()'s body, run once the receipt and the message's place in the chat's line are taken. */
	private async promptInLine(
		conv: Conversation,
		receipt: PromptReceipt,
		flow: PromptFlow,
		text: string,
		attachments: Parameters<ClientSession["prompt"]>[1],
		queue: boolean,
	): Promise<void> {
		// Captured at the START (before any await): the conversation being
		// addressed by this prompt. See the naming block below — a concurrent
		// switch/new_chat while prompt() is in flight must never target a
		// different conversation. (optimistic-send: prompt() captures it and passes it in.)
		// telegram-answers: what the user said here last (a stuck task answered in the chat shows it).
		conv.lastPrompt = { text, at: Date.now() };
		// rewind-to-here：正在回退（换分支 + 写摘要）时发来的话等回退做完再发——输入框已经清了，
		// 拒掉就丢了；等完话落在回退后的分支上，正是用户要的顺序。
		if (conv.rewindDone) await conv.rewindDone;
		// 输入框内容被消费（发送/斜杠执行）→ 清掉该会话存过的草稿（best-effort）。
		// 快捷短语发送（不碰输入框）同样清：客户端发送成功后会把当前草稿重存回来。
		// clear() 同时记录 clear 时间戳水位：清掉之后才 landing 的旧 draft_update
		// （防抖延迟 / 跨 tab 陈旧写，ts <= 水位）由 store 直接丢弃，不复活。
		try {
			this.drafts.clear(conv.session.sessionId);
		} catch {
			// ignore
		}
		// 用户往这条对话里发了话 = 看过也回了：绿灯灭掉，并把它拉回「最近对话」。
		this.markRecentSeen(conv);
		// optimistic-send: wait until every earlier message to this chat has been taken in (started,
		// queued or refused), so this one sees a running chat and joins its queue instead of racing
		// it into a second run (see takePromptAdmission).
		await flow.admission.ready;
		const promptAc = new AbortController();
		conv.activePromptAc = promptAc;
		try {
			// optimistic-send: the chat this prompt was sent to, not whichever one the window shows
			// after the waits above.
			const s = conv.session;
			// Native slash commands (see NATIVE_COMMANDS) are executed here and
			// never reach the SDK. Extension / skill / template commands fall
			// through — AgentSession.prompt() handles those itself.
			const slash = parseSlash(text);
			if (slash) {
				// optimistic-send: a command run here never reaches pi, so it gives up its place in the
				// chat's line first: `/new <text>` sends <text> from inside it, maybe to this same blank
				// chat, and that must not wait behind the command that is waiting for it.
				flow.admission.release();
				if (await this.slash.exec(slash.name, slash.args)) {
					this.flushSnapshot();
					receipt.ok();
					return;
				}
				// Not one of ours (an add-on's command, a skill, a template): it goes to pi, so it takes a
				// place in the line again.
				flow.admission = takePromptAdmission(conv);
				await flow.admission.ready;
			}
			// Native commands above are pure config tweaks (no tokens) — allow them
			// even while quiesced. Everything that reaches the SDK is NEW work and
			// is refused until admission reopens.
			if (this.quiesceBlocked()) {
				receipt.fail("The server is about to restart and is not taking new messages right now.");
				return;
			}

			// 首轮用户发言后锁定当前会话的预设（对齐 DSH 预设语义）
			conv.presetLocked = true;
			// #280：悬空 toolCall 守卫——转录尾是「有调用、无结果」时直接 prompt
			// 会把非法链喂给 provider（有发起迹象但零落盘、零报错的黑洞）。
			// 非流式时先补合成结果再继续；补不上则响亮拒绝。
			if (conv.transcriptBlocked && !s.isStreaming) {
				this.emit({
					type: "notice",
					level: "error",
					text: `Prompt refused: this transcript ends with a tool call that never got a result (last run was force-terminated) and auto-repair failed. Reopen it from history or start a new conversation.`,
					textEn: `Prompt refused: this transcript ends with a tool call that never got a result (last run was force-terminated) and auto-repair failed. Reopen it from history or start a new conversation.`,
				});
				this.flushSnapshot();
				receipt.fail(TRANSCRIPT_BLOCKED_REASON);
				return;
			}
			if (!s.isStreaming) {
				try {
					const live = s.agent.state.messages as unknown[];
					// dangling-tail-only (fork patch): only the tail assistant's unanswered calls.
					// Older ones are legal as they are (pi-ai adds "No result provided" before the
					// next user turn); healing them here appends an orphan tool_result (Anthropic 400).
					const dangling = Array.isArray(live) ? findTailDanglingToolCalls(live) : [];
					if (dangling.length > 0) {
						let healed = 0;
						try {
							const sm = s.sessionManager as unknown as {
								appendMessage?: (m: unknown) => void;
							};
							if (typeof sm?.appendMessage === "function") {
								for (const d of dangling) {
									sm.appendMessage({
										role: "toolResult",
										toolCallId: d.toolCallId,
										toolName: d.toolName,
										content: [
											{
												type: "text",
												text: `${DANGLING_TOOL_RESULT_TEXT}\n${DANGLING_TOOL_RESULT_TEXT_EN}`,
											},
										],
										isError: true,
										timestamp: Date.now(),
									});
									healed += 1;
								}
							}
						} catch {
							// 落盘失败走下面的拒绝分支。
						}
						if (healed === dangling.length && healed > 0) {
							conv.transcriptBlocked = false;
							try {
								await s.reload();
								this.applyRetryOverrides();
								this.applyCompactionOverrides();
								this.applyToolGating(s, conv.agentPreset);
							} catch {
								// reload 失败兜底
							}
							this.emit({
								type: "notice",
								level: "warning",
								text: `Found ${dangling.length} tool call(s) without results from the last run; synthetic results were inserted automatically before continuing. Re-run the tool if the task is incomplete.`,
								textEn: `Found ${dangling.length} tool call(s) without results from the last run; synthetic results were inserted automatically before continuing. Re-run the tool if the task is incomplete.`,
							});
						} else {
							conv.transcriptBlocked = true;
							this.emit({
								type: "notice",
								level: "error",
								text: `Prompt refused: this transcript ends with a tool call that never got a result (last run was force-terminated) and auto-repair failed. Reopen it from history or start a new conversation.`,
								textEn: `Prompt refused: this transcript ends with a tool call that never got a result (last run was force-terminated) and auto-repair failed. Reopen it from history or start a new conversation.`,
							});
							this.flushSnapshot();
							receipt.fail(TRANSCRIPT_BLOCKED_REASON);
							return;
						}
					} else {
						conv.transcriptBlocked = false;
					}
				} catch {
					// 守卫本身绝不挡发送：查不到就按原路径走。
				}
			}
			// issue #145：发之前再查一次同文件持有者 —— 拦住「打开时空闲、发送时在跑」的竞态。
			// 没有第二个 writer，就不可能有看不见的第二个 agent。
			const activeFile = this.activeSessionFileResolved();
			if (activeFile) {
				const owner = this.findSessionOwner?.(activeFile);
				// server-owned-chats：不再有「另一处的 writer」。一条对话在整个服务端
				// 只有一个 runtime，两个窗口看到的是同一个；发消息就是往那一个里发，
				// 分叉在结构上不可能发生，所以这里没有什么可拦的了。
				void owner;
			}
			// issue #145：同项目并行感知 —— 同一 cwd 下别处（或其他对话）正在跑时，
			// 允许并行（可以同时改不同部分），但用户与 AI 都必须知道。只在新一轮启动时
			// 通告一次（steer/排队等流式中发送不重复打扰）。
			// parallelReminderEnabled=false 时整段跳过（不发 notice、不注 AI、不通知对端）。
			if (!conv.isSubagent && !s.isStreaming && this.settingsSvc.current.parallelReminderEnabled !== false) {
				// 认领心跳：本对话发 prompt = 还活着，自己名下的认领续期（同步内存操作）。
				try {
					this.getClaimStore?.().touch(conv.id);
				} catch {
					// ignore
				}
				let projectClaims: { path: string; ownerConvId: string; ownerTitle: string; note?: string }[] = [];
				try {
					projectClaims = this.getClaimStore?.().list(conv.cwd) ?? [];
				} catch {
					projectClaims = [];
				}
				// 本窗口正在跑的：子代理也算进来（以前 !c.isSubagent 把它们排除在外，
				// 对方用子代理干活时 AI 完全收不到提示），标明归属。触碰集就地从内存
				// 消息算，无 I/O，不阻塞发送路径。
				const localRunners = [...this.convs.values()]
					.filter((c) => c.id !== conv.id && c.cwd === conv.cwd && this.conversationStreaming(c))
					.map((c) => {
						let label: string;
						if (c.isSubagent) {
							const parent = c.parentId ? this.convs.get(c.parentId) : undefined;
							label = parent
								? `subagent of "${parent.title}" in this window: "${c.title}"`
								: `subagent "${c.title}" in this window`;
						} else {
							label = `"${c.title}" in this window`;
						}
						return { label, touches: extractTouches(this.convTranscript(c)) };
					});
				const externalRunners = (this.listProjectRunners?.(conv.cwd) ?? []).filter(
					(r) => r.sessionFile === undefined || (activeFile !== undefined && resolve(r.sessionFile) !== activeFile),
				);
				// 取舍（诚实降级）：外部运行只有 title + sessionFile，触碰集要读对方
				// 转录文件 —— 同步文件 I/O 会阻塞发送路径，不做；提醒里如实写
				// 「外部运行的文件触碰未知」，不编造。
				// 每条 ≤60 字符（以前整串 slice(0, 600)，经常从半截路径处拦腰截断）。
				const capItem = (st: string): string => (st.length <= 60 ? st : `${st.slice(0, 59)}…`);
				const noticeTitles = [
					...localRunners.map((r) => r.label),
					...externalRunners.map((r) => `"${r.title}" elsewhere`),
				].map(capItem);
				const aiItems = [
					...localRunners.map((r) => `${r.label}·${r.touches.length} files`),
					...externalRunners.map((r) => `"${r.title}" elsewhere·touches unknown`),
				].map(capItem);
				if (noticeTitles.length > 0) {
					const shown = noticeTitles.slice(0, 3).join(", ");
					const more = noticeTitles.length > 3 ? `(${noticeTitles.length} in total)` : "";
					this.emit({
						type: "notice",
						level: "info",
						text: `Parallel-work notice: ${shown}${more ? " and more" : ""} running in the same project. You may continue (fine for different files); confirm before touching the same files, or wait for it to finish when unsure.`,
						textEn: `Parallel-work notice: ${shown}${more ? " and more" : ""} running in the same project. You may continue (fine for different files); confirm before touching the same files, or wait for it to finish when unsure.`,
					});
					// 给 AI 的上下文：交集由服务端算好写明“⚠ 双方都动过 X”，AI 不用自己
					// 算；拿不准就 ask_user_question 让用户选（并行 / 等它跑完 / 只读围观）。
					// display:false —— 用户界面只看上面的 notice。分两档：无交集只给一行
					// （省 token），有交集才展开细节。
					const mine = extractTouches(this.convTranscript(conv));
					// 认领升级（advisory，但比触碰更强：这是对方的事前意图）：
					// 我动过 + 对方认领 → 最强信号单独点名；其他认领只给一行汇总。
					const othersClaims = projectClaims.filter((c) => c.ownerConvId !== conv.id);
					const myClaimed = matchClaims(
						mine,
						othersClaims.map((c) => ({
							path: c.path,
							ownerConvId: c.ownerConvId,
							ownerTitle: c.ownerTitle,
							claimedAt: 0,
							expiresAt: 0,
						})),
						conv.cwd,
					);
					const claimHitEn = myClaimed
						.slice(0, 3)
						.map((h) => `${h.touch.path} (claimed by ${h.claim.ownerTitle})`)
						.join("; ");
					const claimMore = myClaimed.length > 3 ? ` (+${myClaimed.length - 3})` : "";
					const claimsSummaryEn =
						othersClaims.length > 0
							? ` Claimed by others (steer clear): ${othersClaims
									.slice(0, 3)
									.map((c) => `${c.path} ("${c.ownerTitle}")`)
									.join("; ")}${othersClaims.length > 3 ? ` (+${othersClaims.length - 3})` : ""}.`
							: "";
					const clashes = localRunners
						.map((r) => ({ label: r.label, hits: intersectTouches(r.touches, mine) }))
						.filter((r) => r.hits.length > 0);
					const extNoteEn = externalRunners.length > 0 ? ` Touched files of external run(s) are unknown.` : "";
					// 预设拿掉问卷工具时（minimal/code/ask），提醒文案不点不存在的工具名，
					// 改走正文提问（见 tool-manager.ts 语义总表；认领信息本身照常有用）。
					const canAsk = presetHasQuestionnaire(
						conv.agentPreset ?? this.settingsSvc.current.defaultAgentPreset ?? "standard",
					);
					const askClauseEn = canAsk
						? "use ask_user_question when unsure "
						: "ask the user in your reply text when unsure ";
					let aiReminder: string;
					if (clashes.length === 0 && myClaimed.length === 0) {
						aiReminder =
							`(System reminder: ${aiItems.length} other run(s) [${aiItems.join("; ")}] ` +
							`are currently running in the same project directory. No file written by both you and them was detected, ` +
							`so working on different files in parallel is fine; before writing the same files or running project-wide ` +
							`commands, assess the conflict risk first, and ${askClauseEn}` +
							`(continue in parallel / wait / watch read-only).${extNoteEn}${claimsSummaryEn})`;
					} else {
						// 有交集档：每处 ≤3 条完整路径 + 计数（路径永不截断，见 conversation-touches）。
						const clashPartsEn = clashes.map((h) => `${h.label} — you both wrote: ${formatTouchesCompact(h.hits)}`);
						if (myClaimed.length > 0) {
							clashPartsEn.push(
								`⚠ you touched and others claimed: ${claimHitEn}${claimMore} — ask the user before touching these again`,
							);
						}
						const clashEn = clashPartsEn.join("; ");
						aiReminder =
							`(System reminder: ${aiItems.length} other run(s) [${aiItems.join("; ")}] ` +
							`are currently running in the same project directory. ⚠ ${clashEn} — re-read these files before ` +
							`touching them again, and ${askClauseEn}` +
							`(continue in parallel / wait / watch read-only).${extNoteEn})`;
					}
					try {
						await s.sendCustomMessage(
							{
								customType: "parallel-work-reminder",
								content: [{ type: "text", text: aiReminder }],
								display: false,
							},
							{ deliverAs: "nextTurn" },
						);
					} catch {
						// best effort —— 注入失败不影响发送本身
					}
					// 让对端也知道：有人在同项目开了并行工作（只通知其他客户端，不打扰自己）。
					if (externalRunners.length > 0) {
						this.notifyExternalClients?.({
							type: "notice",
							level: "info",
							text: `Parallel-work notice: another window started a conversation ("${conv.title}") in "${conv.cwd}", possibly editing the same project in parallel with your running task.`,
							textEn: `Parallel-work notice: another window started a conversation ("${conv.title}") in "${conv.cwd}", possibly editing the same project in parallel with your running task.`,
						});
					}
				}
			}
			// 轨迹用：暂存本轮任务文本，下一轮 agent_start 消费（steer/内部续跑
			// 不经此处，届时 task 缺省，插件回退为「继续执行」）。
			conv.pendingTask = text.trim() ? truncRun(text.trim(), RUN_TASK_CAP) : undefined;
			// Name the conversation from its FIRST prompt immediately, before any
			// await: the typed text IS the name. The `conv` reference was captured
			// before the try block, so a concurrent switch/new_chat while prompt()
			// is in flight can never rename a DIFFERENT conversation — or miss the
			// rename entirely. A failed send still leaves the name, which matches
			// what the user typed intent-wise; the entry_appended fallback below
			// re-derives it from the persisted transcript when needed.
			if (isUntitledTitle(conv.title) && text.trim() && !conv.session.sessionName?.trim()) {
				const trimmed = text.trim().replace(/\s+/g, " ");
				conv.title = trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
				// 同时也是 #140 的入列时刻：这条对话从此有内容了，左栏「运行的对话」
				// 立刻要有它（此刻还在流式输出，不能等 agent_end 的防抖刷新）。
				this.emitConversations();
			}
			// Attach files as independent nextTurn context messages (asides) so the
			// user message stays clean; they render as separate attachment cards.
			const asides = await buildAttachmentMessages(
				{
					cwd: this.cwd,
					clientId: this.clientId,
					emit: (msg) => this.emit(msg),
					settings: this.settingsSvc.current,
					session: this.session,
					// issue #91：附件/视觉桥文案按客户端 UI 语言出中英（英文默认）。
					getLang: () => this.getLang(),
				},
				attachments,
			);
			if (promptAc.signal.aborted) {
				conv.activePromptAc = undefined;
				receipt.fail(STOPPED_BEFORE_SEND_REASON);
				return;
			}
			for (const aside of asides) {
				if (s.isStreaming) {
					await s.sendCustomMessage(aside.message, { deliverAs: "nextTurn" });
				} else {
					await s.sendCustomMessage(aside.message);
				}
			}
			// 附件处理完毕后立即刷新快照，让引用的文件卡片在等待模型首字前瞬间出现在界面上
			if (asides.length > 0) {
				this.flushSnapshot();
			}
			// 创建工作区版本影子快照（Dual-State Rollback）
			let snapshotRef: string | null = null;
			try {
				snapshotRef = await createWorkspaceSnapshot(conv.cwd);
			} catch {
				// best-effort
			}
			if (promptAc.signal.aborted) {
				conv.activePromptAc = undefined;
				receipt.fail(STOPPED_BEFORE_SEND_REASON);
				return;
			}
			conv.activePromptAc = undefined;
			// optimistic-send: pi calls this once it has taken the text in (the run is about to start, or
			// the text joined the queue of a running chat, or an add-on handled it) or refused it. Here the
			// next message may go (admission), and the window gets its receipt: right away for a queued
			// text (after a snapshot that shows it), or with the user message that starts the run.
			const preflightResult = (ok: boolean): void => {
				flow.handedOver = ok;
				flow.admission.release();
				if (!ok) {
					// The error reaches the catch below, which answers with its message. A text pi put off
					// (flow.deferred) has no catch here, so answer after it with a general reason.
					setTimeout(() => receipt.fail("The message could not be sent."), 0);
					return;
				}
				if (s.isStreaming) {
					this.flushConvSnapshots(conv);
					receipt.ok();
				} else {
					// (An older receipt still waiting here belongs to a text an add-on took without a
					// message of its own: it was handled.)
					conv.ackOnUserMessage?.ok();
					conv.ackOnUserMessage = receipt;
				}
			};

			if (s.isStreaming) {
				// queue=true (补充 button) → followUp: the message is delivered only
				// after the whole run finishes — the agent finishes what it started,
				// then responds to the queued message. queue=false/undefined
				// (plain Enter) → steer: interrupts the current run — the message
				// is delivered right after the current assistant turn settles
				// (remaining planned tool calls are skipped) and the agent
				// immediately responds to it. This is the pi CLI
				// Enter-during-streaming semantic (docs/usage: Enter queues a
				// steering message); followUp would wait for the whole run
				// to finish, which users perceive as ordinary queueing.
				await s.prompt(text, {
					streamingBehavior: queue ? "followUp" : "steer",
					preflightResult,
				});
			} else {
				await s.prompt(text, { preflightResult });
			}
			// optimistic-send: pi came back without calling preflightResult (a refusal would have thrown):
			// it put the text off until the previous run has settled and calls it then.
			if (!flow.handedOver) flow.deferred = true;

			// 关联快照与本次 prompt 产生的用户消息 entry
			if (snapshotRef) {
				try {
					const entries = conv.session.sessionManager.buildContextEntries();
					const lastUserEntry = [...entries]
						.reverse()
						.find(
							(e) => e.type === "message" && (e as unknown as { message?: { role?: string } }).message?.role === "user",
						);
					conv.workspaceSnapshots.push({
						entryId: lastUserEntry?.id,
						timestamp: Date.now(),
						snapshotRef,
					});
					if (conv.workspaceSnapshots.length > 50) {
						conv.workspaceSnapshots.shift();
					}
				} catch {
					// best-effort
				}
			}
		} catch (err) {
			conv.activePromptAc = undefined;
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to send prompt: ${(err as Error).message}`,
				textEn: `Failed to send prompt: ${(err as Error).message}`,
			});
			// optimistic-send: pi refused the text (compaction running, no model, no key...), an earlier
			// step broke, or the run broke before its user message came out. A run that already showed
			// the message keeps its answer (the receipt answers once).
			if (!flow.handedOver || conv.ackOnUserMessage === receipt) {
				if (conv.ackOnUserMessage === receipt) conv.ackOnUserMessage = undefined;
				receipt.fail((err as Error)?.message || "The message could not be sent.");
			}
		}
		// The active conversation (captured at prompt start — see above) has been
		// continued since it was opened — it must not be dismissed when the user
		// switches away. (Also bumps the per-project "most recently active"
		// order used by set_cwd.)
		conv.promptedSinceActive = true;
		conv.lastActiveAt = Date.now();
		// Fresh run — restart the stall watchdog window.
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		// crash-guard: while this send ran, the window may have moved to another chat, and that chat
		// may have been closed by another window (a window without a socket doesn't count as looking).
		// Then bring the window back to the chat this send went to before refreshing it.
		if (!this.convs.has(this.activeId)) this.recoverLostActive("its send finished", conv);
		this.flushSnapshot();
	}

	/**
	 * Turn attached files into custom-message payloads.
	 *
	 * 一律只给路径引用：文本文件（无论大小）都只发 `<file path="..." />`，模型用
	 * 自己的 read 工具按需读（自带截断/分页）——文件内容永不进 prompt。行范围模式
	 * （mode "lines"）在引用上带 lines 属性，告诉模型用户选的是哪几行。
	 * 图片始终作为 image 内容发送。粘贴/拖入/上传的原始图片（attachment.imageData）
	 * 不走工作区路径，直接进模型；上传文件（attachment.fileData）落在
	 * <dataDir>/uploads/ 下，以绝对路径引用。
	 */

	/**
	 * Hard-abort the running agent (Stop button / global 中断). Tries
	 * session.abort() first; if the run is not idle within
	 * HARD_ABORT_TIMEOUT_MS (model stream ignoring the abort signal), the
	 * conversation's runtime is force-disposed and recreated from the last
	 * persisted session so the chat ALWAYS comes back usable — never stuck
	 * overnight. The notice fires only on the forced-reset path.
	 */
	async abort(): Promise<void> {
		if (this.conv.activePromptAc) {
			this.conv.activePromptAc.abort();
			this.conv.activePromptAc = undefined;
		}
		const isRunning = this.conversationStreaming(this.conv) || !this.conv.session.isIdle;
		if (!isRunning) {
			this.flushSnapshot();
			return;
		}
		// 只停止智能体运行本身；AI 在后台启动的服务由「后台任务」面板单独
		// 管理（可逐个停止或全部关闭），不会在停止对话时被连带杀掉。
		await this.interruptRun(this.conv, "Stopped");
		this.flushSnapshot();
	}

	/** 手动重试上次失败的模型调用：自动重试次数（retryMaxAttempts）用完后
	 *  本轮已停止并标红，用户点「重试」再触发一轮 LLM 调用。不新增用户气泡——
	 *  用 display:false 的 custom 消息 triggerTurn 续跑，模型基于完整上下文
	 * （含上次报错）继续生成。流式中 / 无可重试失败时只发 notice 拒绝。 */
	async retryLast(): Promise<void> {
		const conv = this.conv;
		try {
			if (this.quiesceBlocked()) return;
			const s = this.session;
			if (s.isStreaming) {
				this.emit({
					type: "notice",
					level: "info",
					text: "The conversation is still generating — no need to retry",
					textEn: "The conversation is still generating — no need to retry",
				});
				return;
			}
			if (conv.retryState) {
				this.emit({
					type: "notice",
					level: "info",
					text: "Auto-retry is in progress — please wait",
					textEn: "Auto-retry is in progress — please wait",
				});
				return;
			}
			// 最后一轮失败的证据：末尾 stopReason=error 的 assistant 消息。
			let failed: { errorMessage?: unknown; stopReason?: unknown } | null = null;
			try {
				const msgs = s.agent.state.messages;
				for (let i = msgs.length - 1; i >= 0; i--) {
					const m = msgs[i] as { role?: unknown; errorMessage?: unknown; stopReason?: unknown };
					if (m.role !== "assistant") continue;
					if ((typeof m.errorMessage === "string" && m.errorMessage.trim()) || m.stopReason === "error") {
						failed = m;
					}
					break;
				}
			} catch {
				// 会话替换中——按无可重试处理
			}
			if (!failed) {
				this.emit({
					type: "notice",
					level: "info",
					text: "Nothing to retry: the last turn did not end with an error",
					textEn: "Nothing to retry: the last turn did not end with an error",
				});
				return;
			}
			// 轨迹用：下一轮 agent_start 消费（否则插件回退为「继续执行」）。
			conv.pendingTask = "Manually retrying the last failed model request";
			await s.sendCustomMessage(
				{
					customType: "manual-retry",
					content: [
						{
							type: "text",
							text: '(System: the user clicked "Retry". Re-send the last failed model request based on the full context and continue the user\'s task.)',
						},
					],
					display: false,
				},
				{ triggerTurn: true },
			);
			conv.promptedSinceActive = true;
			conv.lastActiveAt = Date.now();
			conv.lastSdkEventAt = Date.now();
			conv.stallNoticed = false;
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Manual retry failed: ${(err as Error).message}`,
				textEn: `Manual retry failed: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Remove ONE queued prompt (the ✕ on a pending bubble) so it is neither
	 * shown nor eventually delivered. The pi SDK has no per-item queue API, so we
	 * drain the SDK queue (clearQueue), drop the target item and re-queue the rest
	 * in their original order; the SDK re-emits queue_update which re-syncs
	 * conv.queueSteering / conv.queueFollowUp.
	 *
	 * `index` identifies WHICH bubble was clicked (same duplicate text can be
	 * queued twice — text alone drops the wrong one). It is checked against the
	 * item still at that position; on any mismatch we fall back to first-occurrence
	 * text match (old clients, or the queue shifted between click and handling).
	 */
	async removeQueued(kind: "steer" | "followUp", text: string, index?: number): Promise<void> {
		const conv = this.conv;
		// Always-defined display mirrors; also the provenance of bubble rendering.
		const local = kind === "steer" ? conv.queueSteering : conv.queueFollowUp;
		if (!local.includes(text)) {
			// Already gone (delivered / cleared elsewhere) — just refresh the display.
			this.flushSnapshot();
			return;
		}
		const s = this.conv.session;
		if (!s) {
			// Runtime not bound yet (fresh conversation) — drop the display mirror;
			// a later queue_update reconciles any SDK-side state.
			const next = removeQueuedByIndexOrText(local, text, index);
			if (next.length !== local.length) {
				local.splice(0, local.length, ...next);
			}
			this.flushSnapshot();
			return;
		}
		const { steering, followUp } = s.clearQueue();
		// 气泡 ✕ 对应的是「第几个气泡」（index），不是「哪段文本」：同一文本排队两次时
		// 按文本只会删掉第一条，点第二个气泡却删掉第一个。用 index 定位，位置对不上
		// （队列在点击与执行之间变化）或旧客户端没发 index 时回落到第一处文本匹配。
		const keptSteering = kind === "steer" ? removeQueuedByIndexOrText(steering, text, index) : steering;
		const keptFollowUp = kind === "followUp" ? removeQueuedByIndexOrText(followUp, text, index) : followUp;
		// Re-queue the survivors in original order. Guard each call so a single
		// failure can't leave the queue half-drained silently.
		for (const t of keptSteering) {
			try {
				await s.steer(t);
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `Failed to re-queue the steer message: ${(err as Error).message}`,
					textEn: `Failed to re-queue the steer message: ${(err as Error).message}`,
				});
			}
		}
		for (const t of keptFollowUp) {
			try {
				await s.followUp(t);
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `Failed to re-queue the queued message: ${(err as Error).message}`,
					textEn: `Failed to re-queue the queued message: ${(err as Error).message}`,
				});
			}
		}
		this.flushSnapshot();
	}

	// -----------------------------------------------------------------------
	// 未发送输入框草稿（issue #166，单中心文件方案，见 server/composer-drafts.ts）
	// -----------------------------------------------------------------------

	/** 存指定会话的未发送草稿（`draft_update` 入口，经 DispatchSession.saveDraft）。
	 *  按消息自带的 sessionId 落键（不按 active 会话：切会话时的「离开刷盘」
	 *  晚于服务端的切换到达）。空白新会话的转录还没落盘，但 id 内存里已有。
	 *  存完不推快照：同页的草稿本来就是自己打的；恢复走全量快照的 draft 字段。
	 *  陈旧写由 ComposerDraftsStore 的 clear 水位丢弃（ts <= clearTs 不复活）。 */
	saveDraft(sessionId: string, text: string, ts: number): void {
		try {
			if (!sessionId) return;
			this.drafts.save(sessionId, text, ts);
		} catch {
			// best-effort：草稿丢了可以重打
		}
	}

	/** 当前活跃对话的草稿（全量快照用；增量 snapshot_delta 传 withDraft=false 不带）。 */
	private draftForSnapshot(): UiState["draft"] {
		try {
			return this.drafts.get(this.conv.session.sessionId) ?? null;
		} catch {
			return null;
		}
	}

	/** Re-push the current list on request (panel opened); prunes dead entries first. */
	async listBgServers(): Promise<void> {
		await this.bg.listAndPush();
	}

	/** 插件任务集合变化时由宿主调用：重推一次 bg_servers（含插件任务）。
	 *  插件每轮轮询都会对每条任务 update() 一次，内容常常没变；重复推送只会白占
	 *  socket 缓冲，慢链路上会把快照挤掉。内容没变就别推。 */
	refreshBgTasks(): void {
		this.bg.push({ skipIfUnchanged: true });
	}

	/** 插件设置保存结果等需要从 index.ts 发 notice 时用（emit 是私有的）。 */
	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void {
		this.emit({ type: "notice", level, text, textEn });
	}

	/** Kill ONE background server (by port); returns whether anything was killed. */
	/** Kill ONE background server (by port) OR a plugin task (by taskId). */
	async killBackgroundServer(port: number | undefined, taskId?: string): Promise<boolean> {
		if (taskId) {
			// 插件任务：交给插件管理器 stop 回调（不杀进程树——任务在宿主进程内）。
			const ok = this.pluginStopBgTask?.(taskId) ?? false;
			if (!ok) {
				this.emit({
					type: "notice",
					level: "info",
					text: `Background task "${taskId}" does not exist or has ended`,
					textEn: `Background task "${taskId}" does not exist or has ended`,
				});
			}
			this.bg.push();
			this.flushSnapshot();
			return ok;
		}
		if (typeof port !== "number") return false;
		return this.bg.killOne(port);
	}

	/** Kill every background server the agent started; returns the freed ports. */
	async killAllBackgroundServers(): Promise<string[]> {
		return this.bg.killAll();
	}

	/** Kill only the running bash command(s) — the agent run itself continues
	 *  (the bash tool returns an aborted error and the model moves on). Uses
	 *  the per-client AbortController set registered by the bash tool paths
	 *  ({@link makeKillableBashTool} / {@link makeTerminalBashTool}). */
	async abortBash(): Promise<void> {
		if (this.bashKills.size === 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: "No bash command is running",
				textEn: "No bash command is running",
			});
			this.flushSnapshot();
			return;
		}
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const ac of [...this.bashKills]) ac.abort();
		this.emit({
			type: "notice",
			level: "info",
			text: "Bash command stopped (conversation continues)",
			textEn: "Bash command stopped (conversation continues)",
		});
		// 让 AI 明确知道是用户手动停止：sendUserMessage 触发下一轮，agent
		// 会看到「命令被用户中止」而不是普通失败，并据此继续（不会困惑于
		// 为什么命令失败了）。
		try {
			await this.conv.runtime.session.sendUserMessage(
				"(System: the user manually stopped the bash command that was just running — it was aborted, and whatever it printed before stopping is in its tool result. Continue from there; don't re-run the aborted command unless it's really needed.)",
			);
		} catch {
			// best effort — 消息注入失败不影响命令已停止的事实
		}
		this.flushSnapshot();
	}

	/** Interrupt a run: abort, with a force-reset fallback on timeout. */
	private async interruptRun(conv: Conversation, reason: string): Promise<void> {
		if (!this.conversationStreaming(conv) && conv.session.isIdle) {
			return;
		}
		// The run is only truly stopped when its agent_end event arrives:
		// session.abort() can return without stopping anything when the run is
		// stuck before the agent even started (e.g. a model stream that never
		// begins), so we watch for agent_end and force-reset when it never
		// comes — abort 卡住（超时）或空转（结算窗口）两条路都覆盖。
		let ended = false;
		let forced = false;
		const off = conv.session.subscribe((e) => {
			if (e.type === "agent_end") {
				ended = true;
			}
		});
		const force = () => {
			if (forced) return;
			forced = true;
			void this.forceResetConversation(
				conv,
				`${reason}: the run did not stop, so the current conversation was force-reset`,
			);
		};
		// 1) abort itself hangs (model stream ignores the signal) → hard kill.
		const abortTimer = setTimeout(() => {
			if (!ended) force();
		}, ClientSession.HARD_ABORT_TIMEOUT_MS);
		abortTimer.unref?.();
		// 2) abort itself (Stop semantics: kills the process tree, emits
		//    agent_end with stopReason "aborted" on the normal path).
		try {
			await conv.runtime.session.abort();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Abort failed: ${(err as Error).message}`,
				textEn: `Abort failed: ${(err as Error).message}`,
			});
		}
		// 3) abort returned but no agent_end within the settle window:
		//    仅在 session 依然处于非 idle 状态（即真正卡住）时才等待并强制重置
		if (!ended && !conv.session.isIdle) {
			await new Promise((r) => setTimeout(r, ClientSession.HARD_ABORT_SETTLE_MS));
		}
		clearTimeout(abortTimer);
		off();
		if (!ended && !conv.session.isIdle) force();
	}

	/** Force-reset a conversation: dispose the stuck runtime (kills the hung
	 *  model stream / child processes) and rebuild it from the most recent
	 *  persisted session. The conversation record itself is kept (same id,
	 *  same cwd, same serialization caches), so the UI stays attached. */
	private async forceResetConversation(conv: Conversation, reason: string): Promise<void> {
		// #280：先记下本次对话自己的会话文件——重建必须回到同一个文件，
		// 不能用 continueRecent(cwd) 按 mtime 取「最近」（同 cwd 多会话时会接错文件）。
		const ownFile = (() => {
			try {
				const f = conv.session.sessionFile;
				return typeof f === "string" && f ? f : undefined;
			} catch {
				return undefined;
			}
		})();
		try {
			conv.unsubscribe?.();
			conv.unsubscribe = undefined;
			conv.dialogs.cancelAll();
			this.clearAllToolWatchdogs(conv);
			conv.toolStartTimes.clear();
			disposeEvalSession(conv.id);
			await conv.runtime.dispose();
			// #280：dispose 丢弃了内存里的在飞状态（未落盘的工具结果蒸发），
			// 文件尾可能留下一个悬空 toolCall——先补合成 toolResult 再重建，
			// 否则重建后的 prompt 会把非法转录链喂给 provider（零落盘黑洞）。
			let healedCount = 0;
			if (ownFile && existsSync(ownFile)) {
				try {
					const n = healDanglingToolCallFile(ownFile);
					if (n > 0) healedCount = n;
				} catch {
					// best-effort：修不好就按原路径重建，下面的守卫会在 prompt 前再拦。
				}
			}
			// #280 & #335：转录链损坏时修一次再试（见 openManagerAndRuntime）。
			// 严禁在 ownFile 不存在时回退到 continueRecent(conv.cwd) 或按 mtime list 历史文件，
			// 否则会直接接错并顶替同项目的其它历史会话，污染别人的转录记录。
			const opened = await this.openManagerAndRuntime(
				() => {
					if (ownFile && existsSync(ownFile)) {
						return SessionManager.open(ownFile);
					}
					return conv.isEphemeral ? SessionManager.inMemory(conv.cwd) : SessionManager.create(conv.cwd);
				},
				(m) =>
					// 子代理带模板时按原模板重建（conv.subagentTemplate 是派发时工厂
					// 用的同一快照）；普通对话 undefined，行为不变。
					createAgentSessionRuntime(this.makeRuntimeFactory(conv.terminals, conv.subagentTemplate, conv.id), {
						cwd: conv.cwd,
						agentDir: this.agentDir,
						sessionManager: m,
					}),
				async () => (ownFile && existsSync(ownFile) ? ownFile : undefined),
			);
			const runtime = opened.runtime;
			if (opened.repair) {
				for (const n of this.transcriptRepairNotices(opened.repair)) this.emit(n);
			}
			conv.runtime = runtime;
			conv.session = runtime.session;
			if (healedCount > 0) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `The last run was force-terminated; ${healedCount} tool call(s) without results were filled with synthetic results (transcript healed). Verify task state and re-run the tool if needed.`,
					textEn: `The last run was force-terminated; ${healedCount} tool call(s) without results were filled with synthetic results (transcript healed). Verify task state and re-run the tool if needed.`,
				});
			}
			// #280：重建后复查——新 runtime 仍以悬空 toolCall 开头说明修复没落盘
			// （文件被删/只读等），此时响亮拒绝后续 prompt 而不是静默黑洞。
			try {
				const msgs = conv.session.agent.state.messages as unknown[];
				// dangling-tail-only: the file healer only fixes the tail, so only the tail counts
				// here too; an old unanswered call must not block the chat for good.
				const still = Array.isArray(msgs) ? findTailDanglingToolCalls(msgs) : [];
				if (still.length > 0) conv.transcriptBlocked = true;
				else conv.transcriptBlocked = false;
			} catch {
				// ignore：守卫是兜底，查不到就让 prompt 路径再查。
			}
			this.emit({
				type: "notice",
				level: "warning",
				text: reason,
				textEn: `${reason}`,
			});
			await this.bindSession();
			this.emitConversations();
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Force-stop failed: ${(err as Error).message}`,
				textEn: `Force-stop failed: ${(err as Error).message}`,
			});
		}
	}

	/** 新建/切到一个空白对话。返回值 = 「当前活动对话就是一个可以接收首条的
	 *  空白新对话」——/new <prompt> 只在 true 时投递首条提示；false 表示没能进入
	 *  新对话（准入关闭 / 同项目对话数达上限 / runtime 创建失败），此时照发会把
	 *  首条提示投进用户原本正在用的那个对话里。 */
	/** identities: newChat reuses a blank chat; if an identity was picked for it, clear it (pi-identity's
	 *  `/identity none`), so every new chat starts with none. Nothing to do for a blank chat without one. */
	private async clearBlankChatIdentity(conv: Conversation): Promise<void> {
		if (this.identityOf(conv)) await this.setChatIdentity(conv.id, undefined, null);
	}

	async newChat(_preset?: string, ephemeral?: boolean): Promise<boolean> {
		if (this.quiesceBlocked()) return false;
		// Reuse an already-open blank conversation instead of piling up new ones
		// on every click: if the active chat has no messages it IS the new chat
		// (focus already on it); otherwise switch to the first blank one (under
		// the per-project running-list model displaced blanks are disposed, so
		// this branch normally can't exist — kept as a safety net).
		const isBlank = (c: Conversation): boolean => {
			try {
				return messageCountOf(c.session) === 0 && c.terminals.list().length === 0;
			} catch {
				// session being replaced — treat as used so we don't switch onto it
				return false;
			}
		};
		// crash-guard: no getter here — newChat is also how a window whose chat was closed elsewhere
		// gets a new one (ensureActiveConversation), and then there is no active chat.
		const active = this.convs.get(this.activeId);
		if (!ephemeral && active && isBlank(active)) {
			// identities: a new chat starts with no identity, even when it's the blank chat you picked one for.
			await this.clearBlankChatIdentity(active);
			if (_preset) await this.selectAgentPreset(_preset);
			else {
				// 先快照后设置（见 switchConversationNow 末尾）。
				this.flushSnapshot();
				this.pushSettings();
			}
			return true;
		}
		if (!ephemeral) {
			for (const conv of this.convs.values()) {
				if (conv.id === this.activeId) continue;
				if (isBlank(conv)) {
					await this.switchConversation(conv.id);
					await this.clearBlankChatIdentity(conv);
					if (_preset) await this.selectAgentPreset(_preset);
					else this.flushSnapshot();
					return true;
				}
			}
		}
		// Cap is per project — conversations of other projects keep their own
		// lists and don't consume this project's slots. Subagents don't count
		// (inMemory 后台任务，不占位）。临时会话也不占名额。
		if (!ephemeral) {
			const openInProject = [...this.convs.values()].filter(
				(c) => c.cwd === this.cwd && !c.isSubagent && !c.isEphemeral,
			).length;
			if (openInProject >= MAX_OPEN_CONVERSATIONS) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
					textEn: `This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
				});
				return false;
			}
		}
		// The outgoing conversation is left behind — apply the running-list
		// lifecycle. Removal is deferred until the new chat exists so the active
		// conversation stays valid during the (async) runtime creation.
		const displaced = this.displaceActive();
		// Carry the model chosen in the active chat over to the new chat so it
		// doesn't silently revert to the ModelRuntime default model.
		const prevModel = active?.session.agent.state.model ?? null;
		const prevThinking = active?.session.thinkingLevel ?? null;
		let ready = false;
		try {
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, this.cwd);
			let sessionManager: SessionManager;
			if (ephemeral) {
				sessionManager = SessionManager.inMemory(this.cwd);
				// 为无痕临时会话提供隔离的临时运行目录（供 SoL-Pi 等依赖 getSessionDir 的扩展正常放置缓存），
				// 但保持 persist = false（不写 .jsonl 对话文件、不污染历史记录）
				const ephemeralDir = join(this.agentDir, "ephemeral-sessions", conversationId);
				try {
					mkdirSync(ephemeralDir, { recursive: true });
					(sessionManager as unknown as { sessionDir: string }).sessionDir = ephemeralDir;
				} catch {}
			} else {
				sessionManager = SessionManager.create(this.cwd);
			}
			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(terminals, undefined, conversationId, prevModel ?? undefined, _preset),
				{
					cwd: this.cwd,
					agentDir: this.agentDir,
					sessionManager,
				},
			);
			const conv = this.makeConversation(runtime, conversationId, terminals);
			if (ephemeral) conv.isEphemeral = true;
			if (_preset) {
				const hit = PI_AGENT_PRESETS.find((p) => p.id === _preset);
				if (hit) conv.agentPreset = hit.id;
			}
			// 创建即按归属预设门控：工厂内只能按 active/默认兜底（conv 还没进 map），
			// 默认预设非 standard 时那个结果是错的，这里用 conv 自身预设显式重放一次。
			// conv 尚未进 map，preset 必须显式传，插件同步才能正确剥离。
			this.applyToolGating(conv.session, conv.agentPreset);
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			if (_preset && conv.agentPreset !== (this.settingsSvc.current.defaultAgentPreset ?? "standard")) {
				// 显式预设与默认不一致：工厂组装提示词时用的是默认视图，重载一次对齐
				// （技能名录/终端引导；此时 conv 已进 map，override 能读到归属预设）。
				try {
					await conv.session.resourceLoader.reload();
				} catch {
					// loader 未就绪——首轮 run 组装时自然对齐。
				}
			}
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			// A fresh transcript appeared in the sessions dir — the next listing
			// must see it, not the pre-newChat fridge snapshot.
			this.invalidateSessionInfos();
			// New session seeds with the ModelRuntime default model — restore the
			// model the user had selected in the previous chat.
			let modelRestored = !!this.session.model;
			if (!modelRestored && prevModel && this.sharedModelRuntime) {
				try {
					const p = (prevModel as unknown as { provider: string }).provider;
					const mid = `${p}/${(prevModel as unknown as { id: string }).id}`;
					// 先恢复 provider key，再 setModel（否则 checkAuth 鉴权失败）
					await this.restoreKeyForModel(mid, this.cwd);
					await this.session.setModel(prevModel);
					modelRestored = true;
				} catch {
					// model no longer resolvable
				}
			}
			if (!modelRestored) {
				// 上个会话模型未能恢复（或无上个会话）：回落项目记忆或全局默认模型
				try {
					await this.restoreProjectModelForCwd(this.cwd);
				} catch {
					/* 保持默认 */
				}
			}
			if (prevThinking) {
				try {
					this.session.setThinkingLevel(prevThinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
				} catch {
					// model may not support previous thinking level
				}
			}
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			this.pushTerminals();
			// The new runtime re-discovered skills/templates — refresh the catalog
			// so the picker stops showing the previous runtime's list.
			void this.pushSlashCommands();
			// 新对话即当前打开 → 插件重拉（轨迹视图跟随）。
			this.notifyConversationChanged();
			ready = true;
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to create chat: ${(err as Error).message}`,
				textEn: `Failed to create chat: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
		// 先快照后设置（见 switchConversationNow 末尾）。
		if (ready) this.pushSettings();
		return ready;
	}

	/**
	 * The active conversation is being left (new_chat / switch_conversation /
	 * set_cwd). Runs the running-list lifecycle:
	 *
	 * - 子代理豁免：活动的是子代理时永远保留（listed=true，返回 null）——点开
	 *   查看后切走也不释放 runtime，后台任务继续跑、随时可点开看；清理走
	 *   dismiss_conversation / dismiss_finished_subagents（用户显式动作）。
	 * - still streaming → it becomes a background run: ensure it is listed;
	 * - idle + listed + continued → keep it (the user did continue it);
	 * - any retained terminal state → keep it listed until the terminals are closed;
	 * - idle + listed + opened-but-not-continued, or never listed at all → the
	 *   caller must drop it (returns it so removal happens only after the
	 *   active conversation has been switched away).
	 */
	/** Write a pending-compaction marker into the session file. The SDK treats
	 *  unknown custom entries as inert data, so a crash/restart-safe "we were
	 *  compacting" record survives in the transcript itself — no sidecar file
	 *  to orphan or clean up. Removed on compaction_end. */
	private markCompactionPending(conv: Conversation): void {
		try {
			const file = conv.session.sessionFile;
			if (!file) return;
			// parentId joins the live chain: a null-parent marker would become a
			// second root and hijack the leaf, corrupting the transcript.
			// #235: id 必须唯一——硬编码共享 id ＋ SDK byId last-wins ＋ 标记恰为末行
			// 时新消息 parent 记成共享 id ＝ 下次 open 回溯成环，整个会话打不开。
			const marker = {
				type: "custom",
				id: makeCompactionMarkerId("pending"),
				parentId: conv.session.sessionManager.getLeafId(),
				timestamp: new Date().toISOString(),
				customType: "pi-web-ui/compaction-pending",
				data: {
					reason: conv.compactionState?.reason ?? "manual",
					startedAt: conv.compactionState?.startedAt ?? Date.now(),
				},
			};
			appendFileSync(file, `${JSON.stringify(marker)}\n`);
		} catch {
			// Marker is best-effort: compaction still runs without it, only the
			// restart-detection below is lost.
		}
	}

	/** Close out the pending-compaction marker (called on compaction_end). The
	 *  session file is append-only through the SDK, so rewrite the file with the
	 *  pending marker replaced by a completion marker carrying the outcome
	 *  (completed / failed / cancelled + token counts). The transcript then holds
	 *  a durable started→finished record instead of a silent gap. No-op when the
	 *  file or marker is absent. */
	private clearCompactionPending(
		conv: Conversation,
		outcome?: {
			status: "completed" | "failed" | "cancelled";
			tokensBefore?: number;
			tokensAfter?: number;
			error?: string;
		},
	): void {
		try {
			const file = conv.session.sessionFile;
			if (!file || !existsSync(file)) return;
			const raw = readFileSync(file, "utf8");
			const lines = raw.split("\n");
			// #235：按 customType 定位（id 自本 fix 起唯一，老文件仍是硬编码 id，
			// 按 id 找已不可靠）。取最后一个：重叠压缩时它属于本次，旧残留留给
			// 下次 open 的 repair/notice 处理。
			let idx = -1;
			for (let i = lines.length - 1; i >= 0; i--) {
				if (lines[i].includes(`"${COMPACTION_PENDING_TYPE}"`)) {
					idx = i;
					break;
				}
			}
			if (idx < 0) return;
			// ponytail: full-file rewrite on compaction end — compactions are rare
			// (seconds apart at most), session files are KBs; no streaming needed.
			if (!outcome) {
				lines.splice(idx, 1);
			} else {
				let parentId: string | null = null;
				try {
					parentId = conv.session.sessionManager.getLeafId();
				} catch {
					// fall through with null parent
				}
				const done = {
					type: "custom",
					id: makeCompactionMarkerId("done"),
					parentId,
					timestamp: new Date().toISOString(),
					customType: "pi-web-ui/compaction-done",
					data: { reason: conv.compactionState?.reason ?? "manual", ...outcome },
				};
				lines[idx] = JSON.stringify(done);
			}
			atomicWriteFileSync(file, lines.join("\n"));
		} catch {
			// Best-effort, same as the write path.
		}
	}

	/** Check a freshly opened session for a leftover compaction-pending marker.
	 *  A marker with no matching compaction_end means the server died mid-compaction
	 *  (restart/crash): the in-flight summary is gone, but the session is intact.
	 *  Surface a warning notice with a one-click retry (/compact) instead of
	 *  silently dropping it. Consumes the marker either way. */
	private noticeInterruptedCompaction(conv: Conversation): void {
		try {
			const file = conv.session.sessionFile;
			if (!file || !existsSync(file)) return;
			// Match on the stable customType (conversation ids change every restart).
			const raw = readFileSync(file, "utf8");
			if (!raw.includes('"pi-web-ui/compaction-pending"')) return;
			const kept = raw.split("\n").filter((line) => !line.includes("pi-web-ui/compaction-pending"));
			atomicWriteFileSync(file, kept.join("\n"));
			this.emitCompactionInterruptedNotice();
		} catch {
			// Best-effort, same as the write path.
		}
	}

	private emitCompactionInterruptedNotice(): void {
		this.emit({
			type: "notice",
			level: "warning",
			text: "The last context compaction was interrupted by a server restart and did not finish. Send /compact to retry.",
			textEn:
				"The last context compaction was interrupted by a server restart and did not finish. Send /compact to retry.",
		});
	}

	/** #235 修复产生的提示（调用方决定 emit 还是进 pendingNotices）。 */
	private transcriptRepairNotices(
		repair: SessionFileRepair,
	): Array<{ type: "notice"; level: "warning"; text: string; textEn: string }> {
		const out: Array<{ type: "notice"; level: "warning"; text: string; textEn: string }> = [];
		if (repair.interrupted) {
			out.push({
				type: "notice",
				level: "warning",
				text: "The last context compaction was interrupted by a server restart and did not finish. Send /compact to retry.",
				textEn:
					"The last context compaction was interrupted by a server restart and did not finish. Send /compact to retry.",
			});
		}
		if (repair.renamedIds > 0 || repair.rewiredParents > 0 || repair.cyclesBroken > 0) {
			out.push({
				type: "notice",
				level: "warning",
				text: `The conversation transcript had a corrupted parent chain (duplicate compaction markers) and was auto-repaired. The original file is backed up at ${repair.backup ?? "a .bak file next to it"}; restore it manually if anything looks off.`,
				textEn: `The conversation transcript had a corrupted parent chain (duplicate compaction markers) and was auto-repaired. The original file is backed up at ${repair.backup ?? "a .bak file next to it"}; restore it manually if anything looks off.`,
			});
		}
		return out;
	}

	/**
	 * chat-open-speed: read the transcript ONCE before the open and, when it is provably
	 * intact, send its newest messages straight away.
	 *
	 * Opening a 267 MB chat from history used to read and parse the whole file three times
	 * before the page saw anything (repair pre-scan 1.7 s + dangling-tool heal 1.5 s +
	 * interrupted-compaction scan 1.1 s, on top of the SDK's own 1.3 s load). This single
	 * pass (0.5 s for that file) answers what all three asked:
	 *
	 *  - healthy (problem === null): no repair pass, no heal pass, no marker scan, and the
	 *    newest window goes out at once as `switch_preview` — read-only, with the same
	 *    message ids as the snapshot that follows, so the swap doesn't rebuild the list.
	 *  - anything odd (old format, duplicate ids, a leftover compaction marker, a parent
	 *    cycle, a dangling tool call, an unreadable or oversized file): no preview, and the
	 *    open runs exactly as it did before — repair, heal, notice.
	 *
	 * Returns the scan (its `problem` tells the caller which path to take), or null when the
	 * fast path is off (PI_WEB_OPEN_PREVIEW=0) or the file could not be scanned at all.
	 */
	private async scanAndPreview(target: SwitchTarget, file: string): Promise<TranscriptScan | null> {
		if (!OPEN_PREVIEW) return null;
		let scan: TranscriptScan;
		try {
			scan = scanTranscriptFile(file);
		} catch {
			// A scan must never keep a chat from opening: fall back to the old path.
			return null;
		}
		try {
			if (scan.problem === null) await this.emitSwitchPreview(target, scan);
		} catch {
			// Best-effort: the real snapshot is on its way regardless.
		} finally {
			// Drop the parsed entries before the SDK loads its own copy: holding both would
			// double the peak memory of an open (a 267 MB transcript parses to ~0.5 GB).
			scan.entries.length = 0;
		}
		return scan;
	}

	/** chat-open-speed: the newest window of a chat that is still opening (see scanAndPreview).
	 *  Built with the very same code as a snapshot (chatIndexOf / fullRangeOf / question index /
	 *  exchange digests) over a stand-in conversation holding the messages the SDK will load,
	 *  so ids, positions and picture addresses match the snapshot that replaces it. */
	private async emitSwitchPreview(target: SwitchTarget, scan: TranscriptScan): Promise<void> {
		const messages = contextMessagesOf(scan) as AgentMessage[];
		if (messages.length === 0) return;
		// A stand-in conversation: chatIndexOf only reads the message list, the id counter and the
		// caches. Its numbering starts at 1 in first-seen order — exactly what the real conversation
		// does with the same messages a moment later, so the ids are the same ones.
		const pconv = {
			session: { sessionId: scan.sessionId, sessionFile: scan.file, agent: { state: { messages } } },
			msgIds: new Map<string, number>(),
			nextMsgId: 1,
			uiMessageCache: new Map<string, UiMessage>(),
			chatIndex: undefined,
			retryState: null,
		} as unknown as Conversation;
		const idx = chatIndexOf(pconv);
		const total = idx.raw.length;
		if (total === 0) return;
		const start = Math.max(0, total - MESSAGE_WINDOW);
		const full = (i: number) => fullAt(pconv, idx, i);
		const state: UiState = {
			...this.buildLightState(0, false),
			// The chat being opened, not the one the server is still on.
			cwd: scan.cwd || this.cwd,
			sessionId: scan.sessionId,
			sessionFile: scan.file,
			// No conversation exists yet; the page keys the list by the session (see nextListKey).
			conversationId: "",
			isEphemeral: false,
			rev: 0,
			messages: fullRangeOf(pconv, idx, start, total),
			messagesStart: start,
			questionIndex: buildQuestionIndex(idx.raw, (i) => idx.ids[i]),
			...(EXCHANGE_DIGESTS > 0 ? { exchanges: snapshotDigests(idx.raw, start, EXCHANGE_DIGESTS, full) } : {}),
			// Nothing is running in a chat that isn't open yet.
			streamingMessage: null,
			isStreaming: false,
			queue: { steering: [], followUp: [] },
			retry: null,
			compaction: null,
			rewinding: null,
			tooBig: null,
			dialog: null,
			draft: null,
		};
		// Wait until it has really left: the caller blocks the event loop for a second or more right
		// after this (reading the file with the SDK), and a big frame is squeezed on the loop before
		// it goes out — without the wait the preview would land together with the snapshot.
		await this.emitAndFlush({ type: "switch_preview", target, state });
	}

	/**
	 * #235：已知路径先修后开（openConversation 走这条——单文件预扫描零负担）。
	 * 返回 null = 文件健康或无需处理；返回 repair = 修过，调用方弹提示。
	 * #280：顺带修悬空 toolCall（强制重置/崩溃残留的有调用无结果），修过同样弹提示。
	 */
	private repairTranscriptFileBeforeOpen(filePath: string): SessionFileRepair | null {
		let repair: SessionFileRepair | null = null;
		try {
			repair = repairSessionFile(filePath);
		} catch {
			return null;
		}
		if (!repair?.changed) {
			// #280：压缩链健康时仍要查悬空 toolCall（崩溃/强制重置残留）。
			let healed = 0;
			try {
				const n = healDanglingToolCallFile(filePath);
				if (n > 0) healed = n;
			} catch {
				// best-effort
			}
			if (healed <= 0) return null;
			this.emit({
				type: "notice",
				level: "warning",
				text: `${healed} tool call(s) without results from the last run were filled with synthetic results. Re-run the tool if the task is incomplete.`,
				textEn: `${healed} tool call(s) without results from the last run were filled with synthetic results. Re-run the tool if the task is incomplete.`,
			});
			return null;
		}
		for (const n of this.transcriptRepairNotices(repair)) this.emit(n);
		return repair;
	}

	/**
	 * #235：manager＋runtime 一起建，链损坏报错则修最近文件后重试一次。
	 * SessionManager.open 本身不走 parent 链（真正死循环的是 runtime 初始化里的
	 * getBranch），所以重试必须把两步都包进来；修完用全新 manager 重读。
	 */
	private async openManagerAndRuntime(
		makeManager: () => SessionManager,
		makeRuntime: (m: SessionManager) => Promise<AgentSessionRuntime>,
		locateFile: () => Promise<string | undefined>,
	): Promise<{ manager: SessionManager; runtime: AgentSessionRuntime; repair: SessionFileRepair | null }> {
		try {
			const manager = makeManager();
			const runtime = await makeRuntime(manager);
			return { manager, runtime, repair: null };
		} catch (err) {
			if (!looksLikeChainCorruption(err)) throw err;
			const file = await locateFile().catch(() => undefined);
			const repair = file ? repairSessionFile(file) : null;
			if (!repair?.changed) throw err;
			const manager = makeManager();
			const runtime = await makeRuntime(manager);
			return { manager, runtime, repair };
		}
	}

	/** 除了我之外，还有别的活客户端正在看这条对话吗？（server-owned-chats） */
	private viewedElsewhere(convId: string): boolean {
		for (const other of ClientSession.liveSessions) {
			if (other === this || other.disposed) continue;
			// **必须有活 socket** 才算「有人在看」。ClientSession 会比它的 socket 活得久
			// （断线重连要接回原状态），而 client-per-load 之后每次刷新都是一个新会话——
			// 只看 activeId 的话，被遗弃的会话会永远钉住它最后看的那条对话，导致这条
			// 对话再也关不掉、也不再被回收（用户看到的就是「关不掉的对话」）。
			if (other.sinkCount() === 0) continue;
			if (other.activeId === convId) return true;
		}
		return false;
	}

	private displaceActive(): Conversation | null {
		// crash-guard: the active chat may already be gone (closed by another window); nothing to displace.
		const conv = this.convs.get(this.activeId);
		if (!conv) return null;
		// 别人还在看 → 留着（保留 = 展示口径，不改运行时归属）。
		if (this.viewedElsewhere(conv.id)) {
			conv.listed = true;
			return null;
		}
		// 子代理不受切换关闭影响（见上）。
		if (conv.isSubagent) {
			conv.listed = true;
			return null;
		}
		// An isolated reviewer can keep working while the main session is idle;
		// retain that conversation so its review is not disposed when the user
		// switches away without sending another prompt.
		// 同时检查磁盘上的未过期 wait-subscription 记录：后台子代理运行结束后
		// 仍欠本会话一次唤醒回合；此时释放运行时会杀死 pi-subagents 扩展宿主，
		// 唤醒永远无法送达（会话表现为无限期停摆）。保留是自限的：记录过期后
		// 不再阻止释放。
		// Also retain when a non-expired pi-subagents wait-subscription record
		// exists on disk for this session: a finished background subagent run
		// still owes this conversation a wake-up turn.
		// 更靠前的阶段：run 本身还在 queued/running（workflow 编排中）时释放
		// runtime 同样杀死扩展宿主并 abort 所有 live workflow controller，比
		// wake 订阅早一步——磁盘 .active-runs marker + status.json 探测（pi-web-ui #52）。
		// Retain while the session has active (queued/running) pi-subagents async
		// runs on disk — the extension host would otherwise be torn down and its
		// workflow controllers aborted mid-flight.
		// Also retain a parent while any live first-party subagent conversation
		// points at it: dropping an idle in-memory parent orphans the child row
		// (the child vanishes from Running Chats with no result available).
		const hasLiveChild = [...this.convs.values()].some((child) => child.parentId === conv.id);
		const retained =
			hasLiveChild ||
			shouldRetainActive({
				reviewing: conv.goal.reviewing,
				wizardRunning: conv.wizardRunning,
				// optimistic-send: a message on its way (still in the add-ons' "before the AI starts" step)
				// counts as a run: closing the chat now would lose it.
				streaming: conv.session.isStreaming || (conv.sendsInFlight ?? 0) > 0,
				compacting: conv.session.isCompacting,
				// 只看“用过”的存活终端：没动过的空 shell（点开终端 tab 自动建的
				// 那个）不保留对话，切走即随对话释放（见 countBlockingLive）。
				openTerminals: conv.terminals.countBlockingLive(),
				listed: conv.listed,
				promptedSinceActive: conv.promptedSinceActive,
				hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
				hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
			});
		if (retained) {
			conv.listed = true;
			return null;
		}
		return conv;
	}

	/** Remove a conversation from the running list and free its runtime. The
	 *  session stays persisted on disk, so it remains recoverable from the
	 *  history list. Never removes the active conversation. */
	private removeConversation(id: string): void {
		const conv = this.convs.get(id);
		if (!conv || id === this.activeId) return;
		// server-owned-chats：对话表是进程共享的 —— 别的窗口正看着这条时不能回收它，
		// 否则那边的界面会当场失去自己正在读的对话（而它并没有做错任何事）。
		// 必须在释放认领之前：没回收的对话就没有关闭，认领还得留着。
		if (this.viewedElsewhere(id)) return;
		// 对话真关闭（dismiss/释放）→ 放掉它的认领。过户不走这里（对话换个会话
		// 继续，owner 不变，认领继续有效），所以只在此处释放。
		try {
			this.getClaimStore?.().releaseByOwner(id);
		} catch {
			// ignore
		}
		this.convs.delete(id);
		// carry-on: a closed chat isn't working any more (frozen at shutdown, so this is a real close).
		const closedRef = runningRef(conv);
		if (closedRef) runningChats?.finish(closedRef.sessionFile);
		conv.dialogs.cancelAll();
		// telegram-answers: its permission prompts and questions go with it (they are process-wide now,
		// so nothing else would end them), and whoever shows them elsewhere hears they are gone.
		this.cancelPendingApprovals(id, "the chat was closed");
		this.cancelChatQuestions(id, "the chat was closed");
		ClientSession.scheduleStuckReconcile();
		this.clearAllToolWatchdogs(conv);
		// 关对话 → 连它的 eval 内核（Python/Node 子进程 + 临时沙箱目录）一起回收：
		// 这些进程是 detached 进程组，父进程退出不会自动带走它们。
		disposeEvalSession(id);
		conv.terminals.killAll();
		conv.unsubscribe?.();
		conv.unsubscribe = undefined;
		if (conv.isSubagent) {
			const ephemeralDir = join(this.agentDir, "subagent-sessions", conv.id);
			try {
				rmSync(ephemeralDir, { recursive: true, force: true });
			} catch {}
		}
		if (conv.isEphemeral) {
			const ephemeralDir = join(this.agentDir, "ephemeral-sessions", conv.id);
			try {
				rmSync(ephemeralDir, { recursive: true, force: true });
			} catch {}
		}
		void conv.runtime.dispose().catch(() => {});
		// crash-guard: other windows still pointing at this chat (only socketless ones can be: a window
		// with a socket makes viewedElsewhere refuse the removal) move to an open chat now. Left
		// dangling, their next snapshot or the end of a send still in flight hit a chat that no longer
		// exists — that crashed the server on 2026-09-25 17:15 and 2026-09-26 09:11.
		for (const other of ClientSession.liveSessions) {
			if (other === this || other.disposed || other.activeId !== id) continue;
			other.recoverLostActive(`closed by window ${this.clientId}`, undefined, false);
		}
	}

	/** 本会话是否持有这个 SDK 会话对应的对话；命中则给出它的**当前** id
	 *  （AgentService 按 runtime 身份解析过户后的归属方用，见 findConversationHome）。 */
	conversationIdOfSession(sdkSession: AgentSession): string | undefined {
		for (const c of this.convs.values()) {
			if (c.session === sdkSession) return c.id;
		}
		return undefined;
	}

	/** 这个窗口是否正看着这条对话（server-owned-chats：activeId 只是视图状态）。
	 *  AgentService.findConversationHome 挑桥接工具的投递目标时用。 */
	isViewing(convId: string): boolean {
		return this.activeId === convId;
	}

	/** 过户用的对话摘要（AgentService 拼移动集合 + 容量检查用）。 */
	takeoverBriefs(): {
		id: string;
		title: string;
		cwd: string;
		parentId?: string;
		isSubagent: boolean;
		isEphemeral?: boolean;
	}[] {
		return [...this.convs.values()].map((c) => ({
			id: c.id,
			title: c.title,
			cwd: c.cwd,
			...(c.parentId ? { parentId: c.parentId } : {}),
			isSubagent: c.isSubagent,
			isEphemeral: !!c.isEphemeral,
		}));
	}

	/**
	 * 过户转出：把指定对话（含事件订阅/看门狗计时器/等答复问卷/页调用）从本会话摘除。
	 * - 先修 active：active 被搬且还有剩余 → 切过去（优先主对话）；active 被搬且掏空 →
	 *   建空白兜底，建不出来（quiesce）则拒绝搬出（ok:false），绝不留悬空 active。
	 * - 看门狗计时器清掉（toolStartTimes 保留，目标按剩余时间重布）。
	 * - 只搬归属被搬对话的问卷/页调用（conversationId 对得上的；未记归属的留在源会话）。
	 */
	async detachTakeoverConversations(
		ids: string[],
	): Promise<{ ok: true; payload: TakeoverPayload } | { ok: false; reason: "missing" | "empty" }> {
		const set = new Set(ids);
		const convs = [...this.convs.values()].filter((c) => set.has(c.id));
		if (convs.length === 0) return { ok: false, reason: "missing" };
		if (set.has(this.activeId)) {
			const remaining =
				[...this.convs.values()].find((c) => !set.has(c.id) && !c.isSubagent) ??
				[...this.convs.values()].find((c) => !set.has(c.id));
			if (remaining) {
				await this.switchConversation(remaining.id);
			} else if (!(await this.newChat())) {
				return { ok: false, reason: "empty" };
			}
		}
		for (const conv of convs) {
			this.convs.delete(conv.id);
			this.clearAllToolWatchdogs(conv);
			conv.unsubscribe?.();
			conv.unsubscribe = undefined;
		}
		const questions: TakeoverQuestion[] = [];
		for (const [qid, p] of this.pendingQuestions) {
			if (p.conversationId !== undefined && set.has(p.conversationId)) {
				this.pendingQuestions.delete(qid);
				questions.push({
					resolve: p.resolve,
					questions: p.questions,
					conversationId: p.conversationId,
					askId: p.askId ?? qid,
				});
				// 源页面的对话框可能是即时通道弹出的（live），快照为 null 收不掉它 ——
				// 明确撤回，让源页面立即收起（目标页主对话由转入方重推 question_pending 或快照呈现）。
				this.emit({ type: "question_retracted", id: qid });
			}
		}
		const pageCalls: TakeoverPageCall[] = [];
		for (const [pid, p] of this.pendingPageCalls) {
			if (p.conversationId !== undefined && set.has(p.conversationId)) {
				this.pendingPageCalls.delete(pid);
				clearTimeout(p.timer);
				pageCalls.push({ resolve: p.resolve, req: p.req, timeoutMs: p.timeoutMs, conversationId: p.conversationId });
			}
		}
		// 待审批跟对话走：留在源会话就是幽灵弹窗（id 失效点不动，runtime 已搬走，
		// 永远等不到答复）。只搬归属明确的（conversationId 对得上，与问卷/页调用
		// 同一规则）；目标侧按新 id 重发弹窗，等待中的 Promise 原样过户不 resolve。
		// telegram-answers: permission prompts are process-wide now (sharedApprovals). They stay where
		// they are, with the same id; every window shows them, so nothing needs moving.
		const approvals: TakeoverApproval[] = [];
		this.emitConversations();
		this.flushSnapshot();
		return { ok: true, payload: { convs, questions, pageCalls, approvals } };
	}

	/**
	 * 过户转入：把另一会话摘除的对话整体接过来，返回主对话的新 id。
	 * - id 冲突（两边计数器都从 c1 开始，大概率撞上）→ 给搬入方分配新 id，move
	 *   集合内的 parentId/问卷归属同步改写。模型手里旧 runId 的后续子代理工具调用
	 *   会报 unknown（可经列表查新 id）；定时唤醒的旧 id 同理回落无头执行。
	 * - 事件订阅/终端投递/问卷/页调用全部重接到本会话，迁入的主对话立即触发弹窗
	 *   （子代理待答问卷通过角标与快照呈现）。看门狗按剩余时间重布（已逾期的立即触发）。
	 */
	insertTakeoverConvs(payload: TakeoverPayload): string {
		const remap = new Map<string, string>();
		for (const conv of payload.convs) {
			if (this.convs.has(conv.id)) {
				remap.set(conv.id, this.nextConversationId());
			}
		}
		const fix = (id: string): string => remap.get(id) ?? id;
		let mainId = "";
		for (const conv of payload.convs) {
			conv.id = fix(conv.id);
			if (conv.parentId) conv.parentId = fix(conv.parentId);
			if (!conv.isSubagent && !mainId) mainId = conv.id;
			conv.lastActiveAt = Date.now();
			conv.terminals.rebindEmit((msg) => this.emitTerminal(conv.id, msg));
			conv.terminals.onAgentIdle = (terminalId, idleMs, title, lastLines) =>
				this.notifyTerminalIdle(conv.id, terminalId, idleMs, title, lastLines);
			conv.unsubscribe?.();
			conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
			for (const [toolCallId, start] of conv.toolStartTimes) {
				if (!conv.toolWatchdogs.has(toolCallId)) {
					const baseMs = this.getBaseToolWatchdogTimeoutMs();
					if (baseMs > 0) {
						this.rearmToolWatchdog(conv, toolCallId, baseMs - (Date.now() - start), baseMs);
					}
				}
			}
			this.convs.set(conv.id, conv);
		}
		if (!mainId) mainId = payload.convs[0]?.id ?? "";
		for (const q of payload.questions) {
			const nid = `q-${++ClientSession.questionSeq}`;
			const qConvId = fix(q.conversationId);
			this.pendingQuestions.set(nid, {
				resolve: q.resolve,
				questions: q.questions,
				conversationId: qConvId,
				...(q.askId ? { askId: q.askId } : {}),
			});
			// 迁入的主对话立即触发弹窗（子代理问卷留在后台，由角标与切换会话呈现）。
			if (qConvId === mainId) {
				const conv = this.convs.get(qConvId);
				this.emit({
					type: "question_pending",
					id: nid,
					questions: q.questions,
					conversationId: qConvId,
					...(conv?.title ? { conversationTitle: conv.title } : {}),
				});
			}
		}
		for (const p of payload.pageCalls) {
			const nid = `p-${++this.pageSeq}`;
			const timer = this.armPageCallTimeout(nid, p.resolve, p.timeoutMs);
			this.pendingPageCalls.set(nid, {
				resolve: p.resolve,
				timer,
				conversationId: fix(p.conversationId),
				req: p.req,
				timeoutMs: p.timeoutMs,
			});
			this.emit({
				type: "page_request",
				id: nid,
				op: p.req.op,
				args: p.req.args,
				target: p.req.target,
				timeoutMs: p.timeoutMs,
			});
		}
		// 迁入的待审批按新 id 重新挂上（等待中的 Promise 未动，模型还在等）。
		// 主对话的立即弹窗（子代理的靠角标与快照呈现，与问卷同一口径）。
		for (const a of payload.approvals) {
			const nid = `appr-${++ClientSession.approvalSeq}`;
			const aConvId = fix(a.conversationId);
			this.pendingApprovals.set(nid, {
				id: nid,
				toolCallId: a.toolCallId,
				toolName: a.toolName,
				params: a.params,
				reason: a.reason,
				reasonEn: a.reasonEn,
				...(a.category ? { category: a.category } : {}),
				conversationId: aConvId,
				...(a.conversationTitle ? { conversationTitle: a.conversationTitle } : {}),
				resolve: a.resolve,
				createdAt: a.createdAt,
			});
			if (aConvId === mainId) {
				this.emit({
					type: "tool_approval_pending",
					id: nid,
					toolCallId: a.toolCallId,
					toolName: a.toolName,
					params: a.params as Record<string, unknown>,
					reason: a.reason,
					reasonEn: a.reasonEn,
					...(a.category ? { category: a.category } : {}),
					conversationId: aConvId,
					...(a.conversationTitle ? { conversationTitle: a.conversationTitle } : {}),
				});
			}
		}
		return mainId;
	}

	/**
	 * 切到新工作目录后的“跟随面”刷新（roots / 插件钩子 / 最近项目 / 历史列表 /
	 * 文件树 / 命令目录）。调用方先把 this.cwd 改好再调本函数。
	 * switchConversation 跨项目切换、set_cwd、switchSession 打开别项目的历史
	 * 会话三处共用 —— 之前 switchSession 只改了 cwd 没同步 roots，文件树/
	 * 工作区插件/历史列表都还停在旧项目。集中一处避免再漏。
	 */
	private applyCwdSideEffects(abs: string): void {
		this.roots = this.stateStore.getWorkspaceRoots(this.clientId, abs);
		// 工作区跟随型插件（编辑器文件树等）同步切根。
		try {
			this.onCwdChanged?.(abs, this.roots);
		} catch {
			/* 钩子异常不影响主流程 */
		}
		// Remember the new workspace (restore target + recent-project entry).
		this.stateStore.remember(this.clientId, abs);
		void this.pushProjects();
		this.refreshSessionsOnSwitch();
		void this.listFiles(undefined);
		// Commands are per-project (.pi/commands.json in the current cwd).
		void this.listCommands();
	}

	/** Switch the ACTIVE conversation without interrupting any other chat. */
	/** switch-loading：切换回执。成功回执必须在 flushSnapshot() **之后**发 —— 客户端收到它
	 *  就撤掉「正在打开…」，那时新对话的内容必须已经在路上（flushSnapshot 同步 emit，
	 *  同一条 socket 保序，所以「先快照后回执」在这里就是调用顺序）。 */
	private emitSwitchDone(target: SwitchTarget): void {
		this.emit({ type: "switch_done", target });
	}

	private emitSwitchFailed(target: SwitchTarget, text: string, textEn: string): void {
		this.emit({ type: "switch_failed", target, error: text, errorEn: textEn });
	}

	/** chat-open-speed: the pi session of the chat this window is on, "" when there is none.
	 *  A `prompt` may name the session it was typed into (it can now be written while a chat
	 *  is still opening); index.ts refuses it when the two differ. */
	activeSessionId(): string {
		if (!this.convs.has(this.activeId)) return "";
		try {
			return this.conv.session.sessionId ?? "";
		} catch {
			return "";
		}
	}

	/** crash-guard: does this window's active chat still exist in the shared table? */
	hasActiveConversation(): boolean {
		return this.convs.has(this.activeId);
	}

	/** crash-guard: the new chat being opened for a window whose chat was closed (one at a time). */
	private recoveryChat: Promise<boolean> | null = null;

	/**
	 * crash-guard (level 1): this window's active chat is no longer in the shared table. The table is
	 * process-wide (server-owned-chats), so another window can close the chat this one shows: a window
	 * without a socket (its page was reloaded) doesn't count as looking at it (viewedElsewhere). Move
	 * the window to an open chat (planForLostActive: `prefer`, else the project's most recently active
	 * chat). With nothing to move to: a window with a socket gets a new chat (in the background, when
	 * `allowNewChat`), one without waits until it reconnects (attach calls ensureActiveConversation).
	 * Logs one line either way. Returns true when the window has an open active chat afterwards.
	 */
	private recoverLostActive(reason: string, prefer?: Conversation, allowNewChat = true): boolean {
		if (this.convs.has(this.activeId)) return true;
		const lost = this.activeId;
		const plan = planForLostActive({
			activeOpen: false,
			preferId: prefer?.id,
			cwd: this.cwd,
			// = ClientSession.openConversations() (convs IS the shared table), read through `this` so a
			// unit test can hand in its own table.
			open: [...this.convs.values()].map((c) => ({
				id: c.id,
				cwd: c.cwd,
				lastActiveAt: c.lastActiveAt,
				isSubagent: c.isSubagent,
			})),
			hasSocket: this.sinkCount() > 0,
		});
		if (plan.kind === "move") {
			const target = this.convs.get(plan.to);
			if (target) {
				console.warn(
					`[crash-guard] window ${this.clientId}: its chat ${lost} was closed (${reason}); moved it to ${target.id}`,
				);
				this.activeId = target.id;
				this.markRecentSeen(target);
				// What a switch refreshes: the running list, the terminals, the goal bar, the command list.
				this.webUi.refresh();
				this.emitConversations();
				this.goalSvc.emitGoalStatus();
				this.pushTerminals();
				void this.pushSlashCommands().catch((err: unknown) => {
					console.error(`[crash-guard] window ${this.clientId}: command list refresh failed:\n${describeError(err)}`);
				});
				return true;
			}
		}
		if (plan.kind === "new_chat" && allowNewChat) {
			if (!this.recoveryChat) {
				console.warn(
					`[crash-guard] window ${this.clientId}: its chat ${lost} was closed (${reason}); no open chat to move it to, opening a new one`,
				);
			}
			void this.openRecoveryChat();
			return false;
		}
		if (this.lostActiveLogged !== lost) {
			this.lostActiveLogged = lost;
			console.warn(
				`[crash-guard] window ${this.clientId}: its chat ${lost} was closed (${reason}); no open chat to move it to yet, it gets one when it reconnects`,
			);
		}
		return false;
	}

	/** crash-guard: the lost chat already logged as "waiting" (one line per lost chat, not per snapshot). */
	private lostActiveLogged: string | null = null;

	/** crash-guard: open a new blank chat for this window (its chat was closed and none is open). */
	private openRecoveryChat(): Promise<boolean> {
		if (this.recoveryChat) return this.recoveryChat;
		this.recoveryChat = this.newChat()
			.catch((err: unknown) => {
				console.error(`[crash-guard] window ${this.clientId}: opening a new chat failed:\n${describeError(err)}`);
				return false;
			})
			.finally(() => {
				this.recoveryChat = null;
			});
		return this.recoveryChat;
	}

	/** crash-guard: make sure this window has an open active chat before a socket attaches to it
	 *  (a reconnecting window whose chat was closed while it was away). */
	async ensureActiveConversation(reason: string): Promise<boolean> {
		if (this.recoverLostActive(reason, undefined, false)) return true;
		return await this.openRecoveryChat();
	}

	/** reload-adopt：接管共享表里已经开着的那条（只在 attachSink **之前**调）。
	 *
	 *  不走 switchConversation：那条路径会 emit 一堆东西（含一条客户端从没请求过的
	 *  `switch_done`），而此刻连 sink 都还没挂上 —— 首帧快照自然带着 activeId，
	 *  什么都不用发。位置调整仍照 displace → activeId → 回收的旧顺序。 */
	adoptConversation(id: string): boolean {
		const target = this.convs.get(id);
		if (!target || id === this.activeId) return false;
		// 刚建的空白对话被挤下去后直接回收，否则每次刷新都多一条空对话。
		// （runtime.dispose() 只拆 session，不动 services.modelRuntime —— sharedModelRuntime
		//   就是从它那里播的种，活得下来。）
		const displaced = this.displaceActive();
		this.activeId = id;
		this.markRecentSeen(target);
		if (displaced) this.removeConversation(displaced.id);
		target.promptedSinceActive = false;
		target.lastActiveAt = Date.now();
		return true;
	}

	/** have：switch-cache，客户端缓存里目标对话的窗口。切过去之后的那份整份快照对得上就只带新增的部分。 */
	async switchConversation(id: string, have?: CachedWindow): Promise<void> {
		this.switchHave = have ?? null;
		try {
			await this.switchConversationNow(id);
		} finally {
			this.switchHave = null;
		}
	}

	private async switchConversationNow(id: string): Promise<void> {
		if (id === this.activeId) return;
		if (!this.convs.has(id)) {
			// 客户端点的那一行在它点下去之前刚好被释放/移除了（列表推送有延迟）。
			// 以前这里静默返回，前端什么都看不到；现在它在等回执，得告诉它为什么没切成。
			this.emitSwitchFailed(
				{ kind: "conversation", id },
				"That conversation is no longer open (it may have just been closed). Reopen it from history.",
				"That conversation is no longer open (it may have just been closed). Reopen it from history.",
			);
			return;
		}
		const displaced = this.displaceActive();
		this.activeId = id;
		// 看一眼就算看过了：绿灯灭掉（行本身永远留在「最近对话」里）。
		this.markRecentSeen(this.convs.get(id));
		const newCwd = this.conv.cwd;
		// A listed conversation may belong to ANOTHER project (cross-project
		// running list). Switching to it must also switch the active workspace
		// — otherwise the file tree / session history / recent-projects order
		// would keep showing the OLD project while the chat shows the new one.
		// chat-cwd-pin：默认不跟随（见 chatFollowsWorkspace）—— 对话仍在它自己的
		// cwd 里跑，只是文件树/最近项目/新建对话的落点不再被来回抽。
		const cwdChanged = newCwd !== this.cwd && chatFollowsWorkspace();
		if (displaced) this.removeConversation(displaced.id);
		this.conv.promptedSinceActive = false;
		this.conv.lastActiveAt = Date.now();
		this.webUi.refresh();
		this.emitConversations();
		this.goalSvc.emitGoalStatus();
		this.pushTerminals();
		// The switched-to conversation has its own runtime (own resource cache).
		void this.pushSlashCommands();
		if (cwdChanged) {
			this.cwd = newCwd;
			// 模型/key 恢复不挡快照：后台做，带代际 guard（用户又切走就跳过），
			// 做完补一次 flush 刷新模型栏。
			{
				const convId = id;
				void (async () => {
					try {
						await this.restoreProjectProviderKeysForCwd(newCwd);
						if (this.disposed || this.activeId !== convId || this.cwd !== newCwd) return;
						await this.restoreProjectModelForCwd(newCwd);
						if (this.disposed || this.activeId !== convId || this.cwd !== newCwd) return;
						this.flushSnapshot();
					} catch {
						/* 静默：恢复失败保持会话默认 */
					}
				})();
			}
			// Mirror set_cwd's project-switch side-effects so the whole UI follows
			// the new workspace, not just the chat pane.
			this.applyCwdSideEffects(newCwd);
		}
		// 当前打开对话变了 → 插件重拉（轨迹视图切会话后即刷新，不等轮询）。
		this.notifyConversationChanged();
		this.flushSnapshot();
		this.emitSwitchDone({ kind: "conversation", id });
		// switch-loading（同步 v0.96.1）：设置放在最后发。上游 v0.96 在打开对话时推一份 settings_state，
		// 里面 toolsSchema 等只读预览在真实环境有 ~350 KB。它排在快照前面时，socket 缓冲一下子超过
		// 背压下限（SNAPSHOT_BACKPRESSURE_MIN_BYTES = 256 KB），紧跟着的快照被丢掉，250ms 后才补成一份
		// delta（客户端还得靠 rev 缺口 get_state 自愈），switch_done 就跑到了内容前面。
		this.pushSettings();
	}

	/** 左栏「运行的对话」的展示口径（issue #140）。
	 *
	 *  老口径只有 listed：新对话要等「被换到后台且仍在跑」才入列 —— 用户正在聊的
	 *  那条反而不在列表里（只有它一条时，左栏连「运行的对话」标题都不渲染，观感
	 *  像是对话丢了）。新口径把「当前对话 + 已经有内容」也算进来：有消息的对话
	 *  （或已被首条提示词命名 —— 命名与首条消息是同一时刻，见 prompt() 里的
	 *  rename 块）立刻出现在列表里；空白新对话仍然不入列（防连点「新建对话」
	 *  堆出一排空条目）。
	 *
	 *  只影响「列表里推什么」：listed 本身的语义、以及 displaceActive /
	 *  shouldRetainActive / MAX_OPEN_CONVERSATIONS 那套「什么算运行中」的规则
	 *  完全不变（换走时该释放的仍然释放，不会被这次展示口径改动永久钉在列表里）。
	 *  Display-only: retention and disposal rules are deliberately untouched. */
	private shownInRunningList(conv: Conversation): boolean {
		if (conv.listed) return true;
		if (conv.id !== this.activeId) return false;
		// 首条提示词给对话命名 = 用户真的开始聊了（此刻消息可能还没落进会话统计）。
		if (!isUntitledTitle(conv.title)) return true;
		try {
			return messageCountOf(conv.session) > 0;
		} catch {
			// 会话替换中 —— 先不列，下一次 emit 会补上
			return false;
		}
	}

	/** Push every running conversation across ALL projects to the client. The
	 *  running-conversation list is global so a background run from another
	 *  workspace stays visible; clicking one switches both the conversation and
	 *  its project (see switchConversation). The client groups the list by cwd.
	 *  推什么见 shownInRunningList（listed + 当前对话有内容时）。 */
	private emitConversations(): void {
		const conversations: ConversationSummary[] = [];
		const waiting = new Set(this.stateStore.getRecentWaiting().map((p) => resolve(p)));
		/** 活着的行占用的转录路径 —— 下面拼接历史行时用它去重。 */
		const livePaths = new Set<string>();
		/** 转录最后活动时间（排序用，见 ConversationSummary.sortAt）。 */
		const modifiedByPath = new Map<string, number>(this.recentSessions.map((s) => [resolve(s.path), s.modified]));
		// Active parents are normally absent from Running. Keep them visible while
		// listed subagents hang under them, so both rows remain clickable.
		const visibleParents = new Set(
			[...this.convs.values()]
				.filter((conv) => conv.listed)
				.map((conv) => conv.parentId)
				.filter(Boolean),
		);
		for (const conv of this.convs.values()) {
			if (!this.shownInRunningList(conv) && !visibleParents.has(conv.id)) continue;
			let messageCount = 0;
			let isStreaming = false;
			try {
				// list-freeze: this ran for every loaded chat in every window on each running change; the
				// full stats took seconds per big chat and froze the server (pages reconnected).
				messageCount = messageCountOf(conv.session);
				isStreaming = conv.session.isStreaming;
			} catch {
				// session being replaced — report defaults
			}
			const sessionPath = conv.session.sessionFile;
			if (sessionPath) livePaths.add(resolve(sessionPath));
			conversations.push({
				id: conv.id,
				title: conv.title,
				cwd: conv.cwd,
				messageCount,
				isStreaming,
				isSubagent: !!conv.isSubagent,
				...(conv.isEphemeral ? { isEphemeral: true as const } : {}),
				// 落盘会话才有文件（inMemory 子代理缺省）：右键复制路径 / AI 按 path 读历史时用。
				...(() => {
					try {
						const f = conv.session.sessionFile;
						return f ? { sessionFile: f } : {};
					} catch {
						return {};
					}
				})(),
				// 子代理带 error 标记：左栏红点提示（普通对话不参与）。
				...(conv.isSubagent ? this.subagentRunOutcome(conv) : {}),
				// 等答复的问卷：左栏「?」角标（主对话/子代理各自挂名下，切过去即可回答）。
				...(() => {
					const pq = this.getPendingQuestionForConv(conv.id);
					return pq ? { hasQuestion: true as const, questionId: pq.id, questionTitle: pq.title } : {};
				})(),
				// per-chat-dialogs：扩展弹窗在等你 → 左栏同样挂「?」。
				...(conv.dialogs.current ? { dialogId: conv.dialogs.current.id } : {}),
				// tldr-sidebar：最新一行还没折叠的 TL;DR，左栏显示在标题下面代替「N 条消息」。
				// 用 TL;DR tab 的同一份缓存（会话树没动就不重扫）；只有加载着的对话才有，历史行不读文件。
				...(() => {
					const tldr = latestUnseenTldr(this.tldrOf(conv));
					return tldr ? { tldr } : {};
				})(),
				// identities: the chat's identity label (its branch; cached per leaf).
				...(() => {
					const identity = this.identityOf(conv);
					return identity ? { identity } : {};
				})(),
				parentId: conv.parentId,
				...(conv.forkFrom ? { forkFrom: conv.forkFrom } : {}),
				sessionPath,
				live: true,
				// 稳定排序键：转录的最后活动时间；还没落盘/还没进列表缓存时用创建时间
				// （而不是 lastActiveAt：那个一点开就变，行会在鼠标下面跳走）。
				sortAt: (sessionPath ? modifiedByPath.get(resolve(sessionPath)) : undefined) ?? conv.createdAt,
				// flat-recent-chats：左栏按创建时间排（不变量，永不重排）。
				// 必须是**转录**的创建时间，不是运行时的：conv.createdAt 是点开它那一刻
				// 才盖的戳，用它的话一条上周的对话一点开就变成「最新」窜到顶上 ——
				// 恰好就是要消灭的那种移动。只有还没落盘的全新对话才退回运行时创建时间。
				createdAt: (sessionPath ? sessionCreatedAt(sessionPath) : undefined) ?? conv.createdAt,
				// 正在跑的行用黄灯，不叠绿灯；当前对话就在眼前，也不算「等你」。
				waiting: !isStreaming && conv.id !== this.activeId && !!sessionPath && waiting.has(resolve(sessionPath)),
			});
		}
		// issue #145：流式集合签名变化 → 通知其他客户端重推（左栏「另一处正在运行」近实时）。
		// 签名含等问卷态（问卷挂起/解决不改变流式集合，不带它已打开的别处页面永远看不到 `?`）。
		// elsewhere 口径含已结束的空闲行：签名同样覆盖它们（流式位 + 等问卷位），
		// 否则对方跑完（streaming→idle）或空闲行出现/消失时这边收不到重推。
		try {
			const sig = JSON.stringify(
				[...this.convs.values()]
					.filter((c) => this.conversationStreaming(c) || (!c.isSubagent && this.shownInRunningList(c)))
					.map((c) => `${c.id}:${this.conversationStreaming(c) ? 1 : 0}:${this.isWaitingOnUser(c.id) ? 1 : 0}`)
					.sort(),
			);
			if (sig !== this.lastRunningSig) {
				this.lastRunningSig = sig;
				this.onRunningChanged?.();
			}
		} catch {
			// 会话替换中——跳过本轮签名比较
		}
		const elsewhere = this.listExternalRunning?.() ?? [];
		// recent-chats：活着的行之后拼上磁盘上的常驻历史行。
		for (const recent of this.recentHistoryRows(livePaths, waiting)) conversations.push(recent);
		// queue-grouping: an open task's chat goes under the queue chat it came from when both are listed. The
		// links come from the open chats' cached queues (refreshQueueHomes); here they're only looked up.
		applyQueueHomes(conversations, ClientSession.knownQueueHomes());
		this.emit({
			type: "conversations",
			conversations,
			activeId: this.activeId,
			// 为空时缺省（老快照字节一致）
			...(elsewhere.length > 0 ? { elsewhere } : {}),
		});
	}

	/** 「最近对话」里**运行时已经释放**的那些行（recent-chats 补丁）。
	 *
	 *  老行为：一条对话空闲后被换到后台就从左栏消失了 —— 想找回来只能去下面的
	 *  History 里翻。现在列表由磁盘上的转录补齐：最近 RECENT_CHAT_LIMIT 条对话
	 *  常驻左栏（`live: false`），点开走 switch_session，✕ 只在这一列里移出
	 *  （tombstone 记在 client-state，转录一个字都不动，History 照样能找到）。
	 *
	 *  数据来自 pushSessions() 已经解析并推给客户端的那份列表（3 秒缓存），所以
	 *  这里不会额外扫盘；客户端还没请求过会话列表时，这一列暂时只有活着的行。 */
	private recentHistoryRows(livePaths: Set<string>, waiting: Set<string>): ConversationSummary[] {
		const removed = new Set(this.stateStore.getRecentRemoved().map((p) => resolve(p)));
		const rows: ConversationSummary[] = [];
		const limit = recentChatLimit();
		for (const s of this.recentSessions) {
			if (rows.length >= limit) break;
			const abs = resolve(s.path);
			if (livePaths.has(abs) || removed.has(abs)) continue;
			rows.push({
				// 合成 id：从不回传给服务端（这些行只能 switch_session /
				// remove_recent_chat），只用作 React key 与「非活动行」判定。
				id: `recent:${s.path}`,
				title: s.name || s.firstMessage || DEFAULT_CONV_TITLE,
				cwd: s.cwd ?? this.cwd,
				messageCount: s.messageCount,
				isStreaming: false,
				isSubagent: false,
				sessionPath: s.path,
				live: false,
				waiting: waiting.has(abs),
				sortAt: s.modified,
				// 磁盘行的创建时间：转录文件名的 ISO 前缀就是它（比 mtime 可靠 —— mtime
				// 会因为继续聊而变，而文件名不会）；解不出来才退回 mtime。
				createdAt: sessionCreatedAt(s.path) ?? s.modified,
				// identities: worked out with the history list (pushSessions -> attachIdentities).
				...(s.identity ? { identity: s.identity } : {}),
			});
		}
		return rows;
	}

	/** 一轮跑完了：没在看这条对话的话给它点上绿灯（「轮到你了」）。 */
	private markRecentWaiting(conv: Conversation): void {
		const path = conv.session.sessionFile;
		if (!path) return;
		if (conv.id === this.activeId) return;
		if (this.stateStore.setRecentWaiting(resolve(path), true)) this.emitConversations();
	}

	/** 用户打开/继续了这条对话 —— 绿灯灭掉，并撤销它的「移出最近」墓碑。 */
	private markRecentSeen(conv: Conversation | undefined): void {
		// queue-done-hidden: the queue opening (or moving through) chats isn't the user looking at them: a
		// finished task's chat stays out of Recent chats, and a green light stays on.
		if (this.clientId === QUEUE_TASKS_CLIENT_ID || this.clientId === QUEUE_HOME_CLIENT_ID) return;
		const path = conv?.session.sessionFile;
		if (!path) return;
		const abs = resolve(path);
		this.stateStore.restoreRecent(abs);
		this.stateStore.setRecentWaiting(abs, false);
	}

	/** 左栏「最近对话」✕：只从这一列移出（转录保留，History 里还在）。 */
	async removeRecentChat(path: string): Promise<void> {
		this.stateStore.removeRecent(resolve(path));
		this.emitConversations();
	}

	/** List persisted sessions for this client, newest first. */
	/** issue #145：上次 emit 时本实例流式对话 id 集合签名（含等问卷态，见 emitConversations）。
	 *  变化时经 onRunningChanged 让其他客户端重推 conversations（elsewhere 近实时）；
	 *  签名相等即停，天然防 ping-pong 循环。 */
	private lastRunningSig = "";

	/** The client asked for the session list at least once (lazy loading) —
	 *  background refreshes only re-push when this is true, so a mobile
	 *  client that never opened the panel never pays the disk scan. */
	private sessionsRequested = false;

	/**
	 * Last parsed session list for this cwd, cached briefly so repeated
	 * global-search keystrokes don't re-parse every transcript file on each
	 * request (a project can hold 100+ sessions of several MB each).
	 * pushSessions() and searchSessions() share this fridge — opening the
	 * panel warms it, then every keystroke inside the TTL is free.
	 */
	/** 最近一次推给客户端的会话列表（newest first）——「最近对话」常驻行的数据源，
	 *  由 pushSessions() 刷新。客户端没请求过会话列表时为空。 */
	private recentSessions: SessionSummary[] = [];

	private sessionInfosCache: { cwd: string; infos: SessionInfo[]; at: number } | null = null;
	private static readonly SESSION_INFO_CACHE_TTL = 3000;

	/** 最近项目列表缓存：pushProjects 的全量扫盘（SessionManager.listAll +
	 *  existsSync 逐个校验）昂贵，切项目/新对话/跨客户端通知时频繁触发 ——
	 *  TTL 内直接复用并把当前 cwd 合并进去，不反复扫盘。 */
	private projectsCache: { at: number; projects: ProjectSummary[] } | null = null;
	private static readonly PROJECTS_CACHE_TTL = 15_000;
	private projectsInFlight: Promise<ProjectSummary[] | null> | null = null;

	private async loadSessionInfos(): Promise<SessionInfo[]> {
		const now = Date.now();
		// 全局范围的缓存键固定为 `"*"`：列表与 cwd 无关，切项目不应该把全部
		// 转录重新解析一遍。
		const scopeKey = historyScope() === "all" ? "*" : this.cwd;
		const c = this.sessionInfosCache;
		if (c && c.cwd === scopeKey && now - c.at < ClientSession.SESSION_INFO_CACHE_TTL) {
			return c.infos;
		}
		const infos =
			scopeKey === "*"
				? await SessionManager.listAll(piSessionsRoot())
				: await SessionManager.list(this.cwd, piSessionsRoot());
		this.sessionInfosCache = { cwd: scopeKey, infos, at: now };
		return infos;
	}

	/** Session files on disk changed (delete / new-transcript) — drop the brief
	 *  TTL fridge so the NEXT listing re-reads the directory instead of serving
	 *  the pre-mutation snapshot (delete-then-refresh commonly runs inside the
	 *  window, which would re-push the just-removed session). */
	private invalidateSessionInfos(): void {
		this.sessionInfosCache = null;
	}

	/** Push the persisted session list to the client (client-requested). */
	async refreshSessions(): Promise<void> {
		this.sessionsRequested = true;
		await this.pushSessions();
	}

	/** 切项目时的会话列表刷新：历史面板没打开过就不扫盘（只清缓存），打开过
	 *  才重推 —— 首访切项目的转录解析不在关键路径上。 */
	private refreshSessionsOnSwitch(): void {
		this.invalidateSessionInfos();
		if (this.sessionsRequested) void this.refreshSessions();
	}

	private async pushSessions(): Promise<void> {
		if (!this.sessionsRequested) return;
		try {
			// Sessions live in the SDK default per-project dir
			// (<agentDir>/sessions/--<cwd>--/), the same files the pi CLI/TUI use.
			// loadSessionInfos() 按 historyScope() 要么覆盖**全部**文件夹（"all"），
			// 要么只管当前文件夹（"project"）；`cwd` 让左栏能给「不属于当前工作
			// 目录」的对话标上文件夹徽章。
			const infos = await this.loadSessionInfos();

			// 隐藏「被 fork 掉的父会话」，历史列表只保留每条 fork 链最新的链尾会话
			// （全文搜索 searchSessions 保留全部会话，不受此影响）。
			const normSessionPath = (p: string) => String(p).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
			const forkedParentPaths = new Set<string>();
			for (const info of infos) {
				if (typeof info.parentSessionPath === "string" && info.parentSessionPath) {
					forkedParentPaths.add(normSessionPath(info.parentSessionPath));
				}
			}
			const visibleInfos =
				forkedParentPaths.size > 0
					? (() => {
							const kept = infos.filter((info) => !forkedParentPaths.has(normSessionPath(info.path)));
							return kept.length > 0 ? kept : infos;
						})()
					: infos;

			const sessions = new Map<string, SessionSummary>();
			for (const s of visibleInfos) {
				sessions.set(s.path, {
					path: s.path,
					name: s.name,
					firstMessage: s.firstMessage,
					messageCount: s.messageCount,
					modified: s.modified.getTime(),
					source: "web",
					cwd: s.cwd,
				});
			}
			const sorted = [...sessions.values()].sort((a, b) => b.modified - a.modified).slice(0, 200); // newest first — the panel shows recent history
			// identities: each row's identity label, before the list goes out (or right after it, when the
			// first read of big transcripts takes a while; a newer list wins).
			const gen = ++this.sessionsPushGen;
			await this.attachIdentities(sorted, () => {
				if (gen !== this.sessionsPushGen || this.disposed) return;
				this.emit({ type: "sessions", sessions: sorted });
				this.emitConversations();
			});
			this.emit({ type: "sessions", sessions: sorted });
			// 「最近对话」常驻行的来源（recent-chats 补丁）：复用这份已解析好的
			// 列表，emitConversations() 同步取用，不再单独扫盘。
			// queue-done-hidden: the whole list (at most 200), not a few times the limit: finished task
			// chats are taken out of Recent chats, and must not leave it short of rows.
			this.recentSessions = sorted;
			this.emitConversations();
		} catch {
			this.emit({ type: "sessions", sessions: [] });
		}
	}

	/** identities: bumped by every pushSessions, so a late identity pass never resends an older list. */
	private sessionsPushGen = 0;

	/** identities: the History rows' identity labels (server/identities.ts: home chat, else the last
	 *  `identity` entry in the file, else a past home chat). Files are read incrementally and shared by all
	 *  windows, but the very first pass over big transcripts can take a moment: wait at most 400 ms, then
	 *  let the list go without the labels and call `resend` once they're known. */
	private async attachIdentities(rows: SessionSummary[], resend: () => void): Promise<void> {
		const { identities } = identityRegistry();
		if (rows.length === 0 || identities.length === 0) return;
		const apply = (ids: Map<string, string | null>): boolean => {
			let changed = false;
			for (const row of rows) {
				const identity = uiChatIdentity(ids.get(row.path), identities);
				if (identity?.id !== row.identity?.id || identity?.title !== row.identity?.title) changed = true;
				if (identity) row.identity = identity;
				else delete row.identity;
			}
			return changed;
		};
		const scan = fileIdentityIds(
			rows.map((r) => r.path),
			identities,
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const ids = await Promise.race([
			scan,
			new Promise<null>((res) => {
				timer = setTimeout(() => res(null), 400);
			}),
		]).catch(() => null);
		if (timer) clearTimeout(timer);
		if (ids) {
			apply(ids);
			return;
		}
		void scan.then((late) => apply(late) && resend()).catch(() => {});
	}

	/** Remove an entry from the client's recent-project list (UI state only). */
	async removeProject(path: string): Promise<void> {
		this.stateStore.removeProject(this.clientId, path);
		this.invalidateProjectsCache();
		await this.pushProjects();
	}

	/** Permanently delete a persisted session transcript file (history list ✕).
	 *
	 * Deleting the ACTIVE conversation's own transcript is allowed: the session
	 * first switches away to the next-latest persisted chat (or a fresh blank
	 * chat when no other history exists). If the displacement could not release
	 * the file (streaming / open terminals / pending wake subscription /
	 * conversation cap), the deletion is aborted with a notice instead of
	 * yanking the file out of a live runtime. Background conversations still
	 * block deletion outright.
	 */
	async deleteSession(path: string): Promise<void> {
		try {
			const abs = resolve(path);
			if (!isInsideSessionsDir(this.agentDir, abs)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "Only transcripts inside the session directory can be deleted",
					textEn: "Only transcripts inside the session directory can be deleted",
				});
				return;
			}
			// A live conversation may hold the target transcript. A BACKGROUND
			// conversation must still block deletion outright, but when the ACTIVE
			// conversation holds it the request can be satisfied by switching away
			// first (next-latest history chat, or a fresh blank one) and letting
			// the displacement drop the old runtime.
			const holdsTarget = (conv: Conversation): boolean => {
				const file = conv.session.sessionFile;
				return file !== undefined && resolve(file) === abs;
			};
			const holder = [...this.convs.values()].find(holdsTarget);
			if (holder && holder.id !== this.activeId) {
				this.emit({
					type: "notice",
					level: "warning",
					text: "This conversation is still running — stop or close it before deleting",
					textEn: "This conversation is still running — stop or close it before deleting",
				});
				return;
			}
			if (holder) {
				// 故意只看**当前文件夹**（即使 History 是全局的）：删当前对话不应该
				// 把人踢到别的项目去，而是回退到本文件夹的上一个对话。newest first。
				const infos = await SessionManager.list(this.cwd, piSessionsRoot());
				const next = infos
					.filter((s) => resolve(s.path) !== abs)
					.sort((a, b) => b.modified.getTime() - a.modified.getTime())[0];
				if (next) await this.switchSession(next.path);
				else await this.newChat();
				// displaceActive() may have RETAINED the old conversation as a
				// background run (streaming, open terminals, pending wake
				// subscription, conversation cap) — in every such case the file is
				// still held, so abort instead of yanking it from a live runtime.
				// Only a conversation that is genuinely still running in the
				// background (streaming / listed) keeps the "wait for it" notice;
				// a retained-but-idle hold means the switch itself failed (cap,
				// quiesce, runtime creation) — say that instead.
				const stillHeld = [...this.convs.values()].find(holdsTarget);
				if (stillHeld) {
					let stillRunning = stillHeld.listed;
					try {
						stillRunning = stillHeld.session.isStreaming || stillRunning;
					} catch {
						// session being replaced — keep the listed-flag fallback
					}
					this.emit({
						type: "notice",
						level: "warning",
						text: stillRunning
							? "Conversation is still running in the background; delete aborted — wait for it to finish and retry"
							: "Could not switch to another conversation; delete cancelled",
						textEn: stillRunning
							? "Conversation is still running in the background; delete aborted — wait for it to finish and retry"
							: "Could not switch to another conversation; delete cancelled",
					});
					return;
				}
			}
			// #145 同款守卫：删之前查一遍其他客户端是否持有这份转录 ——
			// 对端 runtime 还开着时硬删等于把文件从活 writer 身下抽走（跑着时
			// 更是两支并发写）。被持有就拒绝删除；本客户端自己的持有已在上面处理。
			const otherOwner = this.findSessionOwner?.(abs);
			if (otherOwner) {
				this.emit({
					type: "notice",
					level: "warning",
					text: otherOwner.isStreaming
						? `This conversation is running in another window ("${otherOwner.title}"); delete aborted — stop or close it there first`
						: `This conversation is still open in another window ("${otherOwner.title}"); delete aborted — close it there first`,
					textEn: otherOwner.isStreaming
						? `This conversation is running in another window ("${otherOwner.title}"); delete aborted — stop or close it there first`
						: `This conversation is still open in another window ("${otherOwner.title}"); delete aborted — close it there first`,
				});
				return;
			}
			rmSync(abs, { force: true });
			// 转录删了，sidecar 再留着就是孤儿，一起清掉（不存在不报错）。
			removeTouchSidecar(abs);
			// 转录删了，未发送草稿再留着就是孤儿，一起清掉。
			try {
				this.drafts.pruneSessionFile(abs);
			} catch {
				// ignore
			}
			// Bust the brief session-info fridge: refreshSessions() below usually
			// lands inside its 3s TTL and would otherwise re-serve a listing that
			// still contains the deleted transcript.
			this.invalidateSessionInfos();
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to delete session: ${(err as Error).message}`,
				textEn: `Failed to delete session: ${(err as Error).message}`,
			});
		}
	}

	/** Rename a persisted session by appending a session_info entry — the same
	 *  mechanism pi's /name uses (SessionManager.appendSessionInfo). Works on
	 *  any transcript under the sessions root, live or not; no session switch. */
	async renameSession(path: string, name: string): Promise<void> {
		try {
			const trimmed = (name ?? "").trim();
			if (!trimmed) return;
			const abs = resolve(path);
			if (!isInsideSessionsDir(this.agentDir, abs)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "Only transcripts inside the session directory can be renamed",
					textEn: "Only transcripts inside the session directory can be renamed",
				});
				return;
			}
			const mgr = SessionManager.open(abs);
			mgr.appendSessionInfo(trimmed);
			this.setConversationTitleForFile(abs, trimmed);
			this.invalidateSessionInfos();
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to rename session: ${(err as Error).message}`,
				textEn: `Failed to rename session: ${(err as Error).message}`,
			});
		}
	}

	/** Rename a live conversation by id: retitle in memory AND persist a
	 *  session_info entry to its transcript so History matches immediately. */
	async renameConversation(id: string, name: string): Promise<void> {
		try {
			const trimmed = (name ?? "").trim();
			if (!trimmed) return;
			const conv = this.convs.get(id);
			if (!conv) return;
			conv.title = trimmed;
			try {
				const file = conv.session.sessionFile;
				if (file !== undefined) SessionManager.open(resolve(file)).appendSessionInfo(trimmed);
			} catch {
				// in-memory title still updated; transcript write is best-effort
			}
			this.emitConversations();
			this.invalidateSessionInfos();
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to rename conversation: ${(err as Error).message}`,
				textEn: `Failed to rename conversation: ${(err as Error).message}`,
			});
		}
	}

	/** Point every live conversation holding this transcript file at a new title. */
	private setConversationTitleForFile(abs: string, title: string): void {
		let changed = false;
		for (const conv of this.convs.values()) {
			const file = conv.session.sessionFile;
			if (file !== undefined && resolve(file) === abs) {
				conv.title = title;
				changed = true;
			}
		}
		if (changed) this.emitConversations();
	}

	/** Dismiss 口径的「已结束子代理」：非 streaming 且无保留态（存活终端/
	 *  审查/后台唤醒等），与 dismissFinishedSubagents 的候选口径一致。
	 *  issue #181：终端只看用户终端，残留 AI bash 不算（随移出一起释放）。 */
	private isDismissableFinishedSubagent(conv: Conversation): boolean {
		let streaming = true;
		try {
			streaming = conv.session.isStreaming;
		} catch {
			// 会话替换中——按运行中处理，绝不误删。
		}
		if (streaming) return false;
		return !shouldRetainActive({
			reviewing: conv.goal.reviewing,
			wizardRunning: conv.wizardRunning,
			streaming: false,
			// Dismiss 口径：只看“用过”的用户终端（AI bash 不钉住，见上）。
			openTerminals: conv.terminals.countUserBlockingLive(),
			listed: false,
			promptedSinceActive: false,
			hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
			hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
		});
	}

	/**
	 * 将内存会话（inMemory 子代理 / 临时对话）固化为普通持久化对话：
	 * 写入磁盘 .jsonl 会话文件，清除 isSubagent / isEphemeral 标记，使它进入历史会话列表并长久保留。
	 */
	async persistConversation(id: string): Promise<void> {
		const conv = this.convs.get(id);
		if (!conv) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "This conversation does not exist or is already closed",
				textEn: "This conversation does not exist or is already closed",
			});
			return;
		}
		const sm = (conv.session as unknown as { sessionManager?: SessionManager }).sessionManager;
		if (!conv.isSubagent && !conv.isEphemeral && sm?.isPersisted?.()) {
			this.emit({
				type: "notice",
				level: "info",
				text: `Conversation "${conv.title}" is already persistent`,
				textEn: `Conversation "${conv.title}" is already persistent`,
			});
			return;
		}
		// 固化对象是临时对话时文案换一套（用户看到的是「临时对话」而非「子代理」）。
		const wasEphemeral = !!conv.isEphemeral;
		try {
			const cwd = conv.cwd || this.cwd;
			const sampleSm = SessionManager.create(cwd);
			const sessionDir = sampleSm.getSessionDir();
			if (!existsSync(sessionDir)) {
				mkdirSync(sessionDir, { recursive: true });
			}
			const timestamp = new Date().toISOString();
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			const sessionId = sm?.getSessionId?.() || randomUUID();
			const sessionFile = join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);

			// 获取所有已存在的 entries 并写盘
			const entries = (sm as unknown as { fileEntries?: unknown[] })?.fileEntries ?? [];
			let entriesToWrite = entries;
			if (!entriesToWrite.some((e: unknown) => (e as { type?: string })?.type === "session")) {
				const header = {
					type: "session",
					version: 3,
					id: sessionId,
					timestamp,
					cwd,
				};
				entriesToWrite = [header, ...entriesToWrite];
			}
			writeFileSync(sessionFile, entriesToWrite.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

			// 切换 SessionManager 内部状态，后续消息自动追加写盘
			if (sm) {
				sm.setSessionFile(sessionFile);
				(sm as unknown as { sessionDir: string }).sessionDir = sessionDir;
				(sm as unknown as { persist: boolean }).persist = true;
				(sm as unknown as { flushed: boolean }).flushed = true;
			}
			conv.isSubagent = false;
			conv.isEphemeral = false;
			if (wasEphemeral) {
				const ephemeralDir = join(this.agentDir, "ephemeral-sessions", conv.id);
				try {
					rmSync(ephemeralDir, { recursive: true, force: true });
				} catch {}
			}

			this.emitConversations();
			await this.pushProjects();
			this.flushSnapshot();

			this.emit({
				type: "notice",
				level: "info",
				text: wasEphemeral
					? `Saved ephemeral conversation "${conv.title}" as a regular conversation in history`
					: `Solidified subagent "${conv.title}" into a regular conversation saved to history`,
				textEn: wasEphemeral
					? `Saved ephemeral conversation "${conv.title}" as a regular conversation in history`
					: `Solidified subagent "${conv.title}" into a regular conversation saved to history`,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to persist conversation: ${msg}`,
				textEn: `Failed to persist conversation: ${msg}`,
			});
		}
	}

	/** Dismiss a running conversation from the left-panel list without deleting its
	 *  transcript file. Only idle (non-streaming) conversations that are not
	 *  retained by terminal/wake/review state can be dismissed. The session stays
	 *  in history and can be reopened.
	 *
	 *  withFinishedSubagents=true 时连带关闭该对话下已结束的子代理（传递后代，
	 *  与 dismissFinishedSubagents 同口径；active 的子代理跳过）——只关不运行的：
	 *  运行中的后代不受影响；关完后若还有后代剩下（运行中/保留中/active），父级
	 *  暂留并提示。只有运行中的后代（无可关的）时拒绝。不传 + 存在已结束子代理
	 *  后代时拒绝并提示（由前端确认框先问用户，避免静默 orphan）。 */
	async dismissConversation(id: string, withFinishedSubagents?: boolean, force?: boolean): Promise<void> {
		const conv = this.convs.get(id);
		if (!conv) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "This conversation does not exist or is already closed",
				textEn: "This conversation does not exist or is already closed",
			});
			return;
		}
		if (!this.shownInRunningList(conv)) {
			// Not in list anyway — nothing to do. 展示口径见 shownInRunningList
			// （当前对话有内容时也在列表里，对它的 ✕ 必须真的移出，不能静默 no-op）。
			this.emitConversations();
			return;
		}
		// Streaming / retained conversations refuse dismissal — mirrors displaceActive retention.
		// 运行中的子代理后代也阻止关闭（绝不连带 abort）；已结束的子代理后代：
		// withFinishedSubagents 才连带，否则拒绝并提示（前端确认框先问用户）。
		const isStreaming = (c: Conversation): boolean => {
			try {
				return c.session.isStreaming;
			} catch {
				return true;
			}
		};
		const descendants = collectSubagentDescendantIds(
			[...this.convs.values()].map((c) => ({ id: c.id, parentId: c.parentId, isSubagent: c.isSubagent })),
			id,
		)
			.map((did) => this.convs.get(did))
			.filter((c): c is Conversation => !!c);
		if (force) {
			await this.forceDismissConversation(conv, descendants, isStreaming);
			return;
		}
		const runningKids = descendants.filter((c) => isStreaming(c));
		// 父对话自身的保留态（流式/终端/审查/后台唤醒）——子代理后代另算。
		const selfStreaming = (() => {
			try {
				return conv.session.isStreaming;
			} catch {
				return true;
			}
		})();
		if (selfStreaming) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `Conversation "${conv.title}" is still running — wait for it to finish or press Stop before removing`,
				textEn: `Conversation "${conv.title}" is still running — wait for it to finish or press Stop before removing`,
			});
			return;
		}
		// issue #181：只看用户终端——AI bash（agentBash）是 agent 的内部执行记录，
		// 随对话一起释放（removeConversation 里 killAll），不得阻断移出；否则残留的
		// ai-bash-98/99 会把会话永久钉在列表里。用户亲手开且用过的终端仍拦截。
		if (conv.terminals.countUserBlockingLive() > 0) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `Conversation "${conv.title}" still has open terminals — close them before removing`,
				textEn: `Conversation "${conv.title}" still has open terminals — close them before removing`,
			});
			return;
		}
		// 没动过的空 shell（点开终端 tab 自动建的那个）与 AI bash 不拦截：随对话一起释放
		// （removeConversation 里 killAll）。
		if (
			shouldRetainActive({
				reviewing: conv.goal.reviewing,
				wizardRunning: conv.wizardRunning,
				streaming: false,
				openTerminals: 0,
				listed: conv.listed,
				promptedSinceActive: conv.promptedSinceActive,
				hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
				hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
			})
		) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `Conversation "${conv.title}" cannot be removed right now (pending background task/review)`,
				textEn: `Conversation "${conv.title}" cannot be removed right now (pending background task/review)`,
			});
			return;
		}
		const finishedKids = descendants.filter(
			(c) => c.listed && c.id !== this.activeId && this.isDismissableFinishedSubagent(c),
		);
		if (runningKids.length > 0 && finishedKids.length === 0) {
			// 只有运行中的后代：连 flag 也变不出可关的，拒绝（绝不连带 abort）。
			this.emit({
				type: "notice",
				level: "warning",
				text: `Conversation "${conv.title}" still has ${runningKids.length} running subagent(s) — wait for them to finish or stop them before removing`,
				textEn: `Conversation "${conv.title}" still has ${runningKids.length} running subagent(s) — wait for them to finish or stop them before removing`,
			});
			return;
		}
		if (finishedKids.length > 0 && !withFinishedSubagents) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `Conversation "${conv.title}" still has ${finishedKids.length} finished subagent(s): confirm to dismiss them together, or clear the subagents first (right-click menu) to dismiss only the parent`,
				textEn: `Conversation "${conv.title}" still has ${finishedKids.length} finished subagent(s): confirm to dismiss them together, or clear the subagents first (right-click menu) to dismiss only the parent`,
			});
			return;
		}
		// 只关不运行的：运行中的后代绝不连带 abort；关完后若还有后代剩下
		// （运行中/保留中/active），父级暂留并提示。
		let removedKids = 0;
		for (const kid of finishedKids) {
			if (kid.id === this.activeId) continue;
			if (this.convs.get(kid.id) !== kid) continue;
			this.removeConversation(kid.id);
			removedKids++;
		}
		if (withFinishedSubagents && removedKids > 0) {
			const remaining = descendants.filter((c) => this.convs.get(c.id) === c);
			if (remaining.length > 0) {
				const stillRunning = remaining.filter((c) => isStreaming(c)).length;
				this.emit({
					type: "notice",
					level: "info",
					text: `Dismissed ${removedKids} finished subagent(s); ${remaining.length} subagent(s) remain${stillRunning > 0 ? ` (${stillRunning} running)` : ""}, keeping the parent`,
					textEn: `Dismissed ${removedKids} finished subagent(s); ${remaining.length} subagent(s) remain${stillRunning > 0 ? ` (${stillRunning} running)` : ""}, keeping the parent`,
				});
				this.emitConversations();
				this.flushSnapshot();
				return;
			}
		}
		// Dismissing the ACTIVE conversation: move active elsewhere first
		// (another listed conversation, else a fresh chat), then remove.
		if (id === this.activeId) {
			const vacated = await this.vacateActive(id);
			if (!vacated) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `Cannot dismiss the active conversation "${conv.title}" right now (no replacement chat available)`,
					textEn: `Cannot dismiss the active conversation "${conv.title}" right now (no replacement chat available)`,
				});
				this.emitConversations();
				this.flushSnapshot();
				return;
			}
		}
		// ✕ = 「从最近对话里移出」：运行时释放之外还要打墓碑，否则下一次推送它
		// 会以 live:false 的历史行原地重现（recent-chats 补丁）。转录不动，History 里还在。
		const dismissedPath = conv.session.sessionFile;
		this.removeConversation(id);
		if (dismissedPath) this.stateStore.removeRecent(resolve(dismissedPath));
		this.emitConversations();
		this.flushSnapshot();
	}
	/** Move the active marker away from id so that conversation can be removed.
	 *  Prefers another listed conversation; falls back to creating a fresh chat.
	 *  Returns true when id is no longer active. */
	private async vacateActive(id: string): Promise<boolean> {
		if (id !== this.activeId) return true;
		const other = [...this.convs.values()].find((c) => c.id !== id && c.listed);
		if (other) {
			await this.switchConversation(other.id);
		} else {
			await this.newChat();
		}
		return this.activeId !== id;
	}
	/** 强行关闭：中止自身运行（如在跑）与全部子代理后代（运行中的也停），
	 *  再整体移出；终端/审查/后台唤醒等保留态一并放行。active 的目标先让出
	 *  active（vacateActive），active 的后代跳过、让出后再补移。 */
	private async forceDismissConversation(
		conv: Conversation,
		descendants: Conversation[],
		isStreaming: (c: Conversation) => boolean,
	): Promise<void> {
		const title = conv.title;
		let stopped = 0;
		for (const d of descendants) {
			if (d.id === conv.id) continue;
			if (this.convs.get(d.id) !== d) continue;
			if (isStreaming(d)) {
				try {
					await this.subagentHost.stopSubagent(d.id);
					stopped++;
				} catch {
					// best effort — removal below disposes the runtime anyway.
				}
			}
		}
		let selfAborted = false;
		if (isStreaming(conv)) {
			selfAborted = true;
			await this.interruptRun(conv, "Force-closed");
		}
		let removedKids = 0;
		const deferred: Conversation[] = [];
		for (const d of descendants) {
			const cur = this.convs.get(d.id);
			if (!cur || cur.id === conv.id) continue;
			if (cur.id === this.activeId) {
				deferred.push(cur);
				continue;
			}
			this.removeConversation(cur.id);
			removedKids++;
		}
		if (conv.id === this.activeId) {
			const vacated = await this.vacateActive(conv.id);
			if (!vacated) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `Cannot force-dismiss conversation "${title}" right now (no replacement chat available)`,
					textEn: `Cannot force-dismiss conversation "${title}" right now (no replacement chat available)`,
				});
				this.emitConversations();
				this.flushSnapshot();
				return;
			}
		}
		for (const d of deferred) {
			if (this.convs.get(d.id) === d && d.id !== this.activeId) {
				this.removeConversation(d.id);
				removedKids++;
			}
		}
		if (this.convs.get(conv.id) === conv && conv.id !== this.activeId) {
			const dismissedPath = conv.session.sessionFile;
			this.removeConversation(conv.id);
			// 同 dismissConversation：强行关掉也要从「最近对话」里真的消失。
			if (dismissedPath) this.stateStore.removeRecent(resolve(dismissedPath));
		}
		this.emitConversations();
		this.flushSnapshot();
		const remaining = descendants.filter((c) => this.convs.get(c.id) === c).length;
		this.emit({
			type: "notice",
			level: "info",
			text: `Force-dismissed conversation "${title}"${removedKids > 0 ? ` (incl. ${removedKids} subagent(s))` : ""}${selfAborted ? ", its run was aborted" : ""}${stopped > 0 ? `, ${stopped} running subagent(s) stopped` : ""}${remaining > 0 ? `; ${remaining} subagent(s) remain (now active)` : ""}`,
			textEn: `Force-dismissed conversation "${title}"${removedKids > 0 ? ` (incl. ${removedKids} subagent(s))` : ""}${selfAborted ? ", its run was aborted" : ""}${stopped > 0 ? `, ${stopped} running subagent(s) stopped` : ""}${remaining > 0 ? `; ${remaining} subagent(s) remain (now active)` : ""}`,
		});
	}
	/** Bulk-dismiss finished subagents (left-panel right-click menu).
	 *
	 *  parentId omitted = every finished subagent in the running list;
	 *  given = the transitive subagent descendants of that conversation
	 *  (children, grandchildren, … — parentId chain followed recursively),
	 *  plus the conversation itself when IT is a finished subagent.
	 *  Finished = idle (not streaming, no retained terminal/review/wake
	 *  state). Running ones are skipped, never aborted. Children are removed
	 *  before parents so the "parent with live children refuses" guard in
	 *  dismissConversation never blocks the batch. The active conversation is
	 *  never removed. */
	async dismissFinishedSubagents(parentId?: string): Promise<void> {
		const root = parentId?.trim() ? parentId.trim() : undefined;
		if (root && !this.convs.has(root)) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "This conversation does not exist or is already closed",
				textEn: "This conversation does not exist or is already closed",
			});
			return;
		}
		// Collect the subtree: every conversation whose parentId chain leads to
		// root (or every subagent when root is omitted). Child-before-parent
		// order via depth so parents become dismissable as children leave.
		const depthOf = (id: string): number => {
			let d = 0;
			let cur = this.convs.get(id);
			const seen = new Set<string>([id]);
			while (cur?.parentId) {
				if (seen.has(cur.parentId)) break;
				seen.add(cur.parentId);
				d++;
				cur = this.convs.get(cur.parentId);
				if (!cur) break;
			}
			return d;
		};
		const inScope = (conv: Conversation): boolean => {
			if (!conv.isSubagent) return false;
			if (conv.id === this.activeId) return false;
			if (!conv.listed) return false;
			if (!root) return true;
			if (conv.id === root) return true;
			let cur: Conversation | undefined = conv;
			const seen = new Set<string>();
			while (cur?.parentId) {
				if (cur.parentId === root) return true;
				if (seen.has(cur.parentId)) return false;
				seen.add(cur.parentId);
				cur = this.convs.get(cur.parentId);
				if (!cur) return false;
			}
			return false;
		};
		const isStreaming = (conv: Conversation): boolean => {
			try {
				return conv.session.isStreaming;
			} catch {
				return true;
			}
		};
		const candidates = [...this.convs.values()]
			.filter(inScope)
			// Running first would be pointless — drop streaming/retained up front.
			.filter((conv) => !isStreaming(conv))
			.filter(
				(conv) =>
					!shouldRetainActive({
						reviewing: conv.goal.reviewing,
						wizardRunning: conv.wizardRunning,
						streaming: false,
						// Dismiss 口径：只看“用过”的用户终端（issue #181，AI bash 不钉住）。
						openTerminals: conv.terminals.countUserBlockingLive(),
						listed: false,
						promptedSinceActive: false,
						hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
						hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
					}),
			)
			.sort((a, b) => depthOf(b.id) - depthOf(a.id));
		if (candidates.length === 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: "No finished subagents to dismiss",
				textEn: "No finished subagents to dismiss",
			});
			return;
		}
		let removed = 0;
		let skippedRunning = 0;
		for (const conv of candidates) {
			const cur = this.convs.get(conv.id);
			if (!cur || cur.id === this.activeId) continue;
			if (isStreaming(cur)) {
				skippedRunning++;
				continue;
			}
			// Re-check live children: earlier removals in this same batch may
			// have cleared the guard; still-running children block the parent.
			const liveChild = [...this.convs.values()].some((child) => child.parentId === cur.id && isStreaming(child));
			if (liveChild) {
				skippedRunning++;
				continue;
			}
			this.removeConversation(cur.id);
			removed++;
		}
		this.emitConversations();
		this.flushSnapshot();
		if (removed > 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: `Dismissed ${removed} finished subagent(s)${skippedRunning > 0 ? ` (${skippedRunning} still running, skipped)` : ""}`,
				textEn: `Dismissed ${removed} finished subagent(s)${skippedRunning > 0 ? ` (${skippedRunning} still running, skipped)` : ""}`,
			});
		} else {
			this.emit({
				type: "notice",
				level: "info",
				text: "No finished subagents to dismiss (the rest are still running)",
				textEn: "No finished subagents to dismiss (the rest are still running)",
			});
		}
	}

	/** Open a persisted session as the active conversation (from listSessions).
	 *
	 * A persisted-session click must follow the same ownership rule as
	 * new_chat/switch_conversation: every open conversation keeps its own
	 * runtime. AgentSessionRuntime.switchSession() tears down (and aborts) the
	 * current runtime, which would otherwise stop a response merely because the
	 * user opened history while it was streaming.
	 */
	/** have：switch-cache，见 switchConversation。 */
	async switchSession(path: string, have?: CachedWindow): Promise<void> {
		this.switchHave = have ?? null;
		try {
			await this.switchSessionNow(path);
		} finally {
			this.switchHave = null;
		}
	}

	private async switchSessionNow(path: string): Promise<void> {
		// switch-loading：target 用客户端发来的原始 path（不是 resolve 后的），客户端才能对上。
		const target: SwitchTarget = { kind: "session", path };
		if (this.quiesceBlocked()) {
			this.emitSwitchFailed(
				target,
				"Server is draining (quiesce) and refused to open the session.",
				"Server is draining (quiesce) and refused to open the session.",
			);
			return;
		}
		let openedRuntime: AgentSessionRuntime | null = null;
		let openedTerminals: TerminalManager | null = null;
		try {
			const targetPath = resolve(path);
			if (!isInsideSessionsDir(this.agentDir, targetPath)) {
				// switch-loading：上游 5ca2e70 的越界拒绝原本只发 notice、不回执，客户端的「正在打开…」
				// 会一直等。和其它失败一样走回执（原因照旧；不是客户端在等的那次时它降级成 toast）。
				this.flushSnapshot();
				this.emitSwitchFailed(
					target,
					"Only transcripts inside the session directory can be opened",
					"Only transcripts inside the session directory can be opened",
				);
				return;
			}

			// A session may already be open in the running-conversation map. Reuse it
			// instead of creating a second writer for the same JSONL transcript.
			for (const conv of this.convs.values()) {
				const sessionFile = conv.session.sessionFile;
				if (sessionFile && resolve(sessionFile) === targetPath) {
					// 已经是当前对话时 switchConversation 不发快照；客户端照样在等回执，
					// 补一个快照再回执（先快照后回执的顺序不能反）。先记下「切之前是不是它」：
					// 切完之后 activeId 永远等于它，事后判断会把大会话白白序列化两遍。
					const wasActive = conv.id === this.activeId;
					// switch-cache：客户端报的缓存窗口跟着传下去（switchConversation 会重设 switchHave）。
					await this.switchConversation(conv.id, this.switchHave ?? undefined);
					if (wasActive) this.flushSnapshot();
					this.emitSwitchDone(target);
					return;
				}
			}

			// server-owned-chats：这条转录若已经有 runtime（不管是谁开的），直接切过去
			// 看**同一个**对话——上面的 for 循环已经处理了这种情况。走到这里说明它还没
			// 被打开过，正常从磁盘开一个新的。不再有持有者/拒绝/加入这套概念。

			// #235：先修后开——坏转录到 open 后的 getBranch 会死循环，修完再读。
			// 单文件预扫描，健康文件只多一次小读；修过即弹提示（含压缩被打断）。
			// chat-open-speed: one read of the file answers "is it intact?" and "what are its
			// newest messages?". Intact → the page gets the end of the chat now (switch_preview)
			// and the repair, heal and marker passes are skipped; otherwise the old path runs.
			// scanAndPreview waits until the preview has really left the socket: the SDK read below
			// blocks this thread for a second or more, and a frame still in the queue would be stuck
			// behind it — which is exactly what the preview is there to avoid.
			const scan = await this.scanAndPreview(target, targetPath);
			const fastOpen = scan !== null && scan.problem === null;
			if (!fastOpen) this.repairTranscriptFileBeforeOpen(targetPath);
			const sessionManager = SessionManager.open(targetPath);
			const targetCwd = sessionManager.getCwd();
			const conversationId = this.nextConversationId();
			openedTerminals = this.makeTerminalManager(conversationId, targetCwd);
			openedRuntime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(openedTerminals, undefined, conversationId),
				{
					cwd: targetCwd,
					agentDir: this.agentDir,
					sessionManager,
				},
			);

			// Only displace the old active conversation after the replacement runtime
			// is known-good. This keeps a failed history open entirely non-destructive.
			const oldListed = this.conv.listed;
			const displaced = this.displaceActive();
			const openInProject =
				[...this.convs.values()].filter((c) => c.cwd === targetCwd && !c.isSubagent && !c.isEphemeral).length +
				1 -
				(displaced?.cwd === targetCwd && !displaced?.isSubagent && !displaced?.isEphemeral ? 1 : 0);
			if (openInProject > MAX_OPEN_CONVERSATIONS) {
				// displaceActive() may have promoted a streaming conversation into the
				// running list. Roll that presentation-only mutation back because no
				// switch will take place.
				this.conv.listed = oldListed;
				openedTerminals.killAll();
				await openedRuntime.dispose();
				openedRuntime = null;
				openedTerminals = null;
				// switch-loading：以前是一条 warning toast。现在走回执：客户端若正在等这次切换，
				// 就在聊天区里显示原因；不是它发起的（内部自动切换）则由客户端降级成 toast。
				this.emitSwitchFailed(
					target,
					`This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
					`This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
				);
				return;
			}

			const conv = this.makeConversation(openedRuntime, conversationId, openedTerminals);
			// Deliberately resumed — must not be dismissed when the user later
			// switches away without sending a new message.
			conv.promptedSinceActive = true;
			// chat-open-speed: the scan already read the whole file and found no pending marker,
			// so this second whole-file read (1.1 s on a 267 MB chat) has nothing to find.
			if (!fastOpen) this.noticeInterruptedCompaction(conv);
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			// 从历史/「最近对话」打开 = 看过了：绿灯灭掉，并撤销它的「移出最近」墓碑。
			this.markRecentSeen(conv);
			openedRuntime = null;
			openedTerminals = null;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			// chat-cwd-pin：从历史/「最近对话」打开别的文件夹的对话同样不搬工作区；
			// 对话的运行时已经是用 targetCwd 建的，工具照样在它自己的目录里跑。
			if (chatFollowsWorkspace()) {
				this.cwd = targetCwd;
				// 打开的历史会话可能属于另一个项目 —— 工作区跟随面（roots/文件树/
				// 历史列表/命令目录/最近项目）必须跟着切，否则 UI 停在旧项目。
				this.applyCwdSideEffects(targetCwd);
				await this.restoreProjectProviderKeysForCwd(targetCwd);
				await this.restoreProjectModelForCwd(targetCwd);
			}
			this.conv.lastActiveAt = Date.now();
			this.webUi.refresh();
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			this.pushTerminals();
			// The restored conversation has a fresh project-bound resource cache.
			void this.pushSlashCommands();
			// 切历史会话成功 → 插件重拉（轨迹视图立即显示该会话时间线）。
			this.notifyConversationChanged();
		} catch (err) {
			openedTerminals?.killAll();
			if (openedRuntime) await openedRuntime.dispose().catch(() => {});
			// 失败后的快照是**旧**对话的（什么都没变），先发它再发失败回执，客户端的
			// 错误态就是盖在一份一致的界面上。
			this.flushSnapshot();
			this.emitSwitchFailed(
				target,
				`Failed to switch session: ${(err as Error).message}`,
				`Failed to switch session: ${(err as Error).message}`,
			);
			return;
		}
		this.flushSnapshot();
		this.emitSwitchDone(target);
		// 先快照后设置（见 switchConversationNow 末尾）。
		this.pushSettings();
	}

	/**
	 * Map a rendered user-message id (`u-<timestamp>-<seq>`, assigned in
	 * serialize.ts) back to its append-only session entry id. The seq handles
	 * two user messages sharing the same millisecond timestamp.
	 */
	private resolveUserMessageEntryId(messageId: string): string | null {
		const m = /^u-(\d+)(?:-(\d+))?$/.exec(messageId);
		if (!m) return null;
		const ts = Number(m[1]);
		const seq = m[2] ? Number(m[2]) : 1;
		let count = 0;
		// Resolve against the compaction-aware current leaf path — the same list
		// the UI renders (state.messages). Scanning the whole file (getEntries)
		// could match a summarized entry or one on a different branch.
		for (const entry of this.session.sessionManager.buildContextEntries()) {
			if (entry.type !== "message") continue;
			const msg = (entry as unknown as { message?: AgentMessage }).message;
			if (!msg || msg.role !== "user" || msg.timestamp !== ts) continue;
			count += 1;
			if (count === seq) return entry.id;
		}
		return null;
	}

	/** rewind-to-here：记下「对话太大」卡片的数据。同一条报错（同一时间戳）只量一次：
	 *  量的是整条分支的 JSON（42 MB 的对话约百毫秒）。 */
	private noteTooBig(conv: Conversation, kind: "bytes" | "tokens", errorText: string, at?: number): void {
		const when = at ?? Date.now();
		if (conv.tooBig && conv.tooBig.at === when) return;
		try {
			const items = contextItems(conv.session.sessionManager.buildContextEntries() as unknown as EntryLike[]);
			conv.tooBig = measureTooBig(items, kind, errorText, {
				contextWindow: conv.session.model?.contextWindow,
				now: when,
			});
		} catch {
			conv.tooBig = {
				kind,
				bytes: 0,
				images: 0,
				limitBytes: REQUEST_LIMIT_BYTES,
				errorText,
				suggest: null,
				at: when,
			};
		}
		const tb = conv.tooBig;
		console.log(
			`[rewind] ${conv.id} too big to send (${kind}): ${formatMb(tb.bytes)}, ${tb.images} pictures; ` +
				(tb.suggest
					? `suggest going back ${tb.suggest.dropCount} messages to ${formatMb(tb.suggest.keepBytes)}`
					: "no point small enough"),
		);
	}

	/**
	 * rewind-to-here：把当前对话回到某条消息之后继续——pi 的 /tree：`navigateTree(entry, { summarize })`。
	 * 还是同一个会话文件，跳过的那段原样留在文件里（另一条分支），新位置加一条自动摘要；
	 * 回到用户消息时那条的文字回到输入框（rewind_done.editorText）。
	 * messageId = 气泡 id；fit = 「对话太大」卡片的按钮（挑保留部分 ≤ 24 MB 的最新一条）。
	 * 运行中 / 压缩中 / 已在回退中一律拒绝。
	 */
	async rewindTo(messageId: string | undefined, fit: boolean): Promise<void> {
		const conv = this.conv;
		const done = (ok: boolean, editorText?: string) =>
			this.emit({ type: "rewind_done", ok, conversationId: conv.id, ...(editorText ? { editorText } : {}) });
		const refuse = (level: "info" | "warning" | "error", text: string, textEn: string) => {
			this.emit({ type: "notice", level, text, textEn });
			done(false);
			this.flushSnapshot();
		};
		if (this.quiesceBlocked()) {
			done(false);
			return;
		}
		const s = conv.session;
		if (s.isStreaming || conv.compactionState || conv.rewinding) {
			refuse(
				"warning",
				"The chat is still running; wait until it stops, then go back",
				"The chat is still running; wait until it stops, then go back",
			);
			return;
		}
		let items;
		try {
			items = contextItems(s.sessionManager.buildContextEntries() as unknown as EntryLike[]);
		} catch (err) {
			refuse("error", `Going back failed: ${(err as Error).message}`, `Going back failed: ${(err as Error).message}`);
			return;
		}
		const index = fit
			? suggestRewindIndex(items)
			: messageId
				? findItemIndex(items, messageId, (m) => conv.msgIds.get(uiKeyOf(m)))
				: null;
		if (index === null) {
			if (fit) {
				refuse(
					"error",
					"No earlier point is small enough: pick a message and use its “Rewind to here”",
					"No earlier point is small enough: pick a message and use its “Rewind to here”",
				);
			} else {
				refuse(
					"error",
					"Can't find that message on this branch (it may have been compacted)",
					"Can't find that message on this branch (it may have been compacted)",
				);
			}
			return;
		}
		const plan = planRewind(items, index);
		if (!plan || (!plan.toComposer && plan.keepCount >= items.length)) {
			refuse("info", "There is nothing after this message to skip", "There is nothing after this message to skip");
			return;
		}
		const dropped = droppedMessageCount(items, plan.keepCount);
		let finish: () => void = () => {};
		conv.rewindDone = new Promise<void>((resolve) => {
			finish = resolve;
		});
		conv.rewinding = { startedAt: Date.now() };
		this.flushSnapshot();
		this.checkpointViewers(conv.id, true);
		let ok = false;
		let editorText: string | undefined;
		try {
			const result = await s.navigateTree(plan.navigateEntryId, { summarize: true });
			if (result.cancelled) {
				this.emit({
					type: "notice",
					level: "info",
					text: "Going back was cancelled",
					textEn: "Going back was cancelled",
				});
			} else {
				ok = true;
				editorText = result.editorText || (plan.toComposer ? plan.editorText : undefined);
				conv.tooBig = null;
				console.log(
					`[rewind] ${conv.id} went back to ${plan.navigateEntryId}: ${dropped} messages skipped, ` +
						`summary ${result.summaryEntry ? result.summaryEntry.id : "none"}`,
				);
				this.emit({
					type: "notice",
					level: "info",
					text: `Went back: ${dropped} message${dropped === 1 ? "" : "s"} skipped (still saved in the chat file), and a short summary of them was added`,
					textEn: `Went back: ${dropped} message${dropped === 1 ? "" : "s"} skipped (still saved in the chat file), and a short summary of them was added`,
				});
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Going back failed: ${(err as Error).message}`,
				textEn: `Going back failed: ${(err as Error).message}`,
			});
		} finally {
			conv.rewinding = null;
			conv.rewindDone = undefined;
		}
		done(ok, editorText);
		if (this.activeId === conv.id) this.flushSnapshot(true);
		this.checkpointViewers(conv.id, true);
		ClientSession.emitConversationsToAll();
		// 回退期间发来的话在等它（见 prompt()）：快照发完再放行，页面先看到回退后的样子。
		finish();
	}

	/**
	 * Map any rendered message id (u-*, a-*, t-*, b-*, c-*, or raw entry id)
	 * back to its append-only session entry in the given conversation.
	 */
	private resolveMessageEntry(
		conv: Conversation,
		messageId: string,
	): import("@earendil-works/pi-coding-agent").SessionEntry | null {
		// The matcher re-derives rendered ids with the SAME derivation
		// chatIndexOf() used to hand them to the browser (uiMessageId +
		// the counter below). Historically this recomputed ids with its own
		// numbering (per-timestamp assistant seq, branch-entry global seq),
		// which never matched what was rendered — fork/rollback on any
		// assistant bubble failed 100% of the time (issue #381).
		const entries = conv.session.sessionManager.buildContextEntries();
		const found = findEntryByUiId(
			entries as (UiIdEntryLike & import("@earendil-works/pi-coding-agent").SessionEntry)[],
			messageId,
			(m) => this.uiMessageKey(conv, m).n,
		);
		// 兜底：getEntry 查整棵树
		return found ?? conv.session.sessionManager.getEntry(messageId) ?? null;
	}

	/**
	 * Fork a NEW branch conversation from a specific historical message position.
	 * Truncates the transcript before (or at) that message as the context of the
	 * new conversation, allowing the user to explore alternative lines of thought
	 * without affecting the original conversation.
	 */
	async forkSession(messageId: string, position: "before" | "at" = "before", targetConvId?: string): Promise<void> {
		if (this.quiesceBlocked()) return;
		const targetConv = (targetConvId ? this.convs.get(targetConvId) : this.conv) ?? this.conv;
		const entry = this.resolveMessageEntry(targetConv, messageId);
		if (!entry) {
			this.emit({
				type: "notice",
				level: "error",
				text: "Message node to fork from not found (may have been compacted or is on another branch)",
				textEn: "Message node to fork from not found (may have been compacted or is on another branch)",
			});
			this.flushSnapshot();
			return;
		}

		const targetLeafId = position === "at" ? entry.id : entry.parentId;

		try {
			const currentSessionFile = targetConv.session.sessionFile;
			const isPersisted =
				targetConv.session.sessionManager.isPersisted() && currentSessionFile && existsSync(currentSessionFile);

			const prevModel = targetConv.session.agent.state.model ?? null;
			const prevThinking = targetConv.session.thinkingLevel ?? null;
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, targetConv.cwd);

			let forkedManager: SessionManager;
			if (isPersisted) {
				const sessionDir = targetConv.session.sessionManager.getSessionDir();
				let forkedSessionPath: string | undefined;
				if (!targetLeafId) {
					const sm = SessionManager.create(targetConv.cwd, sessionDir);
					sm.newSession({ parentSession: currentSessionFile });
					forkedSessionPath = sm.getSessionFile();
				} else {
					const sm = SessionManager.open(currentSessionFile, sessionDir);
					forkedSessionPath = sm.createBranchedSession(targetLeafId);
				}
				if (!forkedSessionPath) {
					throw new Error("Failed to create forked session file");
				}
				forkedManager = SessionManager.open(forkedSessionPath, sessionDir);
			} else {
				forkedManager = SessionManager.create(targetConv.cwd);
				if (targetLeafId) {
					const branch = targetConv.session.sessionManager.getBranch(targetLeafId);
					for (const e of branch) {
						if (e.type === "message") {
							try {
								forkedManager.appendMessage(
									(e as unknown as { message: Parameters<SessionManager["appendMessage"]>[0] }).message,
								);
							} catch {
								// skip malformed/unsupported message entries in memory mode
							}
						}
					}
				}
			}

			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(terminals, undefined, conversationId, prevModel ?? undefined),
				{
					cwd: targetConv.cwd,
					agentDir: this.agentDir,
					sessionManager: forkedManager,
				},
			);

			const newConv = this.makeConversation(runtime, conversationId, terminals);
			if (targetConv.agentPreset) newConv.agentPreset = targetConv.agentPreset;
			if (targetConv.permissionPreset) newConv.permissionPreset = targetConv.permissionPreset;
			newConv.forkFrom = {
				conversationId: targetConv.id,
				messageId,
				title: targetConv.title,
			};

			// 与 newChat/switchSession 同一护栏：fork 出的对话也占项目名额，被换下
			// 的旧 active 也要走运行列表生命周期（该保留的保留、该释放的释放）。
			// 之前两者皆无 —— 可以无限 fork 堆爆名额，旧对话也永远留在列表里。
			// 顺序照 switchSession：新 runtime 建好才 displace，失败不伤现有对话。
			const oldListed = this.conv.listed;
			const displaced = this.displaceActive();
			const openInProject =
				[...this.convs.values()].filter((c) => c.cwd === targetConv.cwd && !c.isSubagent && !c.isEphemeral).length +
				1 -
				(displaced?.cwd === targetConv.cwd && !displaced?.isSubagent && !displaced?.isEphemeral ? 1 : 0);
			if (openInProject > MAX_OPEN_CONVERSATIONS) {
				// displaceActive() 可能只是把旧对话标成后台展示（presentation-only）；
				// 没有切换发生时回滚该标记，新 fork 的 runtime/终端直接释放。
				this.conv.listed = oldListed;
				terminals.killAll();
				await runtime.dispose();
				this.emit({
					type: "notice",
					level: "warning",
					text: `This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
					textEn: `This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
				});
				return;
			}

			this.convs.set(conversationId, newConv);
			this.activeId = conversationId;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();

			if (prevModel && this.sharedModelRuntime) {
				try {
					const pm = prevModel as unknown as { provider: string; id: string };
					await this.restoreKeyForModel(`${pm.provider}/${pm.id}`, targetConv.cwd);
					await this.session.setModel(prevModel);
				} catch {
					// keep default
				}
			}
			if (prevThinking) {
				try {
					this.session.setThinkingLevel(prevThinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
				} catch {
					// keep default
				}
			}

			this.emit({
				type: "notice",
				level: "info",
				text: "🌱 Forked new branch session and switched to it (original preserved)",
				textEn: "🌱 Forked new branch session and switched to it (original preserved)",
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to fork branch session: ${(err as Error).message}`,
				textEn: `Failed to fork branch session: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * 回滚会话至指定消息检查点（Checkpoint Rollback）：
	 * 丢弃该消息之后的所有内容，并就地重置 session 状态，用户可直接在此继续提问。
	 */
	async rollbackSession(messageId: string, targetConvId?: string, restoreWorkspace?: boolean): Promise<void> {
		if (this.quiesceBlocked()) return;
		const targetConv = (targetConvId ? this.convs.get(targetConvId) : this.conv) ?? this.conv;
		const entry = this.resolveMessageEntry(targetConv, messageId);
		if (!entry) {
			this.emit({
				type: "notice",
				level: "error",
				text: "Rollback checkpoint not found (may have been compacted or not exist)",
				textEn: "Rollback checkpoint not found (may have been compacted or not exist)",
			});
			this.flushSnapshot();
			return;
		}

		try {
			if (targetConv.session.isStreaming) {
				await targetConv.session.abort();
			}

			// 重置分支 leaf 到目标 entry.id
			targetConv.session.sessionManager.branch(entry.id);
			const branchedContext = targetConv.session.sessionManager.buildSessionContext();
			targetConv.session.agent.state.messages = [...branchedContext.messages];
			if (branchedContext.thinkingLevel) {
				try {
					targetConv.session.setThinkingLevel(
						branchedContext.thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0],
					);
				} catch {
					// ignore
				}
			}
			await targetConv.session.reload();

			// 重新应用设置和门控
			this.applyRetryOverrides();
			this.applyCompactionOverrides();
			this.applyToolGating(targetConv.session, targetConv.agentPreset);

			// 清理该会话的 UI 消息缓存和序列化映射
			targetConv.uiMessageCache.clear();
			targetConv.msgIds.clear();
			targetConv.nextMsgId = 1;
			targetConv.chatIndex = undefined;
			targetConv.lastMessagesSig = "";
			targetConv.lastMessagesArray = [];
			targetConv.queueSteering = [];
			targetConv.queueFollowUp = [];
			try {
				targetConv.session.clearQueue?.();
			} catch {
				// best effort
			}

			// 联动还原物理工作区文件（Dual-State Rollback）
			let workspaceRestored = false;
			if (restoreWorkspace) {
				const entryTs =
					(entry as unknown as { message?: { timestamp?: number }; timestamp?: number }).message?.timestamp ??
					(entry as unknown as { timestamp?: number }).timestamp ??
					0;

				// 查找最贴近该 entry 的快照（按 entryId 或 <= entryTs 的最后一份快照）
				const snapshots = targetConv.workspaceSnapshots ?? [];
				let matched = snapshots.find((s) => s.entryId === entry.id);
				if (!matched) {
					const eligible = snapshots.filter((s) => entryTs === 0 || s.timestamp <= entryTs + 2000);
					matched = eligible[eligible.length - 1];
				}
				if (!matched && snapshots.length > 0) {
					matched = snapshots[0];
				}

				if (matched) {
					const res = await restoreWorkspaceSnapshot(targetConv.cwd, matched.snapshotRef);
					if (res.success) {
						workspaceRestored = true;
					} else {
						this.emit({
							type: "notice",
							level: "warning",
							text: `Session rolled back, but workspace file restore failed: ${res.error}`,
							textEn: `Session rolled back, but workspace file restore failed: ${res.error}`,
						});
					}
				} else {
					this.emit({
						type: "notice",
						level: "warning",
						text: "No workspace snapshot found for this checkpoint (not a Git repo or snapshot unavailable); files left untouched.",
						textEn:
							"No workspace snapshot found for this checkpoint (not a Git repo or snapshot unavailable); files left untouched.",
					});
				}
			}

			this.emit({
				type: "notice",
				level: "info",
				text: workspaceRestored
					? "Rolled back to selected message; workspace physical files restored to checkpoint state."
					: "Rolled back to selected message; subsequent content discarded, ready to continue.",
				textEn: workspaceRestored
					? "Rolled back to selected message; workspace physical files restored to checkpoint state."
					: "Rolled back to selected message; subsequent content discarded, ready to continue.",
			});
			this.emittedKeys = null;
			this.emitConversations();
			this.flushSnapshot(true);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Rollback failed: ${(err as Error).message}`,
				textEn: `Rollback failed: ${(err as Error).message}`,
			});
		}
	}

	/**
	 * Edit a past user question and re-ask it: forks a NEW session file that
	 * keeps everything up to (but not including) that question, then sends the
	 * edited text there. The original thread is untouched and stays in the
	 * session list, so nothing is ever lost.
	 *
	 * Attachments (attachments) travel through the SAME pipeline as prompt()
	 * — the fork intentionally drops the original attachment asides because
	 * they live on the old branch past the fork point, so the browser re-sends
	 * the images it kept in the edit composer (original image blocks + any
	 * newly pasted/dropped ones). Text-only edits pass undefined.
	 */
	async editMessage(
		messageId: string,
		text: string,
		attachments?: Parameters<ClientSession["prompt"]>[1],
	): Promise<void> {
		if (this.quiesceBlocked()) return;
		const trimmed = text.trim();
		if (!trimmed) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "Edited content is empty — cancelled",
				textEn: "Edited content is empty — cancelled",
			});
			this.flushSnapshot();
			return;
		}
		const entryId = this.resolveUserMessageEntryId(messageId);
		if (!entryId) {
			this.emit({
				type: "notice",
				level: "error",
				text: "Message to edit not found (may have been compacted or is on another branch)",
				textEn: "Message to edit not found (may have been compacted or is on another branch)",
			});
			this.flushSnapshot();
			return;
		}
		try {
			// Preserve the model the user had selected — fork() seeds a new
			// branch with the ModelRuntime default model otherwise.
			const prevModel = this.session.agent.state.model ?? null;
			const prevThinking = this.session.thinkingLevel ?? null;
			// fast-mode: the re-asked branch is a new session id; it keeps the chat's choice.
			const prevFast = fastModeRegistry.isOn(this.session.sessionManager);
			const result = await this.runtime.fork(entryId);
			if (result.cancelled) {
				this.emit({
					type: "notice",
					level: "info",
					text: "Edit-and-reask cancelled",
					textEn: "Edit-and-reask cancelled",
				});
				this.flushSnapshot();
				return;
			}
			await this.bindSession();
			// Restore the previously-selected model on the forked branch.
			if (prevModel && this.sharedModelRuntime) {
				try {
					const pm = prevModel as unknown as { provider: string; id: string };
					// 先恢复 provider key，再 setModel（否则 checkAuth 鉴权失败）
					await this.restoreKeyForModel(`${pm.provider}/${pm.id}`, this.cwd);
					await this.session.setModel(prevModel);
				} catch {
					// model no longer resolvable — keep the default
				}
			}
			if (prevThinking) {
				try {
					this.session.setThinkingLevel(prevThinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
				} catch {
					// model no longer supports previous thinking level
				}
			}
			if (prevFast) {
				try {
					const sm = this.session.sessionManager;
					fastModeRegistry.setOn(sm, true);
					sm.appendCustomEntry(FAST_MODE_ENTRY, fastModeEntryData(sm, true));
				} catch {
					// best effort: the chat is just back to normal speed
				}
			}
			await this.prompt(trimmed, attachments);
			this.emit({
				type: "notice",
				level: "info",
				text: "Re-asked from that question (the original stays in the session list)",
				textEn: "Re-asked from that question (the original stays in the session list)",
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Edit-and-reask failed: ${(err as Error).message}`,
				textEn: `Edit-and-reask failed: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Push the recent-project list (persisted per client, merged with every cwd
	 * that has persisted sessions in this client's session store — so workspaces
	 * opened before the recent-list feature existed still show up).
	 */
	async pushProjects(): Promise<void> {
		const now = Date.now();
		const cached = this.projectsCache;
		// TTL 命中：直接复用（把当前 cwd 合并进去，刚 remember 的新项目也可见）。
		if (cached && now - cached.at < ClientSession.PROJECTS_CACHE_TTL) {
			this.emit({ type: "projects", projects: this.withCurrentCwd(cached.projects, now) });
			return;
		}
		// 已有扫描在跑：搭车等它，不要并发扫两遍盘。
		if (this.projectsInFlight) {
			try {
				const projects = await this.projectsInFlight;
				if (projects) this.emit({ type: "projects", projects: this.withCurrentCwd(projects, Date.now()) });
			} catch {
				/* 首发扫描已自行 emit 错误结果，这里不再补 */
			}
			return;
		}
		const run: Promise<ProjectSummary[] | null> = (async () => {
			try {
				const saved = this.stateStore.get(this.clientId);
				const removedProjects = new Set(this.stateStore.getRemovedProjects(this.clientId).map(normalizePathKey));
				const map = new Map<string, number>();
				for (const p of saved.projects) map.set(p.path, p.lastUsed);
				const all = await SessionManager.listAll(piSessionsRoot());
				for (const s of all) {
					if (s.cwd) {
						const t = s.modified.getTime();
						const prev = map.get(s.cwd);
						if (prev === undefined || t > prev) map.set(s.cwd, t);
					}
				}
				// Only keep directories that still exist — a deleted/unmounted workspace
				// is useless in the picker. Tombstoned entries (explicitly removed by
				// the user) stay hidden even though session files still mention them.
				const projects: ProjectSummary[] = [...map.entries()]
					.filter(([path]) => !removedProjects.has(normalizePathKey(path)) && existsSync(path))
					.map(([path, lastUsed]) => ({ path, lastUsed }))
					.sort((a, b) => b.lastUsed - a.lastUsed)
					.slice(0, 20);
				this.projectsCache = { at: Date.now(), projects };
				this.emit({ type: "projects", projects });
				return projects;
			} catch {
				this.emit({ type: "projects", projects: [] });
				return null;
			} finally {
				this.projectsInFlight = null;
			}
		})();
		this.projectsInFlight = run;
		await run;
	}

	/** 缓存命中时把当前 cwd 并进去：命中则刷新 lastUsed 重排，未命中则补到首位
	 *  （remember 刚写入的新项目在 TTL 窗口内也可见，不必等下一次扫盘）。
	 *  若当前工作区已被显式移出，则不强行塞回最近列表。 */
	private withCurrentCwd(projects: ProjectSummary[], now: number): ProjectSummary[] {
		const currentKey = normalizePathKey(this.cwd);
		const removedKeys = new Set(this.stateStore.getRemovedProjects(this.clientId).map(normalizePathKey));
		if (removedKeys.has(currentKey)) {
			return projects;
		}
		if (projects.some((p) => normalizePathKey(p.path) === currentKey)) {
			return projects
				.map((p) => (normalizePathKey(p.path) === currentKey && p.lastUsed < now ? { ...p, lastUsed: now } : p))
				.sort((a, b) => b.lastUsed - a.lastUsed);
		}
		return [{ path: this.cwd, lastUsed: now }, ...projects].slice(0, 20);
	}

	/** 最近项目缓存失效（用户显式移除项目后，下一次推送必须重扫）。 */
	private invalidateProjectsCache(): void {
		this.projectsCache = null;
	}

	/** List a workspace directory (relative to the configured cwd). */
	async listFiles(relPath?: string): Promise<void> {
		return this.files.listFiles(relPath);
	}

	/** 全局搜索：递归文件名匹配（结果经 search_files_result 回推，reqId 匹配）。 */
	async searchFiles(query: string, reqId: number): Promise<void> {
		return this.files.searchFiles(query, reqId);
	}

	/** 全局搜索：在会话转录全文里做大小写不敏感匹配（范围同 History：
	 *  historyScope() 为 "all" 时跨文件夹）——
	 *  不止首条消息，而是每一段 user 与 assistant 文本（AI 输出也在内）。
	 *  结果经 session_search_results 回推（reqId 匹配）；复用 loadSessionInfos()
	 *  缓存，避免每个按键都重新解析全部转录文件。 */
	async searchSessions(query: string, reqId: number): Promise<void> {
		const q = query.trim().toLowerCase();
		if (!q) {
			this.emit({ type: "session_search_results", reqId, query, ok: true, results: [] });
			return;
		}
		try {
			const infos = await this.loadSessionInfos();
			const results = infos
				.filter((s) => sessionMatchesSearch(q, s))
				.sort((a, b) => b.modified.getTime() - a.modified.getTime())
				.slice(0, 50)
				.map((s) => {
					const base: SessionSummary = {
						path: s.path,
						name: s.name,
						firstMessage: s.firstMessage,
						messageCount: s.messageCount,
						modified: s.modified.getTime(),
						source: "web",
						cwd: s.cwd,
					};
					// 命中会话里再定位具体消息（供点击跳转）；仅元数据命中则无锚点
					return { ...base, anchors: collectSessionAnchors(s.path, q) };
				});
			this.emit({ type: "session_search_results", reqId, query, ok: true, results });
		} catch {
			this.emit({ type: "session_search_results", reqId, query, ok: false, results: [] });
		}
	}

	/** SCM 只读查询（结构化 JSON，reqId 匹配）。 */
	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void> {
		return this.files.scmQuery(kind, reqId, arg);
	}

	/**
	 * SCM「AI 生成提交信息」：用当前对话模型做一次 completeSimple 一次性补全
	 * （与视觉桥同一条通路）——不进对话上下文、不打断正在流式的回复。
	 * 恰好应答一次：任何失败都以 ok:false 的 scm_data（kind "commitmsg"）收尾，
	 * 前端按钮不会卡在转圈。
	 */
	async scmGenCommitMessage(reqId: number): Promise<void> {
		const lang = this.getLang();
		const cwd = this.convs.get(this.activeId)?.cwd ?? this.cwd;
		const reply = (ok: boolean, extra: { text?: string; error?: string }) => {
			this.emit({ type: "scm_data", reqId, kind: "commitmsg", ok, ...extra });
		};
		const fail = (err: unknown) => {
			reply(false, { error: err instanceof Error ? err.message : String(err) });
		};
		try {
			const runtime = this.runtime.services.modelRuntime;
			const model = this.session?.model;
			if (!model) {
				throw new Error("No model available — pick one in the top bar first");
			}
			const ctx = await scmCommitContext(cwd, () => lang);
			const input = buildCommitMsgInput(ctx, "en");
			if (!input) {
				throw new Error("Nothing to describe (working tree clean)");
			}

			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), SCM_COMMITMSG_TIMEOUT_MS);
			// 提示词可配置（设置 → 提示词 → AI 提交信息）：追加/替换内置默认。
			const commitSettings = this.settingsSvc.current;
			const systemPrompt = buildCommitMsgPrompt(
				commitSettings.scmCommitMsgPromptMode === "replace" ? "replace" : "append",
				commitSettings.scmCommitMsgPrompt ?? "",
			);
			let msg: Awaited<ReturnType<typeof runtime.completeSimple>>;
			try {
				msg = await runtime.completeSimple(
					model,
					{
						systemPrompt,
						messages: [
							{
								role: "user",
								timestamp: Date.now(),
								content: [{ type: "text", text: input }],
							},
						],
					},
					{ signal: ac.signal, maxTokens: 400 },
				);
			} finally {
				clearTimeout(timer);
			}
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				throw new Error(msg.errorMessage || `Model terminated abnormally (${msg.stopReason})`);
			}
			const raw = msg.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { text?: string }).text ?? "")
				.join("\n");
			const text = sanitizeCommitMessage(raw);
			if (!text) {
				throw new Error("The model returned an empty commit message");
			}
			reply(true, { text });
		} catch (err) {
			if (isNotRepoError(err)) {
				fail(new Error("Current directory is not a Git repository"));
				return;
			}
			if (err instanceof Error && /abort/i.test(`${err.name} ${err.message}`)) {
				fail(new Error(`Commit-message generation timed out (${Math.round(SCM_COMMITMSG_TIMEOUT_MS / 1000)}s)`));
				return;
			}
			fail(err);
		}
	}

	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	async readFile(relPath: string): Promise<void> {
		return this.files.readFile(relPath);
	}

	/** Save text from the file preview panel within the active workspace. */
	async writeFile(relPath: string, text: string): Promise<void> {
		return this.files.writeFile(relPath, text);
	}

	async uploadFile(relDir: string, name: string, data: string): Promise<void> {
		return this.files.uploadFile(relDir, name, data);
	}

	/** 文件树右键菜单：新建（空文件/空文件夹）。 */
	async createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void> {
		return this.files.createEntry(dir, name, kind);
	}

	/** 文件树右键菜单：同目录内重命名。 */
	async renameEntry(path: string, newName: string): Promise<void> {
		return this.files.renameEntry(path, newName);
	}

	/** 文件树右键菜单：删除文件/目录。 */
	async deleteEntry(path: string): Promise<void> {
		return this.files.deleteEntry(path);
	}

	/** 文件树右键菜单：复制/移动（move=true 即剪切粘贴）。 */
	async copyEntry(src: string, destDir: string, move?: boolean): Promise<void> {
		return this.files.copyEntry(src, destDir, move);
	}

	/** 文件树右键菜单：在系统资源管理器中定位（issue #187）。 */
	async revealEntry(path: string): Promise<void> {
		return this.files.revealEntry(path);
	}

	/** 文件树右键菜单：用系统默认应用打开文件（issue #187）。 */
	async openDefaultEntry(path: string): Promise<void> {
		return this.files.openDefaultEntry(path);
	}

	async makeDir(relPath: string, setAsCwd = false): Promise<void> {
		const created = await this.files.makeDir(relPath);
		if (created && setAsCwd) {
			await this.setCwd(created);
		}
	}

	async cycleModel(): Promise<void> {
		try {
			const result = await this.session.cycleModel();
			if (result?.model) {
				const mid = `${result.model.provider}/${result.model.id}`;
				await this.restoreKeyForModel(mid, this.cwd);
				// Remember per-project like setModel — cycling is also a model switch.
				this.rememberProjectModel(mid);
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch model: ${(err as Error).message}`,
				textEn: `Failed to switch model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Path completion for the cwd input: expand ~/relative paths, list the parent
	 * directory, and return prefix matches (dirs first, capped).
	 */
	async completePath(input: string): Promise<void> {
		return this.files.completePath(input);
	}

	/** 当前项目的额外工作区根（空数组 = 单根）。 */
	get workspaceRoots(): string[] {
		return this.roots;
	}

	/**
	 * 设置当前项目的额外工作区根（宿主侧多根，见 protocol 的 set_workspace_roots）。
	 *
	 * 语义：AI 仍只在主 cwd 里干活（pi SDK 是单 cwd 模型），多根只影响「哪些路径算
	 * 工作区内」—— 右栏文件树可跨根浏览，插件的 host.fs / host.project.create 不必
	 * 再走授权就能读这些根（所以它是用户/宿主侧动作，不是插件能静默做的）。
	 *
	 * 归一化交给 ClientStateStore（只收绝对路径 / 去重 / 上限 8）。刻意**不**校验
	 * 目录是否存在：根可能是暂时断开的盘或挂载点，不该把用户设过的根静默清掉。
	 */
	async setWorkspaceRoots(roots: string[] | undefined): Promise<void> {
		const before = this.stateStore.getWorkspaceRoots(this.clientId, this.cwd);
		this.stateStore.saveWorkspaceRoots(this.clientId, this.cwd, roots ?? []);
		const saved = this.stateStore.getWorkspaceRoots(this.clientId, this.cwd);
		if (saved.length === before.length && saved.every((p, i) => p === before[i])) {
			// 没变化（重复点 / 重放的旧命令）：不打扰插件、不推快照。
			return;
		}
		this.roots = saved;
		try {
			// 同一个钩子：插件宿主要跟着把「工作区内的路径」重新算一遍。
			this.onCwdChanged?.(this.cwd, this.roots);
		} catch {
			/* 钩子异常不影响主流程 */
		}
		this.flushSnapshot();
	}

	async setCwd(newCwd: string): Promise<void> {
		try {
			const { resolve } = await import("node:path");
			this.files.unwatchGit(); // stale repo's watcher must not fire across projects
			const fs = await import("node:fs/promises");
			const trimmed = newCwd.trim();
			if (trimmed === MACHINE_ROOT) {
				// 机器根是虚拟层（盘符列表），不能作工作目录——指引用户选具体目录。
				this.emit({
					type: "notice",
					level: "warning",
					text: "Pick a concrete directory as the workspace (This PC itself is not a directory)",
					textEn: "Pick a concrete directory as the workspace (This PC itself is not a directory)",
				});
				return;
			}
			// Windows 裸盘符（"C:"）与相对路径基准的处理收敛到 resolveCwdTarget
			// （纯函数，含 win32/posix 差异说明与单测）。
			const abs = resolveCwdTarget(trimmed, this.cwd);
			const st = await fs.stat(abs);
			if (!st.isDirectory()) {
				throw new Error("Path is not a directory");
			}
			if (abs === this.cwd) {
				this.emit({
					type: "notice",
					level: "info",
					text: `Already in directory: ${abs}`,
					textEn: `Already in directory: ${abs}`,
				});
				this.flushSnapshot();
				return;
			}

			// The outgoing conversation is left behind — apply the running-list
			// lifecycle (removal is deferred until the active conversation is
			// safely switched away).
			const displaced = this.displaceActive();

			// Prefer the target project's own most recently active conversation;
			// only create a fresh one (resuming its most recent session) when the
			// project has none open yet.
			// 与 reload-adopt 同一条规则（`pickAdoptTarget`）：同 cwd 里 lastActiveAt
			// 最大的一条，并列先到先得，**子代理对话永不入选**。原来这里是一份手写
			// 循环，漏了 isSubagent —— 在 X 里派个子代理、切到 Y 再切回 X，离开时
			// 主对话被 displace 掉，cwd===X 就只剩子代理那条，于是直接把用户落在
			// `sa-*` 会话上。换成共用函数，规则只剩一处，单测也就只需要一处。
			const openHere = pickAdoptTarget(abs, this.convs.values());
			// 伪客户端（scheduler:/plugin:）绝不落到别人开着的对话上：它随后直接 prompt，会把
			// 定时任务/插件消息发进用户的对话。也不能从磁盘恢复那条的转录（同一文件
			// 两个写者），所以这个项目里已有开着的对话时它落到空白新对话。
			const pseudo = AgentService.isPseudoClientId(this.clientId);
			const targetId = pseudo ? null : openHere;
			const target = targetId ? this.convs.get(targetId) : undefined;

			if (target) {
				this.activeId = target.id;
				if (displaced) this.removeConversation(displaced.id);
			} else {
				// 冷切换的 runtime 创建要 1~2s（扫技能/扩展）—— 先回一条 ack +
				// 快照，点击看起来不再 frozen；落地后再推第二次全量。
				this.emit({
					type: "notice",
					level: "info",
					text: `Switching to directory: ${abs}`,
					textEn: `Switching to directory: ${abs}`,
				});
				this.flushSnapshot();
				// First visit to this project: resume its most recent session —
				// unless that transcript is still held on another client (#145):
				// default-opening it would strand the tab on a conversation it
				// cannot use (the prompt guard refuses while streaming) with a
				// stale leaf that forks history once both sides send (idle-held
				// files fork the same way — 第二个写者不只跑着时才危险). Land
				// blank instead.
				let resumeSkipped: SessionOwnerInfo | null = null;
				// 别处无可见行时不扫目录（首访切项目的常见情形零开销）。
				if ((this.listExternalRunning?.() ?? []).length > 0) {
					try {
						const infos = await SessionManager.list(abs, piSessionsRoot());
						const recent = infos[0]?.path ? resolve(infos[0].path) : undefined;
						const owner = recent ? this.findSessionOwner?.(recent) : null;
						if (owner && (owner.connected || owner.isStreaming)) {
							resumeSkipped = owner;
						}
					} catch {
						// 列表失败不挡正常恢复
					}
				}
				const conversationId = this.nextConversationId();
				const terminals = this.makeTerminalManager(conversationId, abs);
				// #235：manager＋runtime 一起建，转录链损坏时修最近文件后重试一次
				// （见 openManagerAndRuntime）。blank（别处在跑）是全新空会话，不会坏。
				const opened = await this.openManagerAndRuntime(
					() =>
						resumeSkipped || (pseudo && openHere) ? SessionManager.create(abs) : SessionManager.continueRecent(abs),
					(m) =>
						createAgentSessionRuntime(this.makeRuntimeFactory(terminals, undefined, conversationId), {
							cwd: abs,
							agentDir: this.agentDir,
							sessionManager: m,
						}),
					async () => (await SessionManager.list(abs))[0]?.path,
				);
				const newRuntime = opened.runtime;
				if (opened.repair) {
					for (const n of this.transcriptRepairNotices(opened.repair)) this.emit(n);
				}
				const conv = this.makeConversation(newRuntime, conversationId, terminals);
				this.convs.set(conv.id, conv);
				this.activeId = conv.id;
				if (displaced) this.removeConversation(displaced.id);
				for (const d of newRuntime.diagnostics) {
					if (d.type !== "info") {
						this.emit({ type: "notice", level: d.type, text: d.message, textEn: d.message });
					}
				}
				await this.bindSession();
				if (resumeSkipped) {
					this.emit(
						resumeSkipped.isStreaming
							? {
									type: "notice",
									level: "info",
									text: `The most recent conversation ("${resumeSkipped.title}") is running in another window, so you landed on a new chat instead — opening it here would create a second writer. It is listed under Running chats (tagged "Elsewhere"); open it after it finishes.`,
									textEn: `The most recent conversation ("${resumeSkipped.title}") is running in another window, so you landed on a new chat instead — opening it here would create a second writer. It is listed under Running chats (tagged "Elsewhere"); open it after it finishes.`,
								}
							: {
									type: "notice",
									level: "info",
									text: `The most recent conversation ("${resumeSkipped.title}") is still open in another window (currently idle), so you landed on a blank chat instead — take it over from Running chats (tagged "Elsewhere") or reopen it from History (send new messages from only one place, or the history will fork).`,
									textEn: `The most recent conversation ("${resumeSkipped.title}") is still open in another window (currently idle), so you landed on a blank chat instead — take it over from Running chats (tagged "Elsewhere") or reopen it from History (send new messages from only one place, or the history will fork).`,
								},
					);
				}
			}

			this.pushTerminals();
			this.conv.promptedSinceActive = false;
			this.conv.lastActiveAt = Date.now();
			this.cwd = abs;
			// 模型/key 恢复不挡快照：后台做，带切换代际 guard（用户又切走就跳过，
			// 否则会把旧项目的 key 套到新对话上），做完补一次 flush 刷新模型栏。
			{
				const convId = this.activeId;
				void (async () => {
					try {
						await this.restoreProjectProviderKeysForCwd(abs);
						if (this.disposed || this.activeId !== convId || this.cwd !== abs) return;
						await this.restoreProjectModelForCwd(abs);
						if (this.disposed || this.activeId !== convId || this.cwd !== abs) return;
						this.flushSnapshot();
					} catch {
						/* 静默：恢复失败保持会话默认 */
					}
				})();
			}
			this.applyCwdSideEffects(abs);
			this.webUi.refresh();
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			// Skills / prompt templates are project-bound — refresh the catalog.
			void this.pushSlashCommands();
			this.emit({
				type: "notice",
				level: "info",
				text: `Switched to directory: ${abs}`,
				textEn: `Switched to directory: ${abs}`,
			});
			// 切项目即换了当前打开对话 → 插件重拉。
			this.notifyConversationChanged();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch directory: ${(err as Error).message}`,
				textEn: `Failed to switch directory: ${(err as Error).message}`,
			});
			this.flushSnapshot();
			return;
		}
		this.flushSnapshot();
		// 先快照后设置（见 switchConversationNow 末尾）。
		this.pushSettings();
	}

	/** Strip the "(New)" freshness marker some catalogs append to display names
	 *  (pi.dev data, e.g. "DeepSeek V4 Pro (New)") — display-only; the model id
	 *  is untouched so switching still uses the exact official id. */
	private cleanModelDisplayName(name: string): string {
		return name.replace(/\s*\(new\)$/i, "").trim();
	}

	/** List models that have valid authentication configured. */
	async listModels(): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			// Reconcile built-in provider catalogs with the official pi.dev
			// endpoint before listing: within the SDK's 4h freshness window this
			// is a fast 304; past it the newest catalog is downloaded WHOLESALE
			// (patch-remote-catalog.ts) — no union merge, no stale built-in
			// leftovers, no "新增 N 个模型" noise. Network failure falls back to
			// the cached catalog silently.
			await mr.refresh({ allowNetwork: true, signal: AbortSignal.timeout(15_000) }).catch(() => {
				// list must never fail because the catalog sync did
			});
			const available = await mr.getAvailable();
			const models = available.map((m) => ({
				id: `${m.provider}/${m.id}`,
				name: this.cleanModelDisplayName(m.name),
				provider: m.provider,
				reasoning: m.reasoning,
				vision: m.input?.includes("image") ?? false,
			}));
			this.emit({ type: "models", models });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to fetch model list: ${(err as Error).message}`,
				textEn: `Failed to fetch model list: ${(err as Error).message}`,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Goal / review
	// ---------------------------------------------------------------------------

	/** Goal family delegates to GoalService (see goal-service.ts). */
	async setGoal(
		goalText: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			autoStart?: boolean;
		},
	): Promise<void> {
		return this.goalSvc.setGoal(goalText, opts);
	}

	async startGoalWizard(
		text: string,
		opts?: {
			wizardModel?: string;
			maxRounds?: number;
			locked?: boolean;
		},
	): Promise<void> {
		return this.goalSvc.startGoalWizard(text, opts);
	}

	async setGoalPrefs(opts?: { reviewModel?: string; maxRounds?: number; locked?: boolean }): Promise<void> {
		return this.goalSvc.setGoalPrefs(opts);
	}

	async clearGoal(): Promise<void> {
		return this.goalSvc.clearGoal();
	}

	/**
	 * Run a git diff (unstaged + staged) in a conversation's workspace, or
	 * "" when not a repo.
	 *
	 * 返回值是 goal 审查用的「变更指纹」，构造规则（截断与等值比较的相互作用）
	 * 见 buildDiffFingerprint：diff 为空时以排序后的 `git status --porcelain`
	 * 兜底（未跟踪文件也算变更），diff 非空时正文截断后拼 [diff-meta] 尾段，
	 * 避免大 diff 截断后两轮前缀相同被误判成停滞。
	 */
	private async gitDiff(cwd: string): Promise<string> {
		try {
			const { code, out } = await this.runAsync("git", ["diff", "HEAD"], 10_000, cwd);
			if (code !== 0) return "";
			let status = "";
			try {
				const st = await this.runAsync("git", ["status", "--porcelain"], 10_000, cwd);
				if (st.code === 0) status = st.out;
			} catch {
				// status 拍不到 → 指纹退化为纯 diff，行为与旧版一致
			}
			return buildDiffFingerprint(out, status);
		} catch {
			return "";
		}
	}

	/** Switch to a specific model by "provider/id" (e.g. "anthropic/claude-sonnet-5").
	 *  失败时只发 notice 不抛错（UI 路径靠 notice 提示，见 cycleModel 等调用方）。
	 *  需要「失败即拒绝」的无头路径（插件/定时任务）用 switchModelOrThrow。 */
	async setModel(modelId: string): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = modelId.indexOf("/");
			if (slash <= 0 || slash === modelId.length - 1) {
				throw new Error(`Invalid model ID: ${modelId}`);
			}
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			const model = mr.getModel(provider, id);
			if (!model) throw new Error(`Model not found: ${modelId}`);
			// 先恢复 provider key，再 setModel（否则 checkAuth 鉴权失败）
			await this.restoreKeyForModel(modelId, this.cwd);
			await this.session.setModel(model);
			// Immediately remember the model + the key it uses for the current
			// project (not only after a turn). This is what makes project switching
			// restore both the model and the provider key.
			this.rememberProjectModel(modelId);
			// 换模型后按新模型的窗口重算软上限覆盖（按模型覆盖可能不同，issue #229）。
			this.applyCompactionOverrides();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch model: ${(err as Error).message}`,
				textEn: `Failed to switch model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Set the GLOBAL default model ("provider/id"): projects with no memory
	 *  fall back to it (project memory wins). Also remembers the provider's
	 *  currently-active key globally so new projects restore the same {model,
	 *  key} pair. Shared across clients, persisted server-side. */
	async setDefaultModel(modelId: string): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = modelId.indexOf("/");
			if (slash <= 0 || slash === modelId.length - 1) {
				throw new Error(`Invalid model ID: ${modelId}`);
			}
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			if (!mr.getModel(provider, id)) throw new Error(`Model not found: ${modelId}`);
			this.stateStore.saveDefaultModel(modelId);
			const active = this.modelAdmin.getActiveKeyName(provider);
			if (active) this.stateStore.saveDefaultProviderKey(provider, active);
			// 同步写入 SDK 的 settingsManager，使底层 session 创建时 findInitialModel 也能识别该默认模型
			try {
				this.session.settingsManager.setDefaultModelAndProvider(provider, id);
			} catch {
				/* 会话未就绪时忽略 */
			}
			this.pushDefaultModel();
			this.emit({
				type: "notice",
				level: "info",
				text: `🌍 Global default model set to ${modelId} (new projects follow it; project memory wins)`,
				textEn: `🌍 Global default model set to ${modelId} (new projects follow it; project memory wins)`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to set global default model: ${(err as Error).message}`,
				textEn: `Failed to set global default model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Clear the GLOBAL default model (new projects fall back to the SDK default). */
	clearDefaultModel(): void {
		this.stateStore.clearDefaultModel();
		try {
			this.session.settingsManager.setDefaultModelAndProvider(
				undefined as unknown as string,
				undefined as unknown as string,
			);
		} catch {
			/* 忽略 */
		}
		this.pushDefaultModel();
		this.emit({
			type: "notice",
			level: "info",
			text: "🌍 Global default model cleared (new projects use the SDK default)",
			textEn: "🌍 Global default model cleared (new projects use the SDK default)",
		});
		this.flushSnapshot();
	}

	/** Push the current global default model (attach + after every change). */
	pushDefaultModel(): void {
		this.emit({ type: "default_model", modelId: this.stateStore.getDefaultModel() ?? null });
	}

	/** 切换模型，失败时抛出（无头路径专用：插件 host.chat / 定时任务）。
	 *  setModel 为兼容 UI 把异常吞成 notice（面板要能看到原因、调用方是 fire-and-forget），
	 *  无头路径拿不到那个 notice，于是「模型 ID 打错/没配密钥」会变成静默按旧模型跑 ——
	 *  账单与效果都和用户预期不符。这里统一改成响亮失败。 */
	async switchModelOrThrow(modelId: string): Promise<void> {
		await this.setModel(modelId);
		// 复核结果：读不到（无活跃对话）不阻断，读得到且不符才拒绝。
		// 注意 session 是 getter，无活跃对话时会抛，不能用 `?.` 兜底。
		let curId = "";
		try {
			const cur = this.session?.model;
			curId = cur ? `${cur.provider}/${cur.id}` : "";
		} catch {
			curId = "";
		}
		if (curId && curId !== modelId)
			throw new Error(`Failed to switch model (${modelId}); still on ${curId} — check the model ID and provider key`);
	}

	/** Set the thinking level for future turns. */
	setThinking(level: string): void {
		try {
			const thinkingLevel = level as Parameters<AgentSession["setThinkingLevel"]>[0];
			this.session.setThinkingLevel(thinkingLevel, { persist: true });
			const cur = this.session.model;
			if (cur) {
				this.session.settingsManager.setModelThinkingLevel(cur.provider, cur.id, thinkingLevel);
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch thinking level: ${(err as Error).message}`,
				textEn: `Failed to switch thinking level: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** fast-mode: turn "⚡ Fast" on/off for the chat in view (ChatGPT fast-mode models only; the
	 *  extension never sends the tier to other models anyway). Saved with the chat; any toggle clears
	 *  the "normal speed for now" cooldown, so off-and-on tries fast again right away. */
	setFastMode(on: boolean): void {
		const conv = this.conv;
		if (!conv) return;
		try {
			const sm = conv.session.sessionManager;
			fastModeRegistry.setOn(sm, on === true);
			sm.appendCustomEntry(FAST_MODE_ENTRY, fastModeEntryData(sm, on === true));
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch fast mode: ${(err as Error).message}`,
				textEn: `Failed to switch fast mode: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	cycleThinking(): void {
		try {
			const nextLevel = this.session.cycleThinkingLevel({ persist: true });
			const cur = this.session.model;
			if (cur && nextLevel) {
				this.session.settingsManager.setModelThinkingLevel(cur.provider, cur.id, nextLevel);
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch thinking level: ${(err as Error).message}`,
				textEn: `Failed to switch thinking level: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Push the user command list (.pi/commands.json) to the client. */
	async listCommands(): Promise<void> {
		const { commands, path, warning, warningEn } = await loadCommands(this.cwd);
		if (warning) {
			this.emit({ type: "notice", level: "warning", text: warning, textEn: warningEn });
		}
		this.emit({ type: "commands", commands, path });
	}

	/** Persist the user command list (.pi/commands.json). */
	async saveCommands(commands: CommandDef[]): Promise<void> {
		const { path, error, errorEn } = await saveCommandsFile(this.cwd, commands);
		if (error) {
			this.emit({ type: "notice", level: "error", text: error, textEn: errorEn });
			return;
		}
		this.emit({ type: "commands", commands, path });
		this.emit({ type: "notice", level: "info", text: `Command saved: ${path}`, textEn: `Command saved: ${path}` });
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		ClientSession.liveSessions.delete(this);
		// modelAdmin 是本客户端自己的（OAuth 登录流程挂在它上），下面两条路径都要收。
		this.modelAdmin.dispose();
		// server-owned-chats：对话是**服务端**的，别的客户端可能正在看/正在跑。
		// 一个浏览器断开不该杀掉它们的终端与运行时——本会话只是个视图，走人即可。
		// （进程退出时的整体清理见 AgentService.disposeAll。）
		if (ClientSession.liveSessions.size > 0) {
			this.finishLocalTimers();
			return;
		}
		// 关机路径：Windows 下跳过 pty.kill()（issue #215 ConPTY 死锁），只做
		// TerminateProcess + 状态清理，句柄由 OS 在进程退出时回收。
		for (const conv of this.convs.values()) conv.terminals.killAll({ shutdown: true });
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		if (this.sessionsTimer) {
			clearTimeout(this.sessionsTimer);
			this.sessionsTimer = null;
		}
		if (this.widgetsTimer) {
			clearInterval(this.widgetsTimer);
			this.widgetsTimer = null;
		}
		if (this.stallTimer) {
			clearInterval(this.stallTimer);
			this.stallTimer = null;
		}
		this.files.unwatchDir();
		this.files.unwatchGit();
		this.webUi.dispose();
		// 关闭所有挂起的用户提问（dispose 时以「取消」解析，避免模型挂死）。
		this.cancelPendingQuestions();
		// 同理关闭挂起的页面调用（以失败解析：对面是扩展，没有答可等）。
		this.cancelPendingPageCalls();
		// 挂起的工具审批一并清掉（以「拒绝」解析，防 Promise/runtime 泄漏）。
		this.cancelPendingApprovals();
		this.bg.stop();
		for (const conv of this.convs.values()) {
			this.clearAllToolWatchdogs(conv);
			// 逐个对话回收 eval 内核；下面的兜底再清一次表（含已 delete 的残留）。
			disposeEvalSession(conv.id);
			conv.unsubscribe?.();
			conv.dialogs.cancelAll();
			try {
				await conv.runtime.dispose();
			} catch {
				// best effort
			}
		}
		disposeAllEvalKernels();
	}

	/** 只收本客户端自己的东西（定时器 / 文件监听 / 挂起的提问）——共享对话不动。 */
	private finishLocalTimers(): void {
		for (const timer of [this.snapshotTimer, this.sessionsTimer]) if (timer) clearTimeout(timer);
		this.snapshotTimer = null;
		this.sessionsTimer = null;
		if (this.widgetsTimer) clearInterval(this.widgetsTimer);
		this.widgetsTimer = null;
		if (this.stallTimer) clearInterval(this.stallTimer);
		this.stallTimer = null;
		this.files.unwatchDir();
		this.files.unwatchGit();
		this.webUi.dispose();
		this.cancelPendingQuestions();
		this.cancelPendingPageCalls();
		// telegram-answers: permission prompts are process-wide now; other windows and plugins can
		// still answer them, so a window going away leaves them be (the full dispose denies them).
		this.bg.stop();
	}
}

/** issue #226：插件无头调用的工作目录校验（纯函数，可单测）。
 *  存在性语义与定时任务一致（须存在且为目录，不默默跑错目录）；另在
 *  Windows 下拒绝 SystemRoot 及其子树（如 C:\Windows\System32）——后台服务/
 *  快捷方式启动时宿主 cwd 常飘到 system32，直接跑就是高危误操作。 */
export function checkPluginCwd(cwd: string): { ok: boolean; abs?: string; error?: string } {
	const trimmed = String(cwd ?? "").trim();
	if (!trimmed) return { ok: false, error: "Working directory is empty" };
	let abs: string;
	try {
		abs =
			process.platform === "win32" && /^[A-Za-z]:$/.test(trimmed) ? `${trimmed.toUpperCase()}${sep}` : resolve(trimmed);
	} catch {
		return { ok: false, error: `Invalid working directory: ${trimmed}` };
	}
	try {
		if (!statSync(abs).isDirectory()) throw new Error("not-a-dir");
	} catch {
		return { ok: false, error: `Target project does not exist or is not a directory: ${trimmed}` };
	}
	if (process.platform === "win32") {
		const sysRoot = (process.env.SystemRoot || process.env.windir || "C:\\Windows")
			.replace(/\//g, "\\")
			.replace(/\\+$/, "");
		const norm = abs.replace(/\//g, "\\").replace(/\\+$/, "");
		const low = norm.toLowerCase();
		const rootLow = sysRoot.toLowerCase();
		if (low === rootLow || low.startsWith(`${rootLow}\\`)) {
			return {
				ok: false,
				error: `Refusing to run in a system directory: ${abs} (set a project working directory in the plugin settings)`,
			};
		}
	}
	return { ok: true, abs };
}

export class AgentService {
	/** index.ts 注入：SDK 工具执行事件的插件转发钩子，attach 时拷贝到每个新会话。 */
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	/** index.ts 注入：bash/read 插件拦截钩子，attach 时拷贝到每个新会话。 */
	toolGuard: ToolGuardHook | undefined = undefined;
	/** index.ts 注入：运行轨迹事件的插件转发钩子，attach 时拷贝到每个新会话。 */
	onRunEvent: ((ev: PluginRunEvent) => void) | undefined = undefined;
	/** index.ts 注入：对话切换通知钩子，attach 时拷贝到每个新会话。 */
	onConversationChanged: (() => void) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的 AI 工具（attach 时拷贝到每个新会话）。 */
	pluginToolsProvider: (() => PluginAgentTool[]) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的斜杠命令（attach 时拷贝到每个新会话）。 */
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined = undefined;
	/** index.ts 注入：读取插件注册的常驻后台任务（并入 bg_servers 面板）。 */
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	/** index.ts 注入：停止插件任务（kill_background_server with taskId）。 */
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	/** index.ts 注入：内置调度存储（attach 时拷贝到每个新会话，供 schedule_* 工具）。 */
	schedulerStore: SchedulerStore | undefined = undefined;
	private clients = new Map<string, ClientSession>();
	/** 全局认领表（跨浏览器标签页共享；<dataDir>/claims.json，best-effort 持久化）。 */
	private claimStore: ClaimStore;
	/** Quiesce (draining) state — the service refuses NEW work (prompts, forks,
	 *  session resumes, new clients) so a deploy/upgrade/backup can stop cleanly
	 *  once existing runs finish. Controlled via the local control socket:
	 *  `pi-web-ui server quiesce|unquiesce`. */
	private quiesced = false;
	private quiescedAt = 0;
	/** Attached browser sockets (reported by index.ts on open/close) — the
	 *  control socket reports real sockets, not cached client-session objects. */
	private socketCount = 0;
	private pending = new Map<string, Promise<ClientSession>>();
	private stateStore: ClientStateStore;
	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** 任意客户端成功切换工作区后触发（新绝对路径 + 该项目的额外工作区根）。
	 *  index.ts 接到 PluginManager.notifyCwd / notifyWorkspaceRoots，让插件宿主的
	 *  host.cwd 实时跟随当前项目、受支持路径范围跟着多根变。 */
	onClientCwdChanged: ((cwd: string, roots: string[]) => void) | undefined = undefined;

	constructor(
		private cwd: string,
		stateFile: string,
	) {
		this.stateStore = new ClientStateStore(stateFile);
		this.claimStore = new ClaimStore(join(this.stateStore.dataDir, "claims.json"));
	}

	/** Get or create the session for a client, racing attach calls safely. */
	/** True while the service is draining — new work is refused. */
	isQuiesced(): boolean {
		return this.quiesced;
	}

	/** Enter quiesce: stop admitting new work. Existing runs keep going. */
	quiesce(): void {
		this.quiesced = true;
		this.quiescedAt = Date.now();
	}

	/** Leave quiesce: admit new work again. */
	unquiesce(): void {
		this.quiesced = false;
		this.quiescedAt = 0;
	}

	/** Snapshot for the control socket / status command. */
	quiesceInfo(): { quiesced: boolean; quiescedSince?: number } {
		return this.quiesced ? { quiesced: true, quiescedSince: this.quiescedAt } : { quiesced: false };
	}

	/** issue #145：除请求方外是否有客户端正在跑（扫目录查重前置的无 I/O 判断）。 */
	hasStreamingElsewhere(excludeClientId: string): boolean {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				if (cs.activeConversations() > 0) return true;
			} catch {
				// 单客户端坏了不影响判断
			}
		}
		return false;
	}

	/** issue #145：跨客户端同会话查重 —— 找持有某 session 文件的别处对话。
	 *  调用方在 SessionManager.open() 之前问这一句，就造不出第二个 writer。 */
	findSessionOwner(targetPath: string, excludeClientId: string): SessionOwnerInfo | null {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			const conv = cs.findConversationBySessionFile(targetPath);
			if (conv) {
				return {
					clientId,
					title: conv.title,
					cwd: conv.cwd,
					isStreaming: cs.conversationStreaming(conv),
					connected: cs.sinkCount() > 0,
				};
			}
		}
		return null;
	}

	/** 插件 steer 跨客户端兜底：除请求方外逐个问其他客户端的 conversations，
	 *  找到持有方由其执行 steer（只调 steerOwnConversation，不碰钩子，无递归）；
	 *  都找不到回 undefined，调用方回未知对话。单客户端异常跳过，不影响其他。 */
	async steerElsewhere(
		excludeClientId: string,
		id: string,
		text: string,
	): Promise<{ ok: boolean; error?: string } | undefined> {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				const r = await cs.steerOwnConversation(id, text);
				if (r) return r;
			} catch {
				// 单客户端坏了继续找下一个
			}
		}
		return undefined;
	}

	/** issue #193：定时任务唤醒发起对话。逐个客户端找持有方，用 steer 语义投递
	 *  （运行时插队、未跑时普通投递，不切用户当前对话）；都找不到回 ok:false，
	 *  调用方（index.ts executor）回落视口/无头执行。quiesced 时直接拒绝。
	 *  issue #226：成功时带回持有方 clientId（插件绑定网页会话时原样回执）。
	 *  issue #231：opts.sessionFile 是跨压缩/重启的稳定键 —— 优先按它认同一会话
	 *  （内存对话 id 重启即失效，压缩后同文件对话可能已换新 id，成功时带回**实际**
	 *  投递的 conversationId + sessionFile，调用方据此重绑定任务）；id 相位带 cwd
	 *  护栏（各客户端计数器都从 c1 开始，不校验会把报告投进无关项目）。压缩进行中
	 *  的持有方回 busy:true（调用方另寻视口兄弟，而不是当成“不在”静默转无头）。 */
	async wakeConversation(
		id: string,
		text: string,
		opts?: { sessionFile?: string; cwd?: string },
	): Promise<{
		ok: boolean;
		conversationId?: string;
		sessionFile?: string;
		clientId?: string;
		busy?: boolean;
		error?: string;
	}> {
		const wantFile = String(opts?.sessionFile ?? "").trim();
		const wantCwd = String(opts?.cwd ?? "").trim();
		if ((!id && !wantFile) || !text.trim()) return { ok: false, error: "Wake target or text is empty" };
		if (this.quiesced) return { ok: false, error: "Server is busy (quiesced), retry later" };
		const liveFile = (c: Conversation): string => {
			try {
				return String(c.session.sessionFile ?? "");
			} catch {
				return "";
			}
		};
		const flush = (cs: ClientSession): void => {
			try {
				cs.flushSnapshot();
			} catch {
				// 推送失败不影响已投递的唤醒
			}
		};
		// 相位一：落盘会话文件（稳定键）。同文件可能在多处打开，取最近活跃者；
		// 全部忙（压缩中）则报 busy，调用方去找视口兄弟。
		if (wantFile) {
			const hits: { cs: ClientSession; clientId: string; conv: Conversation }[] = [];
			for (const [clientId, cs] of this.clients) {
				try {
					const conv = cs.resolveSchedulerTarget({ sessionFile: wantFile });
					if (conv) hits.push({ cs, clientId, conv });
				} catch {
					// 单客户端坏了继续找下一个
				}
			}
			hits.sort((a, b) => b.conv.lastActiveAt - a.conv.lastActiveAt);
			let busyError: string | undefined;
			for (const h of hits) {
				try {
					const r = await h.cs.trySteerScheduler(h.conv, text);
					if (r.ok) {
						flush(h.cs);
						return { ok: true, conversationId: h.conv.id, sessionFile: liveFile(h.conv), clientId: h.clientId };
					}
					if (r.busy) busyError = r.error;
					// 非忙失败（投递异常）试下一个同文件持有方
				} catch {
					// 单客户端坏了继续找下一个
				}
			}
			if (hits.length > 0) {
				if (busyError) return { ok: false, busy: true, error: busyError };
				// 同文件持有方都在但都投递失败 —— id 相位大概率指向同一批，无需再试
				return { ok: false, error: "Delivery to the target conversation failed (owner error)" };
			}
			// No chat has the transcript open: a miss (wake-reopen: the caller reopens it; no id phase).
		}
		// 相位二：内存对话 id（易失键，必须配 cwd 护栏防跨项目串台）。
		// wake-reopen: only when the transcript isn't known (old tasks, plugins). When it is, the
		// transcript is who the chat is: chat ids start again at c1 after a restart, so an old id
		// can name a different chat of the same project. The caller reopens the transcript instead.
		if (id && !wantFile) {
			const hits: { cs: ClientSession; clientId: string; conv: Conversation }[] = [];
			for (const [clientId, cs] of this.clients) {
				try {
					const conv = cs.resolveSchedulerTarget({
						conversationId: id,
						...(wantCwd ? { cwd: wantCwd } : {}),
					});
					if (conv) hits.push({ cs, clientId, conv });
				} catch {
					// 单客户端坏了继续找下一个
				}
			}
			hits.sort((a, b) => b.conv.lastActiveAt - a.conv.lastActiveAt);
			let busyError: string | undefined;
			for (const h of hits) {
				try {
					const r = await h.cs.trySteerScheduler(h.conv, text);
					if (r.ok) {
						flush(h.cs);
						return { ok: true, conversationId: h.conv.id, sessionFile: liveFile(h.conv), clientId: h.clientId };
					}
					if (r.busy) busyError = r.error;
				} catch {
					// 单客户端坏了继续找下一个
				}
			}
			if (busyError) return { ok: false, busy: true, error: busyError };
		}
		return { ok: false, error: "Target conversation is not running (closed, or the server restarted)" };
	}

	/**
	 * wake-reopen: a scheduled wake-up whose chat isn't open (closed, or left idle through a
	 * restart, which only reopens working chats) reopens that chat and is delivered there, the
	 * way carry-on reopens the chats a restart cut off. Before, it went to whichever chat of the
	 * project was active last (wakeViewportInCwd), which is someone else's conversation.
	 * One at a time: the wake-up client has one active chat.
	 * ok:false = it couldn't be reopened (transcript gone, project full, …); the caller then
	 * falls back as before.
	 */
	async wakeClosedChat(
		sessionFile: string,
		text: string,
	): Promise<{ ok: boolean; conversationId?: string; sessionFile?: string; error?: string }> {
		const file = String(sessionFile ?? "").trim();
		if (!file || !text.trim()) return { ok: false, error: "Wake target or text is empty" };
		if (this.quiesced) return { ok: false, error: "Server is busy (quiesced), retry later" };
		if (!existsSync(file)) return { ok: false, error: "the chat's transcript is gone" };
		const run = this.wakeReopenChain.then(() => this.reopenAndWake(file, text));
		this.wakeReopenChain = run.catch(() => {});
		return run;
	}

	private wakeReopenChain: Promise<unknown> = Promise.resolve();

	private async reopenAndWake(
		file: string,
		text: string,
	): Promise<{ ok: boolean; conversationId?: string; sessionFile?: string; error?: string }> {
		try {
			const cs = await this.attach(WAKE_REOPEN_CLIENT_ID, WAKE_REOPEN_SINK);
			try {
				// Reopens the chat (or switches to it, if it got opened in the meantime), sends the
				// wake-up, and keeps it in the running list once its run has started.
				if (!(await cs.carryOn(file, text))) return { ok: false, error: "couldn't reopen the chat" };
				const conv = cs.resolveSchedulerTarget({ sessionFile: file });
				let live = file;
				try {
					live = String(conv?.session.sessionFile ?? file);
				} catch {
					// session being replaced: keep the file we opened
				}
				// Open windows list it now (a window that connects later gets it with its first list).
				this.pokeExternalRunning(WAKE_REOPEN_CLIENT_ID);
				return { ok: true, conversationId: conv?.id, sessionFile: live };
			} finally {
				// Nobody watches through this client: the chat counts as unwatched (its done ring rings).
				this.detach(WAKE_REOPEN_CLIENT_ID, WAKE_REOPEN_SINK);
			}
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** queue-lanes: taken back down in disposeAll. */
	private uninstallQueueHost: (() => void) | null = null;
	/** queue-lanes: one task chat opened at a time, one chat opened for a command at a time. */
	private queueTasksChain = makeChain();
	private queueHomeChain = makeChain();

	/**
	 * queue-lanes: offer pi-queue a way to run queued tasks in chats of their own (queue-host.ts).
	 * The command-line pi has none; there tasks run in the queue's chat as before.
	 */
	installQueueHost(): void {
		if (this.uninstallQueueHost) return;
		// telegram-answers: a stuck task's answer from elsewhere (Telegram, the Queue tab) goes into its
		// chat the way a scheduled wake-up does: the chat is opened (or switched to) and gets the text.
		ClientSession.stuckAnswerSender = async (file, text) => {
			const r = await this.wakeClosedChat(file, text);
			return r.ok ? { ok: true } : { ok: false, error: r.error ?? "couldn't send the answer" };
		};
		this.uninstallQueueHost = installQueueHost({
			startChat: (o) =>
				this.queueTasksChain(() => this.withQueueClient(QUEUE_TASKS_CLIENT_ID, (cs) => cs.openTaskChat(o))),
			runCommand: (file, line) => this.queueRunCommand(file, line),
			closeChat: (file) => this.queueCloseChat(file),
		});
	}

	/** queue-lanes: do something through one of the queue's pseudo clients; open windows list the result. */
	private async withQueueClient<T>(clientId: string, fn: (cs: ClientSession) => Promise<T>): Promise<T> {
		if (this.quiesced) throw new Error("the server is busy (quiesced)");
		const cs = await this.attach(clientId, QUEUE_HOST_SINK);
		try {
			return await fn(cs);
		} finally {
			this.pokeExternalRunning(clientId);
			// Nobody watches through this client: its chats count as unwatched (their done ring rings).
			this.detach(clientId, QUEUE_HOST_SINK);
		}
	}

	/** queue-lanes: the open chat with this transcript, in any client. */
	private queueSessionFor(file: string): AgentSession | null {
		for (const cs of this.clients.values()) {
			try {
				const s = cs.queueSessionFor(file);
				if (s) return s;
			} catch {
				// one broken client doesn't stop the search
			}
		}
		return null;
	}

	/** queue-lanes: run a "/queue ..." line in the chat with this transcript, opening it if it isn't open. */
	private async queueRunCommand(file: string, line: string): Promise<boolean> {
		const run = async (session: AgentSession | null): Promise<boolean> => {
			// No /queue command (pi-queue isn't loaded there): prompt() would send the line to the model.
			if (!session?.extensionRunner?.getCommand?.("queue")) return false;
			await session.prompt(line);
			return true;
		};
		const open = this.queueSessionFor(file);
		if (open) return run(open);
		if (!existsSync(file)) return false;
		return this.queueHomeChain(() =>
			this.withQueueClient(QUEUE_HOME_CLIENT_ID, async (cs) =>
				run(this.queueSessionFor(file) ?? (await cs.openChatForQueue(file))),
			),
		);
	}

	/**
	 * queue-lanes: a done (or removed) task's chat leaves the running list once it is idle (at most 2
	 * minutes). queue-done-hidden: it leaves Recent chats too, with the same tombstone as its ✕ there,
	 * set before every window's list is read again. Its transcript stays: History lists it, the queue's
	 * links open it, and opening it puts it back in Recent chats (markRecentSeen). Only a queued task's
	 * own chat gets the tombstone, also when it isn't open any more.
	 */
	private async queueCloseChat(file: string): Promise<boolean> {
		const session = this.queueSessionFor(file);
		if (session) await waitUntil(() => !session.isStreaming && !session.isCompacting, 120_000, 500);
		const open = this.queueSessionFor(file);
		const taskChat = open ? isQueueTaskChatEntries(open.sessionManager.getEntries()) : await isQueueTaskChatFile(file);
		return this.queueTasksChain(async () => {
			if (taskChat) this.stateStore.removeRecent(resolve(file));
			for (const cs of this.clients.values()) {
				try {
					if (cs.releaseQueueChat(file)) return true;
				} catch {
					// try the next client
				}
			}
			if (taskChat) ClientSession.recentChangedForAll();
			return taskChat;
		});
	}

	/** issue #231：同项目视口回退 —— 原绑定对话不在时，把唤醒投给该项目最近活跃
	 *  的对话（用户当前正看着的面），而不是静默转无头。excludeIds 跳过已知忙对话；
	 *  候选全部忙回 busy:true；无候选回 ok:false。成功带回实际投递方（调用方重绑定）。 */
	async wakeViewportInCwd(
		cwd: string,
		text: string,
		excludeIds?: Set<string>,
	): Promise<{
		ok: boolean;
		conversationId?: string;
		sessionFile?: string;
		clientId?: string;
		busy?: boolean;
		error?: string;
	}> {
		const want = String(cwd ?? "").trim();
		if (!want || !text.trim()) return { ok: false, error: "Fallback target or text is empty" };
		if (this.quiesced) return { ok: false, error: "Server is busy (quiesced), retry later" };
		const cands: { cs: ClientSession; clientId: string; conv: Conversation }[] = [];
		for (const [clientId, cs] of this.clients) {
			try {
				const conv = cs.findViewportInCwd(want, excludeIds);
				if (conv) cands.push({ cs, clientId, conv });
			} catch {
				// 单客户端坏了继续找下一个
			}
		}
		cands.sort((a, b) => b.conv.lastActiveAt - a.conv.lastActiveAt);
		if (cands.length === 0) return { ok: false, error: "No live conversation in the same project" };
		let busyError: string | undefined;
		for (const c of cands) {
			try {
				const r = await c.cs.trySteerScheduler(c.conv, text);
				if (r.ok) {
					try {
						c.cs.flushSnapshot();
					} catch {
						// 推送失败不影响已投递的唤醒
					}
					let f = "";
					try {
						f = String(c.conv.session.sessionFile ?? "");
					} catch {
						f = "";
					}
					return { ok: true, conversationId: c.conv.id, sessionFile: f, clientId: c.clientId };
				}
				if (r.busy) busyError = r.error;
			} catch {
				// 单客户端坏了继续找下一个
			}
		}
		if (busyError) return { ok: false, busy: true, error: busyError };
		return { ok: false, error: "Delivery to a same-project conversation failed" };
	}

	/** issue #145：别处在某 cwd 下正在跑的对话（同项目并行感知用，不含请求方）。 */
	listProjectRunners(cwd: string, excludeClientId: string): ProjectRunnerInfo[] {
		const out: ProjectRunnerInfo[] = [];
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			for (const r of cs.streamingInCwd(cwd)) out.push({ clientId, title: r.title, sessionFile: r.sessionFile });
		}
		return out;
	}

	/** 按 SDK 会话（runtime 身份）找它当前归属的客户端会话与对话 id（过户后归属会变）：
	 *  桥接工具（问卷 / 页面）在调用瞬间用它投递，见 ClientSession.bridgeTarget。
	 *  一条对话任一时刻只属于一个会话（过户先摘后插），扫一遍即可 —— 问卷/截图都是
	 *  低频调用，不值得为此再维护一张全局索引。
	 *
	 *  server-owned-chats：对话表进程共享，**每个**客户端都持有每条对话，上面「第一个
	 *  持有者 = 归属方」在这里等于按接入顺序随便挑 —— 表里最早的往往是插件/调度伪客户端
	 *  （sink 是空函数，page_request 石沉大海，干等到超时），或早已刷新掉的旧标签页
	 *  （client-per-load 每次刷新都是新会话，旧的留在表里、没有 socket，browser_page 当场
	 *  报「没有已连接的页面」）。所以按这个顺序挑：正开着这条对话的在线浏览器 →
	 *  任一在线浏览器（都取最新接入的）→ 任一浏览器（pageCall 会当场报没有页面，而不是
	 *  干等）→ 上游口径。问卷走广播 + 进程共享登记表，挑谁都一样；在乎的是 browser_page
	 *  （只发给一个客户端）。见 tests/unit/conversation-home.test.ts。 */
	findConversationHome(sdkSession: AgentSession): { session: ClientSession; convId: string } | undefined {
		type Home = { session: ClientSession; convId: string };
		let first: Home | undefined;
		let browser: Home | undefined;
		let live: Home | undefined;
		let viewer: Home | undefined;
		for (const [clientId, cs] of this.clients) {
			let convId: string | undefined;
			try {
				convId = cs.conversationIdOfSession(sdkSession);
			} catch {
				continue; // 单客户端坏了不影响解析
			}
			if (!convId) continue;
			const hit: Home = { session: cs, convId };
			first ??= hit;
			if (AgentService.isPseudoClientId(clientId)) continue;
			browser ??= hit;
			let online = false;
			try {
				online = cs.sinkCount() > 0;
			} catch {
				online = false;
			}
			if (!online) continue;
			// Map 按接入顺序迭代：留到最后的就是最新接入的。
			live = hit;
			try {
				if (cs.isViewing(convId)) viewer = hit;
			} catch {
				// 视图状态读不到就不算在看
			}
		}
		return viewer ?? live ?? browser ?? first;
	}

	/** issue #145 的「另一处正在运行」在 server-owned-chats 之后已无意义：对话表是
	 *  进程共享的，别处在跑的对话**本来就在**每个客户端的 conversations 列表里。
	 *  再补一份 elsewhere 只会让左栏出现重复行，所以这里恒为空（wire 字段保留，
	 *  老客户端拿到空数组即可）。 */
	listExternalRunning(_excludeClientId: string): ElsewhereRunning[] {
		return [];
	}

	/** issue #291：删除定时任务后回收对应伪客户端，避免残留在 elsewhere 列表。 */
	releaseSchedulerClient(taskId: string): void {
		const safe = String(taskId ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "task";
		const clientId = `scheduler:${safe}`;
		const cs = this.clients.get(clientId);
		if (!cs) return;
		// 伪客户端常驻一个 noop sink（chatFromScheduler 的 attach），所以不能按
		// sinkCount 判断「有没有浏览器」—— 它永远为 1。这里就是它的回收点。
		this.clients.delete(clientId);
		// 先摘出 map 再异步 dispose：只删 map 的话，对话的 runtime/终端/看门狗
		// 计时器全都留在内存里（泄漏），转录还挂着活 writer（同文件双写者风险）。
		void cs.dispose().catch(() => {
			// 回收失败不拦主流程：尽力而为，进程退出时 OS 兜底
		});
		// 通知其他客户端刷新 elsewhere 列表。
		this.pokeExternalRunning(clientId);
	}

	/** issue #145: 某客户端流式集合变化 → 其他客户端重推 conversations。 */
	/** list-freeze: windows waiting for their coalesced list refresh (see pokeExternalRunning). */
	private readonly pokedClients = new Set<string>();
	private pokeTimer: ReturnType<typeof setImmediate> | null = null;

	/** Every other window rebuilds its running list (their Elsewhere rows changed).
	 *  list-freeze: the rebuilds wait for the end of the current turn of the event loop, and a window
	 *  poked several times meanwhile rebuilds once. Each window's rebuild used to poke all the others
	 *  straight away, so one change cost windows-times-windows rebuilds and froze the server with big chats. */
	pokeExternalRunning(excludeClientId: string): void {
		for (const clientId of this.clients.keys()) if (clientId !== excludeClientId) this.pokedClients.add(clientId);
		if (this.pokeTimer || this.pokedClients.size === 0) return;
		this.pokeTimer = setImmediate(() => {
			this.pokeTimer = null;
			const ids = [...this.pokedClients];
			this.pokedClients.clear();
			for (const clientId of ids) {
				const cs = this.clients.get(clientId);
				if (!cs) continue;
				try {
					cs.refreshExternalRunning();
				} catch {
					// 单客户端坏了不影响其他
				}
			}
		});
		this.pokeTimer.unref?.();
	}

	/** issue #145：向除请求方外的所有客户端发一条 notice（并行通告用）。 */
	notifyClientsExcept(
		excludeClientId: string,
		msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string },
	): void {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				// 经 ClientSession.emit 才能进该客户端的 sink 组播；用公开发送面。
				cs.sendNotice(msg);
			} catch {
				// 单客户端坏了不影响其他
			}
		}
	}

	/** busy-endpoint：见 ClientSession.busyConversations（对话表进程共享，不按客户端累加）。 */
	busyConversations(): BusyConversation[] {
		return ClientSession.busyConversations();
	}

	/** lazy-images: GET /api/chat-image (see ClientSession.chatImage). */
	chatImage(sessionId: string, msgId: string, n: number, v: string): ChatImage | null {
		return ClientSession.chatImage(sessionId, msgId, n, v);
	}

	/** Aggregate across every client session: conversations with in-flight runs. */
	activeConversations(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.activeConversations();
		return n;
	}

	/** Aggregate across every client session: messages queued in the SDK. */
	pendingMessages(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.pendingMessages();
		return n;
	}

	/** 插件用：全客户端最近活跃对话的快照（at 最大者即“当前打开的对话”）。 */
	readConversationForPlugins(): PluginConversationSnapshot | null {
		let best: PluginConversationSnapshot | null = null;
		for (const cs of this.clients.values()) {
			try {
				const s = cs.readConversationForPlugins();
				if (s && (!best || s.at > best.at)) best = s;
			} catch {
				/* 单客户端坏了不影响其他 */
			}
		}
		return best;
	}

	/** 插件无头调用（host.chat 的落地）：外部通道（微信等）把文本投给 agent。
	 *  每个 (pluginId, accountId) 独立伪客户端——复用 attach 完整链路
	 *  （会话恢复/持久化/工具注入/快照），无浏览器也能跑；sink 是空函数，
	 *  快照/notice 发了即丢，不攒内存。fire-and-forget：prompt 投递即返回，
	 *  运行结果经 onRunEvent(run_end) 按 conversationId 关联。
	 *  v1 语义：与该服务 cwd 下最近会话共享（单用户视角连续）；peer 名由插件
	 *  拼进文本前缀，per-peer 会话隔离以后再加。
	 *  issue #226：对齐定时任务的四件套——conversationId 命中时走 steer 语义
	 *  投递（网页端实时可见，miss 则回落无头）；cwd 显式 pin 住（不存在/系统
	 *  目录即拒绝，不默默跑错目录）；model/thinkingLevel 投递前应用（失败即
	 *  拒绝，不回落，避免账单/效果与预期不符）。 */
	async chatFromPlugin(pluginId: string, req: PluginChatRequest): Promise<PluginChatResult> {
		const safe = String(pluginId ?? "plugin").replace(/[^A-Za-z0-9_-]/g, "") || "plugin";
		const acct = String(req?.accountId ?? "default").replace(/[^A-Za-z0-9_-]/g, "") || "default";
		const clientId = `plugin:${safe}:${acct}`;
		const text = String(req?.text ?? "");
		if (!text.trim()) throw new Error("chatFromPlugin: text is empty");
		if (this.quiesced) throw new QuiesceRejectedError("Headless plugin call refused; retry after the server recovers");
		// 1. 绑定已有会话：steer 语义投递，网页端实时可见（微信当远程遥控器用）。
		// miss/已回收时不抛错，回落无头伪客户端（浏览器关着时微信照常可用）。
		const target = String(req?.conversationId ?? "").trim();
		if (target) {
			const w = await this.wakeConversation(target, text);
			if (w.ok) return { conversationId: target, clientId: w.clientId ?? clientId };
		}
		// 2. 工作空间：不传回落伪客户端当前目录；传了必须存在且非系统目录。
		const cwdReq = String(req?.cwd ?? "").trim();
		let cwdAbs = "";
		if (cwdReq) {
			const chk = checkPluginCwd(cwdReq);
			if (!chk.ok) throw new Error(`chatFromPlugin: ${chk.error}`);
			cwdAbs = chk.abs ?? "";
		}
		const cs = await this.attach(clientId, () => {});
		try {
			if (cwdAbs && cs.cwd !== cwdAbs) await cs.setCwd(cwdAbs);
		} catch (err) {
			throw new Error(`chatFromPlugin: failed to switch working directory (${cwdAbs}): ${(err as Error).message}`);
		}
		const model = String(req?.model ?? "").trim();
		if (model) {
			try {
				await cs.switchModelOrThrow(model);
			} catch (err) {
				throw new Error(`chatFromPlugin: failed to switch model (${model}): ${(err as Error).message}`);
			}
		}
		const thinking = String(req?.thinkingLevel ?? "").trim();
		if (thinking) {
			try {
				cs.setThinking(thinking);
			} catch (err) {
				throw new Error(`chatFromPlugin: failed to switch thinking level (${thinking}): ${(err as Error).message}`);
			}
		}
		const conversationId = cs.readConversationForPlugins()?.conversationId ?? "";
		void cs.prompt(text);
		return { conversationId, clientId };
	}

	/** 内置定时任务的无头执行（issue #184，server/scheduler-tasks.ts 的 executor）。
	 *  每个任务独立伪客户端 `scheduler:<taskId>`（专属会话连续、无浏览器也能跑）；
	 *  cwd 按任务配置 pin 住（不存在即失败，不默默跑错目录）；可选模型/思考强度
	 *  在投递前应用（失败即返回错误，不回落，避免账单/效果与预期不符）。
	 *  fire-and-forget 投递后等待运行结束（最长 10 分钟轮询），回填真实 outcome
	 * （成功/失败/耗时/会话 id）供历史记录与通知使用；超时按失败记录（运行本身
	 *  不中止，继续在后台跑完）。 */
	async chatFromScheduler(task: {
		id: string;
		cwd: string;
		prompt: string;
		model?: string;
		thinkingLevel?: string;
	}): Promise<{ ok: boolean; conversationId?: string; error?: string }> {
		const safe = String(task.id ?? "task").replace(/[^A-Za-z0-9_-]/g, "") || "task";
		const clientId = `scheduler:${safe}`;
		const text = String(task.prompt ?? "");
		if (!text.trim()) return { ok: false, error: "Trigger prompt is empty" };
		if (this.quiesced) return { ok: false, error: "Server is busy (quiesced), retry later" };
		const cwd = String(task.cwd ?? "").trim();
		try {
			if (!cwd || !statSync(cwd).isDirectory()) throw new Error("not-a-dir");
		} catch {
			return { ok: false, error: `Target project does not exist or is not a directory: ${cwd || "(empty)"}` };
		}
		try {
			const cs = await this.attach(clientId, () => {});
			if (cs.cwd !== cwd) await cs.setCwd(cwd);
			const model = String(task.model ?? "").trim();
			if (model) {
				try {
					await cs.switchModelOrThrow(model);
				} catch (err) {
					return { ok: false, error: `Failed to switch model (${model}): ${(err as Error).message}` };
				}
			}
			const thinking = String(task.thinkingLevel ?? "").trim();
			if (thinking) {
				try {
					cs.setThinking(thinking);
				} catch (err) {
					return { ok: false, error: `Failed to switch thinking level (${thinking}): ${(err as Error).message}` };
				}
			}
			const conversationId = cs.readConversationForPlugins()?.conversationId ?? "";
			void cs.prompt(`[Scheduled task] ${text}`);
			// 等待运行结束：每 2s 轮询，最长 10 分钟。超时按失败记录（运行继续）。
			const deadline = Date.now() + 10 * 60 * 1000;
			for (;;) {
				await new Promise((r) => setTimeout(r, 2000));
				let streaming = false;
				let lastError: string | undefined;
				try {
					const snap = cs.readConversationForPlugins();
					streaming = snap?.isStreaming === true;
					const msgs = snap?.messages ?? [];
					for (let i = msgs.length - 1; i >= 0; i--) {
						const m = msgs[i];
						if (m.role === "assistant" && m.errorMessage) {
							lastError = m.errorMessage;
							break;
						}
						if (m.role === "assistant") break;
					}
				} catch {
					streaming = false;
				}
				if (!streaming) {
					if (lastError) return { ok: false, conversationId: conversationId || undefined, error: lastError };
					return { ok: true, conversationId: conversationId || undefined };
				}
				if (Date.now() >= deadline)
					return {
						ok: false,
						conversationId: conversationId || undefined,
						error: "Run timed out (10 min); it continues in the background",
					};
			}
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** 插件直调模型（host.llm.complete 的落地）：孤立无工具的一次性补全。
	 *  不建对话、不进历史、不碰任何会话状态；花费走用户自己的模型额度。
	 *  quiesced 时拒绝；无客户端时用进程 cwd + 默认模型照常跑。 */
	async completeForPlugins(
		pluginId: string,
		req: { prompt?: string; system?: string; model?: string; maxChars?: number; timeoutMs?: number },
	): Promise<{
		ok: boolean;
		text?: string;
		model?: string;
		usage?: { input: number; output: number };
		error?: string;
	}> {
		try {
			if (this.quiesced) return { ok: false, error: "Plugin LLM call refused; retry after the server recovers" };
			let env: { cwd: string; agentDir: string; fallbackModel?: { provider: string; id: string } };
			const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
			try {
				const cs = this.pluginClient();
				env = cs?.llmEnvForPlugins() ?? { cwd: this.cwd, agentDir };
			} catch {
				env = { cwd: this.cwd, agentDir };
			}
			const mod = await import("./plugin-llm.js");
			const r = await mod.completeWithIsolatedSession(env, { ...req, prompt: String(req?.prompt ?? "") });
			if (!r.ok) return r;
			console.log(`[plugin:${pluginId}] llm.complete ok (model ${r.model}, output ${r.text.length} chars)`);
			return r;
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** index.ts calls this when a browser socket opens/closes. */
	noteSocketOpen(): void {
		this.socketCount += 1;
	}
	noteSocketClose(): void {
		this.socketCount = Math.max(0, this.socketCount - 1);
	}

	/** Full status for the control socket / `server status` command. */
	serviceStatus(): {
		pid: number;
		version: string;
		cwd: string;
		quiesced: boolean;
		quiescedSince?: number;
		connectedClients: number;
		activeConversations: number;
		pendingMessages: number;
		/** 托管本实例的平台服务（null = 前台/dev/Docker）——CLI 的
		 *  `server status` 据此显示启动方式，见 launch-origin.ts。 */
		service: UiServiceInfo | null;
	} {
		return {
			pid: process.pid,
			version: VERSION,
			cwd: this.cwd,
			...this.quiesceInfo(),
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
			service: toServiceInfo(launchOrigin()),
		};
	}

	/** 插件/调度伪客户端：sink 常驻（fire-and-forget 的空函数），不能按浏览器存活判断。
	 *  reload-adopt：ClientSession.setCwd 也用它（伪客户端不接管别人的对话），所以不是 private。 */
	static isPseudoClientId(id: string): boolean {
		return id.startsWith("plugin:") || id.startsWith("scheduler:") || id.startsWith(CARRY_ON_CLIENT_PREFIX);
	}

	/**
	 * 浏览器重启认领：给 fresh clientId 找一个可接管的断开残留会话（返回旧 id）。
	 * 有别的在线浏览器时返回 null（issue #10 隔离优先）。
	 * 全同步：attach 里的认领段不含 await，并发的新标签后到者看到 sinkCount>0，
	 * 不会抢走同一个残留。
	 */
	private findAdoptableOrphan(excludeClientId: string): { oldId: string; cs: ClientSession } | null {
		const cands: OrphanCandidate[] = [];
		for (const [id, cs] of this.clients) {
			if (id === excludeClientId) continue;
			const pseudo = AgentService.isPseudoClientId(id);
			let live = false;
			let streaming = 0;
			let adoptable = false;
			let activity = 0;
			try {
				live = cs.sinkCount() > 0;
			} catch {
				live = false;
			}
			if (!pseudo && !live) {
				try {
					streaming = cs.activeConversations();
				} catch {
					streaming = 0;
				}
				try {
					adoptable = cs.hasAdoptableContent();
				} catch {
					adoptable = false;
				}
				try {
					activity = cs.latestActivity();
				} catch {
					activity = 0;
				}
			}
			cands.push({ id, live, pseudo, streaming, adoptable, activity });
		}
		const picked = pickAdoptableOrphan(cands);
		if (!picked) return null;
		const cs = this.clients.get(picked);
		return cs ? { oldId: picked, cs } : null;
	}

	/**
	 * 跨客户端感知接线（同会话查重 / 同项目并行 / elsewhere 列表 / 跨端 steer）。
	 * attach 尾部与认领分支共用 —— 认领换了 map 键，必须在首帧推送（attachSink）
	 * 前就按新 id 重接，否则 self-exclusion 失效：把自己当成“另一处”（elsewhere
	 * 误报 + prompt/switch 自拦）。尾部会再调一次，幂等。
	 */
	private wireClient(cs: ClientSession, clientId: string): void {
		cs.findSessionOwner = (targetPath) => this.findSessionOwner(targetPath, clientId);
		cs.hasStreamingElsewhere = () => this.hasStreamingElsewhere(clientId);
		cs.listProjectRunners = (cwd) => this.listProjectRunners(cwd, clientId);
		cs.getClaimStore = () => this.claimStore;
		cs.findConversationHome = (sdkSession) => this.findConversationHome(sdkSession);
		cs.listExternalRunning = () => this.listExternalRunning(clientId);
		cs.notifyExternalClients = (msg) => this.notifyClientsExcept(clientId, msg);
		cs.onRunningChanged = () => this.pokeExternalRunning(clientId);
		cs.steerConversationElsewhere = (id, text) => this.steerElsewhere(clientId, id, text);
		cs.schedulerStore = this.schedulerStore;
	}

	/**
	 * 手动过户（take_over_conversation）：把 owner 会话的某主对话（含子代理后代、
	 * 等答复问卷/页调用）整体搬到 target 会话并切过去。搬的是 runtime 本体不是
	 * 副本，单 writer 不变 —— 从在线标签页手里接管也是安全的；源会话修好 active
	 * 并推全量刷新，双方都收到去向通知。quiesce 排空期也放行（重连既有工作）。
	 */
	async takeOverConversation(targetId: string, ownerId: string, convId: string): Promise<void> {
		const target = this.clients.get(targetId);
		if (!target) return;
		const fail = (text: string, textEn: string): void => {
			target.sendNotice({ type: "notice", level: "warning", text, textEn });
		};
		if (!ownerId || !convId) {
			fail(
				"Takeover target unclear (missing owner/id), please retry.",
				"Takeover target unclear (missing owner/id), please retry.",
			);
			return;
		}
		// server-owned-chats：对话表进程共享，目标手里本来就有这条对话 → 也只是切过去。
		// 下面搬 runtime 的路径（detach + insert）在共享表上会把它从所有窗口摘掉再塞回来。
		// 见 tests/unit/takeover-shared-table.test.ts。
		if (ownerId === targetId || target.takeoverBriefs().some((b) => b.id === convId)) {
			// 自己的对话 → 退化为普通切换。
			try {
				await target.switchConversation(convId);
			} catch {
				/* switch 内部已用 notice 报错 */
			}
			return;
		}
		if (AgentService.isPseudoClientId(ownerId)) {
			fail("Scheduler/plugin sessions cannot be taken over.", "Scheduler/plugin sessions cannot be taken over.");
			return;
		}
		const source = this.clients.get(ownerId);
		if (!source) {
			fail(
				"The source session is gone; reopen it from History instead.",
				"The source session is gone; reopen it from History instead.",
			);
			target.refreshExternalRunning();
			return;
		}
		const briefs = source.takeoverBriefs();
		const main = briefs.find((b) => b.id === convId);
		if (!main) {
			fail(
				"That conversation is gone on the other side; the list refreshes shortly.",
				"That conversation is gone on the other side; the list refreshes shortly.",
			);
			target.refreshExternalRunning();
			return;
		}
		if (main.isSubagent) {
			fail(
				"Only main conversations can be taken over (subagents move with their parent).",
				"Only main conversations can be taken over (subagents move with their parent).",
			);
			return;
		}
		const moveIds = [convId, ...collectSubagentDescendantIds(briefs, convId)];
		const moveSet = new Set(moveIds);
		// 容量：与 switchSession 同口径（目标项目非子代理且非临时会话 8 个）。
		const movedMains = briefs.filter((b) => moveSet.has(b.id) && !b.isSubagent && !b.isEphemeral).length;
		const openInProject =
			target.takeoverBriefs().filter((b) => b.cwd === main.cwd && !b.isSubagent && !b.isEphemeral).length + movedMains;
		if (openInProject > MAX_OPEN_CONVERSATIONS) {
			fail(
				`This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
				`This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
			);
			return;
		}
		try {
			const detached = await source.detachTakeoverConversations(moveIds);
			if (!detached.ok) {
				fail(
					detached.reason === "empty"
						? "The source session only has this conversation and the server is draining; try later."
						: "That conversation is gone on the other side; the list refreshes shortly.",
					detached.reason === "empty"
						? "The source session only has this conversation and the server is draining; try later."
						: "That conversation is gone on the other side; the list refreshes shortly.",
				);
				if (detached.reason === "missing") target.refreshExternalRunning();
				return;
			}
			const newMainId = target.insertTakeoverConvs(detached.payload);
			// 源会话修好 active（detach 内部已处理）→ 推全量刷新 + 告知去向；
			// 无 sink 时 emit 即丢，无需判断。
			source.sendNotice({
				type: "notice",
				level: "info",
				text: `"${main.title}" was taken over by another page and is no longer held here.`,
				textEn: `"${main.title}" was taken over by another page and is no longer held here.`,
			});
			target.sendNotice({
				type: "notice",
				level: "info",
				text: `"${main.title}" was moved to this page — pick up right where it left off.`,
				textEn: `"${main.title}" was moved to this page — pick up right where it left off.`,
			});
			await target.switchConversation(newMainId);
		} catch (err) {
			fail(`Takeover failed: ${(err as Error).message}`, `Takeover failed: ${(err as Error).message}`);
		}
	}

	/**
	 * 跨页作答预告（peek_elsewhere_question）：把 owner 会话里某对话的等答复问卷
	 *  原文取回 target 页展示。只读，不搬迁对话；问卷已不在则直说（并刷新左栏）。
	 */
	async peekElsewhereQuestion(targetId: string, ownerId: string, convId: string): Promise<void> {
		const target = this.clients.get(targetId);
		if (!target) return;
		const fail = (text: string, textEn: string): void => {
			target.sendNotice({ type: "notice", level: "warning", text, textEn });
		};
		if (!ownerId || !convId) {
			fail(
				"Question target unclear (missing owner/id), please retry.",
				"Question target unclear (missing owner/id), please retry.",
			);
			return;
		}
		if (ownerId === targetId) return; // 自己的问卷走本地通道，不需要预告
		if (AgentService.isPseudoClientId(ownerId)) {
			fail(
				"Scheduler/plugin session questions cannot be answered cross-page.",
				"Scheduler/plugin session questions cannot be answered cross-page.",
			);
			return;
		}
		const source = this.clients.get(ownerId);
		const q = source?.peekPendingQuestion(convId);
		if (!q) {
			fail(
				"That question is gone (just answered/cancelled there, or the run ended).",
				"That question is gone (just answered/cancelled there, or the run ended).",
			);
			target.refreshExternalRunning();
			return;
		}
		target.pushElsewhereQuestion(ownerId, convId, q);
	}

	/**
	 * 跨页作答（question_answer 带 owner）：把本页提交的答案送到持有方会话。
	 * 问卷已不在（对方刚回答/取消）则明确告知，答案不吞不丢两不沾 —— 没送出就是没送出。
	 */
	async answerElsewhereQuestion(
		targetId: string,
		ownerId: string,
		id: string,
		answers: QuestionAnswer[],
		cancelled?: boolean,
	): Promise<void> {
		const target = this.clients.get(targetId);
		if (!target) return;
		const source = this.clients.get(ownerId);
		const ok = source ? source.resolveQuestion(id, answers, cancelled) : false;
		if (!ok) {
			target.sendNotice({
				type: "notice",
				level: "warning",
				text: "That question is gone (just answered/cancelled there, or the run ended) — your answer was not delivered.",
				textEn:
					"That question is gone (just answered/cancelled there, or the run ended) — your answer was not delivered.",
			});
			target.refreshExternalRunning();
		}
	}

	/** Get or create the session for a client, racing attach calls safely. */
	async attach(clientId: string, send: (msg: ServerMessage) => void): Promise<ClientSession> {
		// carry-on: while the startup reopens the chats a restart cut off, everyone else waits
		// (bounded): a window opening its most recent chat at the same moment would give that
		// transcript a second writer.
		if (this.carryOnGate && !clientId.startsWith(CARRY_ON_CLIENT_PREFIX)) await this.carryOnGate;
		let cs = this.clients.get(clientId);
		if (!cs) {
			const inflight = this.pending.get(clientId);
			if (inflight) {
				cs = await inflight;
			} else {
				// reload-adopt：不走上游 v0.94 的「浏览器重启认领」（findAdoptableOrphan）。
				// 那套按「clientId 存 sessionStorage、刷新不换 id」设计，只在关掉浏览器重开时触发；
				// 本 fork 的 client-per-load 让每次刷新都是新 id，它会在每次单标签刷新时触发。
				// 而 server-owned-chats 之后 convs 是进程共享的：每个残留会话的「有内容 / 在跑 /
				// 最近活跃」算的是同一张表、完全相同，于是总挑到最早的那个残留 —— 落到它
				// 很久以前打开的对话上，还每次都弹「已恢复你关闭浏览器前的工作会话」。
				// 刷新/新标签落到哪条对话，统一由下面的 pickAdoptTarget 决定。
				// Admission gate: while quiesced, only clients with an EXISTING
				// session may attach (they can watch their runs drain); brand-new
				// clients are refused — index.ts closes their socket (4403) and the
				// browser reconnect loop retries after admission reopens.
				if (this.quiesced) {
					throw new QuiesceRejectedError("New connection refused; retry after the server recovers");
				}
				// patch: no-cwd-restore —— 不再自动恢复 lastCwd。新连接一律用服务端启动
				// 目录；想去别的项目用左栏切。自动恢复的问题是它会把你拽回上一次碰过的
				// 目录（而不是你现在想要的），且每开一个新标签页都重演一次。
				const cwd = this.cwd;
				// Sessions use the SDK default per-project dir — no per-client dir.
				// reload-adopt：对话是进程共享的（server-owned-chats）—— 这个 cwd 下已经
				// 开着的那条直接接管，而不是从磁盘再恢复一份（那会让同一份 JSONL 被
				// 两个 runtime 打开）。纯内存判断，不扫目录；没有候选时照旧恢复。
				// 伪客户端（scheduler:/plugin:，定时任务/插件的无头调用）绝不接管：它们 attach 之后
				// 直接 prompt，接管了就会把消息发进用户开着的对话（上游 v0.95 同一意图：
				// 「伪客户端不再认领会话」）。
				// 它们也不能从磁盘恢复那条的转录（同一文件两个写者），所以有开着的就落空白。
				const openHere = pickAdoptTarget(cwd, ClientSession.openConversations());
				const adoptId = AgentService.isPseudoClientId(clientId) ? null : openHere;
				// carry-on: its client starts blank too; it opens exactly the chats it carries on.
				const creating = ClientSession.create(
					clientId,
					cwd,
					this.stateStore,
					openHere || clientId.startsWith(CARRY_ON_CLIENT_PREFIX) ? { blank: true } : undefined,
				).finally(() => {
					this.pending.delete(clientId);
				});
				this.pending.set(clientId, creating);
				cs = await creating;
				this.clients.set(clientId, cs);
				// issue #145 接线提前：首帧 elsewhere 依赖它。
				this.wireClient(cs, clientId);
				// reload-adopt：挂 sink 之前就定位到已开的那条，首帧快照直接就是它。
				// （候选可能在 create() 的 await 期间被别人关掉 —— adoptConversation 自己查。）
				if (adoptId) cs.adoptConversation(adoptId);
				// Make sure the restored/default workspace appears in the project list.
				this.stateStore.remember(clientId, cwd);
			}
		}
		// First attach after a restart: reopen sessions that were streaming
		// when the previous process shut down and continue them (consumed
		// once, then cleared). Fire-and-forget AFTER attachSink + hooks:
		// resume emits directly to sinks and needs the owner guards.
		// Progress arrives over the socket as usual.
		// crash-guard: a window coming back after its chat was closed elsewhere first gets an open chat
		// (attachSink pushes the terminals and more of the active chat).
		if (!cs.hasActiveConversation()) await cs.ensureActiveConversation("reconnect");
		// Forward hooks (set once by index.ts) to every session. Before attachSink: its first pushes
		// (the background-task list, the slash commands) read the plugin providers, and a new
		// window's list would otherwise lack the plugins' lines until one of them changed.
		cs.onQuit = this.onQuit;
		cs.onToolEvent = this.onToolEvent;
		cs.toolGuard = this.toolGuard;
		cs.onRunEvent = this.onRunEvent;
		cs.onConversationChanged = () => this.onConversationChanged?.();
		cs.pluginToolsProvider = this.pluginToolsProvider;
		cs.pluginCommandsProvider = this.pluginCommandsProvider;
		cs.pluginBgTasksProvider = this.pluginBgTasksProvider;
		cs.pluginStopBgTask = this.pluginStopBgTask;
		cs.isQuiesced = () => this.quiesced;
		cs.attachSink(send);
		// issue #145 跨客户端感知接线（同会话查重 / 同项目并行 / elsewhere 列表）。
		this.wireClient(cs, clientId);
		// 插件宿主工作区跟随：初次接入也同步一次（恢复的 lastCwd 可能≠服务启动目录），
		// notifyCwd 幂等去重；此后 set_cwd 成功时由 cs.onCwdChanged 继续驱动。
		cs.onCwdChanged = (abs, roots) => this.onClientCwdChanged?.(abs, roots);
		this.onClientCwdChanged?.(cs.cwd, cs.workspaceRoots);
		// carry-on: what the restart did (replaces upstream's per-window resume, which rarely
		// matched here: every page load has a new client id, and pages reload after an install).
		this.sendStartupNotices(clientId, send);
		return cs;
	}

	// -----------------------------------------------------------------------
	// carry-on: chats that a restart cut off carry on by themselves
	// -----------------------------------------------------------------------

	private carryOnPlan: CarryOnPlan | null = null;
	private carryOnGate: Promise<void> | null = null;
	private openCarryOnGate: (() => void) | null = null;
	private startupNotices: { level: "info" | "warning"; text: string; textEn: string }[] = [];
	private startupNoticesUntil = 0;
	private noticedClients = new Set<string>();

	/**
	 * Startup, before the server takes connections: read the list of chats the last process left
	 * working, plan the carry-on, and start the new live list with the chats being carried on.
	 * Windows wait (attach gate, at most 30 s) until carryOnAfterRestart() has reopened them.
	 */
	prepareCarryOn(): void {
		const dataDir = this.stateStore.dataDir;
		const file = join(dataDir, RUNNING_CHATS_FILE);
		const now = Date.now();
		let prev = readRunningChatsFile(file);
		// The old per-window records (upstream's resume): used once, when there is no list yet.
		const oldRecords = this.stateStore.takeAllInterrupted();
		if (!prev && !existsSync(file)) {
			const newest = newestInterrupted(oldRecords, now);
			if (newest.length > 0) {
				prev = {
					v: 1,
					pid: 0,
					shutdown: { at: Math.max(...newest.map((r) => r.at)), signal: "old-record" },
					chats: newest.map((r) => ({
						sessionFile: resolve(r.sessionFile),
						title: r.title,
						cwd: r.cwd,
						startedAt: r.at,
						cutoffs: 0,
						tools: [],
						step: stepFromTranscriptTail(readTail(r.sessionFile)),
					})),
				};
			}
		}
		const plan = planCarryOn(prev, takeRestartReason(join(dataDir, RESTART_REASON_FILE)), now);
		const list = new RunningChats(file);
		runningChats = list;
		list.seed(
			plan.carry.map((item): RunningChat => ({ ...item.chat, cutoffs: item.cutoffs, awaiting: true, startedAt: now })),
		);
		if (plan.carry.length === 0 && plan.guarded.length === 0) return;
		const names = (chats: RunningChat[]) => chats.map((c) => `"${c.title}"`).join(", ");
		console.log(
			`[carry-on] restarted (${plan.reason}): carrying on ${plan.carry.length} chat(s)` +
				(plan.carry.length ? `: ${names(plan.carry.map((i) => i.chat))}` : "") +
				(plan.guarded.length ? `; cut off ${plan.guarded.length}x in a row, left alone: ${names(plan.guarded)}` : ""),
		);
		for (const chat of plan.guarded) {
			this.startupNotices.push({
				level: "warning",
				text: `"${chat.title}" was cut off by 3 restarts in a row without finishing, so it wasn't told to carry on this time. Open it and tell it what to do.`,
				textEn: `"${chat.title}" was cut off by 3 restarts in a row without finishing, so it wasn't told to carry on this time. Open it and tell it what to do.`,
			});
		}
		this.startupNoticesUntil = now + 10 * 60_000;
		if (plan.carry.length === 0) return;
		this.carryOnPlan = plan;
		let open!: () => void;
		const gate = new Promise<void>((r) => {
			open = r;
		});
		const timer = setTimeout(() => open(), 30_000);
		timer.unref?.();
		this.openCarryOnGate = () => {
			clearTimeout(timer);
			open();
		};
		this.carryOnGate = gate.then(() => {
			this.carryOnGate = null;
		});
	}

	/** Startup, once the server listens: reopen each cut-off chat and send it the carry-on note. */
	async carryOnAfterRestart(): Promise<void> {
		const plan = this.carryOnPlan;
		this.carryOnPlan = null;
		if (!plan) return;
		const clientId = `${CARRY_ON_CLIENT_PREFIX}startup`;
		const noop = () => {};
		const carried: string[] = [];
		const failed: string[] = [];
		try {
			const cs = await this.attach(clientId, noop);
			for (const item of plan.carry) {
				const file = item.chat.sessionFile;
				let ok = false;
				try {
					ok = existsSync(file) && (await cs.carryOn(file, item.note));
				} catch (err) {
					console.error(`[carry-on] "${item.chat.title}": ${(err as Error).message}`);
				}
				if (ok) carried.push(item.chat.title);
				else {
					failed.push(item.chat.title);
					runningChats?.finish(file);
				}
			}
			// Nobody watches through this client: the chats count as unwatched (done rings etc.).
			this.detach(clientId, noop);
		} catch (err) {
			console.error(`[carry-on] couldn't reopen the chats: ${(err as Error).message}`);
		} finally {
			this.openCarryOnGate?.();
			this.openCarryOnGate = null;
		}
		const quote = (list: string[]) => list.map((t) => `"${t}"`).join(", ");
		console.log(
			`[carry-on] carried on: ${carried.length ? quote(carried) : "none"}` +
				(failed.length ? `; couldn't reopen: ${quote(failed)}` : ""),
		);
		if (carried.length > 0) {
			this.startupNotices.push({
				level: "info",
				text: `pi-web-ui restarted (${plan.reason}). ${carried.length} chat(s) it cut off are carrying on: ${quote(carried)}`,
				textEn: `pi-web-ui restarted (${plan.reason}). ${carried.length} chat(s) it cut off are carrying on: ${quote(carried)}`,
			});
		}
		if (failed.length > 0) {
			this.startupNotices.push({
				level: "warning",
				text: `After the restart these cut-off chats couldn't be reopened: ${quote(failed)}. Open them and tell them to carry on.`,
				textEn: `After the restart these cut-off chats couldn't be reopened: ${quote(failed)}. Open them and tell them to carry on.`,
			});
		}
		this.startupNoticesUntil = Date.now() + 10 * 60_000;
	}

	/** Each window that connects in the first minutes after a restart hears once what it did. */
	private sendStartupNotices(clientId: string, send: (msg: ServerMessage) => void): void {
		if (this.startupNotices.length === 0 || Date.now() > this.startupNoticesUntil) return;
		if (AgentService.isPseudoClientId(clientId) || this.noticedClients.has(clientId)) return;
		this.noticedClients.add(clientId);
		for (const n of this.startupNotices) {
			try {
				send({ type: "notice", level: n.level, text: n.text, textEn: n.textEn });
			} catch {
				/* socket gone */
			}
		}
	}

	/** 插件 AI 工具集合变化（注册/注销）时由 index.ts 触发：推送到所有客户端的全部会话。 */
	applyPluginAgentTools(): void {
		for (const cs of this.clients.values()) cs.refreshPluginTools();
	}

	/** Browser UI locale report (hello.locale / set_locale): persist per client
	 *  and refresh lang-aware prompts (streaming-safe via ClientSession). */
	async setLocale(clientId: string, locale: string): Promise<void> {
		const cs = this.clients.get(clientId);
		if (cs) {
			await cs.setLocale(locale);
			return;
		}
		// hello race: session still being created — wait for it, then apply.
		const inflight = this.pending.get(clientId);
		if (inflight) {
			try {
				await (await inflight).setLocale(locale);
			} catch {
				/* attach failed — nothing to apply to */
			}
		}
	}

	/** 插件斜杠命令集合变化时由 index.ts 触发：重推各客户端的命令目录。 */
	applyPluginCommandCatalog(): void {
		for (const cs of this.clients.values()) void cs.pushSlashCommands();
	}

	/** 插件常驻后台任务变化时由 index.ts 触发：重推各客户端的 bg_servers。 */
	refreshBackgroundServers(): void {
		for (const cs of this.clients.values()) cs.refreshBgTasks();
	}

	/** Remove a socket from a client's broadcast set (called on socket close). */
	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		const cs = this.clients.get(clientId);
		cs?.detachSink(send);
		// issue #291：最后一个 sink 断开 = 该客户端不再在线 → 它的对话不该再出现在
		// 别人的 elsewhere 列表（listExternalRunning 已跳过 sinkCount=0 的非伪客户端，
		// 但列表是推过去的，得让其他客户端重推一次才能立刻消失）。
		if (cs && !AgentService.isPseudoClientId(clientId) && cs.sinkCount() === 0) {
			this.pokeExternalRunning(clientId);
		}
	}

	get(clientId: string): ClientSession | undefined {
		return this.clients.get(clientId);
	}

	/** 插件扩展点 v2：挑一个最合适的客户端会话供无浏览器调用的插件 API 用
	 *  （conversationLister/Searcher/Writer、modelLister、runAborter）。
	 *  有运行中对话的优先，否则任意残留客户端；一个没有时返回 undefined，
	 *  调用方（index.ts 注入）回退空列表 / {ok:false}，绝不抛错。 */
	pluginClient(): ClientSession | undefined {
		let fallback: ClientSession | undefined;
		for (const cs of this.clients.values()) {
			if (!fallback) fallback = cs;
			try {
				if (cs.activeConversations() > 0) return cs;
			} catch {
				// 单客户端坏了不影响挑选
			}
		}
		return fallback;
	}

	/** Snapshot still-streaming conversations for post-restart resume.
	 *  Called during graceful shutdown AND from the restart_service handler
	 *  (which exits without shutdown under systemd — without this, the
	 *  interrupted-run record would silently never be written there). */
	recordInterruptedRuns(): void {
		// carry-on: freeze the live list of working chats BEFORE tearing anything down. The runs
		// the shutdown aborts stay in it, and the next process tells each of them to carry on.
		// Idempotent (shutdown and restart_service both call it).
		try {
			runningChats?.freeze("shutdown");
		} catch {
			// best effort — never block shutdown on bookkeeping
		}
	}

	async disposeAll(): Promise<void> {
		this.uninstallQueueHost?.();
		this.uninstallQueueHost = null;
		ClientSession.stuckAnswerSender = null;
		this.recordInterruptedRuns();
		const all = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(all.map((cs) => cs.dispose()));
	}
}
