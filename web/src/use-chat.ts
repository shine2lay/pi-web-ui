import { useCallback, useEffect, useReducer, useRef } from "react";
import { randomUuid } from "./uuid";
import { withToken } from "./auth-token";
import { appUrl } from "./base-url";
import type {
	ClientMessage,
	BgServer,
	CommandDef,
	ConversationSummary,
	ElsewhereRunning,
	FileContent,
	FileListing,
	FileSearchResult,
	GoalStatus,
	ModelInfo,
	ProjectSummary,
	ProviderKeyInfo,
	ProviderOAuthFlowState,
	ProviderStatus,
	ServerMessage,
	SessionSearchResult,
	SessionSummary,
	SwitchTarget,
	SlashCommandInfo,
	ToolStatus,
	TerminalInfo,
	DshPermissionOption,
	UiAgentPreset,
	UiHostMetrics,
	UiModelConfigEntry,
	UiEnrichResult,
	UiPendingQuestion,
	UiPluginCatalogEntry,
	UiPluginInfo,
	UiPluginUpdateInfo,
	UiProviderConfig,
	UiQuestion,
	UiServiceInfo,
	UiSettingsState,
	UiState,
	UiToolApproval,
} from "./types";

import { applyMessageDelta, type MessageDeltaMsg } from "./message-delta";
import { keepLoadedHistory, paginationAfterDelta, prependOlderExchanges, prependOlderMessages } from "./message-window";
import { applyReuse, cachedWindow, ChatCache, windowKey } from "./chat-cache";
import { resolvePendingQuestion, type QuestionSource } from "./pending-question";
import {
	sameSwitchTarget,
	settleOnSnapshot,
	switchAlreadyShown,
	type PendingSwitch,
	type SwitchError,
} from "./switch-pending";
import { setAppGlobals, setAppSend } from "./app-globals";
// 工具定义说明弹窗（工具卡右键 → 「显示工具详细信息」）：应答直接回模块级 store，
// 不进 ChatState（弹窗挂在 App 上，消息列表里几十张卡片不必为此各拿一份数据）。
import { receiveToolInfo } from "./tool-info-state";
import {
	receiveIdentities,
	receiveIdentityDraft,
	receiveIdentityDraftDone,
	receiveOwnSkills,
	receiveIdentityFile,
	receiveIdentitySaved,
	receiveRoleMessages,
} from "./identity-state";
import {
	NOTEBOOK_TAB_REF,
	receiveNote,
	receiveNotebook,
	receiveNotebookSaved,
	receiveNoteSaved,
	receiveNotesFound,
	resendNotebookWatch,
} from "./notebook-state";
import { receiveSubsLimits, requestSubsLimits } from "./subs-limits-state";
import { receiveBoardResult, receiveRoles, resendRolesWatch } from "./roles-state";
import { emitPluginData } from "./plugin-loader";
import { ingestPluginLogsData } from "./plugin-logs";
import { resolveCatalogSyncResult } from "./plugin-host";
import { PROTOCOL_VERSION } from "./protocol-version";
// mobile-fixes: a quiet socket is found dead within seconds and replaced at once (see conn-health.ts).
import { ConnHealth, setReconnectingNote } from "./conn-health";
import {
	applyPromptAck,
	failPending,
	idsToCheck,
	isSlashText,
	newPendingSend,
	onReconnect,
	parsePending,
	PENDING_STORAGE_KEY,
	type PendingSend,
	type PromptAckInfo,
	reconcilePending,
	removePending,
	retryPending,
	sameChat,
	serializePending,
} from "./pending-sends";
import {
	initialProviderOAuthState,
	reduceProviderOAuthState,
	type ProviderOAuthResultState,
	type ProviderOAuthServerMessage,
} from "./provider-oauth-state";
import type { SchedulerTaskView } from "./types";

export type ConnStatus = "connecting" | "open" | "closed";

/** UI locale for the hello server report (issue #91). pi-web-ui speaks English only now
 *  (the Chinese UI and the language menu were removed), so this is always "en"; an old
 *  stored "pi-web-ui:lang" choice is ignored. */
function readUiLocale(): string {
	return "en";
}

/** One component in an all-source update check (update_status_all). */
export interface UpdateAllItem {
	name: string;
	kind: "webui" | "pi-core" | "package" | "git-extension" | "plugin";
	current: string;
	latest: string | null;
	latestPublishedAt?: string | null;
	upToDate: boolean;
	error?: string;
	/** git-extension / plugin only: `host/path` shorthand (prepend `git:` for the `pi update` command). */
	source?: string;
	pluginId?: string;
	builtin?: boolean;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
	textEn?: string;
}

/** A terminal tab. The output stream itself lives in the xterm instance
 * (via the terminal bridge) — this is just the tab metadata. */
export interface TerminalMeta extends TerminalInfo {
	conversationId: string;
}

/** 插件后台作业（安装/更新/卸载）的实时状态（issue #152）。
 *  由服务端的 `plugin_job` 即时通道消息驱动；只在发起它的客户端上看得到。 */
export interface PluginJobState {
	jobId: string;
	action: "install" | "update" | "uninstall";
	pluginId: string;
	phase: "start" | "log" | "done";
	/** phase="done"：作业是否成功。 */
	ok?: boolean;
	/** phase="done" 且失败：可读原因。 */
	error?: string;
	/** phase="done"：输出尾部（就地展开看详情）。 */
	output?: string;
	/** 最近的输出行（滚动显示最后一行）。 */
	lines: string[];
	/** 本地收到 start 的时间（算耗时；作业在服务端）。 */
	startedAt: number;
}

/** 目录同步回执（issue #165：设置面板「从目录同步」框用；发起它的客户端才看得到）。
 *  由服务端的 `plugin_catalog_sync_result` 即时通道消息驱动（与 plugin-host 的
 *  reloadCatalog 等待者在 use-chat 里共用同一条消息，各取所需）。 */
export interface CatalogSyncState {
	requestId: string;
	ok: boolean;
	error?: string;
	/** 同步后的完整市场列表长度（成功时）。 */
	entryCount?: number;
	/** install:true 时逐条安装结果。 */
	installed?: { id: string; ok: boolean; error?: string }[];
	/** 本地收到回执的时间。 */
	receivedAt: number;
}

/** 「安装前先读 spec」结果（DSH P0-3）：形状分类 + 已装判定 + 远端 manifest 探测。
 *  由 `plugin_install_inspect_result` 驱动；problem 非空时设置面板在输入框下显示一句话。 */
export interface PluginInstallInspectState {
	requestId: string;
	source: string;
	kind: "npm" | "github" | "url" | "path" | "invalid";
	suggestedId: string;
	installed: boolean;
	problem?:
		"invalid-spec" | "already-installed" | "not-found" | "not-a-package" | "not-a-bundle" | "network" | "unknown";
	detail?: string;
	manifest?: { id?: string; name?: string; version?: string; description?: string; permissions?: string[] };
}

export interface ChatState {
	status: ConnStatus;
	/** True once the server confirmed the agent session is ready (hello processed). */
	ready: boolean;
	state: UiState | null;
	/** Latest host server CPU and memory usage from heartbeat. */
	hostMetrics: UiHostMetrics | null;
	/** Live tool output accumulated from tool_delta messages, keyed by toolCallId. */
	liveOutputs: Map<string, { toolName: string; text: string }>;
	/**
	 * Tools that FINISHED executing (tool_status from tool_execution_end), keyed
	 * by toolCallId. Lets the card show "done · waiting for the model" even
	 * while the session is still streaming. Cleared once the toolResult message
	 * lands in the snapshot (it carries the authoritative result).
	 */
	toolStatuses: Map<string, ToolStatus>;
	notices: Notice[];
	serverVersion?: string;
	/** 引擎标识（pi | dsh）—— ready 消息携带，底栏显示徽标。 */
	engine?: string;
	/** PI_WEB_MANAGED=1 on the server: updates and plugin installs come from
	 *  whoever deploys this instance, so the interface does not offer them.
	 *  The server refuses those messages regardless (server/managed.ts). */
	/** pi-web-ui's own version, from `ready`. `serverVersion` is the pi SDK's,
	 *  and the update check — the client's other source — does not run on a
	 *  managed instance. */
	appVersion?: string;
	managed?: boolean;
	/** PI_WEB_TABS on the server: the tabs this instance offers. Undefined
	 *  means all of them, which is the default. */
	tabs?: string[];
	/** Persisted session list for the left panel. */
	sessions: SessionSummary[];
	/** Open conversations (each runs its own session in parallel). */
	conversations: ConversationSummary[];
	/** issue #145 遗留字段：server-owned-chats 之后服务端恒发空数组（对话本来就共享）。 */
	elsewhere: ElsewhereRunning[];
	/** Id of the conversation the current snapshot belongs to. */
	activeConversationId: string;
	/** Recent workspaces this client opened (left panel project picker). */
	projects: ProjectSummary[];
	/** Workspace file listing for the right panel. */
	files: FileListing | null;
	/** Latest file content fetched for the preview panel (path-matched in the modal). */
	fileContent: FileContent | null;

	/** Last dir-changed push from the server fs.watch (path = listed directory). */
	fileChanged: { path: string } | null;
	/** Models with valid auth, for the model dropdown. */
	models: ModelInfo[];
	/** True while a model list request is in flight. */
	modelsLoading: boolean;
	/** Custom providers from agentDir/models.json (model config panel). */
	modelsConfig: UiProviderConfig[];
	/** Built-in providers with auth status (key-only config). */
	providers: ProviderStatus[];
	/** Stored API keys per built-in provider (masked), for multi-key grouping. */
	providerKeys: Record<string, ProviderKeyInfo[]>;
	/** 全局默认模型（"provider/id"，null = 未设置）：模型下拉的 ★ 标记 +
	 *  "设为全局默认"按钮状态。pi 引擎经 default_model 消息推送。 */
	defaultModel: string | null;
	/** OAuth login flows that may survive a browser reconnect. */
	providerOAuthFlows: ProviderOAuthFlowState[];
	/** Last OAuth action result per provider. */
	providerOAuthResults: Record<string, ProviderOAuthResultState>;
	/** Result of the last install_pi_agent run (null while not started/running). */
	installResult: { ok: boolean; detail: string } | null;
	/** Path completions for the cwd input. */
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	/** Self-update status (result of check_update). */
	update: {
		current: string;
		latest: string | null;
		latestPublishedAt: string | null;
		upToDate: boolean;
		error?: string;
	} | null;
	/** All-source update check (webui + pi core + installed packages). */
	updatesAll: UpdateAllItem[] | null;
	/** issue #321：pi SDK 副本状态（update_status_all 随发）。`running` = 本进程实际
	 *  加载的版本；`bundledInUse` = 加载的是随包自带那份（未跟随全局）；
	 *  `newerInstalled` = 机器上更新的 pi 版本（全局 CLI / 被遮蔽副本），null = 没有。 */
	updatesSdk: { running: string; bundledInUse: boolean; newerInstalled: string | null } | null;
	/** Extension widgets (TUI overlays bridged to the web UI). */
	widgets: { key: string; lines: string[] }[];
	/** Extension footer statuses (setStatus bridge). */
	statuses: { key: string; text: string | undefined }[];
	/** Active extension dialog (select/confirm/input) awaiting a response. */
	dialog: {
		id: number;
		kind: "select" | "confirm" | "input";
		title: string;
		args: unknown[];
	} | null;
	/** 待用户审批的高危工具调用（Human-in-the-Loop: Edit & Run）。 */
	approval: UiToolApproval | null;
	/** 待用户回答的模型提问（ask_user_question）——两个引擎共用。服务端是事实源：
	 *  即时通道（question_pending）+ 快照（UiState.pendingQuestion，见 syncPendingQuestion）。 */
	question: UiPendingQuestion | null;
	/** 跨页作答预告（peek_elsewhere_question 的回包）：别处会话问卷的原文。
	 *  与本地 question 独立共存（id 各会话作用域，不进 answered 集合）；
	 *  提交带 owner 由持有方 resolve，本页只负责展示/关闭。 */
	remoteQuestion: {
		owner: string;
		convId: string;
		id: string;
		questions: UiQuestion[];
		conversationTitle?: string;
	} | null;
	/** User command list from .pi/commands.json (terminal left panel). */
	commands: CommandDef[];
	commandsPath: string;
	/** Slash-command catalog for the chat input (builtin + extension +
	 *  template + skill). */
	slashCommands: SlashCommandInfo[];
	/** Open terminal tabs (metadata only; streams go through the bridge). */
	terminals: TerminalMeta[];
	/** Terminal the SCM/settings panel asked to focus (auto-switch on write ops). */
	terminalActiveId: string | null;
	/** Goal / review status (set via the goal bar). */
	goal: GoalStatus;
	/** Settings-panel state (system prompt, skill/extension toggles, presets). */
	settings: UiSettingsState | null;
	/** AI-started background servers (managed from the 后台任务 panel). The
	 *  list lives on the client session, so it survives conversation ends. */
	bgServers: BgServer[];
	/** Built-in scheduled tasks (issue #184, global list, all projects). */
	schedulerTasks: SchedulerTaskView[];
	/** Last fetch_models probe result (custom-provider model list), matched by
	 *  reqId in the model config modal. */
	fetchModelsResult: {
		reqId: number;
		ok: boolean;
		models?: UiModelConfigEntry[];
		error?: string;
	} | null;
	/** Last test_model_connection result, matched by reqId in the model config modal. */
	testModelConnectionResult: {
		reqId: number;
		ok: boolean;
		latencyMs?: number;
		error?: string;
	} | null;
	/** Last enrich_models result (catalog params for draft rows), matched by
	 *  reqId in the model config modal. */
	enrichModelsResult: {
		reqId: number;
		ok: boolean;
		results?: UiEnrichResult[];
		error?: string;
	} | null;
	/** Progress notification for enrich_models while downloading catalogs or matching. */
	enrichModelsProgress: {
		reqId: number;
		phase: "catalog" | "page" | "matching" | "aborted";
		current?: number;
		total?: number;
		message?: string;
	} | null;
	/** Last refresh_provider_models result (saved-provider list refresh). */
	refreshProviderResult: {
		reqId: number;
		ok: boolean;
		added?: number;
		total?: number;
		error?: string;
	} | null;
	/** Last refresh_builtin_models result (forced official-catalog refresh),
	 *  matched by reqId in the model config modal. */
	refreshBuiltinResult: {
		reqId: number;
		ok: boolean;
		error?: string;
	} | null;
	/** Last append_builtin_model result (one model appended to a built-in
	 *  provider's overlay entry), matched by reqId in the modal. */
	appendBuiltinResult: {
		reqId: number;
		ok: boolean;
		error?: string;
	} | null;
	/** Last clone_provider result (built-in → custom draft for the model
	 *  config modal to open pre-filled). */
	cloneProviderResult: {
		reqId: number;
		ok: boolean;
		config?: UiProviderConfig;
		configs?: UiProviderConfig[];
		error?: string;
	} | null;
	/** Last source-control query result (scm_status / scm_filediff /
	 *  scm_commit), matched by reqId in the SCM panel. */
	scmData: ServerMessage | null;
	/** Last global-search file query result, matched by reqId in the
	 *  global search panel (stale results with older reqIds are ignored). */
	fileSearch: {
		reqId: number;
		ok: boolean;
		results: FileSearchResult[];
		truncated?: boolean;
	} | null;
	/** Last global-search conversation-content query result (server-side
	 *  transcript match, AI output included) — same reqId discipline. */
	sessionSearch: {
		reqId: number;
		ok: boolean;
		results: SessionSearchResult[];
	} | null;
	/** Installed optional plugins (<dataDir>/plugins). Empty = none installed. */
	plugins: UiPluginInfo[];
	/** Server-side plugin reload counter (import-cache buster, see plugins msg). */
	pluginsEpoch: number;
	/** 已装插件的更新状态（key = pluginId）。 */
	pluginUpdates: Record<string, UiPluginUpdateInfo> | null;
	/** 正在检查插件更新 */
	checkingPluginUpdates: boolean;
	/** Installable-plugin list (marketplace): shipped catalog + user-added
	 *  entries, each a one-click install candidate (see plugin_catalog msg). */
	pluginCatalog: UiPluginCatalogEntry[];
	/** Catalog epoch (increments on every add/remove — re-render trigger). */
	pluginCatalogEpoch: number;
	/** 插件后台作业的实时状态，key = jobId（即时通道消息：刷新即丢，作业在服务端继续跑）。 */
	pluginJobs: Record<string, PluginJobState>;
	/** 最近一次目录同步的回执（设置面板「从目录同步」框展示用；刷新即丢）。 */
	catalogSync: CatalogSyncState | null;
	/** 最近一次「安装前先读 spec」的检查结果（设置面板输入框下展示；刷新即丢）。 */
	installInspect: PluginInstallInspectState | null;
	/** 插件目录授权表（issue #146）：设置面板列出 + 可撤销。 */
	pluginGrants: { pluginId: string; paths: string[] }[];
	/** 插件能力授权表（动态授权）：设置面板列出 + 可撤销；session 授权只在本次运行有效。 */
	pluginPermissions: {
		pluginId: string;
		family: "net" | "llm";
		hosts?: string[];
		models?: string[];
		reason?: string;
		grantedAt: number;
		session?: boolean;
	}[];
	/** 等待用户答复的「插件请求访问目录」（队列；服务端 120s 未答复视为拒绝）。 */
	pathRequests: { id: string; pluginId: string; path: string; reason?: string }[];
	/** 等待用户答复的「插件请求能力授权」（队列；语义与 pathRequests 同）。 */
	permRequests: {
		id: string;
		pluginId: string;
		family: "net" | "llm";
		hosts?: string[];
		models?: string[];
		reason?: string;
	}[];
	/** DSH engine: <dataDir>/dsh-patches user patch files (list + dir). */
	dshPatches: { patchDir: string; files: { name: string; path: string; size: number; mtimeMs: number }[] } | null;
	/** DSH engine: Agent 预设名录（null = 未加载/legacy，UI 隐藏预设条）。 */
	dshPresets: { presets: UiAgentPreset[]; defaultPreset: string } | null;
	/** DSH engine: 权限预设选项表 + 新会话默认（null = 未就绪/legacy，UI 隐藏权限条）。 */
	dshPermission: { options: DshPermissionOption[]; defaultPreset: string } | null;
	/** Increments when the server reports the watched git dir changed
	 *  outside the panel — SCMPanel refreshes on change while visible. */
	scmDirty: number;
	/** Server wire-protocol version differs from ours — the page was loaded
	 *  before/after an app update; show a persistent refresh banner. */
	protocolMismatch: boolean;
	/** switch-loading：正在等服务端切过去的那次切换（发出 switch_* 即设，回执/对上的快照即清）。 */
	pendingSwitch: PendingSwitch | null;
	/** switch-loading：最近一次切换失败（留在原对话上，聊天区显示原因 + 重试）。 */
	switchError: SwitchError | null;
	/** switch-cache：切换进行中先显示的目标对话缓存（点下去那一刻就有；要的那条显示出来、
	 *  切换结束或被隐藏就清）。只给消息列表用，其余界面仍是服务端当前对话的状态；
	 *  输入区被透明遮罩挡着，发不出东西。 */
	preview: UiState | null;
	/** rewind-to-here：回到一条用户消息后要放回输入框的文字（seq 递增，App 并进撤回草稿的同一条路）。 */
	rewindDraft: { text: string; seq: number } | null;
	/** optimistic-send: messages this window sent that the server hasn't confirmed yet (every chat;
	 *  drawn faded at the end of their chat, see web/src/pending-sends.ts). */
	pendingSends: readonly PendingSend[];
}

type Action =
	| { type: "rewind_draft"; text: string }
	| { type: "pending_add"; pending: PendingSend }
	| { type: "pending_retry"; id: string }
	| { type: "pending_fail"; id: string; reason: string }
	| { type: "pending_remove"; id: string }
	| { type: "prompt_ack"; ack: PromptAckInfo }
	| { type: "status"; status: ConnStatus }
	| { type: "switch_started"; target: SwitchTarget; startedAt: number; preview?: UiState }
	| { type: "switch_preview"; target: SwitchTarget; state: UiState }
	| { type: "switch_done"; target: SwitchTarget }
	| { type: "switch_failed"; target: SwitchTarget; error: string; errorEn?: string }
	| { type: "switch_hide" }
	| { type: "switch_dismiss_error" }
	| { type: "snapshot"; state: UiState }
	| { type: "snapshot_delta"; msg: Extract<ServerMessage, { type: "snapshot_delta" }> }
	| { type: "older_messages"; msg: Extract<ServerMessage, { type: "older_messages" }> }
	| { type: "older_exchanges"; msg: Extract<ServerMessage, { type: "older_exchanges" }> }
	| { type: "protocol_mismatch" }
	| { type: "tool_delta"; toolCallId: string; toolName: string; delta: string }
	| { type: "message_delta"; msg: MessageDeltaMsg }
	| { type: "tool_status"; status: ToolStatus }
	| { type: "notice"; notice: Notice }
	| { type: "dismiss_notice"; id: number }
	| {
			type: "ready";
			serverVersion: string;
			protocolVersion?: number;
			engine?: string;
			appVersion?: string;
			buildId?: string;
			managed?: boolean;
			tabs?: string[];
			service?: UiServiceInfo;
	  }
	| { type: "sessions"; sessions: SessionSummary[] }
	| {
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
			elsewhere?: ElsewhereRunning[];
	  }
	| { type: "projects"; projects: ProjectSummary[] }
	| { type: "files"; files: FileListing }
	| { type: "file_changed"; path: string }
	| { type: "file_content"; content: FileContent }
	| { type: "models"; models: ModelInfo[]; loading: boolean }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	| { type: "provider_keys"; keys: Record<string, ProviderKeyInfo[]> }
	| { type: "default_model"; modelId: string | null }
	| { type: "provider_oauth"; message: ProviderOAuthServerMessage }
	| {
			type: "fetch_models_result";
			result: { reqId: number; ok: boolean; models?: UiModelConfigEntry[]; error?: string };
	  }
	| {
			type: "test_model_connection_result";
			result: { reqId: number; ok: boolean; latencyMs?: number; error?: string };
	  }
	| {
			type: "enrich_models_result";
			result: { reqId: number; ok: boolean; results?: UiEnrichResult[]; error?: string };
	  }
	| {
			type: "enrich_models_progress";
			progress: {
				reqId: number;
				phase: "catalog" | "page" | "matching" | "aborted";
				current?: number;
				total?: number;
				message?: string;
			};
	  }
	| {
			type: "refresh_provider_result";
			result: { reqId: number; ok: boolean; added?: number; total?: number; error?: string };
	  }
	| {
			type: "refresh_builtin_result";
			result: { reqId: number; ok: boolean; error?: string };
	  }
	| {
			type: "append_builtin_result";
			result: { reqId: number; ok: boolean; error?: string };
	  }
	| {
			type: "clone_provider_result";
			result: { reqId: number; ok: boolean; config?: UiProviderConfig; configs?: UiProviderConfig[]; error?: string };
	  }
	| { type: "scm_data"; data: ServerMessage }
	| {
			type: "file_search_result";
			result: {
				reqId: number;
				ok: boolean;
				results: FileSearchResult[];
				truncated?: boolean;
			};
	  }
	| {
			type: "session_search_result";
			result: {
				reqId: number;
				ok: boolean;
				results: SessionSearchResult[];
			};
	  }
	| { type: "scm_changed" }
	| { type: "install_result"; result: { ok: boolean; detail: string } }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| {
			type: "update_status";
			status: {
				current: string;
				latest: string | null;
				latestPublishedAt: string | null;
				upToDate: boolean;
				error?: string;
			};
	  }
	| {
			type: "update_status_all";
			items: UpdateAllItem[];
			/** issue #321：pi SDK 副本状态快照。 */
			piSdk?: { running: string; bundledInUse: boolean; newerInstalled: string | null };
	  }
	| { type: "updates_check_started" }
	| { type: "widgets"; widgets: { key: string; lines: string[] }[] }
	| { type: "statuses"; statuses: { key: string; text: string | undefined }[] }
	| {
			type: "dialog";
			dialog: {
				id: number;
				kind: "select" | "confirm" | "input";
				title: string;
				args: unknown[];
			} | null;
	  }
	| {
			type: "question";
			question: UiPendingQuestion | null;
	  }
	| {
			type: "tool_approval";
			approval: UiToolApproval | null;
	  }
	| {
			/** telegram-answers: one permission prompt was answered (here, in another window or on Telegram). */
			type: "tool_approval_resolved";
			id: string;
	  }
	| {
			type: "remote_question";
			question: {
				owner: string;
				convId: string;
				id: string;
				questions: UiQuestion[];
				conversationTitle?: string;
			} | null;
	  }
	| { type: "commands"; commands: CommandDef[]; path: string }
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "terminal_add"; meta: TerminalMeta }
	| { type: "terminal_remove"; id: string }
	| { type: "terminal_exit"; conversationId?: string; terminalId: string; exitCode: number | null }
	| { type: "terminal_restart"; terminalId: string }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }
	| { type: "terminal_active"; id: string }
	| { type: "goal_status"; status: GoalStatus }
	| { type: "settings"; settings: UiSettingsState }
	| { type: "bg_servers"; servers: BgServer[] }
	| { type: "scheduler_tasks"; tasks: SchedulerTaskView[] }
	| { type: "plugins"; plugins: UiPluginInfo[]; epoch: number }
	| { type: "plugin_updates"; updates: UiPluginUpdateInfo[] }
	| { type: "plugin_updates_check_started" }
	| { type: "plugin_catalog"; entries: UiPluginCatalogEntry[]; epoch: number }
	/** 插件后台作业进度（安装/更新/卸载）：line 为该次新增的一行输出。 */
	| { type: "plugin_job"; job: Omit<PluginJobState, "lines" | "startedAt">; line?: string }
	| { type: "plugin_catalog_sync_result"; result: Omit<CatalogSyncState, "receivedAt"> }
	| { type: "plugin_install_inspect_result"; result: PluginInstallInspectState }
	/** 插件目录授权表（服务端推）。 */
	| { type: "plugin_grants"; grants: { pluginId: string; paths: string[] }[] }
	/** 插件能力授权表（服务端推；session 授权只在本次运行有效）。 */
	| {
			type: "plugin_permissions";
			grants: {
				pluginId: string;
				family: "net" | "llm";
				hosts?: string[];
				models?: string[];
				reason?: string;
				grantedAt: number;
				session?: boolean;
			}[];
	  }
	/** 插件请求能力授权（等用户答复；答复/超时后服务端推 resolved，本地移除）。 */
	| {
			type: "plugin_permission_request";
			req: {
				id: string;
				pluginId: string;
				family: "net" | "llm";
				hosts?: string[];
				models?: string[];
				reason?: string;
			};
	  }
	| { type: "plugin_permission_resolved"; id: string }
	/** 插件请求访问某个目录（等用户答复；答复后本地移除）。 */
	| { type: "plugin_path_request"; req: { id: string; pluginId: string; path: string; reason?: string } }
	| { type: "plugin_path_resolved"; id: string }
	| {
			type: "dsh_patches";
			patchDir: string;
			files: { name: string; path: string; size: number; mtimeMs: number }[];
	  }
	| { type: "dsh_presets"; presets: UiAgentPreset[]; defaultPreset: string }
	| { type: "dsh_permission"; options: DshPermissionOption[]; defaultPreset: string }
	| { type: "host_metrics"; metrics: UiHostMetrics };

const MAX_LIVE_OUTPUT = 200_000;
const MAX_TERM_BUFFER = 200_000;
/** Marker for truncated live output (was "…[前 N 字符已省略]…" / "…[N chars omitted above]…").
 *  ToolCallBlock maps it through the liveOutputOmitted i18n key so only one language shows. */
const LIVE_OMIT_MARK = "LIVE_OMIT";

/** Initial (inactive) goal status before the server pushes the first one. */
const DEFAULT_GOAL: GoalStatus = {
	conversationId: null,
	goal: null,
	reviewModel: null,
	maxRounds: 3,
	locked: true,
	reviewing: false,
	round: 0,
	status: "",
	verdict: "pending",
	wizard: {
		active: false,
		draft: "",
		model: null,
		step: 0,
		maxSteps: 6,
		status: "",
	},
};

/**
 * Bridges terminal output from the socket to live xterm instances. Output for
 * a terminal whose component isn't mounted yet (or that this tab doesn't know
 * about) is buffered (capped) so nothing is lost during mount/reconnect.
 */
interface TerminalWriter {
	write: (data: string) => void;
	dispose: () => void;
}

function makeTerminalBridge() {
	/** Multiple writers may subscribe to the same (conversation, terminal) pair —
	 *  e.g. the SCM panel's hidden query terminal parses output through its own
	 *  writer while a (hidden) xterm instance may also be registered for it.
	 *  A Set keeps them all: later registrations no longer shadow earlier ones. */
	const writers = new Map<string, Set<TerminalWriter>>();
	const buffers = new Map<string, string>();
	const key = (conversationId: string, terminalId: string) => `${conversationId}:${terminalId}`;
	return {
		write(conversationId: string, terminalId: string, data: string): void {
			const writerKey = key(conversationId, terminalId);
			const set = writers.get(writerKey);
			if (set && set.size > 0) {
				for (const w of set) {
					try {
						w.write(data);
					} catch {
						// best effort
					}
				}
				return;
			}
			const prev = buffers.get(writerKey) ?? "";
			const next = prev.length + data.length > MAX_TERM_BUFFER ? data : prev + data;
			buffers.set(writerKey, next);
		},
		/** Register a writer (xterm instance / output parser); flushes buffered
		 *  output to the new subscriber. Returns an unregister fn. */
		register(conversationId: string, terminalId: string, writer: TerminalWriter): () => void {
			const writerKey = key(conversationId, terminalId);
			let set = writers.get(writerKey);
			if (!set) {
				set = new Set();
				writers.set(writerKey, set);
			}
			set.add(writer);
			const buffered = buffers.get(writerKey);
			if (buffered) {
				try {
					writer.write(buffered);
				} catch {
					// best effort
				}
				buffers.delete(writerKey);
			}
			return () => {
				const s = writers.get(writerKey);
				if (s) {
					s.delete(writer);
					if (s.size === 0) writers.delete(writerKey);
				}
				buffers.delete(writerKey);
			};
		},
		clear(): void {
			writers.clear();
			buffers.clear();
		},
	};
}

function pruneLiveOutputs(
	live: Map<string, { toolName: string; text: string }>,
	state: UiState,
): Map<string, { toolName: string; text: string }> {
	const completed = new Set<string>();
	for (const m of state.messages) {
		if (m.role === "toolResult" && m.toolCallId) completed.add(m.toolCallId);
		// bashExecution transcript messages supersede live bash deltas
		if (m.role === "bashExecution") completed.add(`bash-${m.id}`);
	}
	let changed = false;
	for (const id of live.keys()) {
		if (completed.has(id)) {
			live.delete(id);
			changed = true;
		}
	}
	return changed ? new Map(live) : live;
}

/** Drop tool_status entries once the authoritative toolResult message lands.
 *  Builds the landed-id Set once (O(messages)) instead of scanning all
 *  messages per status entry (was O(statuses × messages) every snapshot). */
function pruneToolStatuses(statuses: Map<string, ToolStatus>, state: UiState): Map<string, ToolStatus> {
	if (statuses.size === 0) return statuses;
	const landed = new Set<string>();
	for (const m of state.messages) {
		if (m.role === "toolResult" && m.toolCallId) landed.add(m.toolCallId);
	}
	let changed = false;
	for (const id of statuses.keys()) {
		if (landed.has(id)) {
			statuses.delete(id);
			changed = true;
		}
	}
	return changed ? new Map(statuses) : statuses;
}

function reducer(state: ChatState, action: Action): ChatState {
	switch (action.type) {
		case "status":
			return {
				...state,
				status: action.status,
				// A new socket is not ready until its hello/ready round-trip completes.
				ready: action.status === "open" ? state.ready : false,
				// PTYs are conversation-owned and survive socket reconnects. Clear only
				// the browser views so xterm writers remount when the server replays them.
				terminals: action.status === "closed" ? [] : state.terminals,
				hostMetrics: action.status === "closed" ? null : state.hostMetrics,
			};
		case "host_metrics":
			return {
				...state,
				hostMetrics: action.metrics,
			};
		case "ready":
			return {
				...state,
				serverVersion: action.serverVersion,
				engine: action.engine,
				appVersion: action.appVersion,
				managed: action.managed === true,
				tabs: action.tabs,
				ready: true,
				// 新的一条 socket = 新的真相：上一条连接上发出的切换要么已经完成（接下来的快照
				// 就是它），要么随服务端重启丢了 —— 两种情况都不该继续盖着「正在打开」。
				pendingSwitch: null,
				preview: null,
				// optimistic-send: sends still waiting for an answer are asked about again on this socket.
				pendingSends: onReconnect(state.pendingSends),
				// Old page + new server (or the reverse) after an in-place update:
				// WS handling on either side may be stale — banner asks for refresh.
				protocolMismatch: action.protocolVersion !== undefined && action.protocolVersion !== PROTOCOL_VERSION,
			};
		case "snapshot": {
			// 整份快照只带最新一截：同一会话时把用户已加载的更早历史留住，否则重连/
			// resync 一来就把「加载更早消息」的结果冲掉（load-older-survives-snapshot）。
			const next = keepLoadedHistory(state.state, action.state);
			const settled = settleOnSnapshot(state.pendingSwitch, state.switchError, action.state);
			return {
				...state,
				ready: true,
				state: next,
				approval: next.pendingApproval ?? null,
				activeConversationId: next.conversationId,
				liveOutputs: pruneLiveOutputs(state.liveOutputs, next),
				toolStatuses: pruneToolStatuses(state.toolStatuses, next),
				// optimistic-send: the faded copies this snapshot shows the real message of go now, in the
				// same render that draws it (no gap, no duplicate).
				pendingSends: reconcilePending(state.pendingSends, next),
				// switch-loading 保险信号：要的那条已经显示出来了就撤遮罩（主信号是 switch_done）。
				...settled,
				// switch-cache：真快照到了，预览功成身退。
				...(settled && settled.pendingSwitch === null ? { preview: null } : {}),
			};
		}
		case "older_messages": {
			// 向前拼一截历史消息（chat-window-pagination）；作废的回执原状返回。
			const ui = state.state;
			if (!ui) return state;
			const next = prependOlderMessages(ui, action.msg);
			return next ? { ...state, state: next } : state;
		}
		case "older_exchanges": {
			// 往前拼几轮摘要（exchange-digest）；作废的回执原状返回。
			const ui = state.state;
			if (!ui) return state;
			const next = prependOlderExchanges(ui, action.msg);
			return next ? { ...state, state: next } : state;
		}
		case "switch_started":
			return {
				...state,
				pendingSwitch: { target: action.target, startedAt: action.startedAt, hidden: false },
				// 重试 = 新的一次切换，上一次的错误态不再相关。
				switchError: null,
				// switch-cache：缓存里有目标就先显示它（连点两条时换成后一条的，没有就清掉）。
				preview: action.preview ?? null,
			};
		case "switch_preview":
			// chat-open-speed: the newest messages of the chat being opened, read from its file while
			// the rest of it still loads. Only for the switch we are still waiting on, and only while
			// the overlay is up: a late one must not paint over a chat that finished opening. It
			// replaces the page's own cached preview (same messages, but current).
			return sameSwitchTarget(state.pendingSwitch?.target, action.target) && !state.pendingSwitch?.hidden
				? { ...state, preview: action.state }
				: state;
		case "switch_done":
			// 只认自己还在等的那次：连点两条时早先那次的回执不能把后一次的遮罩撤掉。
			return sameSwitchTarget(state.pendingSwitch?.target, action.target)
				? { ...state, pendingSwitch: null, preview: null }
				: state;
		case "switch_failed":
			if (!sameSwitchTarget(state.pendingSwitch?.target, action.target)) return state;
			return {
				...state,
				pendingSwitch: null,
				switchError: { target: action.target, error: action.error, errorEn: action.errorEn },
				preview: null,
			};
		case "switch_hide":
			// 隐藏遮罩 = 继续用原来的对话（服务端还在它上面），预览也得撤：否则看到的是 B、输入却进了 A。
			return state.pendingSwitch
				? { ...state, pendingSwitch: { ...state.pendingSwitch, hidden: true }, preview: null }
				: state;
		case "switch_dismiss_error":
			return { ...state, switchError: null };
		case "snapshot_delta": {
			// Incremental checkpoint from the server. Apply ONLY when it chains
			// cleanly onto our current rev; a mismatch (dropped message under
			// backpressure, stale tab) is ignored here — the ws handler schedules
			// a get_state resync. Immutable merge: appended messages extend the
			// array (element references preserved → React memo keeps working);
			// light fields replace wholesale.
			const ui = state.state;
			const d = action.msg;
			if (!ui || ui.conversationId !== d.conversationId || ui.rev !== d.baseRev) return state;
			const merged: UiState = {
				...ui,
				...d.state,
				messages: d.appended.length > 0 ? [...ui.messages, ...d.appended] : ui.messages,
				...paginationAfterDelta(ui, d.state),
			};
			return {
				...state,
				ready: true,
				state: merged,
				approval: merged.pendingApproval !== undefined ? (merged.pendingApproval ?? null) : state.approval,
				activeConversationId: merged.conversationId,
				liveOutputs: pruneLiveOutputs(state.liveOutputs, merged),
				toolStatuses: pruneToolStatuses(state.toolStatuses, merged),
				pendingSends: reconcilePending(state.pendingSends, merged),
			};
		}
		case "tool_approval":
			return { ...state, approval: action.approval };
		case "tool_approval_resolved":
			// telegram-answers: prompts are process-wide and a window may show another chat's, so close
			// only the one that was answered. The server's next snapshot brings the next one, if any.
			return state.approval?.id === action.id ? { ...state, approval: null } : state;
		case "tool_delta": {
			const prev = state.liveOutputs.get(action.toolCallId);
			// Keep the TAIL when over the cap (not the head): for a long-running
			// tool what matters is the LATEST output — keeping the head would show
			// only the earliest 200K chars and freeze visually while the tool is
			// still streaming. The terminal-bridge buffer below already keeps the
			// newest data; this unifies the semantics.
			const text = (prev?.text ?? "") + action.delta;
			const capped =
				text.length > MAX_LIVE_OUTPUT
					? `…[${LIVE_OMIT_MARK}:${text.length - MAX_LIVE_OUTPUT}]…\n` + text.slice(text.length - MAX_LIVE_OUTPUT)
					: text;
			const liveOutputs = new Map(state.liveOutputs);
			liveOutputs.set(action.toolCallId, {
				toolName: action.toolName,
				text: capped,
			});
			return { ...state, liveOutputs };
		}
		case "message_delta": {
			const ui = state.state;
			// Server only streams the active conversation, but filter defensively:
			// a late delta for another conversation must not clobber this view.
			if (!ui || ui.conversationId !== action.msg.conversationId) return state;
			// applyMessageDelta is pure/immutable (StrictMode double-invokes reducers).
			return { ...state, state: applyMessageDelta(ui, action.msg) };
		}
		case "tool_status":
			return {
				...state,
				toolStatuses: new Map(state.toolStatuses).set(action.status.toolCallId, action.status),
			};
		case "notice":
			return { ...state, notices: [...state.notices, action.notice].slice(-6) };
		case "rewind_draft":
			return { ...state, rewindDraft: { text: action.text, seq: (state.rewindDraft?.seq ?? 0) + 1 } };
		case "pending_add":
			return { ...state, pendingSends: [...state.pendingSends, action.pending] };
		case "pending_retry":
			return { ...state, pendingSends: retryPending(state.pendingSends, action.id, state.state) };
		case "pending_fail":
			return { ...state, pendingSends: failPending(state.pendingSends, action.id, action.reason) };
		case "pending_remove":
			return { ...state, pendingSends: removePending(state.pendingSends, action.id) };
		case "prompt_ack": {
			const next = applyPromptAck(state.pendingSends, action.ack, state.state);
			return next === state.pendingSends ? state : { ...state, pendingSends: next };
		}
		case "dismiss_notice":
			return {
				...state,
				notices: state.notices.filter((n) => n.id !== action.id),
			};
		case "sessions":
			return { ...state, sessions: action.sessions };
		case "conversations":
			return {
				...state,
				conversations: action.conversations,
				elsewhere: action.elsewhere ?? [],
				activeConversationId: action.activeId,
			};
		case "projects":
			return { ...state, projects: action.projects };
		case "files":
			return { ...state, files: action.files };
		case "file_changed":
			return { ...state, fileChanged: { path: action.path } };
		case "file_content":
			return { ...state, fileContent: action.content };
		case "models":
			return { ...state, models: action.models, modelsLoading: action.loading };
		case "models_config":
			return { ...state, modelsConfig: action.providers };
		case "providers_status":
			return { ...state, providers: action.providers };
		case "provider_keys":
			return { ...state, providerKeys: action.keys };
		case "default_model":
			return { ...state, defaultModel: action.modelId };
		case "provider_oauth": {
			const oauth = reduceProviderOAuthState(
				{ flows: state.providerOAuthFlows, results: state.providerOAuthResults },
				action.message,
			);
			return { ...state, providerOAuthFlows: oauth.flows, providerOAuthResults: oauth.results };
		}
		case "fetch_models_result":
			return { ...state, fetchModelsResult: action.result };
		case "test_model_connection_result":
			return { ...state, testModelConnectionResult: action.result };
		case "enrich_models_progress":
			return { ...state, enrichModelsProgress: action.progress };
		case "enrich_models_result":
			return { ...state, enrichModelsResult: action.result, enrichModelsProgress: null };
		case "refresh_provider_result":
			return { ...state, refreshProviderResult: action.result };
		case "refresh_builtin_result":
			return { ...state, refreshBuiltinResult: action.result };
		case "append_builtin_result":
			return { ...state, appendBuiltinResult: action.result };
		case "clone_provider_result":
			return { ...state, cloneProviderResult: action.result };
		case "install_result":
			return { ...state, installResult: action.result };
		case "scm_data":
			return { ...state, scmData: action.data };
		case "file_search_result":
			return { ...state, fileSearch: action.result };
		case "session_search_result":
			return { ...state, sessionSearch: action.result };
		case "scm_changed":
			return { ...state, scmDirty: state.scmDirty + 1 };
		case "path_completions":
			return { ...state, pathCompletions: action.completions };
		case "update_status":
			return { ...state, update: action.status };
		case "update_status_all":
			return { ...state, updatesAll: action.items, updatesSdk: action.piSdk ?? null };
		case "updates_check_started":
			// Forced re-check: clear stale rows so the "checking" state renders.
			return { ...state, updatesAll: null };
		case "widgets":
			return { ...state, widgets: action.widgets };
		case "statuses":
			return { ...state, statuses: action.statuses };
		case "dialog":
			return { ...state, dialog: action.dialog };
		case "question":
			return { ...state, question: action.question };
		case "remote_question":
			return { ...state, remoteQuestion: action.question };
		case "commands":
			return {
				...state,
				commands: action.commands,
				commandsPath: action.path,
			};
		case "slash_commands":
			return { ...state, slashCommands: action.commands };
		case "goal_status":
			return { ...state, goal: action.status };
		case "settings":
			return { ...state, settings: action.settings };
		case "bg_servers":
			return { ...state, bgServers: action.servers };
		case "scheduler_tasks":
			return { ...state, schedulerTasks: action.tasks };
		case "plugins":
			return { ...state, plugins: action.plugins, pluginsEpoch: action.epoch };
		case "plugin_updates_check_started":
			return { ...state, checkingPluginUpdates: true };
		case "plugin_updates": {
			const map: Record<string, UiPluginUpdateInfo> = {};
			for (const u of action.updates) {
				map[u.id] = u;
			}
			return { ...state, pluginUpdates: map, checkingPluginUpdates: false };
		}
		case "plugin_catalog":
			return { ...state, pluginCatalog: action.entries, pluginCatalogEpoch: action.epoch };
		case "plugin_grants":
			return { ...state, pluginGrants: action.grants };
		case "plugin_permissions":
			return { ...state, pluginPermissions: action.grants };
		case "plugin_path_request":
			return {
				...state,
				pathRequests: [...state.pathRequests.filter((r) => r.id !== action.req.id), action.req],
			};
		case "plugin_path_resolved":
			return { ...state, pathRequests: state.pathRequests.filter((r) => r.id !== action.id) };
		case "plugin_permission_request":
			return {
				...state,
				permRequests: [...state.permRequests.filter((r) => r.id !== action.req.id), action.req],
			};
		case "plugin_permission_resolved":
			return { ...state, permRequests: state.permRequests.filter((r) => r.id !== action.id) };
		case "plugin_job": {
			// 插件后台作业的进度（安装/更新/卸载）——即时通道，不进快照。
			const { pluginId, phase, ok, action: jobAction } = action.job;
			let nextUpdates = state.pluginUpdates;
			if (jobAction === "update" && phase === "done" && ok && state.pluginUpdates?.[pluginId]) {
				nextUpdates = {
					...state.pluginUpdates,
					[pluginId]: {
						...state.pluginUpdates[pluginId],
						updatable: false,
					},
				};
			}
			const prev = state.pluginJobs[action.job.jobId];
			const lines = action.line ? [...(prev?.lines ?? []), action.line].slice(-40) : (prev?.lines ?? []);
			const next: PluginJobState = {
				...prev,
				...action.job,
				lines,
				startedAt: prev?.startedAt ?? Date.now(),
			};
			return {
				...state,
				pluginUpdates: nextUpdates,
				pluginJobs: { ...state.pluginJobs, [action.job.jobId]: next },
			};
		}
		case "plugin_catalog_sync_result":
			return { ...state, catalogSync: { ...action.result, receivedAt: Date.now() } };
		case "plugin_install_inspect_result":
			// 只留最近一次（输入框下面的那一句话），旧的直接丢掉。
			return { ...state, installInspect: action.result };
		case "dsh_patches":
			return { ...state, dshPatches: { patchDir: action.patchDir, files: action.files } };
		case "dsh_presets":
			return { ...state, dshPresets: { presets: action.presets, defaultPreset: action.defaultPreset } };
		case "dsh_permission":
			return { ...state, dshPermission: { options: action.options, defaultPreset: action.defaultPreset } };
		case "terminal_add":
			return { ...state, terminals: [...state.terminals, action.meta] };
		case "terminal_remove":
			return {
				...state,
				terminals: state.terminals.filter((t) => t.id !== action.id),
			};
		case "terminal_exit":
			if (
				action.conversationId &&
				(state.activeConversationId || state.state?.conversationId) &&
				action.conversationId !== (state.activeConversationId || state.state?.conversationId)
			)
				return state;
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId ? { ...t, running: false, exitCode: action.exitCode } : t,
				),
			};
		case "terminal_restart":
			// The command is re-running in the same tab (server restarted the PTY).
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId ? { ...t, running: true, exitCode: null } : t,
				),
			};
		case "terminal_list":
			if (
				action.conversationId &&
				(state.activeConversationId || state.state?.conversationId) &&
				action.conversationId !== (state.activeConversationId || state.state?.conversationId)
			) {
				return state;
			}
			return {
				...state,
				terminals: action.terminals.map((terminal) => ({
					...terminal,
					conversationId: action.conversationId ?? state.state?.conversationId ?? "",
				})),
			};
		case "terminal_active":
			return { ...state, terminalActiveId: action.id };
		default:
			return state;
	}
}

/** optimistic-send: the sends kept from before a reload (read once per page load). */
let restoredPendingSends: readonly PendingSend[] | null = null;
function loadPendingSends(): readonly PendingSend[] {
	if (restoredPendingSends === null) {
		let raw: string | null = null;
		try {
			raw = sessionStorage.getItem(PENDING_STORAGE_KEY);
		} catch {
			// storage off: nothing to restore
		}
		restoredPendingSends = parsePending(raw);
	}
	return restoredPendingSends;
}

/** optimistic-send: why Retry did nothing (the window has no connection to send it on). */
const NOT_CONNECTED_REASON = "Not connected to the server.";

let cachedClientId: string | null = null;

/**
 * 客户端标识 —— **每次页面加载独立**（不落任何存储）。
 *
 * 演进：localStorage（同源所有标签页共用一个 id → 后端挂到同一个 ClientSession
 * 上互为镜像，B 页切对话把 A 页也切走、甚至中断 A 正在输出的 agent，issue #10）
 * → sessionStorage（每标签页独立，但「复制标签页」/ Ctrl-点链接 / 恢复上次会话
 * 会把它一起克隆，两个窗口照样共用一个 id，镜像原样复现）
 * → 现在：每次加载现生一个，撞车在构造上不可能。
 */
export function getClientId(): string {
	// 每次页面加载一个**全新**的 id，不落任何存储。
	//
	// 为什么不持久化：id 相同 = 后端挂到同一个 ClientSession = 两个窗口互为镜像
	// （一边切对话另一边跟着变，issue #10 的老毛病）。sessionStorage 看似每标签页
	// 独立，但「复制标签页」/ Ctrl-点链接 / 恢复上次会话都会把它一起克隆，于是
	// 两个窗口又拿到同一个 id。改成每次加载现生，撞车在构造上就不可能发生。
	//
	// 代价（刻意接受）：刷新后不再自动回到上次那条对话 —— 对话本身在服务端好好
	// 跑着，左栏「最近对话」里点回去就是。工作目录另有 localStorage 记忆（见下面的
	// lastCwd），不依赖 clientId。
	cachedClientId ??= randomUuid();
	return cachedClientId;
}

// no-cwd-restore：上游在这里用 localStorage（`pi-web-last-cwd`）记住上次工作目录，首帧快照
// 时补发 set_cwd 切回去。整套删掉了：工作目录只由用户显式切换，项目列表由服务端
// stateStore 记，浏览器这边不再有任何「记住目录」的状态（只写不读的 key 只会让下一个
// 读代码的人以为恢复还在）。上游 #319 的 clearLastCwdIfMatches（移出项目时清这个 key）
// 也就没有可清的了，连同左栏的调用一起删掉。

/** Resolve the WebSocket URL: same host when served by the backend, or the Vite proxy in dev. */
function wsUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	// appUrl 补应用根前缀：子路径反代（/pi/）下 WS 也必须走 /pi/ws。
	return withToken(`${proto}//${location.host}${appUrl("/ws")}`);
}

export function useChat() {
	const [chat, dispatch] = useReducer(reducer, {
		status: "connecting",
		ready: false,
		state: null,
		hostMetrics: null,
		liveOutputs: new Map(),
		toolStatuses: new Map(),
		notices: [],
		sessions: [],
		conversations: [],
		elsewhere: [],
		activeConversationId: "",
		projects: [],
		files: null,

		fileChanged: null,
		fileContent: null,
		models: [],
		modelsLoading: false,
		modelsConfig: [],
		providers: [],
		providerKeys: {},
		defaultModel: null,
		providerOAuthFlows: [],
		providerOAuthResults: initialProviderOAuthState().results,
		installResult: null,
		pathCompletions: [],
		update: null,
		updatesAll: null,
		updatesSdk: null,
		widgets: [],
		statuses: [],
		dialog: null,
		approval: null,
		question: null,
		remoteQuestion: null,
		commands: [],
		commandsPath: "",
		slashCommands: [],
		terminals: [],
		terminalActiveId: null,
		goal: DEFAULT_GOAL,
		bgServers: [],
		schedulerTasks: [],
		settings: null,
		fetchModelsResult: null,
		testModelConnectionResult: null,
		enrichModelsResult: null,
		enrichModelsProgress: null,
		refreshProviderResult: null,
		refreshBuiltinResult: null,
		appendBuiltinResult: null,
		cloneProviderResult: null,
		scmData: null,
		fileSearch: null,
		sessionSearch: null,
		scmDirty: 0,
		plugins: [],
		pluginsEpoch: 0,
		pluginUpdates: null,
		checkingPluginUpdates: false,
		pluginCatalog: [],
		pluginCatalogEpoch: 0,
		pluginJobs: {},
		catalogSync: null,
		installInspect: null,
		pluginGrants: [],
		pluginPermissions: [],
		pathRequests: [],
		permRequests: [],
		dshPatches: null,
		dshPresets: null,
		dshPermission: null,
		protocolMismatch: false,
		pendingSwitch: null,
		switchError: null,
		preview: null,
		rewindDraft: null,
		// optimistic-send: sends from before a reload come back and are asked about again.
		pendingSends: loadPendingSends(),
	});
	const wsRef = useRef<WebSocket | null>(null);
	/** Terminal output bridge (writers keyed by terminalId). */
	const bridgeRef = useRef(makeTerminalBridge());
	/** Reconnect backoff counter — ref so it never causes re-renders. */
	const retryRef = useRef(0);
	/** Pending reconnect timer. */
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** False once the hook is unmounted/cleaned up — stops stale onclose handlers from reconnecting. */
	const aliveRef = useRef(true);
	/** Last time any server message arrived — used to detect half-open connections. */
	const lastBeatRef = useRef(0);
	/** mobile-fixes: is the current socket alive? (quiet too long / no answer after coming back = dead) */
	const healthRef = useRef(new ConnHealth());
	/** mobile-fixes: when the current socket started connecting (a hanging attempt is given up). */
	const connectAtRef = useRef(0);
	/** mobile-fixes: a socket was open before (the note is for losing a connection, not the first load). */
	const hadOpenRef = useRef(false);
	/** mobile-fixes: catching up after a lost connection since (ms; 0 = not): the note stays until the
	 *  chat's content has come in again. */
	const catchUpRef = useRef(0);
	/** mobile-fixes: the open socket is in doubt (no answer yet after coming back / quiet for a while). */
	const doubtRef = useRef(false);
	const noticeId = useRef(0);
	/** Last delta seq seen per conversation (message_delta + tool_delta share
	 *  one per-conversation sequence) — a gap on the ACTIVE conversation
	 *  triggers a one-shot get_state resync; background conversations converge
	 *  via snapshot when switched to. */
	const lastDeltaSeqRef = useRef<Map<string, number>>(new Map());
	const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** 已作答/取消的问卷 id —— 在途旧快照不得把已答过的问卷重新弹出来。
	 *  id 全局单调递增（服务端 questionSeq / 时间戳），保留少量历史即可。 */
	const answeredQuestionsRef = useRef<Set<string>>(new Set());
	/** switch-cache：看过的对话按转录路径留一份（切回来先显示它，服务端只补差异）。 */
	const chatCacheRef = useRef<ChatCache | null>(null);
	chatCacheRef.current ??= new ChatCache();
	/** 发出去的 have 各是按哪份缓存算的（按 windowKey）：reuse 回来时就拿那一份来接。
	 *  连点几条时可能同时有好几个在途；这条会话的整份快照一到就清掉它的，换连接时全清。 */
	const resumeBasesRef = useRef<Map<string, UiState>>(new Map());
	// 当前显示的对话状态随时记进缓存（只存引用，流式期间 60ms 一次也便宜）。
	useEffect(() => {
		chatCacheRef.current?.put(chat.state);
	}, [chat.state]);
	/** 当前问卷面板的来源：live = question_pending 即时通道弹出；snapshot = 由快照
	 *  恢复（重连/刷新）。在同一会话内，只有 snapshot 来源的才接受快照收起（切换会话
	 *  时无论来源一律收起，见 resolvePendingQuestion 规则 2）。 */
	const questionSourceRef = useRef<QuestionSource>("live");

	/** Debounced authoritative resync: get_state always returns a FULL snapshot.
	 *  Shared by delta-seq gap detection and snapshot_delta rev mismatch. */
	const scheduleResync = (): void => {
		if (resyncTimerRef.current) return;
		resyncTimerRef.current = setTimeout(() => {
			resyncTimerRef.current = null;
			const ws = wsRef.current;
			if (ws && ws.readyState === WebSocket.OPEN)
				ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
		}, 300);
	};

	const noteDeltaSeq = (conversationId: string, seq: number): void => {
		const map = lastDeltaSeqRef.current;
		const last = map.get(conversationId);
		if (last !== undefined && seq !== last + 1) {
			const c = chatApi.current.chat;
			const active = c.activeConversationId || c.state?.conversationId;
			if (conversationId === active) {
				// Missed deltas (should not happen on a healthy WS) — resync via a
				// debounced get_state; keep patching meanwhile (the next snapshot
				// reconciles any drift).
				scheduleResync();
			}
		}
		map.set(conversationId, seq);
	};

	const pushNotice = useCallback((level: Notice["level"], text: string) => {
		const id = ++noticeId.current;
		dispatch({ type: "notice", notice: { id, level, text } });
		// 自动消失计时由通知组件（NoticeToast）管理：悬浮暂停、移开继续。
	}, []);

	/** chat-open-speed: messages written while their chat was still opening. They show as faded
	 *  copies straight away and go out once that chat is ready (`switch_done`), each tagged with the
	 *  chat it was written in so the server refuses it if the window ended up on another one. */
	const heldSendsRef = useRef<{ target: SwitchTarget; id: string; msg: ClientMessage }[]>([]);

	/** The chat they were written in is ready: send them, oldest first. */
	const flushHeldSends = (target: SwitchTarget): void => {
		const held = heldSendsRef.current;
		if (held.length === 0) return;
		const mine = held.filter((h) => sameSwitchTarget(h.target, target));
		if (mine.length === 0) return;
		heldSendsRef.current = held.filter((h) => !sameSwitchTarget(h.target, target));
		const ws = wsRef.current;
		for (const h of mine) {
			if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(h.msg));
			else dispatch({ type: "pending_fail", id: h.id, reason: "The connection dropped before it was sent." });
		}
	};

	/** That chat never came up (the open failed, the window went back, the connection dropped):
	 *  mark the copies "Not sent" instead of leaving them waiting for ever. */
	const failHeldSends = (reason: string, target?: SwitchTarget): void => {
		const held = heldSendsRef.current;
		if (held.length === 0) return;
		const mine = target ? held.filter((h) => sameSwitchTarget(h.target, target)) : held;
		if (mine.length === 0) return;
		heldSendsRef.current = target ? held.filter((h) => !sameSwitchTarget(h.target, target)) : [];
		for (const h of mine) dispatch({ type: "pending_fail", id: h.id, reason });
	};

	const send = useCallback((msg: ClientMessage) => {
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			// Forced re-check: drop stale rows immediately so the "checking"
			// state renders instead of the cached list.
			if (msg.type === "check_updates_all" && msg.force === true) {
				dispatch({ type: "updates_check_started" });
			}
			if (msg.type === "check_plugin_updates") {
				dispatch({ type: "plugin_updates_check_started" });
			}
			// switch-loading：在发出的那一刻就进入「正在打开…」。在 send 里拦而不是在各个点击处：
			// 左栏、全局搜索、插件 startChat……所有入口都经过这里。已经显示着目标则不设：
			// 那种情况服务端可能不发任何新东西，遮罩会一直盖着。
			const switchTarget: SwitchTarget | null =
				msg.type === "switch_session"
					? { kind: "session", path: msg.path }
					: msg.type === "switch_conversation"
						? { kind: "conversation", id: msg.id }
						: null;
			// chat-open-speed: going somewhere else while a chat is still opening drops what was written
			// in it — better a clear "not sent" than a message arriving in a chat they have left.
			if (
				heldSendsRef.current.length > 0 &&
				(msg.type === "new_chat" ||
					((msg.type === "switch_session" || msg.type === "switch_conversation") &&
						heldSendsRef.current.some((h) => switchTarget === null || !sameSwitchTarget(h.target, switchTarget))))
			) {
				failHeldSends("You left the chat before it opened, so this wasn't sent.");
			}
			let out: ClientMessage = msg;
			if (switchTarget && !switchAlreadyShown(switchTarget, chatApi.current.chat.state)) {
				// switch-cache：看过这条就先显示缓存的那份，并告诉服务端手里有哪一截（它只补差异）。
				const preview = chatCacheRef.current?.forTarget(switchTarget, chatApi.current.chat.conversations);
				const have = preview ? cachedWindow(preview) : null;
				if (preview && have && (msg.type === "switch_session" || msg.type === "switch_conversation")) {
					resumeBasesRef.current.set(windowKey(have), preview);
					out = { ...msg, have };
				}
				dispatch({
					type: "switch_started",
					target: switchTarget,
					startedAt: Date.now(),
					...(preview && have ? { preview } : {}),
				});
			}
			// optimistic-send: a message sent with an id is drawn at once, faded, until the server
			// answers (web/src/pending-sends.ts). Slash commands run a command instead: no copy.
			// chat-open-speed: written while the chat was still opening? Then the copy belongs to the
			// chat being opened (the one on screen), and the message itself waits for it.
			const opening = chatApi.current.chat.pendingSwitch;
			const shownPreview = chatApi.current.chat.preview;
			const hold =
				out.type === "prompt" &&
				out.id &&
				!isSlashText(out.text) &&
				opening &&
				!opening.hidden &&
				shownPreview?.sessionId
					? { target: opening.target, id: out.id, forSession: shownPreview.sessionId, state: shownPreview }
					: null;
			if (out.type === "prompt" && out.id && !isSlashText(out.text)) {
				const ui = hold ? hold.state : chatApi.current.chat.state;
				const id = out.id;
				if (ui && !chatApi.current.chat.pendingSends.some((p) => p.id === id)) {
					dispatch({
						type: "pending_add",
						pending: newPendingSend({
							id,
							text: out.text,
							attachments: out.attachments,
							queue: out.queue,
							state: ui,
							now: Date.now(),
						}),
					});
				}
			}
			if (hold && out.type === "prompt") {
				// Waits for switch_done (flushHeldSends); the faded copy above shows it meanwhile.
				heldSendsRef.current.push({ target: hold.target, id: hold.id, msg: { ...out, forSession: hold.forSession } });
				return true;
			}
			ws.send(JSON.stringify(out));
			// 提交/取消模型提问后立即收起对话框：服务端只 resolve 模型侧 Promise，
			// 不会发任何回执清除前端面板（否则会出现“回答后不消失、取消无效”）。
			// 模型再次 ask_user_question 时会重新 question_pending，面板自动回来。
			if (msg.type === "question_answer") {
				if (msg.owner) {
					// 跨页作答：只收跨页对话框。id 是对方会话作用域，绝不进 answered
					// 集合 —— 否则会误杀本会话未来同号问卷（两边计数器都从 q1 起）。
					const cur = chatApi.current.chat.remoteQuestion;
					if (cur && cur.id === msg.id) dispatch({ type: "remote_question", question: null });
				} else {
					// 记住这个 id：快照恢复时跳过它（回答消息与快照在途时会交错，服务端
					// 删除 pending 之前生成的快照仍带着这张问卷）。
					answeredQuestionsRef.current.add(msg.id);
					if (answeredQuestionsRef.current.size > 64) {
						const oldest = answeredQuestionsRef.current.values().next().value;
						if (oldest !== undefined) answeredQuestionsRef.current.delete(oldest);
					}
					questionSourceRef.current = "live";
					dispatch({ type: "question", question: null });
				}
			}
			return true;
		}
		return false;
	}, []);

	/** 快照里的待答问卷 → 恢复/收起对话框（页面刷新、WS 重连、新标签页）。
	 *
	 *  为什么需要它：question_pending 是即时通道，只推给「提问那一刻在线」的连接；
	 *  刷新/重连后前端拿不到那条历史消息，而服务端还在阻塞等人回答——问卷就从眼前
	 *  消失（DshQuestionDialog 无入口）。快照是权威态，据此把面板补回来。
	 *  判定规则（含三条边界）全在纯函数 resolvePendingQuestion。 */
	const syncPendingQuestion = useCallback((p: UiPendingQuestion | null | undefined, activeConversationId: string) => {
		const decision = resolvePendingQuestion({
			current: chatApi.current.chat.question,
			source: questionSourceRef.current,
			snapshot: p,
			answered: answeredQuestionsRef.current,
			activeConversationId,
		});
		if (!decision.changed) return;
		questionSourceRef.current = decision.source;
		dispatch({ type: "question", question: decision.question });
	}, []);

	// 装配全局发送器（web/src/app-globals.ts 的 appSend）：**在 render 期间**赋值，不用 effect。
	// 子组件的 effect 先于父组件跑，若放到 effect 里装配，那些「挂载即发请求」的弹窗
	// （PiSetupModal / ModelConfigModal / TerminalPanel …）会在 appSend 还是空的时候发消息，
	// 静默丢包。send 是 useCallback([]) 的稳定引用，重复赋值无副作用（StrictMode 双渲染亦然）。
	setAppSend(send);

	/** mobile-fixes: the "Reconnecting…" note: a connection was lost (or is in doubt) and the chat
	 *  hasn't caught up yet. Refs only, so it is stable. */
	const refreshNote = useCallback(() => {
		const ws = wsRef.current;
		const open = !!ws && ws.readyState === WebSocket.OPEN;
		setReconnectingNote(hadOpenRef.current && (!open || catchUpRef.current > 0 || doubtRef.current));
	}, []);

	/** Stable across renders — the reconnect loop lives entirely inside this closure. */
	const connect = useCallback(() => {
		if (!aliveRef.current) return;
		dispatch({ type: "status", status: "connecting" });
		const ws = new WebSocket(wsUrl());
		wsRef.current = ws;
		connectAtRef.current = Date.now();

		ws.onopen = () => {
			if (wsRef.current !== ws) return; // stale socket
			dispatch({ type: "status", status: "open" });
			retryRef.current = 0;
			lastBeatRef.current = Date.now();
			healthRef.current.opened(Date.now());
			hadOpenRef.current = true;
			doubtRef.current = false;
			ws.send(
				JSON.stringify({
					type: "hello",
					clientId: getClientId(),
					// UI language report (issue #91): server persists it per
					// client and uses it for tool return values / AI prompts.
					locale: readUiLocale(),
					// mobile-fixes: announce big messages first, so a slow link doesn't look dead.
					frameHints: true,
				} satisfies ClientMessage),
			);
			refreshNote();
		};

		ws.onmessage = (ev) => {
			if (wsRef.current !== ws) return; // stale socket
			lastBeatRef.current = Date.now(); // any traffic proves the connection is alive
			let msg: ServerMessage;
			try {
				msg = JSON.parse(ev.data as string) as ServerMessage;
			} catch {
				return;
			}
			// mobile-fixes: connection health (conn-health.ts). A big message is announced first; after
			// the page comes back only the answer to its ping proves the socket alive.
			if (msg.type === "frame_hint") {
				healthRef.current.heard(Date.now(), msg.chars);
				return;
			}
			healthRef.current.heard(Date.now());
			if (msg.type === "pong") {
				healthRef.current.answered(msg.id);
				if (doubtRef.current && !healthRef.current.checking) {
					doubtRef.current = false;
					refreshNote();
				}
				return;
			}
			// Caught up after a lost connection once the chat's content comes in again.
			if (
				catchUpRef.current &&
				(msg.type === "snapshot" ||
					msg.type === "snapshot_delta" ||
					msg.type === "switch_preview" ||
					msg.type === "switch_done")
			) {
				catchUpRef.current = 0;
				refreshNote();
			}
			switch (msg.type) {
				case "ready": {
					// Stale-build self-reload: the server reports the entry-chunk hash
					// of the index.html it serves now; ours is the hash in the entry
					// <script> of the index.html this page was served. Mismatch =
					// rebuilt since this page loaded → reload once for the fresh bundle.
					// single-load：上游拿 Vite 编进 bundle 的 __BUILD_ID__（构建时间戳）跟这个 hash 比，
					// 永远对不上，每个新标签页都白刷一次；改成读页面自己的入口 <script>，和服务端
					// buildId() 读的是同一个东西。
					// Loop guard: stamp sessionStorage BEFORE reloading — the fresh
					// page sees the same server hash, finds the stamp, and stops.
					// The stamp is per-build-id, so the NEXT rebuild reloads again.
					// Dev-server (Vite :5173) serves /src/main.tsx, no hash — never reload there.
					const mine =
						document
							.querySelector('script[src*="/assets/index-"]')
							?.getAttribute("src")
							?.match(/\/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1] ?? "";
					// Auto-reload setting (display tab, default on from source / off
					// for installs): settings may not have arrived yet on first
					// connect — fall back to ON so a fresh build never strands a stale
					// page on its very first load.
					const autoReload = chatApi.current.chat.settings?.autoReload ?? true;
					if (autoReload && msg.buildId && mine && msg.buildId !== mine) {
						const key = `pi-web-ui-reloaded-${msg.buildId}`;
						if (!sessionStorage.getItem(key)) {
							sessionStorage.setItem(key, "1");
							location.reload();
							return;
						}
					}
					// 全局运行态（engine / managed / tabs / 版本号）在这里落一次：
					// 同步于 dispatch 之前，等 React 因为新状态重渲染时，读全局的组件
					// 已经拿到正确值（不会闪一帧 pi）。详见 web/src/app-globals.ts。
					setAppGlobals({
						engine: msg.engine ?? "pi",
						managed: !!msg.managed,
						tabs: msg.tabs,
						appVersion: msg.appVersion,
						serverVersion: msg.serverVersion,
						service: msg.service,
					});
					dispatch({
						type: "ready",
						serverVersion: msg.serverVersion,
						protocolVersion: msg.protocolVersion,
						engine: msg.engine,
						appVersion: msg.appVersion,
						managed: msg.managed,
						tabs: msg.tabs,
						service: msg.service,
					});
					// Reconnect/attach: clear answered questions cache and stale dialog so
					// freshly started server runs don't collide on restarted question counters (e.g. q-1).
					answeredQuestionsRef.current.clear();
					// switch-cache：新连接上服务端不记得之前报过的 have。
					resumeBasesRef.current.clear();
					dispatch({ type: "question", question: null });
					// Ensure a fresh snapshot on (re)connect.
					ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
					// identity-notebook-tab: a new socket has no notebook watch yet; the open tab asks again.
					resendNotebookWatch();
					// roles-overview: the Roles page / top bar count watch is per socket too.
					resendRolesWatch();
					// subs-limits-box: the Limits box needs the readings (and whether a check runs) again.
					requestSubsLimits();
					// optimistic-send: ask what became of the sends still shown as "Sending" (after the
					// snapshot, which may show them already). Same list the "ready" reducer case keeps.
					const unanswered = idsToCheck(onReconnect(chatApi.current.chat.pendingSends));
					if (unanswered.length > 0)
						ws.send(JSON.stringify({ type: "prompt_status", ids: unanswered } satisfies ClientMessage));
					// Sessions + recent projects are LAZY: LeftPanel requests them
					// when it is actually shown — listing scans every session file
					// on disk (listAll scans ALL projects), too heavy for the
					// connect critical path.
					ws.send(JSON.stringify({ type: "list_files" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "list_models" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "list_commands" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "get_commands" } satisfies ClientMessage));
					// A managed instance refuses both (server/managed.ts): asking
					// anyway would greet every visitor with two red toasts about a
					// thing the interface does not even offer.
					if (!msg.managed) {
						ws.send(JSON.stringify({ type: "check_update" } satisfies ClientMessage));
						ws.send(JSON.stringify({ type: "check_updates_all" } satisfies ClientMessage));
					}
					break;
				}
				case "snapshot": {
					// switch-cache：带 reuse 的快照只有新增的尾巴，把当时报上去的那份缓存接在前面。
					// 对不上（缓存已经不在了）就不用它，要一份完整的。
					let state = msg.state;
					if (msg.reuse) {
						const merged = applyReuse(resumeBasesRef.current.get(windowKey(msg.reuse)), msg.state, msg.reuse);
						if (!merged) {
							ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
							break;
						}
						state = merged;
					}
					if (resumeBasesRef.current.size > 0) {
						for (const [k, base] of resumeBasesRef.current) {
							if (base.sessionId === state.sessionId) resumeBasesRef.current.delete(k);
						}
					}
					// Snapshot is authoritative — delta sequence tracking restarts.
					lastDeltaSeqRef.current = new Map();
					dispatch({ type: "snapshot", state });
					// 重连/刷新后从这里把待答问卷恢复出来（见 syncPendingQuestion）。
					syncPendingQuestion(state.pendingQuestion, state.conversationId);
					break;
				}
				case "snapshot_delta": {
					// Gap detection BEFORE dispatch: if this incremental checkpoint
					// doesn't chain onto our current rev (a message was dropped under
					// backpressure, or we're stale), schedule one debounced full resync.
					const cur = chatApi.current.chat.state;
					if (!cur || cur.conversationId !== msg.conversationId || cur.rev !== msg.baseRev) scheduleResync();
					dispatch({ type: "snapshot_delta", msg });
					syncPendingQuestion(msg.state.pendingQuestion, msg.conversationId);
					break;
				}
				case "older_messages":
					// 历史消息回执（chat-window-pagination）：不涉及 rev 链，不触发 resync。
					dispatch({ type: "older_messages", msg });
					break;
				case "older_exchanges":
					// 更早几轮的摘要（exchange-digest）：同样不涉及 rev 链。
					dispatch({ type: "older_exchanges", msg });
					break;
				case "tool_delta":
					noteDeltaSeq(msg.conversationId, msg.seq);
					dispatch({
						type: "tool_delta",
						toolCallId: msg.toolCallId,
						toolName: msg.toolName,
						delta: msg.delta,
					});
					break;
				case "tool_status":
					dispatch({ type: "tool_status", status: msg });
					break;
				case "message_delta": {
					noteDeltaSeq(msg.conversationId, msg.seq);
					dispatch({ type: "message_delta", msg });
					break;
				}
				case "subagent_handoff": {
					// 收到子代理对等交接事件：快照与 notice 会同步下发，此处作为协同事件分发入口
					break;
				}
				case "notice": {
					const id = ++noticeId.current;
					dispatch({
						type: "notice",
						notice: { id, level: msg.level, text: msg.text, textEn: msg.textEn },
					});
					break;
				}
				case "switch_preview":
					// chat-open-speed: the end of the chat, sent before the whole of it is loaded.
					dispatch({ type: "switch_preview", target: msg.target, state: msg.state });
					break;
				case "switch_done":
					// chat-open-speed: the chat is ready, so anything written while it was opening goes now.
					flushHeldSends(msg.target);
					dispatch({ type: "switch_done", target: msg.target });
					break;
				case "prompt_ack":
					// optimistic-send: the answer to a send (its snapshot came first, so the faded copy is
					// usually gone already; a refusal marks it "Not sent").
					dispatch({ type: "prompt_ack", ack: msg });
					break;
				case "rewind_done":
					// 回到的是用户消息：那条的文字回到输入框（别的结果靠服务端的 notice 和新快照）。
					if (msg.ok && msg.editorText) dispatch({ type: "rewind_draft", text: msg.editorText });
					break;
				case "switch_failed": {
					// 是自己在等的那次 → 聊天区错误态；不是（服务端内部自动切换失败）→ 降级成 toast，
					// 与以前的行为一致，不丢信息。
					failHeldSends("The chat didn't open, so this wasn't sent.", msg.target);
					if (sameSwitchTarget(chatApi.current.chat.pendingSwitch?.target, msg.target)) {
						dispatch({ type: "switch_failed", target: msg.target, error: msg.error, errorEn: msg.errorEn });
					} else {
						const id = ++noticeId.current;
						dispatch({ type: "notice", notice: { id, level: "error", text: msg.error, textEn: msg.errorEn } });
					}
					break;
				}
				case "sessions":
					dispatch({ type: "sessions", sessions: msg.sessions });
					break;
				case "conversations":
					dispatch({
						type: "conversations",
						conversations: msg.conversations,
						activeId: msg.activeId,
						elsewhere: msg.elsewhere,
					});
					break;
				case "projects":
					dispatch({ type: "projects", projects: msg.projects });
					break;
				case "files":
					dispatch({ type: "files", files: msg });
					break;
				case "file_changed":
					dispatch({ type: "file_changed", path: msg.path });
					break;
				case "file_content":
					dispatch({ type: "file_content", content: msg });
					break;
				case "models":
					dispatch({ type: "models", models: msg.models, loading: false });
					break;
				case "models_config":
					dispatch({ type: "models_config", providers: msg.providers });
					break;
				case "providers_status":
					dispatch({ type: "providers_status", providers: msg.providers });
					break;
				case "provider_keys":
					dispatch({ type: "provider_keys", keys: msg.keys });
					break;
				case "default_model":
					dispatch({ type: "default_model", modelId: msg.modelId });
					break;
				case "provider_oauth_started":
				case "provider_oauth_flows":
				case "provider_oauth_prompt":
				case "provider_oauth_event":
				case "provider_oauth_result":
				case "provider_oauth_logout_result":
					dispatch({ type: "provider_oauth", message: msg });
					break;
				case "fetch_models_result":
					dispatch({
						type: "fetch_models_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							models: msg.models,
							error: msg.error,
						},
					});
					break;
				case "test_model_connection_result":
					dispatch({
						type: "test_model_connection_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							latencyMs: msg.latencyMs,
							error: msg.error,
						},
					});
					break;
				case "enrich_models_progress":
					dispatch({
						type: "enrich_models_progress",
						progress: {
							reqId: msg.reqId,
							phase: msg.phase,
							current: msg.current,
							total: msg.total,
							message: msg.message,
						},
					});
					break;
				case "enrich_models_result":
					dispatch({
						type: "enrich_models_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							results: msg.results,
							error: msg.error,
						},
					});
					break;
				case "refresh_provider_result":
					dispatch({
						type: "refresh_provider_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							added: msg.added,
							total: msg.total,
							error: msg.error,
						},
					});
					break;
				case "refresh_builtin_result":
					dispatch({
						type: "refresh_builtin_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							error: msg.error,
						},
					});
					break;
				case "append_builtin_result":
					dispatch({
						type: "append_builtin_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							error: msg.error,
						},
					});
					break;
				case "clone_provider_result":
					dispatch({
						type: "clone_provider_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							config: msg.config,
							configs: (msg as { configs?: UiProviderConfig[] }).configs,
							error: msg.error,
						},
					});
					break;
				case "scm_data":
					dispatch({ type: "scm_data", data: msg });
					break;
				case "search_files_result":
					dispatch({
						type: "file_search_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							results: msg.results,
							truncated: msg.truncated,
						},
					});
					break;
				case "session_search_results":
					dispatch({
						type: "session_search_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							results: msg.results,
						},
					});
					break;
				case "scm_changed":
					dispatch({ type: "scm_changed" });
					break;
				case "tool_info":
					receiveToolInfo(msg);
					break;
				// subs-limits-box: every subscription's limits, for the Limits box (subs-limits-state.ts).
				case "subs_limits":
					receiveSubsLimits(msg);
					break;
				// identities: the identity list and the Settings editor (identity-state.ts).
				case "identities":
					receiveIdentities(msg);
					break;
				case "role_messages":
					// role-messages: Settings -> Identities -> Role messages.
					receiveRoleMessages(msg);
					break;
				case "roles":
					// roles-overview: the Roles page and the top bar's count (roles-state.ts).
					receiveRoles(msg);
					break;
				case "board_result":
					// board: the answer to the Board view's post or close (roles-state.ts).
					receiveBoardResult(msg);
					break;
				case "identity_file":
					receiveIdentityFile(msg);
					break;
				case "identity_file_saved":
					// identity-notebook-tab: the Notebook tab's saves carry its ref; Settings' don't.
					if (msg.ref === NOTEBOOK_TAB_REF) receiveNotebookSaved(msg);
					else receiveIdentitySaved(msg);
					break;
				// identity-config: a role's waiting draft, and the answer to its save / accept / discard.
				case "identity_draft":
					receiveIdentityDraft(msg);
					break;
				case "identity_draft_done":
					receiveIdentityDraftDone(msg);
					break;
				// identity-config: the roles' own skills (Settings asked; they stay out of the identity list).
				case "identity_skills":
					receiveOwnSkills(msg);
					break;
				case "identity_notebook":
					receiveNotebook(msg);
					break;
				// identity-notes: the Notebook tab's notes list or search, the open note, an edit or delete's answer.
				case "identity_notes_found":
					receiveNotesFound(msg);
					break;
				case "identity_note":
					receiveNote(msg);
					break;
				case "identity_note_saved":
					receiveNoteSaved(msg);
					break;
				case "heartbeat":
					if (msg.hostMetrics) {
						dispatch({ type: "host_metrics", metrics: msg.hostMetrics });
					}
					break;
				case "install_result":
					dispatch({ type: "install_result", result: msg });
					break;
				case "path_completions":
					dispatch({ type: "path_completions", completions: msg.completions });
					break;
				case "update_status":
					dispatch({ type: "update_status", status: msg });
					break;
				case "update_status_all":
					dispatch({ type: "update_status_all", items: msg.items, piSdk: msg.piSdk });
					break;
				case "widgets":
					dispatch({ type: "widgets", widgets: msg.widgets });
					break;
				case "statuses":
					dispatch({ type: "statuses", statuses: msg.statuses });
					break;
				case "dialog":
					dispatch({
						type: "dialog",
						dialog: {
							id: msg.id,
							kind: msg.kind,
							title: msg.title,
							args: msg.args,
						},
					});
					break;
				case "dialog_closed":
					dispatch({ type: "dialog", dialog: null });
					break;
				case "question_pending":
					questionSourceRef.current = "live";
					dispatch({
						type: "question",
						question: {
							id: msg.id,
							...(msg.deadline !== undefined ? { deadline: msg.deadline } : {}),
							questions: msg.questions,
							...(msg.conversationId !== undefined ? { conversationId: msg.conversationId } : {}),
							...(msg.conversationTitle !== undefined ? { conversationTitle: msg.conversationTitle } : {}),
						},
					});
					break;
				case "tool_approval_pending":
					dispatch({
						type: "tool_approval",
						approval: {
							id: msg.id,
							toolCallId: msg.toolCallId,
							toolName: msg.toolName,
							params: msg.params,
							reason: msg.reason,
							reasonEn: msg.reasonEn,
							...(msg.category ? { category: msg.category } : {}),
							...(msg.conversationId !== undefined ? { conversationId: msg.conversationId } : {}),
							...(msg.conversationTitle !== undefined ? { conversationTitle: msg.conversationTitle } : {}),
						},
					});
					break;
				case "tool_approval_resolved":
					dispatch({ type: "tool_approval_resolved", id: msg.id });
					break;
				case "question_retracted": {
					// 问卷被搬走/取消（手动过户到另一会话）：源页面正在展示该 id 即立即收起。
					// 快照为 null 收不掉 live 面板（见 pending-question.ts 规则 3），必须显式撤回；
					// 记入 answered，迟到的旧快照也不会把它复活。
					const cur = chatApi.current.chat.question;
					if (cur && cur.id === msg.id) {
						answeredQuestionsRef.current.add(msg.id);
						if (answeredQuestionsRef.current.size > 64) {
							const oldest = answeredQuestionsRef.current.values().next().value;
							if (oldest !== undefined) answeredQuestionsRef.current.delete(oldest);
						}
						questionSourceRef.current = "live";
						dispatch({ type: "question", question: null });
					}
					break;
				}
				case "elsewhere_question":
					// 跨页作答预告（peek 的回包）：别处问卷原文直接弹框，提交带 owner
					// 由持有方 resolve。与本地问卷独立共存，id 不进 answered 集合。
					dispatch({
						type: "remote_question",
						question: {
							owner: msg.owner,
							convId: msg.convId,
							id: msg.id,
							questions: msg.questions,
							...(msg.conversationTitle !== undefined ? { conversationTitle: msg.conversationTitle } : {}),
						},
					});
					break;
				case "page_request": {
					// 模型要操作浏览器里的页面（browser_page 工具）：转给扩展，再把结果回给服务端。
					// 服务端的工具正阻塞等这个 page_response —— 任何一条路径（宿主桥缺失、
					// 扩展没装、页面没授权、动作失败）都必须回一条，否则模型只能等到超时。
					void (async () => {
						const host = (
							window as unknown as {
								__piWebUiHost?: {
									pageCall?: (opts: {
										op: string;
										args?: Record<string, unknown>;
										target?: string;
										timeoutMs?: number;
									}) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
								};
							}
						).__piWebUiHost;
						let res: { ok: boolean; result?: unknown; error?: string };
						if (!host?.pageCall) {
							res = {
								ok: false,
								error: "The page bridge is unavailable (is the page outdated?) — reload this page and try again",
							};
						} else {
							try {
								res = await host.pageCall({
									op: msg.op,
									...(msg.args === undefined ? {} : { args: msg.args }),
									...(msg.target ? { target: msg.target } : {}),
									timeoutMs: msg.timeoutMs,
								});
							} catch (err) {
								res = { ok: false, error: err instanceof Error ? err.message : String(err) };
							}
						}
						send({
							type: "page_response",
							id: msg.id,
							ok: res.ok === true,
							...(res.ok === true
								? res.result === undefined
									? {}
									: { result: res.result }
								: { error: res.error ?? "Page action failed" }),
						});
					})();
					break;
				}
				case "terminal_output":
					bridgeRef.current.write(
						msg.conversationId ?? chatApi.current.chat.activeConversationId,
						msg.terminalId,
						msg.data,
					);
					break;
				case "terminal_exit":
					dispatch({
						type: "terminal_exit",
						conversationId: msg.conversationId,
						terminalId: msg.terminalId,
						exitCode: msg.exitCode,
					});
					break;
				case "terminal_list":
					dispatch({
						type: "terminal_list",
						conversationId: msg.conversationId,
						terminals: msg.terminals,
					});
					break;
				case "commands":
					dispatch({
						type: "commands",
						commands: msg.commands,
						path: msg.path,
					});
					break;
				case "slash_commands":
					dispatch({ type: "slash_commands", commands: msg.commands });
					break;
				case "goal_status":
					dispatch({ type: "goal_status", status: msg.status });
					break;
				case "settings_state":
					dispatch({ type: "settings", settings: msg.settings });
					break;
				case "bg_servers":
					dispatch({ type: "bg_servers", servers: msg.servers });
					break;
				case "scheduler_tasks":
					dispatch({ type: "scheduler_tasks", tasks: msg.tasks });
					break;
				case "plugins":
					dispatch({ type: "plugins", plugins: msg.plugins, epoch: msg.epoch });
					break;
				case "plugin_updates":
					dispatch({ type: "plugin_updates", updates: msg.updates });
					break;
				case "plugin_catalog":
					dispatch({ type: "plugin_catalog", entries: msg.entries, epoch: msg.epoch });
					break;
				case "plugin_grants":
					dispatch({ type: "plugin_grants", grants: msg.grants });
					break;
				case "plugin_permissions":
					dispatch({ type: "plugin_permissions", grants: msg.grants });
					break;
				case "plugin_permission_request":
					dispatch({
						type: "plugin_permission_request",
						req: {
							id: msg.id,
							pluginId: msg.pluginId,
							family: msg.family,
							...(msg.hosts ? { hosts: msg.hosts } : {}),
							...(msg.models ? { models: msg.models } : {}),
							...(msg.reason ? { reason: msg.reason } : {}),
						},
					});
					break;
				case "plugin_permission_resolved":
					dispatch({ type: "plugin_permission_resolved", id: msg.id });
					break;
				case "plugin_path_request":
					dispatch({
						type: "plugin_path_request",
						req: {
							id: msg.id,
							pluginId: msg.pluginId,
							path: msg.path,
							...(msg.reason ? { reason: msg.reason } : {}),
						},
					});
					break;
				case "plugin_dom_consent_request":
					// DOM 授权两步握手（协议 v20）：grant 由服务端生成在途请求并广播；
					// 只有发起端（from === 自己的 clientId）自动确认——用户在设置面板
					// 点一下的体验不变，其他端不是发起人不代答（服务端也只接受广播时
					// 在线端的应答，陌生连接无从插手）。
					if (msg.from === getClientId()) {
						ws.send(
							JSON.stringify({
								type: "plugin_dom_consent_response",
								id: msg.id,
								ok: true,
							} satisfies ClientMessage),
						);
					}
					break;
				case "plugin_job":
					dispatch({
						type: "plugin_job",
						job: {
							jobId: msg.jobId,
							action: msg.action,
							pluginId: msg.pluginId,
							phase: msg.phase,
							...(msg.ok === undefined ? {} : { ok: msg.ok }),
							...(msg.error ? { error: msg.error } : {}),
							...(msg.output ? { output: msg.output } : {}),
						},
						...(msg.line ? { line: msg.line } : {}),
					});
					break;
				case "plugin_install_inspect_result":
					dispatch({
						type: "plugin_install_inspect_result",
						result: {
							requestId: String(msg.requestId ?? ""),
							source: String(msg.source ?? ""),
							kind: msg.kind,
							suggestedId: String(msg.suggestedId ?? ""),
							installed: msg.installed === true,
							...(msg.problem ? { problem: msg.problem } : {}),
							...(msg.detail ? { detail: msg.detail } : {}),
							...(msg.manifest ? { manifest: msg.manifest } : {}),
						},
					});
					break;
				case "plugin_catalog_sync_result":
					// host.reloadCatalog() 的回执（等待中的 Promise 由 plugin-host 管）。
					resolveCatalogSyncResult(msg);
					// 设置面板发起的同步也在此收回执（requestId 对上才展示，见 SettingsModal）。
					dispatch({
						type: "plugin_catalog_sync_result",
						result: {
							requestId: String(msg.requestId ?? ""),
							ok: msg.ok === true,
							...(msg.error ? { error: msg.error } : {}),
							...(msg.entries ? { entryCount: msg.entries.length } : {}),
							...(msg.installed ? { installed: msg.installed } : {}),
						},
					});
					break;
				case "dsh_patches":
					dispatch({ type: "dsh_patches", patchDir: msg.patchDir, files: msg.files });
					break;
				case "dsh_presets":
					dispatch({ type: "dsh_presets", presets: msg.presets, defaultPreset: msg.defaultPreset });
					break;
				case "dsh_permission":
					dispatch({ type: "dsh_permission", options: msg.options, defaultPreset: msg.defaultPreset });
					break;
				case "plugin_data":
					// 宿主保留通道（host.log 按需拉取回包）先拦截：命中即吞掉，只进日志 store。
					if (!ingestPluginLogsData(msg.pluginId, msg.payload)) emitPluginData(msg.pluginId, msg.payload);
					break;
				default:
					break;
			}
		};

		ws.onclose = () => {
			if (wsRef.current === ws) wsRef.current = null;
			// chat-open-speed: messages still waiting for a chat to open never left this window.
			failHeldSends("The connection dropped before it was sent.");
			// Terminals died with the server-side PTYs — drop writers/buffers.
			bridgeRef.current.clear();
			// Cleanup closed this socket on purpose — do not reconnect.
			if (!aliveRef.current) return;
			// A newer socket already took over (e.g. a StrictMode remount raced
			// this socket's close) — do not spawn a third connection that would
			// shadow the live one and drop its incoming messages.
			if (wsRef.current && wsRef.current !== ws) return;
			dispatch({ type: "status", status: "closed" });
			if (hadOpenRef.current && !catchUpRef.current) catchUpRef.current = Date.now();
			refreshNote();
			// Reconnect with exponential backoff (1s → 2s → 4s → … capped at 10s).
			// mobile-fixes: the page coming back or the network returning skips the wait (see below).
			const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
			retryRef.current += 1;
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				connect();
			}, delay);
		};

		ws.onerror = () => {
			// onclose fires after onerror, triggering reconnect.
			// Do NOT call ws.close() here: it's redundant and causes a browser
			// warning "WebSocket is closed before the connection is established"
			// when the connection is still in CONNECTING state.
		};
	}, []);

	// Mount once; all reconnection is self-contained in `connect`.
	useEffect(() => {
		aliveRef.current = true;
		connect();
		// mobile-fixes: the watchdog. The server speaks every 2 s, so a socket that stays quiet (or doesn't
		// answer after the page comes back) is dead: it is dropped on the spot (waiting for a dead socket
		// to close took minutes) and a new one opens at once. Rules and slow-link allowance: conn-health.ts.
		const CHECK_EVERY_MS = 500;
		/** A connection attempt that hangs this long (made while the network was gone) is given up. */
		const CONNECT_GIVE_UP_MS = 10_000;
		/** Safety net: the note goes once the new socket has been open this long, even if no chat content came. */
		const CATCH_UP_GIVE_UP_MS = 20_000;
		let lastCheckAt = Date.now();
		/** When the page was last hidden or frozen (a phone may cut a background tab's network). */
		let hiddenAt = document.visibilityState === "visible" ? 0 : Date.now();
		const replace = (ws: WebSocket, retryNow: boolean) => {
			ws.onopen = null;
			ws.onmessage = null;
			ws.onerror = null;
			ws.onclose = null;
			if (wsRef.current === ws) wsRef.current = null;
			try {
				ws.close();
			} catch {
				/* already closing */
			}
			// What onclose would have done for this socket.
			failHeldSends("The connection dropped before it was sent.");
			bridgeRef.current.clear();
			if (hadOpenRef.current && !catchUpRef.current) catchUpRef.current = Date.now();
			doubtRef.current = false;
			dispatch({ type: "status", status: "closed" });
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			if (retryNow) {
				retryRef.current = 0;
				connect();
			} else {
				const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
				retryRef.current += 1;
				timerRef.current = setTimeout(() => {
					timerRef.current = null;
					connect();
				}, delay);
			}
			refreshNote();
		};
		const check = () => {
			if (!aliveRef.current) return;
			const now = Date.now();
			const stalled = now - lastCheckAt > 4 * CHECK_EVERY_MS;
			lastCheckAt = now;
			const ws = wsRef.current;
			if (!ws) return;
			if (ws.readyState === WebSocket.CONNECTING) {
				if (now - connectAtRef.current > CONNECT_GIVE_UP_MS) replace(ws, false);
				return;
			}
			if (ws.readyState !== WebSocket.OPEN) return;
			// The page was frozen, throttled or busy: messages may still be waiting to be handed over,
			// so the silence so far proves nothing. Ask instead.
			if (stalled) {
				cameBack();
				return;
			}
			const verdict = healthRef.current.verdict(now);
			if (verdict === "dead") {
				// Quiet with nothing to explain it may be a very slow link: the next socket gets more
				// patience, so it can't loop. Explained, so no more patience: it didn't answer after the
				// page came back, the phone knows it is offline, or the page was in the background.
				const h = healthRef.current;
				const explained =
					h.checking ||
					navigator.onLine === false ||
					document.visibilityState !== "visible" ||
					hiddenAt >= h.lastHeardAt;
				if (!explained) h.droppedForSilence();
				replace(ws, true);
				return;
			}
			const doubt = verdict === "doubt";
			const caughtUpAnyway = catchUpRef.current > 0 && now - healthRef.current.openedAt > CATCH_UP_GIVE_UP_MS;
			if (caughtUpAnyway) catchUpRef.current = 0;
			if (doubt !== doubtRef.current || caughtUpAnyway) {
				doubtRef.current = doubt;
				refreshNote();
			}
		};
		/** The page came back or the network changed: the socket must answer now; a lost one is retried now. */
		const cameBack = () => {
			if (!aliveRef.current) return;
			const ws = wsRef.current;
			const now = Date.now();
			if (ws && ws.readyState === WebSocket.OPEN) {
				const id = healthRef.current.cameBack(now);
				if (id !== null) {
					try {
						ws.send(JSON.stringify({ type: "ping", id } satisfies ClientMessage));
					} catch {
						/* the check finds out */
					}
				}
			} else if (ws && ws.readyState === WebSocket.CONNECTING) {
				// An attempt from before (maybe made with no network) may never finish.
				if (now - connectAtRef.current > 1_500) replace(ws, true);
			} else if (timerRef.current) {
				// Waiting to retry after a lost connection: retry now.
				clearTimeout(timerRef.current);
				timerRef.current = null;
				retryRef.current = 0;
				connect();
			}
		};
		const watchdog = setInterval(check, CHECK_EVERY_MS);
		const onVisible = () => {
			if (document.visibilityState === "visible") cameBack();
			else hiddenAt = Date.now();
		};
		const onFreeze = () => {
			hiddenAt = Date.now();
		};
		const onPageShow = (e: PageTransitionEvent) => {
			if (e.persisted) cameBack();
		};
		// Android Chrome tells when the phone moves between Wi-Fi and mobile data.
		const netInfo = (navigator as Navigator & { connection?: EventTarget }).connection;
		document.addEventListener("visibilitychange", onVisible);
		document.addEventListener("resume", cameBack);
		document.addEventListener("freeze", onFreeze);
		window.addEventListener("pageshow", onPageShow);
		window.addEventListener("online", cameBack);
		netInfo?.addEventListener?.("change", cameBack);
		return () => {
			aliveRef.current = false;
			clearInterval(watchdog);
			document.removeEventListener("visibilitychange", onVisible);
			document.removeEventListener("resume", cameBack);
			document.removeEventListener("freeze", onFreeze);
			window.removeEventListener("pageshow", onPageShow);
			window.removeEventListener("online", cameBack);
			netInfo?.removeEventListener?.("change", cameBack);
			setReconnectingNote(false);
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			wsRef.current?.close();
			wsRef.current = null;
		};
	}, [connect]);

	// -- 全局镜像：连接态 + 当前工作目录 -----------------------------------------
	// 这三个值整棵树都要（左栏/输入框/右栏/全局搜索/底栏…）且变化频率低，放全局 store
	// 省掉逐层传参（见 web/src/app-globals.ts）。用 effect 单一写入：值就是 reducer
	// 里的真值，不会出现第二个 source of truth；最多晚一帧（对应默认值只会是
	//「未就绪 / 未连接 / 空目录」，用户看不出）。
	useEffect(() => {
		setAppGlobals({
			ready: chat.ready,
			status: chat.status,
			cwd: chat.state?.cwd ?? "",
			// 额外工作区根（多根）与 cwd 同源：右栏文件树用 useAppField("workspaceRoots") 取。
			workspaceRoots: chat.state?.workspaceRoots ?? [],
			// 用户主目录（右栏 🏠）：与 cwd 同源，空串 = 旧服务不提供 → 不渲染 🏠。
			homeDir: chat.state?.homeDir ?? "",
			// 桌面目录（右栏 🖥️）：与 cwd 同源，空串 = 不存在/旧服务 → 不渲染 🖥️。
			desktopDir: chat.state?.desktopDir ?? "",
		});
	}, [
		chat.ready,
		chat.status,
		chat.state?.cwd,
		chat.state?.workspaceRoots,
		chat.state?.homeDir,
		chat.state?.desktopDir,
	]);

	const dismissNotice = useCallback((id: number) => dispatch({ type: "dismiss_notice", id }), []);

	// -- optimistic-send ------------------------------------------------------

	// Keep the unanswered sends across a reload (this tab only).
	useEffect(() => {
		try {
			if (chat.pendingSends.length === 0) sessionStorage.removeItem(PENDING_STORAGE_KEY);
			else sessionStorage.setItem(PENDING_STORAGE_KEY, serializePending(chat.pendingSends));
		} catch {
			// quota or storage off: a reload just forgets them
		}
	}, [chat.pendingSends]);

	/** Retry a "Not sent" message: the same id goes out again (the server never adds it twice). Only
	 *  while its chat is the one the server has open for this window. */
	const retrySend = useCallback((id: string) => {
		const cur = chatApi.current.chat;
		const p = cur.pendingSends.find((x) => x.id === id);
		if (!p || p.status !== "failed" || cur.pendingSwitch || !cur.state || !sameChat(p, cur.state)) return;
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			dispatch({ type: "pending_fail", id, reason: NOT_CONNECTED_REASON });
			return;
		}
		dispatch({ type: "pending_retry", id });
		ws.send(
			JSON.stringify({
				type: "prompt",
				text: p.text,
				queue: p.queue,
				...(p.attachments ? { attachments: p.attachments } : {}),
				id,
			} satisfies ClientMessage),
		);
	}, []);

	/** × on a "Not sent" message: it leaves the chat and comes back (for the input box). */
	const removeSend = useCallback((id: string): PendingSend | undefined => {
		const p = chatApi.current.chat.pendingSends.find((x) => x.id === id);
		if (p) dispatch({ type: "pending_remove", id });
		return p;
	}, []);

	/** switch-loading：遮罩上的两个按钮（重试不在这里 —— 它就是再发一次 switch_*，走 send）。 */
	const switchHide = useCallback(() => {
		// chat-open-speed: back to the chat the window was on; anything written into the one that was
		// opening has nowhere to go.
		failHeldSends("The chat it was written in was left before it opened, so this wasn't sent.");
		dispatch({ type: "switch_hide" });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- failHeldSends only touches refs.
	}, []);
	const switchDismissError = useCallback(() => dispatch({ type: "switch_dismiss_error" }), []);

	// -- terminal tab management ----------------------------------------------

	const terminalCreate = useCallback((meta: TerminalMeta) => dispatch({ type: "terminal_add", meta }), []);
	const terminalClose = useCallback((id: string) => dispatch({ type: "terminal_remove", id }), []);
	const terminalRestart = useCallback((id: string) => dispatch({ type: "terminal_restart", terminalId: id }), []);

	const terminalSelect = useCallback((id: string) => dispatch({ type: "terminal_active", id }), []);
	const terminalRegister = useCallback(
		(conversationId: string, id: string, writer: TerminalWriter) =>
			bridgeRef.current.register(conversationId, id, writer),
		[],
	);

	const chatApi = useRef({
		chat,
		send,
		retrySend,
		removeSend,
		pushNotice,
		dismissNotice,
		switchHide,
		switchDismissError,
		terminal: {
			create: terminalCreate,
			close: terminalClose,
			register: terminalRegister,
			restart: terminalRestart,
			select: terminalSelect,
		},
	});
	chatApi.current = {
		chat,
		send,
		retrySend,
		removeSend,
		pushNotice,
		dismissNotice,
		switchHide,
		switchDismissError,
		terminal: {
			create: terminalCreate,
			close: terminalClose,
			register: terminalRegister,
			restart: terminalRestart,
			select: terminalSelect,
		},
	};
	return chatApi.current;
}
