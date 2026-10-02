/**
 * subs-limits-box: the Limits section at the bottom of the left panel, under History (desktop and the
 * phone's side drawer alike). One row per subscription pi-multi-pass knows: name, plan, who, the
 * 5-hour and weekly windows as "% used" with a thin bar and "resets in …", a mark when limited, how
 * old the numbers are, and a mark on the account the open chat uses. A failed check keeps the last
 * numbers and says why. Only the refresh button runs checks; numbers seen in replies update rows by
 * themselves (the server pushes every change).
 */
import { memo, useEffect, useState, type ReactNode } from "react";
import { FiRefreshCw } from "react-icons/fi";
import { useT, type Translate } from "../i18n";
import {
	accountLimited,
	accountWho,
	agoParts,
	formatResetIn,
	limitLevel,
	orderedWindows,
	refreshSubsLimits,
	useSubsLimits,
} from "../subs-limits-state";
import type { UiLimitWindow, UiLimitsAccount } from "../types";

export type SectionHeader = (
	title: string,
	collapsed: boolean,
	onToggle: () => void,
	count?: number,
	actions?: ReactNode,
) => ReactNode;

interface LimitsSectionProps {
	collapsed: boolean;
	onToggle: () => void;
	/** The provider the open chat's model comes from ("anthropic-2"); its row gets the mark. */
	currentProvider?: string;
	/** LeftPanel's section header, so the box folds and looks like the others. */
	header: SectionHeader;
}

function agoText(t: Translate, at: number, now: number): string {
	const { unit, n } = agoParts(at, now);
	if (unit === "now") return t("limitsJustNow");
	if (unit === "min") return t("limitsMinAgo", { n });
	if (unit === "h") return t("limitsHoursAgo", { n });
	return t("limitsDaysAgo", { n });
}

function LimitWindowRow({ w, now, t }: { w: UiLimitWindow; now: number; t: Translate }) {
	const level = limitLevel(w);
	const used = w.usedPercent;
	const reset = formatResetIn(w.resetAt, now);
	return (
		<div className={`lp-limit-window lp-limit-${level}`}>
			<span className="lp-limit-wlabel">{w.label}</span>
			<span className="lp-limit-bar" aria-hidden="true">
				<span className="lp-limit-fill" style={{ width: `${Math.max(0, Math.min(100, used ?? 0))}%` }} />
			</span>
			<span className="lp-limit-pct">{used === undefined ? "?" : t("limitsUsed", { percent: Math.round(used) })}</span>
			{reset !== undefined && (
				<span className="lp-limit-reset">
					{reset === null ? t("limitsResetSince") : t("limitsResetsIn", { time: reset })}
				</span>
			)}
		</div>
	);
}

function LimitsAccountRow({ a, now, current, t }: { a: UiLimitsAccount; now: number; current: boolean; t: Translate }) {
	const limited = accountLimited(a);
	const who = accountWho(a);
	return (
		<div
			className={`lp-limit-row${limited ? " limited" : ""}${current ? " current" : ""}${a.failure ? " failed" : ""}`}
			data-provider={a.provider}
		>
			<div className="lp-limit-head">
				{current && (
					<span className="lp-limit-current" title={t("limitsThisChat")} aria-label={t("limitsThisChat")}>
						●
					</span>
				)}
				<span className="lp-limit-name">{a.name}</span>
				{a.plan && <span className="lp-limit-plan">{a.plan}</span>}
				{who && (
					<span className="lp-limit-who" title={who}>
						{who}
					</span>
				)}
				{limited && <span className="lp-limit-badge">{t("limitsLimited")}</span>}
			</div>
			{orderedWindows(a.windows).map((w) => (
				<LimitWindowRow key={w.key} w={w} now={now} t={t} />
			))}
			{a.failure && <div className="lp-limit-failure">{a.failure.text}</div>}
			<div className="lp-limit-age">
				{a.checkedAt !== undefined ? t("limitsChecked", { ago: agoText(t, a.checkedAt, now) }) : t("limitsNoNumbers")}
			</div>
		</div>
	);
}

export const LimitsSection = memo(function LimitsSection({
	collapsed,
	onToggle,
	currentProvider,
	header,
}: LimitsSectionProps) {
	const t = useT();
	const limits = useSubsLimits();
	const [now, setNow] = useState(() => Date.now());
	const spinning = limits.checking || limits.pressed;

	// "checked N min ago" and "resets in …" move on while the box is open.
	useEffect(() => {
		if (collapsed) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(id);
	}, [collapsed, limits]);

	const refresh = (
		<button
			type="button"
			className={`lp-section-action lp-limits-refresh${spinning ? " spinning" : ""}`}
			title={spinning ? t("limitsChecking") : t("limitsRefresh")}
			aria-label={spinning ? t("limitsChecking") : t("limitsRefresh")}
			aria-busy={spinning}
			onClick={(e) => {
				e.stopPropagation();
				refreshSubsLimits();
			}}
		>
			<FiRefreshCw />
		</button>
	);

	const never = limits.loaded && limits.checkedAt === undefined && limits.accounts.length === 0;
	return (
		<div className={`lp-section lp-section-limits panel-limits ${collapsed ? "collapsed" : ""}`}>
			{header(t("limitsSection"), collapsed, onToggle, undefined, refresh)}
			{!collapsed && (
				<div className="lp-section-body lp-limits-body">
					{limits.error && <div className="lp-limits-error">{limits.error}</div>}
					{never && !spinning && (
						<div className="lp-limits-empty">
							<div>{t("limitsNotChecked")}</div>
							<div className="lp-limits-hint">{t("limitsNotCheckedHint")}</div>
						</div>
					)}
					{never && spinning && <div className="lp-limits-empty">{t("limitsChecking")}</div>}
					{limits.accounts.map((a) => (
						<LimitsAccountRow key={a.provider} a={a} now={now} current={a.provider === currentProvider} t={t} />
					))}
				</div>
			)}
		</div>
	);
});
