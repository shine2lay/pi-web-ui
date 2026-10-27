import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { FiClock, FiEdit3, FiPlay, FiPlus, FiTrash2, FiX } from "react-icons/fi";
import type { ClientMessage, SchedulerTaskView, UiVisionBridgeModel } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { appAdmit } from "../app-admit";
import { THINKING_VALUES } from "../thinking-levels";
import { HintTip } from "./HintTip";

interface SchedulerPanelProps {
	tasks: SchedulerTaskView[];
	/** 当前项目（新建任务时一键填入）。 */
	cwd: string;
	/** 可选模型（与子代理模板编辑器同一来源：settings.subagentModels）。 */
	models: UiVisionBridgeModel[];
}

const CRON_PRESETS: { value: string; key: string }[] = [
	{ value: "0 9 * * *", key: "schedulerPresetDaily" },
	{ value: "0 * * * *", key: "schedulerPresetHourly" },
	{ value: "*/30 * * * *", key: "schedulerPresetHalfHour" },
	{ value: "0 9 * * 1-5", key: "schedulerPresetWorkday" },
	{ value: "0 9 * * 1", key: "schedulerPresetMonday" },
];

export interface SchedulerTaskDraft {
	id: string;
	name: string;
	description: string;
	cwd: string;
	kind: "cron" | "interval";
	cron: string;
	preset: string;
	intervalMinutes: string;
	prompt: string;
	model: string;
	thinkingLevel: string;
	catchUp: boolean;
}

type SaveMessage = Extract<ClientMessage, { type: "schedule_save" }>;

/** Page-local source identity, NOT a conversation, server receipt or replay permission. */
export interface SchedulerAdmissionSource {
	readonly workspace: string;
	readonly taskId: string | null;
	readonly formId: string;
	readonly revision: number;
	readonly form: Readonly<SchedulerTaskDraft>;
}
interface Attempt {
	readonly source: SchedulerAdmissionSource;
	readonly message: Readonly<SaveMessage>;
	readonly phase: "pending" | "unconfirmed" | "admitted";
}
export interface SchedulerDraftRecovery {
	readonly workspace: string;
	readonly current: Readonly<SchedulerTaskDraft>;
	readonly attempts: readonly Attempt[];
	readonly restoredSources: readonly SchedulerAdmissionSource[];
}
interface DraftEntry {
	workspace: string;
	current: Readonly<SchedulerTaskDraft>;
	revision: number;
	attempts: readonly Attempt[];
	restoredSources: readonly SchedulerAdmissionSource[];
	pending: boolean;
}
interface Editor {
	entry: DraftEntry;
	id: string;
}

// Authored scheduler drafts only. Page-memory recovery survives panel navigation,
// not reload. #570 must checkpoint the complete source + message before true.
const retainedDrafts = new Map<string, DraftEntry>();
const admissionSources = new WeakMap<ClientMessage, SchedulerAdmissionSource>();
const currentSources = new Map<string, SchedulerAdmissionSource>();
const currentSourceListeners = new Set<(source: SchedulerAdmissionSource) => void>();
/** Authored edits only, not a schedule action or server persistence receipt. */
export function getSchedulerCurrentSources(): readonly SchedulerAdmissionSource[] {
	return Object.freeze([...currentSources.values()]);
}
export function subscribeSchedulerCurrentSources(listener: (source: SchedulerAdmissionSource) => void): () => void {
	currentSourceListeners.add(listener);
	return () => {
		currentSourceListeners.delete(listener);
	};
}
function rememberCurrentSource(editor: Editor): void {
	const form = Object.freeze({ ...editor.entry.current });
	const source: SchedulerAdmissionSource = Object.freeze({
		workspace: editor.entry.workspace,
		taskId: form.id || null,
		formId: editor.id,
		revision: editor.entry.revision,
		form,
	});
	currentSources.set(source.formId, source);
	for (const listener of currentSourceListeners) {
		try {
			listener(source);
		} catch {
			/* Keep the complete editable source on storage/view failure. */
		}
	}
}
const draftListeners = new Set<() => void>();
let draftVersion = 0;
const getDraftVersion = () => draftVersion;
function subscribeDrafts(listener: () => void) {
	draftListeners.add(listener);
	return () => {
		draftListeners.delete(listener);
	};
}
function notifyDrafts() {
	draftVersion++;
	for (const listener of draftListeners) listener();
}

/** #570's handler must read/copy this exact source synchronously before awaiting. */
export function getSchedulerAdmissionSource(message: ClientMessage): SchedulerAdmissionSource | undefined {
	return admissionSources.get(message);
}

/** Look-only recovery snapshots; reading/restoring never sends or activates tasks. */
export function getSchedulerDraftRecoveries(): readonly SchedulerDraftRecovery[] {
	return Object.freeze(
		[...retainedDrafts.values()].map((entry) =>
			Object.freeze({
				workspace: entry.workspace,
				current: entry.current,
				attempts: Object.freeze([...entry.attempts]),
				restoredSources: Object.freeze([...entry.restoredSources]),
			}),
		),
	);
}

const FORM_TEXT_FIELDS = [
	"id",
	"name",
	"description",
	"cwd",
	"cron",
	"preset",
	"intervalMinutes",
	"prompt",
	"model",
	"thinkingLevel",
] as const;
function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return (
		(proto === Object.prototype || proto === null) &&
		Reflect.ownKeys(value).length === keys.length &&
		keys.every(
			(key) =>
				Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
				Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), "value"),
		)
	);
}
function isAdmissionSource(value: unknown): value is SchedulerAdmissionSource {
	if (!exactRecord(value, ["workspace", "taskId", "formId", "revision", "form"])) return false;
	const form = value.form;
	return (
		typeof value.workspace === "string" &&
		value.workspace.length > 0 &&
		(value.taskId === null || (typeof value.taskId === "string" && value.taskId.length > 0)) &&
		typeof value.formId === "string" &&
		value.formId.length > 0 &&
		typeof value.revision === "number" &&
		Number.isSafeInteger(value.revision) &&
		value.revision >= 0 &&
		exactRecord(form, [...FORM_TEXT_FIELDS, "kind", "catchUp"]) &&
		FORM_TEXT_FIELDS.every((key) => typeof form[key] === "string") &&
		(form.kind === "cron" || form.kind === "interval") &&
		typeof form.catchUp === "boolean" &&
		form.id === (value.taskId ?? "") &&
		(form.preset === "custom" || CRON_PRESETS.some((preset) => preset.value === form.preset))
	);
}
function sameForm(a: Readonly<SchedulerTaskDraft>, b: Readonly<SchedulerTaskDraft>): boolean {
	return FORM_TEXT_FIELDS.every((key) => a[key] === b[key]) && a.kind === b.kind && a.catchUp === b.catchUp;
}

/** LOOK ONLY: true means retained for review, never admitted/saved/activated.
 * Existing current drafts always win; conflicting recovered originals stay separate.
 */
export function restoreSchedulerDraft(value: unknown): boolean {
	if (!isAdmissionSource(value)) return false;
	const source: SchedulerAdmissionSource = Object.freeze({ ...value, form: Object.freeze({ ...value.form }) });
	const key = JSON.stringify([source.workspace, source.taskId ?? ""]);
	let entry = retainedDrafts.get(key);
	const prior = [...(entry?.attempts.map((attempt) => attempt.source) ?? []), ...(entry?.restoredSources ?? [])].find(
		(item) => item.formId === source.formId && item.revision === source.revision,
	);
	if (prior && !sameForm(prior.form, source.form)) return false;
	if (entry?.restoredSources.some((item) => item.formId === source.formId && item.revision === source.revision))
		return true;
	if (!entry) {
		entry = {
			workspace: source.workspace,
			current: source.form,
			revision: source.revision,
			attempts: [],
			restoredSources: [],
			pending: false,
		};
		retainedDrafts.set(key, entry);
	}
	entry.restoredSources = [...entry.restoredSources, source];
	notifyDrafts();
	return true;
}

function admissionNotice(phase: Attempt["phase"]): string {
	if (phase === "pending")
		return "Keeping the complete draft while local admission is checked; saving is not confirmed.";
	if (phase === "admitted")
		return "Kept by local admission only — server save, enablement and execution are not confirmed.";
	return "Local admission was not confirmed. The complete submitted draft is retained. Check recovery/status before saving again; it may already have been recorded.";
}

function blankDraft(cwd: string): SchedulerTaskDraft {
	return {
		id: "",
		name: "",
		description: "",
		cwd,
		kind: "cron",
		cron: "0 9 * * *",
		preset: "0 9 * * *",
		intervalMinutes: "60",
		prompt: "",
		model: "",
		thinkingLevel: "",
		catchUp: false,
	};
}

function draftFromTask(t: SchedulerTaskView): SchedulerTaskDraft {
	const presetHit = t.kind === "cron" && CRON_PRESETS.some((p) => p.value === t.spec);
	return {
		id: t.id,
		name: t.name,
		description: t.description,
		cwd: t.cwd,
		kind: t.kind,
		cron: t.kind === "cron" ? t.spec : "0 9 * * *",
		preset: presetHit ? t.spec : "custom",
		intervalMinutes: t.kind === "interval" ? String(Math.max(1, Math.round(Number(t.spec) / 60000))) : "60",
		prompt: t.prompt,
		model: t.model,
		thinkingLevel: t.thinkingLevel,
		catchUp: t.catchUp === "once",
	};
}

/** 调度规格一句话（列表行展示用）。 */
function specSummary(t: SchedulerTaskView, tr: ReturnType<typeof useT>): string {
	if (t.kind === "interval") {
		const min = Math.round(Number(t.spec) / 60000);
		if (min < 60) return `${tr("schedulerKindInterval")} · ${min} min`;
		if (min % 60 === 0) return `${tr("schedulerKindInterval")} · ${min / 60} h`;
		return `${tr("schedulerKindInterval")} · ${min} min`;
	}
	const hit = CRON_PRESETS.find((p) => p.value === t.spec);
	if (hit) return tr(hit.key as Parameters<typeof tr>[0]);
	return t.spec;
}

function formatTime(ts: number | null): string {
	if (!ts) return "";
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return String(ts);
	}
}

/**
 * 内置定时任务管理（issue #184）：任务列表（下次触发/上次状态/手动执行/
 * 启用停用/历史）+ 新建/编辑表单。全部经 schedule_* wire 消息走服务端
 * SchedulerStore（<dataDir>/scheduler-tasks.json 全局持久化）。
 */
export function SchedulerPanel({ tasks, cwd, models }: SchedulerPanelProps) {
	const t = useT();
	const [editor, setEditor] = useState<Editor | null>(null);
	const activeEditor = useRef<Editor | null>(null);
	const [openHistory, setOpenHistory] = useState<Set<string>>(new Set());
	useSyncExternalStore(subscribeDrafts, getDraftVersion, getDraftVersion);
	const draft = editor?.entry.workspace === cwd ? editor.entry.current : null;
	const recoveries = getSchedulerDraftRecoveries().filter((entry) => entry.workspace === cwd);

	// Even A -> B -> A is a new view lifetime. Closing/navigation keeps the copy,
	// but an old operation can no longer close any subsequently opened form.
	useLayoutEffect(() => {
		activeEditor.current = null;
		setEditor(null);
		return () => {
			activeEditor.current = null;
		};
	}, [cwd]);

	const reviewEntry = (entry: DraftEntry) => {
		const next = { entry, id: crypto.randomUUID() };
		activeEditor.current = next;
		setEditor(next);
		notifyDrafts();
	};
	const openEditor = (task?: SchedulerTaskView) => {
		const key = JSON.stringify([cwd, task?.id ?? ""]);
		let entry = retainedDrafts.get(key);
		if (!entry) {
			entry = {
				workspace: cwd,
				current: Object.freeze(task ? draftFromTask(task) : blankDraft(cwd)),
				revision: 0,
				attempts: [],
				restoredSources: [],
				pending: false,
			};
			retainedDrafts.set(key, entry);
		}
		reviewEntry(entry);
	};
	const closeEditor = () => {
		activeEditor.current = null;
		setEditor(null);
	};
	const changeDraft = (patch: Partial<SchedulerTaskDraft>) => {
		if (!editor || activeEditor.current !== editor || editor.entry.workspace !== cwd) return;
		editor.entry.current = Object.freeze({ ...editor.entry.current, ...patch });
		editor.entry.revision++; // Value equality cannot detect A -> B -> A.
		rememberCurrentSource(editor);
		notifyDrafts();
	};

	// 打开面板即向服务端要一份新鲜列表（重连/别处改动后对齐）。
	useEffect(() => {
		appSend({ type: "schedule_list" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const toggleHistory = (id: string) =>
		setOpenHistory((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const save = async () => {
		const view = activeEditor.current;
		if (!view || view !== editor || view.entry.workspace !== cwd || view.entry.pending) return;
		const entry = view.entry;
		const form = Object.freeze({ ...entry.current });
		if (!form.name.trim() || !form.cwd.trim() || !form.prompt.trim()) return;
		const source: SchedulerAdmissionSource = Object.freeze({
			workspace: cwd,
			taskId: form.id || null,
			formId: view.id,
			revision: entry.revision,
			form,
		});
		const message: SaveMessage = Object.freeze({
			type: "schedule_save",
			task: Object.freeze({
				...(form.id ? { id: form.id } : {}),
				name: form.name,
				description: form.description,
				cwd: form.cwd,
				kind: form.kind,
				// The wire needs milliseconds, while the original minute string and
				// inactive cron/preset fields remain in the captured form above.
				spec:
					form.kind === "cron" ? form.cron : String(Math.max(1, Math.floor(Number(form.intervalMinutes) || 0)) * 60000),
				prompt: form.prompt,
				model: form.model,
				thinkingLevel: form.thinkingLevel,
				catchUp: form.catchUp ? "once" : "skip",
			}),
		});
		admissionSources.set(message, source);
		const attempt: Attempt = Object.freeze({ source, message, phase: "pending" });
		entry.attempts = [...entry.attempts, attempt];
		entry.pending = true; // Synchronous guard: a second click cannot race React.
		notifyDrafts();
		let admitted = false;
		try {
			admitted = (await appAdmit(message)) === true;
		} catch {
			// payloadCommitted errors are still uncertain. Keep both copies; never
			// fall back, auto-retry or claim a server save from a transport outcome.
		}
		entry.attempts = entry.attempts.map((item) =>
			item === attempt ? Object.freeze({ ...item, phase: admitted ? "admitted" : "unconfirmed" }) : item,
		);
		entry.pending = false;
		notifyDrafts();
		if (admitted && activeEditor.current === view && entry.revision === source.revision) closeEditor();
		// Even exact true only closes this unchanged view. The recovery copy is
		// retained until #570 supplies correlated downstream retirement/recovery.
	};

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiClock className="set-section-icon" />
				{t("settingsScheduler")}
				<HintTip text={t("schedulerDesc")} />
				<span className="set-count">{tasks.length}</span>
				<button type="button" className="set-save-btn" title={t("schedulerNew")} onClick={() => openEditor()}>
					<FiPlus /> {t("schedulerNew")}
				</button>
			</div>

			{tasks.length === 0 ? (
				<p className="set-hint">{t("schedulerEmpty")}</p>
			) : (
				<ul className="scheduler-list">
					{tasks.map((task) => (
						<li key={task.id} data-scheduler-task={task.id} className={`scheduler-item ${task.enabled ? "" : "off"}`}>
							<div className="scheduler-line1">
								<span className="scheduler-name" title={task.description || task.name}>
									{task.running ? `${t("schedulerRunning")} ` : ""}
									{task.name}
								</span>
								<span className={`scheduler-badge ${task.enabled ? "on" : ""}`}>
									{task.enabled ? t("schedulerEnabled") : t("schedulerDisabled")}
								</span>
								<button
									type="button"
									className={`set-switch ${task.enabled ? "on" : ""}`}
									title={task.enabled ? t("schedulerDisable") : t("schedulerEnable")}
									onClick={() => appSend({ type: "schedule_toggle", id: task.id, enabled: !task.enabled })}
								>
									<span className="set-switch-knob" />
								</button>
							</div>
							<div className="scheduler-line2">
								<span title={task.cwd}>{task.cwd}</span>
								<span>·</span>
								<span title={task.kind === "cron" ? task.spec : `${task.spec} ms`}>{specSummary(task, t)}</span>
							</div>
							<div className="scheduler-line2">
								<span>
									{t("schedulerNextFire")}: {task.nextFire ? formatTime(task.nextFire) : "—"}
								</span>
								<span>·</span>
								<span>
									{t("schedulerLastRun")}:{" "}
									{task.lastRun ? (
										<>
											{formatTime(task.lastRun.at)} ·{" "}
											<span className={task.lastRun.ok ? "scheduler-ok" : "scheduler-fail"}>
												{task.lastRun.ok ? t("schedulerRunOk") : t("schedulerRunFail")}
											</span>
											{task.lastRun.manual ? ` · ${t("schedulerManualBadge")}` : ""}
											{task.lastRun.error ? ` · ${task.lastRun.error}` : ""}
										</>
									) : (
										t("schedulerNeverRun")
									)}
								</span>
								{task.history.length > 1 && (
									<button type="button" className="scheduler-link" onClick={() => toggleHistory(task.id)}>
										{t("schedulerHistory")} ({task.history.length})
									</button>
								)}
							</div>
							{openHistory.has(task.id) && task.history.length > 0 && (
								<ul className="scheduler-history">
									{task.history.map((h, i) => (
										<li key={`${h.at}-${i}`}>
											{formatTime(h.at)} ·{" "}
											<span className={h.ok ? "scheduler-ok" : "scheduler-fail"}>
												{h.ok ? t("schedulerRunOk") : t("schedulerRunFail")}
											</span>
											{` · ${(h.durationMs / 1000).toFixed(0)}s`}
											{h.manual ? ` · ${t("schedulerManualBadge")}` : ""}
											{h.error ? ` · ${h.error}` : ""}
										</li>
									))}
								</ul>
							)}
							<div className="scheduler-actions">
								<button
									type="button"
									className="btn"
									disabled={task.running}
									title={t("schedulerRunNow")}
									onClick={() => appSend({ type: "schedule_run", id: task.id })}
								>
									<FiPlay /> {t("schedulerRunNow")}
								</button>
								<button type="button" className="btn" title={t("schedulerEdit")} onClick={() => openEditor(task)}>
									<FiEdit3 /> {t("schedulerEdit")}
								</button>
								<button
									type="button"
									className="btn"
									title={t("schedulerDelete")}
									onClick={() => {
										if (window.confirm(t("schedulerConfirmDelete", { name: task.name })))
											appSend({ type: "schedule_delete", id: task.id });
									}}
								>
									<FiTrash2 /> {t("schedulerDelete")}
								</button>
							</div>
						</li>
					))}
				</ul>
			)}

			{recoveries.some((entry) => entry.attempts.length > 0 || entry.restoredSources.length > 0) && (
				<details data-scheduler-recovery>
					<summary>Retained task drafts — page memory only</summary>
					<p className="set-hint">
						Local admission is not a server receipt. No task is created, enabled or run by opening a retained draft.
					</p>
					{recoveries
						.filter((entry) => entry.attempts.length > 0 || entry.restoredSources.length > 0)
						.map((entry) => (
							<div key={entry.current.id} data-scheduler-review={entry.current.id}>
								<button
									type="button"
									className="btn"
									onClick={() => {
										const retained = retainedDrafts.get(JSON.stringify([cwd, entry.current.id]));
										if (retained) reviewEntry(retained);
									}}
								>
									Open retained draft for review
								</button>
								{entry.restoredSources.map((source) => (
									<details key={`${source.formId}-${source.revision}`} data-scheduler-restored>
										<summary>Recovered original — review only; existing current edits are unchanged</summary>
										<pre>{JSON.stringify({ originalForm: source.form, currentForm: entry.current }, null, 2)}</pre>
									</details>
								))}
							</div>
						))}
					{recoveries.flatMap((entry) =>
						entry.attempts.map((attempt, index) => (
							<div key={`${attempt.source.formId}-${index}`} data-scheduler-admission={attempt.phase} role="status">
								<p>{admissionNotice(attempt.phase)}</p>
								<pre>
									{JSON.stringify(
										{ task: attempt.message.task, originalForm: attempt.source.form, currentForm: entry.current },
										null,
										2,
									)}
								</pre>
							</div>
						)),
					)}
				</details>
			)}

			{draft && (
				<div className="modal-backdrop" data-scheduler-form={editor?.id} onClick={closeEditor}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<button type="button" className="modal-close" aria-label={t("close")} onClick={closeEditor}>
							<FiX />
						</button>
						<div className="modal-head">
							<FiClock className="modal-head-icon" />
							<h2>{!draft.id ? t("schedulerNew") : `${t("schedulerEdit")} · ${draft.name || ""}`}</h2>
						</div>
						<div className="modal-body">
							{editor?.entry.restoredSources.length ? (
								<p role="status">
									Recovered for review only. No task was created, enabled or run by restoring this draft.
								</p>
							) : null}
							{editor?.entry.attempts.length ? (
								<div data-scheduler-current-admission={editor.entry.attempts.at(-1)!.phase} role="status">
									<p>{admissionNotice(editor.entry.attempts.at(-1)!.phase)}</p>
									<details>
										<summary>Complete submitted original</summary>
										<pre>{JSON.stringify(editor.entry.attempts.at(-1)!.source.form, null, 2)}</pre>
									</details>
								</div>
							) : null}
							<div className="tpl-fields">
								<input
									className="set-input"
									placeholder={t("schedulerNamePlaceholder")}
									name="name"
									value={draft.name}
									onChange={(e) => changeDraft({ name: e.target.value })}
								/>
								<input
									className="set-input"
									placeholder={t("schedulerDescPlaceholder")}
									name="description"
									value={draft.description}
									onChange={(e) => changeDraft({ description: e.target.value })}
								/>
							</div>
							<div className="set-mode-row">
								<label className="set-field-label">{t("schedulerCwdLabel")}</label>
								<div className="scheduler-cwd-row">
									<input
										className="set-input"
										placeholder={t("schedulerCwdPlaceholder")}
										name="cwd"
										value={draft.cwd}
										onChange={(e) => changeDraft({ cwd: e.target.value })}
									/>
									<button type="button" className="btn" onClick={() => changeDraft({ cwd })}>
										{t("schedulerUseCurrentCwd")}
									</button>
								</div>
							</div>
							<div className="set-mode-row">
								<label className="set-field-label">{t("schedulerKindLabel")}</label>
								<select
									className="set-select"
									name="kind"
									value={draft.kind}
									onChange={(e) => changeDraft({ kind: e.target.value as "cron" | "interval" })}
								>
									<option value="cron">{t("schedulerKindCron")}</option>
									<option value="interval">{t("schedulerKindInterval")}</option>
								</select>
							</div>
							{draft.kind === "cron" ? (
								<div className="set-mode-row">
									<label className="set-field-label">{t("schedulerKindCron")}</label>
									<div className="scheduler-cwd-row">
										<select
											className="set-select"
											name="preset"
											value={draft.preset}
											onChange={(e) => {
												const v = e.target.value;
												changeDraft({ preset: v, ...(v !== "custom" ? { cron: v } : {}) });
											}}
										>
											{CRON_PRESETS.map((p) => (
												<option key={p.value} value={p.value}>
													{t(p.key as Parameters<typeof t>[0])} · {p.value}
												</option>
											))}
											<option value="custom">{t("schedulerPresetCustom")}</option>
										</select>
										{draft.preset === "custom" && (
											<input
												className="set-input"
												placeholder={t("schedulerCronPlaceholder")}
												name="cron"
												value={draft.cron}
												onChange={(e) => changeDraft({ cron: e.target.value })}
											/>
										)}
									</div>
								</div>
							) : (
								<div className="set-mode-row">
									<label className="set-field-label">{t("schedulerKindInterval")}</label>
									<input
										className="set-input"
										type="number"
										min={1}
										placeholder={t("schedulerIntervalMinutes")}
										name="intervalMinutes"
										value={draft.intervalMinutes}
										onChange={(e) => changeDraft({ intervalMinutes: e.target.value })}
									/>
								</div>
							)}
							<div className="tpl-fields">
								<textarea
									className="set-input"
									rows={4}
									placeholder={t("schedulerPromptPlaceholder")}
									name="prompt"
									value={draft.prompt}
									onChange={(e) => changeDraft({ prompt: e.target.value })}
								/>
							</div>
							<div className="set-mode-row">
								<label className="set-field-label">{t("schedulerModelLabel")}</label>
								<select
									className="set-select"
									name="model"
									value={draft.model}
									onChange={(e) => changeDraft({ model: e.target.value })}
								>
									<option value="">{t("subagentFollowMain")}</option>
									{draft.model && !models.some((m) => `${m.provider}/${m.id}` === draft.model) && (
										<option value={draft.model}>{draft.model}</option>
									)}
									{models.map((m) => (
										<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
											{m.label}
										</option>
									))}
								</select>
							</div>
							{models.length === 0 && <p className="set-hint">{t("subagentNoModels")}</p>}
							<div className="set-mode-row">
								<label className="set-field-label">
									{t("schedulerThinkingLabel")} <HintTip text={t("tplThinkingHint")} />
								</label>
								<select
									className="set-select"
									name="thinkingLevel"
									value={draft.thinkingLevel}
									onChange={(e) => changeDraft({ thinkingLevel: e.target.value })}
								>
									<option value="">{t("tplThinkingFollowMain")}</option>
									{draft.thinkingLevel && !THINKING_VALUES.some((value) => value === draft.thinkingLevel) && (
										<option value={draft.thinkingLevel}>{draft.thinkingLevel}</option>
									)}
									{THINKING_VALUES.map((v) => (
										<option key={v} value={v}>
											{t(`thinking.${v}`)}
										</option>
									))}
								</select>
							</div>
							<label className="scheduler-check">
								<input
									type="checkbox"
									name="catchUp"
									checked={draft.catchUp}
									onChange={(e) => changeDraft({ catchUp: e.target.checked })}
								/>
								<span>
									{t("schedulerCatchUp")} <HintTip text={t("schedulerCatchUpHint")} />
								</span>
							</label>
							<div className="scheduler-foot">
								<button type="button" className="btn" onClick={closeEditor}>
									{t("schedulerCancelEdit")}
								</button>
								<button
									type="button"
									className="btn primary"
									disabled={editor?.entry.pending || !draft.name.trim() || !draft.cwd.trim() || !draft.prompt.trim()}
									onClick={save}
								>
									{t("schedulerSave")}
								</button>
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
