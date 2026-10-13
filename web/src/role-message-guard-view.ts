/** Component A's isolated presentation. No runtime registration, globals, network or authority.
 * UI intent is not an authenticated decision. #122 must supply verified native state/transport.
 */
import type {
	GuardApprovalContext,
	GuardGrant,
	GuardOwnerQuestion,
	GuardRequest,
	GuardRequestState,
	GuardRoleChoice,
} from "../../server/role-message-guard-contract.js";
export type GuardViewLanguage = "en" | "zh";
export type GuardViewState = GuardRequestState | "unavailable" | "disconnected";
export interface GuardApprovalViewInput {
	readonly request: GuardRequest | null;
	readonly grant?: GuardGrant | null;
	readonly ownerQuestion?: GuardOwnerQuestion | null;
	readonly viewer: "status" | "lower" | "owner";
	/** Presentation eligibility ONLY. The native host must still authenticate/revalidate the answer. */
	readonly eligible: boolean;
	readonly connected: boolean;
	readonly nowMs: number;
	readonly language?: GuardViewLanguage;
}
export interface GuardViewSection {
	readonly label: string;
	readonly values: readonly string[];
}
export interface GuardApprovalView {
	readonly key: string;
	readonly title: string;
	readonly state: GuardViewState;
	readonly status: string;
	readonly statusDetail: string;
	readonly tier: string;
	readonly limits: string;
	readonly sections: readonly GuardViewSection[];
	readonly choices: readonly { value: GuardRoleChoice; label: string; description: string }[];
	readonly submit: string;
	readonly close: string;
	readonly legend: string;
	readonly unknown: string;
	readonly requestId: string;
	readonly generation: string;
	readonly questionId: string | null;
	readonly questionGeneration: string | null;
}
const copy = {
	en: {
		title: "Message continuation",
		lower: "Lead / COO approval — through hop 11 only",
		owner: "Owner approval — required before hop 12",
		none: "No verified request",
		submit: "Submit selected decision",
		close: "Close without deciding",
		legend: "Choose one finite decision",
		unknown: "Delivery unknown. Query the same request; do not resend or start new work.",
		empty: "None recorded",
		declared: "Declared claims (not verified facts)",
		native: "Native evidence references (host verification required)",
		limits:
			"Communication only, finite uses, one hour maximum. Original root and scope stay unchanged. 20/hour, holds, access and consent still apply. No automatic business send; no action, spending, installation or hold-lift authority.",
		labels: [
			"Goal",
			"Progress and changes",
			"Prior decisions",
			"Why an answer is needed",
			"Next step and expected outcome",
			"All outstanding questions",
			"Options and trade-offs",
			"Time, cost and risk",
			"Exact communication authority",
			"Safety scope and holds",
		],
		deny: "Deny",
		one: "Allow one send",
		many: "Allow requested quantity",
		escalate: "Ask Owner instead",
		denyDetail: "No further business messages.",
		oneDetail: "One scoped send; not sent automatically.",
		manyDetail: "Only the stated quantity and hop bound; no other authority.",
		escalateDetail: "One explicit upward request; this is not Owner approval.",
	},
	zh: {
		title: "消息继续申请",
		lower: "负责人 / COO 批准 — 仅到第 11 跳",
		owner: "Owner 批准 — 第 12 跳前必须取得",
		none: "没有已验证的申请",
		submit: "提交所选决定",
		close: "关闭，不作决定",
		legend: "选择一个有限决定",
		unknown: "送达状态未知。查询同一申请；不要重发或开始新工作。",
		empty: "暂无记录",
		declared: "声明（并非已验证事实）",
		native: "原生证据引用（仍需主机验证）",
		limits:
			"只批准通信，次数有限，最长一小时。保留原始根和范围。每小时 20 条、暂停、访问和同意要求仍有效。不自动发送业务消息；不授权执行、花费、安装或解除暂停。",
		labels: [
			"目标",
			"进度和变化",
			"先前决定",
			"为什么需要回答",
			"下一步和预期结果",
			"全部未决问题",
			"选项和权衡",
			"时间、费用和风险",
			"准确的通信权限",
			"安全范围和暂停",
		],
		deny: "拒绝",
		one: "允许发送一条",
		many: "允许申请的有限次数",
		escalate: "改为询问 Owner",
		denyDetail: "不允许继续发送业务消息。",
		oneDetail: "只允许范围内一条；不自动发送。",
		manyDetail: "只允许所示次数和跳数；不授予其他权限。",
		escalateDetail: "仅一次明确上报；这不是 Owner 批准。",
	},
} as const;
const states: Record<GuardViewState, readonly [string, string]> = {
	context_needed: ["Complete context required", "需要完整背景"],
	awaiting_approver: ["Waiting for lead / COO", "等待负责人 / COO"],
	awaiting_owner: ["Waiting for Owner", "等待 Owner"],
	approved: ["Approved — not sent", "已批准 — 尚未发送"],
	denied: ["Denied", "已拒绝"],
	expired: ["Expired", "已过期"],
	exhausted: ["Finite allowance used", "有限次数已用完"],
	revoked: ["Revoked", "已撤销"],
	unknown: ["Unknown — do not retry", "未知 — 不要重试"],
	unavailable: ["Unavailable — no authority", "不可用 — 没有权限"],
	disconnected: ["Disconnected — decisions disabled", "已断开 — 无法作决定"],
	held: ["Held — no message sent", "已暂停 — 未发送消息"],
	rate_limited: ["20/hour allowance reached", "每小时 20 条限额已达到"],
};
function contextSections(c: GuardApprovalContext, language: GuardViewLanguage): GuardViewSection[] {
	const t = copy[language];
	const values = [
		[c.goal],
		[c.progressAndChanges],
		c.priorDecisions,
		[c.whyNeeded],
		[c.nextStepAndOutcome],
		c.outstandingQuestions,
		c.optionsAndTradeoffs,
		[c.timeCostRisk],
		[c.exactCommunicationAuthority],
		c.safetyScopeAndHolds,
	];
	return [
		...values.map((v, i) => ({ label: t.labels[i], values: v.length ? v : [t.empty] })),
		{ label: t.native, values: c.nativeFacts.length ? c.nativeFacts.map((f) => JSON.stringify(f)) : [t.empty] },
		{ label: t.declared, values: c.declaredClaims.length ? c.declaredClaims : [t.empty] },
	];
}
/** Readable remaining time from the caller's clock; never reads Date.now(). */
export function expiresIn(remainingMs: number): string {
	if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "expired";
	const minutes = Math.ceil(remainingMs / 60000);
	const hours = Math.floor(minutes / 60);
	return hours > 0 ? `expires in ${hours} h ${minutes % 60} min` : `expires in ${minutes} min`;
}

function complete(c: GuardApprovalContext): boolean {
	const texts = [
		c.goal,
		c.progressAndChanges,
		c.whyNeeded,
		c.nextStepAndOutcome,
		c.timeCostRisk,
		c.exactCommunicationAuthority,
	];
	const lists = [
		c.priorDecisions,
		c.outstandingQuestions,
		c.optionsAndTradeoffs,
		c.nativeFacts,
		c.declaredClaims,
		c.safetyScopeAndHolds,
	];
	return (
		texts.every((s) => typeof s === "string" && s.trim().length > 0) &&
		lists.every(Array.isArray) &&
		c.outstandingQuestions.length > 0 &&
		c.optionsAndTradeoffs.length > 1 &&
		c.safetyScopeAndHolds.length > 0 &&
		[c.priorDecisions, c.outstandingQuestions, c.optionsAndTradeoffs, c.declaredClaims, c.safetyScopeAndHolds].every(
			(list) => list.every((value) => typeof value === "string" && value.trim().length > 0),
		)
	);
}
export function guardApprovalView(input: GuardApprovalViewInput): GuardApprovalView {
	const language = input.language ?? "en";
	const t = copy[language];
	const r = input.request;
	const q = input.ownerQuestion;
	let state: GuardViewState = r?.state ?? "unavailable";
	const clock = Number.isSafeInteger(input.nowMs) && input.nowMs >= 0;
	if (r && !complete(r.context)) state = "context_needed";
	if (r && !clock) state = "unavailable";
	if (
		r &&
		clock &&
		["awaiting_approver", "awaiting_owner", "approved"].includes(state) &&
		(input.nowMs >= r.expiresAt || (input.grant && input.nowMs >= input.grant.expiresAt))
	)
		state = "expired";
	if (!(state in states)) state = "unknown";
	if (!input.connected) state = "disconnected";
	const eligible =
		input.eligible &&
		input.connected &&
		clock &&
		r !== null &&
		r.firstDecision === null &&
		((input.viewer === "lower" &&
			state === "awaiting_approver" &&
			r.binding.tier === "lower" &&
			r.binding.upperHop <= 11) ||
			(input.viewer === "owner" &&
				state === "awaiting_owner" &&
				r.binding.tier === "owner" &&
				q !== null &&
				q !== undefined &&
				JSON.stringify(q.binding) === JSON.stringify(r.binding) &&
				JSON.stringify(q.detail) === JSON.stringify(r.context) &&
				q.questionId.length > 0 &&
				q.generation.length > 0 &&
				q.choicesDigest.length > 0 &&
				q.choices.join(",") === "deny,one_send,requested_quantity"));
	const decisions = eligible
		? [
				{ value: "deny" as const, label: t.deny, description: t.denyDetail },
				{ value: "one_send" as const, label: t.one, description: t.oneDetail },
				{
					value: "requested_quantity" as const,
					label: `${t.many} (${r!.binding.quantity})`,
					description: t.manyDetail,
				},
				...(input.viewer === "lower" && r!.upwardEscalations === 0
					? [{ value: "escalate_owner" as const, label: t.escalate, description: t.escalateDetail }]
					: []),
			]
		: [];
	const remaining = input.grant ? Math.max(0, input.grant.maximumUses - input.grant.acceptedUses) : null;
	const expiry = r ? expiresIn(r.expiresAt - input.nowMs) : "";
	const statusDetail = r
		? `${r.binding.requester.role} · ${r.binding.requester.task.kind} · ${r.binding.scope.scopeId} · hops ${r.binding.causal.nextHop}–${r.binding.upperHop} · quantity ${r.binding.quantity}${remaining !== null ? ` · remaining ${remaining}` : ""} · ${expiry}`
		: t.none;
	return {
		key: JSON.stringify([r?.binding.requestId, r?.binding.generation, q?.questionId, q?.generation]),
		title: t.title,
		state,
		status: states[state][language === "en" ? 0 : 1],
		statusDetail,
		tier: r ? (r.binding.tier === "owner" ? t.owner : t.lower) : t.none,
		limits: t.limits,
		sections: r && complete(r.context) ? contextSections(r.context, language) : [],
		choices: decisions,
		submit: t.submit,
		close: t.close,
		legend: t.legend,
		unknown: t.unknown,
		requestId: r?.binding.requestId ?? "",
		generation: r?.binding.generation ?? "",
		questionId: q?.questionId ?? null,
		questionGeneration: q?.generation ?? null,
	};
}
