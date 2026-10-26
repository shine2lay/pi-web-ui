import {
	Fragment,
	memo,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from "react";
import { FiTarget, FiLock, FiUnlock, FiX, FiChevronUp } from "react-icons/fi";
import type { GoalStatus, ModelInfo } from "../types";
import { useT } from "../i18n";
import { appSend, useIsDsh } from "../app-globals";
import { appAdmit } from "../app-admit";
import { Dropdown, DropdownItem } from "./Dropdown";
import type { UiSlotEntry } from "../ui-slots";
import { renderMergedToolbar } from "../slot-toolbar";

/** Messages this component sends. */
export type GoalBarMsg =
	| { type: "set_goal"; goal: string; reviewModel?: string; maxRounds: number; locked: boolean }
	| { type: "clear_goal" }
	| { type: "start_goal_wizard"; text: string; wizardModel?: string; maxRounds?: number; locked?: boolean }
	| {
			type: "set_goal_prefs";
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
	  }
	| { type: "list_models" };

/** #570's shared target field is required for these authored submissions.
 * Bind the real prop before admission; never substitute a later active target.
 * The host still owns source/ownership checks and safe original-target dispatch. */
export type GoalAuthoredIntent = Extract<GoalBarMsg, { type: "set_goal" | "start_goal_wizard" }> & {
	readonly conversationId: string;
};
type AdmissionState = "pending" | "refused" | "uncertain" | "admitted";
interface GoalAttempt {
	readonly message: Readonly<GoalAuthoredIntent>;
	readonly state: AdmissionState;
}
interface GoalDraft {
	text: string;
	reviewModel: string;
	maxRounds: number;
	locked: boolean;
	collapsed: boolean;
	edited: boolean;
	revision: number;
	pending: GoalAttempt | null;
	attempts: readonly GoalAttempt[];
}

// Component-owned, conversation-scoped recovery across navigation/unmount only.
// No persistence claim, automatic replay, expiry, or generic control journal.
// Even local true keeps the original; #570 owns durable recovery/ack retirement.
const goalDrafts = new Map<
	string,
	{
		snapshot: GoalDraft;
		subscribe: (listener: () => void) => () => void;
		read: () => GoalDraft;
		write: (draft: GoalDraft) => void;
	}
>();
function goalDraftFor(conversationId: string, goal: GoalStatus) {
	let resource = goalDrafts.get(conversationId);
	if (!resource) {
		const listeners = new Set<() => void>();
		const created = {
			snapshot: {
				text: "",
				reviewModel: goal.reviewModel ?? "",
				maxRounds: goal.maxRounds || 0,
				locked: goal.locked,
				collapsed: true,
				edited: false,
				revision: 0,
				pending: null,
				attempts: [],
			} as GoalDraft,
			subscribe: (listener: () => void) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			read: (): GoalDraft => created.snapshot,
			write: (draft: GoalDraft) => {
				created.snapshot = draft;
				for (const listener of listeners) listener();
			},
		};
		resource = created;
		goalDrafts.set(conversationId, resource);
	}
	return resource;
}

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  the goal bar entirely during streaming. */
interface Props {
	goal: GoalStatus;
	models: ModelInfo[];
	modelsLoading: boolean;
	activeConversationId: string;
	/** `goalbar.actions` 槽位的最终条目（全量，含 hidden；宿主 chrome + 插件按槽位顺序合并渲染）。
	 *  不传 = 未接线，回落默认顺序（与旧硬编码一致）。 */
	uiGoalbarActions?: UiSlotEntry[];
	/** 点击一条目标条动作：交回 App 分发给贡献它的插件（与顶栏 onUiAction 同通道）。 */
	onUiAction?: (item: UiSlotEntry) => void;
}

export const GoalBar = memo(function GoalBar(props: Props) {
	// A → B → A is a new lifetime even if the final target string is equal.
	return <GoalBarEditor key={props.activeConversationId} {...props} />;
});

function GoalBarEditor({ goal, models, modelsLoading, activeConversationId, uiGoalbarActions, onUiAction }: Props) {
	const t = useT();
	const goalDetail = goal.statusEn ? goal.statusEn : goal.status || "";
	const wizardDetail = goal.wizard?.statusEn ? goal.wizard.statusEn : goal.wizard?.status || "";
	// DSH：无独立审查模型 —— 隐藏 reviewModel 下拉（轮次上限仍然有效）。
	// engine 走全局（web/src/app-globals.ts），不再从 App 一路传下来。
	const isDsh = useIsDsh();
	// Goals belong to the conversation that created them. The server keeps the
	// status around while switching chats so returning to the owner restores the
	// goal, but never show another conversation's goal as active.
	const goalBelongsToActiveConversation = !goal.conversationId || goal.conversationId === activeConversationId;
	const active = goal.goal !== null && goalBelongsToActiveConversation;

	const wizardActive = (goal.wizard?.active ?? false) && goalBelongsToActiveConversation;
	const resource = goalDraftFor(activeConversationId, goal);
	const draft = useSyncExternalStore(resource.subscribe, resource.read);
	const { text, reviewModel, maxRounds, locked, collapsed } = draft;
	const editDraft = (patch: Partial<GoalDraft>, authored = true) => {
		const current = resource.read();
		resource.write({ ...current, ...patch, edited: current.edited || authored, revision: current.revision + 1 });
	};
	const setText = (text: string) => editDraft({ text });
	const setReviewModel = (reviewModel: string) => editDraft({ reviewModel });
	const setMaxRounds = (maxRounds: number) => editDraft({ maxRounds });
	const setLocked = (locked: boolean) => editDraft({ locked });
	const setCollapsed = (collapsed: boolean) => editDraft({ collapsed }, false);
	const [modelOpen, setModelOpen] = useState(false);
	const [reqLoading, setReqLoading] = useState(false);
	const view = useRef({ current: false });
	useLayoutEffect(() => {
		const lifetime = { current: true };
		view.current = lifetime;
		return () => {
			lifetime.current = false;
		};
	}, [active, wizardActive]);

	// Remembered server defaults may populate a clean editor, never overwrite
	// authored options or an outstanding intent (including on goal transitions).
	useEffect(() => {
		const current = resource.read();
		if (current.edited || current.pending) return;
		resource.write({
			...current,
			reviewModel: goal.reviewModel ?? "",
			maxRounds: goal.maxRounds || 0,
			locked: goal.locked,
			revision: current.revision + 1,
		});
	}, [resource, goal.goal, goal.reviewModel, goal.maxRounds, goal.locked]);

	// Lazily fetch the model list when the review-model dropdown opens.
	useEffect(() => {
		if (modelOpen && models.length === 0 && !reqLoading && !modelsLoading) {
			setReqLoading(true);
			appSend({ type: "list_models" });
		}
	}, [modelOpen, models.length, reqLoading, modelsLoading]);
	useEffect(() => {
		if (models.length > 0) setReqLoading(false);
	}, [models.length]);

	const reviewModelName = (): string => {
		if (!reviewModel) return t("goalBarUseMainModel");
		return models.find((m) => m.id === reviewModel)?.name ?? reviewModel;
	};

	const submit = async (kind: "set_goal" | "start_goal_wizard") => {
		const original = resource.read();
		if (!original.text.trim() || !activeConversationId || original.pending) return;
		const message: Readonly<GoalAuthoredIntent> = Object.freeze({
			...(kind === "set_goal"
				? { type: kind, goal: original.text, ...(original.reviewModel ? { reviewModel: original.reviewModel } : {}) }
				: { type: kind, text: original.text, ...(original.reviewModel ? { wizardModel: original.reviewModel } : {}) }),
			maxRounds: original.maxRounds,
			locked: original.locked,
			conversationId: activeConversationId,
		});
		const attempt: GoalAttempt = { message, state: "pending" };
		const lifetime = view.current;
		// Synchronous shared guard, before appAdmit/await: Enter/click/remount
		// cannot submit another copy while either authored action is pending.
		resource.write({ ...original, pending: attempt, attempts: [...original.attempts, attempt] });
		let state: AdmissionState;
		try {
			state = (await appAdmit(message)) === true ? "admitted" : "refused";
		} catch {
			// Including payloadCommitted: true. Unknown dispatch is not permission
			// to clear or retry automatically. Keep the complete recoverable source.
			state = "uncertain";
		}
		const current = resource.read();
		const mayClear =
			state === "admitted" && lifetime.current && view.current === lifetime && current.revision === original.revision;
		resource.write({
			...current,
			pending: null,
			attempts: current.attempts.map((item) => (item === attempt ? { message, state } : item)),
			...(mayClear ? { text: "", collapsed: false, edited: false, revision: current.revision + 1 } : {}),
		});
	};
	const set = () => {
		void submit("set_goal");
	};
	const startWizard = () => {
		void submit("start_goal_wizard");
	};
	const admissionCopy: Record<AdmissionState, string> = {
		pending: "Waiting for local admission. Draft kept; nothing is confirmed.",
		refused: "Admission not confirmed. Draft kept; check the original conversation before trying again.",
		uncertain:
			"Admission uncertain. Draft kept; work may have started. Check the original conversation before trying again.",
		admitted: "Accepted locally, not server confirmation. Original kept for recovery.",
	};
	const recovery = draft.attempts.length > 0 && (
		<div className="goalbar-admission" role="status" aria-live="polite">
			{draft.attempts.map((attempt, index) => (
				<details key={index} data-admission-state={attempt.state}>
					<summary>{admissionCopy[attempt.state]}</summary>
					<textarea
						aria-label={`Original goal intent for ${attempt.message.conversationId}`}
						readOnly
						rows={5}
						style={{ width: "100%" }}
						value={JSON.stringify(attempt.message, null, 2)}
					/>
				</details>
			))}
		</div>
	);

	// A wizard running (scoping questions in flight) — show its progress.
	// ---- 槽位合并：宿主 chrome 按 id 分区（编辑行/选项行/活跃行/pill），插件条目跟随同行；
	// 未接线时用默认顺序（与旧硬编码一致），hidden 由上层过滤（App 传全量）。 ----
	const GOAL_DEFAULT_ORDER = [
		"host:goal-pill",
		"host:goal-set",
		"host:goal-wizard",
		"host:goal-lock",
		"host:goal-collapse",
		"host:goal-model",
		"host:goal-rounds",
		"host:goal-clear",
	];
	const allGoalEntries: UiSlotEntry[] =
		uiGoalbarActions === undefined
			? GOAL_DEFAULT_ORDER.map((id) => ({ id, source: "host" }) as UiSlotEntry)
			: uiGoalbarActions.filter((e) => !e.hidden);
	/** 取某行要画的条目：该行宿主 id + 全部插件条目（插件跟随每行，与旧版 renderSlotToolbar 四处都画一致），按槽位顺序。 */
	const goalZone = (ids: string[]): UiSlotEntry[] => {
		const set = new Set(ids);
		return allGoalEntries.filter((e) => set.has(e.id) || e.source !== "host");
	};
	const goalHostNodes: Record<string, ReactNode> = {
		"host:goal-pill": (
			<button
				type="button"
				className="goalbar-hint"
				title={t("goalBarPlaceholder")}
				onClick={() => setCollapsed(false)}
			>
				<FiTarget /> <span>{t("goalBarTitle")}</span>
			</button>
		),
		"host:goal-set": (
			<button
				type="button"
				className="goalbar-btn"
				disabled={!text.trim() || !activeConversationId || !!draft.pending}
				onClick={set}
			>
				{t("goalBarSet")}
			</button>
		),
		"host:goal-wizard": (
			<button
				type="button"
				className="goalbar-btn wizard"
				disabled={!text.trim() || !activeConversationId || !!draft.pending}
				title={t("goalWizardTip")}
				onClick={startWizard}
			>
				🔍 {t("goalWizardBtn")}
			</button>
		),
		"host:goal-lock": (
			<button
				type="button"
				className="goalbar-icon-btn"
				title={locked ? t("goalBarLocked") : t("goalBarUnlocked")}
				onClick={() => {
					const next = !resource.read().locked;
					setLocked(next);
					appSend({ type: "set_goal_prefs", locked: next });
				}}
			>
				{locked ? <FiLock /> : <FiUnlock />}
			</button>
		),
		"host:goal-collapse": (
			<button type="button" className="goalbar-icon-btn" title={t("goalBarClear")} onClick={() => setCollapsed(true)}>
				<FiChevronUp />
			</button>
		),
		"host:goal-model": isDsh ? (
			<p className="goalbar-dsh-note">{t("dshNoReviewModel")}</p>
		) : (
			<Dropdown
				trigger={
					<span className="goalbar-opt">
						{t("goalBarReviewModel")}: <b>{reviewModelName()}</b>
					</span>
				}
				open={modelOpen}
				onOpenChange={setModelOpen}
				direction="up"
			>
				<div className="dd-header">{t("goalBarReviewModel")}</div>
				{(reqLoading || modelsLoading) && <div className="dd-loading">{t("loading")}</div>}
				{models.length === 0 && !reqLoading && !modelsLoading && <div className="dd-loading">{t("noModels")}</div>}
				<DropdownItem
					active={reviewModel === ""}
					onClick={() => {
						setReviewModel("");
						setModelOpen(false);
						appSend({ type: "set_goal_prefs", reviewModel: "" });
					}}
				>
					{t("goalBarUseMainModel")}
				</DropdownItem>
				{models.map((m) => (
					<DropdownItem
						key={m.id}
						active={reviewModel === m.id}
						onClick={() => {
							setReviewModel(m.id);
							setModelOpen(false);
							appSend({ type: "set_goal_prefs", reviewModel: m.id });
						}}
					>
						<span className="dd-model-cell">
							<span className="dd-model-name">{m.name}</span>
							<span className="dd-model-meta">
								<span className="dd-model-provider">{m.provider}</span>
								<span className="dd-model-id">{m.id.split("/").slice(1).join("/")}</span>
							</span>
						</span>
					</DropdownItem>
				))}
				<button type="button" className="dd-refresh" onClick={() => appSend({ type: "list_models" })}>
					{t("refreshModels")}
				</button>
			</Dropdown>
		),
		"host:goal-rounds": (
			<label className="goalbar-round" title={t("goalBarMaxRoundsTip")}>
				<span>{t("goalBarMaxRounds")}</span>
				<input
					type="number"
					min={0}
					step={1}
					value={maxRounds}
					placeholder={t("goalBarUnlimitedShort")}
					onChange={(e) => {
						const v = parseInt(e.target.value, 10);
						if (Number.isNaN(v) || v < 0) {
							setMaxRounds(0);
							return;
						}
						setMaxRounds(v);
					}}
					onBlur={() => appSend({ type: "set_goal_prefs", maxRounds: maxRounds })}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							appSend({ type: "set_goal_prefs", maxRounds: maxRounds });
							(e.target as HTMLInputElement).blur();
						}
					}}
				/>
			</label>
		),
	};
	if (wizardActive) {
		return (
			<div className={`goalbar goalbar-active ${wizardActive ? "wizard" : ""}`}>
				<div className="goalbar-active-row">
					<span className="goalbar-icon">
						<span className="goalbar-spin">🔍</span>
					</span>
					<span className="goalbar-text" title={goal.wizard?.draft ?? ""}>
						{t("goalWizardRunning")}: {goal.wizard?.draft}
					</span>
					<span className="goalbar-chip reviewing">
						{t("goalBarRound", { n: (goal.wizard?.step ?? 0) + 1 })} / {goal.wizard?.maxSteps ?? 6}
					</span>
					<span className="goalbar-detail">{wizardDetail || t("goalBarReviewing")}</span>
					{renderMergedToolbar(
						goalZone(["host:goal-clear"]),
						{
							...goalHostNodes,
							"host:goal-clear": (
								<button
									type="button"
									className="goalbar-x"
									title={t("goalBarClear")}
									onClick={() => {
										appSend({ type: "clear_goal" });
										setCollapsed(true);
									}}
								>
									<FiX />
								</button>
							),
						},
						onUiAction,
					)}
				</div>
				{recovery}
			</div>
		);
	}

	if (active) {
		return (
			<div className={`goalbar goalbar-active ${goal.reviewing ? "reviewing" : ""}`}>
				<div className="goalbar-active-row">
					<span className="goalbar-icon">{goal.reviewing ? <span className="goalbar-spin">◌</span> : "🎯"}</span>
					<span className="goalbar-text" title={goal.goal ?? ""}>
						{goal.goal}
					</span>
					{goal.reviewing ? (
						<span className="goalbar-chip reviewing">
							{t("goalBarReviewing")} {t("goalBarRound", { n: goal.round })}
						</span>
					) : (
						<span
							className={`goalbar-chip ${goal.verdict === "pass" ? "pass" : goal.verdict === "fail" ? "fail" : goal.verdict === "blocked" ? "blocked" : ""}`}
						>
							{goal.verdict === "pass"
								? t("goalBarPassed")
								: goal.verdict === "fail"
									? t("goalBarFailed")
									: goal.verdict === "blocked"
										? t("goalBarBlocked")
										: `${t("goalBarRound", { n: goal.round || 1 })} · ${goal.locked ? t("goalBarLocked") : t("goalBarUnlocked")}`}
						</span>
					)}
					<span className="goalbar-detail">{goalDetail}</span>
					{renderMergedToolbar(
						goalZone(["host:goal-clear"]),
						{
							...goalHostNodes,
							"host:goal-clear": (
								<button
									type="button"
									className="goalbar-x"
									title={t("goalBarClear")}
									disabled={goal.reviewing}
									onClick={() => {
										if (goal.goal && !resource.read().edited) setText(goal.goal);
										appSend({ type: "clear_goal" });
										setCollapsed(false);
									}}
								>
									<FiX />
								</button>
							),
						},
						onUiAction,
					)}
				</div>
				{recovery}
			</div>
		);
	}

	// Inactive, collapsed — a single compact pill aligned LEFT (not a centered
	// full-width strip). A discreet 🎯 chip; click to open the editor.
	if (collapsed) {
		// pill 藏掉且无插件条目时整条不占位（布局页「恢复」可找回）。
		const pillBar = renderMergedToolbar(goalZone(["host:goal-pill"]), goalHostNodes, onUiAction);
		if (!pillBar && !recovery) return null;
		return (
			<div className="goalbar goalbar-collapsed">
				{pillBar}
				{recovery}
			</div>
		);
	}

	return (
		<div className="goalbar">
			<div className="goalbar-row">
				<span className="goalbar-icon">
					<FiTarget />
				</span>
				<input
					className="goalbar-input"
					value={text}
					placeholder={t("goalBarPlaceholder")}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") set();
					}}
				/>
				{renderMergedToolbar(
					goalZone(["host:goal-set", "host:goal-wizard", "host:goal-lock", "host:goal-collapse"]),
					goalHostNodes,
					onUiAction,
				)}
			</div>
			<div className="goalbar-opts">
				{goalZone(["host:goal-model", "host:goal-rounds"])
					.filter((e) => e.source === "host")
					.map((e) => (
						<Fragment key={e.id}>{goalHostNodes[e.id]}</Fragment>
					))}

				<span className="goalbar-lock-hint">{locked ? t("goalBarLocked") : t("goalBarUnlocked")}</span>
			</div>
			{recovery}
		</div>
	);
}
