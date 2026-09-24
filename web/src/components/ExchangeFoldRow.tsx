import { memo, useEffect, useState } from "react";
import { FiChevronRight } from "react-icons/fi";
import type { ToolStatus, UiMessage } from "../types";
import { useT } from "../i18n";
import { countSteps, formatSpan, liveStep, type ExchangeFold, type LiveStep } from "../exchange-fold";
import { toolArgHints } from "../tool-args";
import "../exchange-fold.css";

/**
 * exchange-fold（fork 补丁）：一轮对话的步骤折叠行（逻辑见 exchange-fold.ts）。
 *
 *     ▸ 23 turns · 11 thinking · 31 tool calls · 4m 10s
 *
 * 直播轮多一个转圈和「进行中」，计数带上正在生成的那一轮，耗时每秒走；
 * 折着的时候下面一行是当前步骤（正在跑的工具和它的命令/路径、思考中、写回答、等模型）。
 */
interface ExchangeFoldRowProps {
	fold: ExchangeFold;
	open: boolean;
	/** 点击：el = 这一行的外层元素（宿主用它把行钉在原位）。 */
	onToggle: (fold: ExchangeFold, el: HTMLElement | null) => void;
	/** 以下三项只给直播行（其它行不传，memo 才省得了重画）。 */
	streamingMessage?: UiMessage | null;
	toolResults?: ReadonlyMap<string, UiMessage>;
	toolStatuses?: ReadonlyMap<string, ToolStatus>;
}

/** 工具步骤的提示：命令取第一行，否则路径、派单模板名。 */
function toolHint(argumentsText?: string): string {
	const h = toolArgHints(argumentsText);
	if (h.command) return h.command.split("\n", 1)[0];
	return h.path ?? h.agent ?? "";
}

function StepLine({ step }: { step: LiveStep }) {
	const t = useT();
	if (step.kind === "tool") {
		const hint = toolHint(step.argumentsText);
		return (
			<>
				<span className="xfold-step-tool">{step.name}</span>
				{hint && <span className="xfold-step-hint">{hint}</span>}
			</>
		);
	}
	if (step.kind === "thinking") return <>{t("foldStepThinking")}</>;
	if (step.kind === "writing") return <>{t("foldStepWriting")}</>;
	return <>{t("waitingResponse")}</>;
}

export const ExchangeFoldRow = memo(function ExchangeFoldRow({
	fold,
	open,
	onToggle,
	streamingMessage,
	toolResults,
	toolStatuses,
}: ExchangeFoldRowProps) {
	const t = useT();
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!fold.live) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [fold.live]);

	let { turns, thinking, toolCalls } = fold;
	const streaming = fold.live ? streamingMessage : undefined;
	if (streaming) {
		const c = countSteps(streaming);
		turns++;
		thinking += c.thinking;
		toolCalls += c.toolCalls;
	}
	let span: number | undefined;
	if (fold.startTs !== undefined) {
		if (fold.live) span = now - fold.startTs;
		else if (fold.endTs !== undefined && fold.endTs > fold.startTs) span = fold.endTs - fold.startTs;
	}

	const parts: string[] = [];
	if (turns > 0) parts.push(turns === 1 ? t("foldTurnOne") : t("foldTurns", { n: turns }));
	if (thinking > 0) parts.push(t("foldThinking", { n: thinking }));
	if (toolCalls > 0) parts.push(toolCalls === 1 ? t("foldToolCallOne") : t("foldToolCalls", { n: toolCalls }));
	if (span !== undefined) parts.push(formatSpan(span));

	const status =
		fold.status === "working"
			? t("foldWorking")
			: fold.status === "error"
				? t("foldError")
				: fold.status === "aborted"
					? t("foldAborted")
					: "";

	const step =
		fold.live && !open
			? liveStep(streaming, fold.lastAssistant, (id) => !!toolResults?.has(id) || !!toolStatuses?.has(id))
			: undefined;

	return (
		<div className={`xfold xfold-${fold.status}${open ? " open" : ""}`} data-fold-key={fold.key}>
			<button
				type="button"
				className="xfold-head"
				aria-expanded={open}
				title={open ? t("foldHide") : t("foldShow")}
				onClick={(e) => onToggle(fold, e.currentTarget.parentElement)}
			>
				<FiChevronRight className="xfold-caret" aria-hidden />
				{fold.live && <span className="xfold-spin" aria-hidden />}
				{status && <span className="xfold-status">{status}</span>}
				{parts.length > 0 && <span className="xfold-counts">{parts.join(" · ")}</span>}
			</button>
			{step && (
				<div className="xfold-step">
					<StepLine step={step} />
				</div>
			)}
		</div>
	);
});
