/**
 * 机器可读的注册面目录（DSH 对照 P2-7）。
 *
 * DSH 用词法扫描生成 CLIENT_SLOT_API（slot 的 key/kind/occupants/example…），
 * 供只读 inspect 给模型查 —— 能力发现与执行分离，先查真实 API 再写码。
 * pi-web-ui 之前只有手写 `plugin-sdk/index.d.ts` + README，没有运行时可查的目录。
 *
 * 本模块 = 目录的纯装配层（类型唯一事实源在 server/protocol.ts）：
 * - 静态部分（slot 例子、宿主方法表）写死在这里，与源码同仓、单测锁住
 *   （别名目标必须存在、每个 slot 必须有例子、方法 needs 必须是已知族）；
 * - 动态部分（occupants：谁占着哪个 slot）由 PluginManager 现算传入。
 *
 * 下发方式：WS 只读查询 `plugin_api_catalog` → `plugin_api_catalog_result`
 * （不进快照、不进清单，按需拉）。给将来「AI 写插件」铺路；当前消费方是
 * 插件作者（浏览器 devtools 发一条 WS 即可查）与后面的设置面板目录页。
 */
import type {
	CatalogAgentTool,
	CatalogHostMethod,
	CatalogSlotEntry,
	CatalogSlotOccupant,
	PluginApiCatalog,
} from "./protocol.js";

export const PLUGIN_API_CATALOG_VERSION = 1 as const;

/** 每个 slot 的 manifest 最小例子（与 parseUiContributions 同口径，别名已展开写法也收）。 */
export const SLOT_EXAMPLES: Readonly<Record<string, string>> = {
	"topbar.primary": `{ "topbar": [{ "id": "inbox", "label": "Inbox", "kind": "action", "action": "my:open" }] }`,
	"topbar.overflow": `{ "topbar.more": [{ "id": "about", "label": "About", "kind": "action", "action": "my:about" }] }`,
	bottombar: `{ "ui": { "bottombar": [{ "id": "st", "label": "Status", "kind": "action", "action": "my:st" }] } }`,
	"composer.leading": `{ "ui": { "composer.leading": [{ "id": "m", "label": "+", "kind": "action", "action": "my:m" }] } }`,
	"composer.actions": `{ "composer": [{ "id": "pick", "label": "Pick", "kind": "action", "action": "my:pick" }] }`,
	"message.actions": `{ "message": [{ "id": "send", "label": "Forward", "kind": "action", "action": "my:send" }] }`,
	"rightpanel.tabs": `{ "rightpanel": [{ "id": "mail", "label": "Mail", "kind": "view" }] }`,
	"contextmenu.topbar": `{ "ui": { "contextmenu.topbar": [{ "id": "m", "label": "Top bar menu", "kind": "action", "action": "my:m" }] } }`,
	"contextmenu.message": `{ "ui": { "contextmenu.message": [{ "id": "m", "label": "Message menu", "kind": "action", "action": "my:m" }] } }`,
	"contextmenu.session": `{ "ui": { "contextmenu.session": [{ "id": "m", "label": "Chat menu", "kind": "action", "action": "my:m" }] } }`,
	"contextmenu.file": `{ "contextmenu.file": [{ "id": "mail", "label": "Send to mail", "kind": "action", "action": "my:send" }] }`,
	"contextmenu.toolcall": `{ "ui": { "contextmenu.toolcall": [{ "id": "m", "label": "Tool menu", "kind": "action", "action": "my:m" }] } }`,
	"settings.pages": `{ "settings": [{ "id": "conf", "label": "Mail settings", "kind": "page" }] }`,
	"leftpanel.sessions": `{ "ui": { "leftpanel.sessions": [{ "id": "m", "label": "Chats", "kind": "action", "action": "my:m" }] } }`,
	"chat.header": `{ "ui": { "chat.header": [{ "id": "m", "label": "Chat header", "kind": "action", "action": "my:m" }] } }`,
	"chat.empty": `{ "ui": { "chat.empty": [{ "id": "m", "label": "Empty state", "kind": "action", "action": "my:m" }] } }`,
	"file.preview.toolbar": `{ "ui": { "file.preview.toolbar": [{ "id": "m", "label": "Preview tools", "kind": "action", "action": "my:m" }] } }`,
	"terminal.toolbar": `{ "ui": { "terminal.toolbar": [{ "id": "m", "label": "Terminal tools", "kind": "action", "action": "my:m" }] } }`,
	"scm.toolbar": `{ "ui": { "scm.toolbar": [{ "id": "m", "label": "SCM tools", "kind": "action", "action": "my:m" }] } }`,
	"goalbar.actions": `{ "ui": { "goalbar.actions": [{ "id": "m", "label": "Goal bar", "kind": "action", "action": "my:m" }] } }`,
	"notice.actions": `{ "ui": { "notice.actions": [{ "id": "m", "label": "Notice action", "kind": "action", "action": "my:m" }] } }`,
	"modal.dialog": `{ "modal": [{ "id": "m", "label": "Dialog", "kind": "action", "action": "my:m" }] }`,
};

/** 宿主方法表（与 server/plugins.ts#PluginHost 同语义的精简版：只收发现用的注册/调用面）。
 *  needs="-" = 观察/基础设施类（无需能力声明）；其余走 can() 门控。 */
export const HOST_METHODS: ReadonlyArray<CatalogHostMethod> = [
	{
		name: "ui.register",
		needs: "ui",
		summary: "Register UI items at runtime (same rules as the manifest: alias mapping + enum checks)",
		example: `host.ui.register({ slot: "topbar.primary", id: "btn", label: "Button" })`,
	},
	{
		name: "ui.update",
		needs: "ui",
		summary: "Update an existing item by id (label/badge/checked/value/progress)",
		example: `host.ui.update("btn", { badge: "3" })`,
	},
	{
		name: "ui.remove",
		needs: "ui",
		summary: "Remove an item (also suppresses manifest-declared ones until reload)",
		example: `host.ui.remove("btn")`,
	},
	{
		name: "ui.arrange",
		needs: "ui",
		summary: "Arrange any item (including host:* built-ins): hide/order/group/label",
		example: `host.ui.arrange([{ id: "host:tasks", hide: true }])`,
	},
	{
		name: "ui.list",
		needs: "ui",
		summary: "List this plugin's own items + arrange (other plugins' are not visible)",
		example: `host.ui.list()`,
	},
	{
		name: "onUiAction",
		needs: "ui",
		summary: "Subscribe to item clicks (action name → callback, client bundle side)",
		example: `__piWebUiHost.onUiAction("my:open", () => {})`,
	},
	{
		name: "registerAgentTool",
		needs: "tools",
		summary: "Register tools for the AI (the plugin gives the model abilities; the opposite of the AI writing plugins)",
		example: `host.registerAgentTool({ name: "mail_list", description: "…", execute: async () => ({}) })`,
	},
	{
		name: "onToolPre",
		needs: "tools",
		summary: "Tool pre-hook (bash/read only): allow/deny/ask, first block wins",
		example: `host.onToolPre((req) => req.params?.command?.includes("rm -rf") ? { decision: "deny" } : undefined)`,
	},
	{
		name: "onToolPost",
		needs: "tools",
		summary: "Tool post-hook (bash/read only): replace content / add additionalContext",
		example: `host.onToolPost(({ result }) => ({ content: result.content }))`,
	},
	{
		name: "onToolEvent",
		needs: "-",
		summary: "Subscribe to tool execution events (start/end pairs, observe only)",
		example: `host.onToolEvent((ev) => {})`,
	},
	{
		name: "bash",
		needs: "tools",
		summary: "Restricted shell (no piped shell, split into words; cwd locked to the workspace, 60s timeout by default)",
		example: `await host.bash("ls", { timeoutMs: 10000 })`,
	},
	{
		name: "registerCommand",
		needs: "-",
		summary: "Register slash commands (/name picker + intercept the prompt to run)",
		example: `host.registerCommand({ name: "deploy", description: "Deploy", run: (args) => {} })`,
	},
	{
		name: "route",
		needs: "http",
		summary: "Mount HTTP routes (/plugins-api/<id><path>)",
		example: `host.route("GET", "/inbox", (req, res) => res.json([]))`,
	},
	{
		name: "registerProxy",
		needs: "http",
		summary: "Reverse-proxy a prefix (passes through to 127.0.0.1:port; loopback only, against SSRF)",
		example: `host.registerProxy("/app", 3000)`,
	},
	{
		name: "chat",
		needs: "chat",
		summary: "Headless call: hand external channel text to the agent (fire-and-forget)",
		example: `await host.chat({ text: "hi" })`,
	},
	{
		name: "chatWait",
		needs: "chat",
		summary: "Wait for a headless call's run_end (120s by default, clamped)",
		example: `await host.chatWait({ conversationId })`,
	},
	{
		name: "llm.complete",
		needs: "llm",
		summary: "Isolated one-shot completion without tools (uses the user's model quota)",
		example: `await host.llm.complete({ prompt: "…" })`,
	},
	{
		name: "requestPermission",
		needs: "-",
		summary: "Request a capability grant (net hosts / llm model scope, user confirms)",
		example: `await host.requestPermission({ family: "net", hosts: ["api.example.com"] })`,
	},
	{
		name: "fs",
		needs: "fs",
		summary: "Workspace files (list/read/readText/write/remove…, anchored to the live cwd, out-of-bounds refused)",
		example: `await host.fs.readText("notes/todo.md")`,
	},
	{
		name: "fs.requestAccess",
		needs: "fs",
		summary: "Request access to a directory outside the workspace (browser confirm dialog, remember saves to disk)",
		example: `await host.fs.requestAccess("/data")`,
	},
	{
		name: "project.create",
		needs: "fs",
		summary: "Assemble a project in an allowed directory (mkdir/clone/write files/git init)",
		example: `await host.project.create({ dir: "/data/app", files: {} })`,
	},
	{
		name: "schedule",
		needs: "-",
		summary: "Scheduled jobs (cron/delay, persisted across restarts, long delays chunked to avoid overflow)",
		example: `host.schedule("0 9 * * *", () => {})`,
	},
	{
		name: "registerBackgroundTask",
		needs: "-",
		summary: "Long-running background task (joins the background task panel, removed on deactivate)",
		example: `host.registerBackgroundTask({ id: "svc", label: "Service" })`,
	},
	{
		name: "onRunEvent",
		needs: "-",
		summary: "Subscribe to the run trace (run/message/tool…, for timeline aggregation)",
		example: `host.onRunEvent((ev) => {})`,
	},
	{
		name: "getActiveConversation",
		needs: "-",
		summary: "Read a snapshot of the open chat (read-only reference; summarize before broadcasting)",
		example: `host.getActiveConversation()`,
	},
	{
		name: "onConversationChanged",
		needs: "-",
		summary: "Subscribe to chat switches (trace plugins reload their timeline)",
		example: `host.onConversationChanged(() => {})`,
	},
	{
		name: "storage",
		needs: "-",
		summary: "Plugin-private KV (storage.json, atomic writes, deleted on uninstall)",
		example: `host.storage.get("k")`,
	},
	{
		name: "secrets",
		needs: "-",
		summary: "Encrypted secrets (plaintext never written to disk or sent out)",
		example: `host.secrets.get("token")`,
	},
	{
		name: "ensureDeps",
		needs: "-",
		summary: "Auto-install dependencies (single-flight, npm packages)",
		example: `await host.ensureDeps(["dayjs"])`,
	},
	{
		name: "getSettings",
		needs: "-",
		summary: "Read declared setting values (manifest.settings fields)",
		example: `host.getSettings()`,
	},
	{
		name: "onSettingsChanged",
		needs: "-",
		summary: "Subscribe to settings saves (fires after the ⚙ panel saves)",
		example: `host.onSettingsChanged((v) => {})`,
	},
	{
		name: "onCwdChange",
		needs: "-",
		summary: "Subscribe to workspace switches",
		example: `host.onCwdChange((cwd) => {})`,
	},
	{
		name: "onAttach",
		needs: "-",
		summary: "Subscribe to browser connects (push the full state; the server is the only source of truth)",
		example: `host.onAttach((clientId) => {})`,
	},
	{
		name: "broadcast",
		needs: "-",
		summary: "Broadcast this plugin's message to all browsers",
		example: `host.broadcast({ kind: "state" })`,
	},
	{
		name: "notify",
		needs: "-",
		summary: "Show a system notice (notice toast)",
		example: `host.notify("info", "Done")`,
	},
	{
		name: "effect",
		needs: "-",
		summary: "Hook your own side effects into the effect stack (unwound in reverse on deactivate)",
		example: `host.effect("timer", () => clearInterval(t))`,
	},
	{
		name: "events.emit/on",
		needs: "-",
		summary: "Inter-plugin event bus (topics should use an <id>: prefix; the sender cannot be forged)",
		example: `host.events.on("notes:changed", () => {})`,
	},
	{
		name: "models.list",
		needs: "-",
		summary: "List models with configured auth (provider/id)",
		example: `host.models.list()`,
	},
	{
		name: "scm",
		needs: "-",
		summary: "Read-only git queries (status/branches/history, no shell)",
		example: `await host.scm.status()`,
	},
	{
		name: "asks.list",
		needs: "asks",
		summary: "Everything chats wait on you for now: questions, pop-ups, permission prompts, stuck queued tasks",
		example: `host.asks.list()`,
	},
	{
		name: "asks.on",
		needs: "asks",
		summary: "Hear asks appear, get answered (summary + from) or go away; returns the way to stop",
		example: `host.asks.on((ev) => { if (ev.type === "appeared") send(ev.ask); })`,
	},
	{
		name: "asks.answer",
		needs: "asks",
		summary: "Answer an ask as this plugin, like the browser would; first answer wins, never throws",
		example: `await host.asks.answer(ask.id, [{ id: "q0", selected: ["Yes"] }])`,
	},
	{
		name: "net.fetch",
		needs: "net",
		summary: "Outbound network (allowed only on allow-list hits; failures return {ok:false} instead of throwing)",
		example: `await host.net.fetch("https://api.example.com/x")`,
	},
	{
		name: "conversations",
		needs: "-",
		summary: "Chat directory (list/get/search, read-only assembly + targeted delivery)",
		example: `await host.conversations.list()`,
	},
	{
		name: "prompt",
		needs: "-",
		summary: "Send a user message to a given chat (returns ok:false when nothing was injected)",
		example: `await host.prompt(convId, { text: "hi" })`,
	},
	{
		name: "steer",
		needs: "-",
		summary: "Steer the current run of a given chat",
		example: `await host.steer(convId, "Change direction")`,
	},
	{ name: "abortRun", needs: "-", summary: "Abort the run of a given chat", example: `await host.abortRun(convId)` },
];

/** 装配目录：静态表（本模块）+ 动态占用（调用方现算）。调用方保证入参即真相（别名/枚举与解析层同源）。 */
export function buildPluginApiCatalog(opts: {
	slots: string[];
	aliases: Record<string, string>;
	kinds: string[];
	agentTools: Array<{ name: string; group: string; defaultOn: boolean; dshVisible: boolean }>;
	occupantsOf: (slot: string) => CatalogSlotOccupant[];
}): PluginApiCatalog {
	const aliasByTarget = new Map<string, string[]>();
	for (const [alias, target] of Object.entries(opts.aliases)) {
		const list = aliasByTarget.get(target) ?? [];
		list.push(alias);
		aliasByTarget.set(target, list);
	}
	const slots = [...opts.slots].sort().map((slot): CatalogSlotEntry => {
		const example =
			SLOT_EXAMPLES[slot] ??
			`{ "ui": { "${slot}": [{ "id": "m", "label": "Item", "kind": "action", "action": "my:m" }] } }`;
		return {
			slot,
			aliases: [...(aliasByTarget.get(slot) ?? [])].sort(),
			kinds: [...opts.kinds].sort(),
			occupants: [...opts.occupantsOf(slot)].sort((a, b) => (a.pluginId < b.pluginId ? -1 : 1)),
			replaceRisk:
				"Plugin arrange can change any item (including host:* built-ins); the user's preference has the last word (restorable on the layout page)",
			example,
		};
	});
	return {
		version: PLUGIN_API_CATALOG_VERSION,
		slots,
		agentTools: opts.agentTools.map((t) => ({
			name: t.name,
			group: t.group,
			defaultOn: t.defaultOn,
			dshVisible: t.dshVisible,
		})),
		hostMethods: HOST_METHODS.map((m) => ({ ...m })),
	};
}
