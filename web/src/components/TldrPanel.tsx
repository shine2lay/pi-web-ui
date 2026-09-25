/**
 * 右栏的 TL;DR tab（tldr-panel）。
 *
 * 长任务里 agent 用 pi-tldr 的 `tldr` 工具边做边写一句大白话进展；这里把当前对话的
 * 这些行倒过来列（最新的在最上面），默认只显示最新几行，「显示全部」展开整份。
 * 「需要你」的行（要用户出手或拍板）高亮。
 */

import { memo, useState } from "react";
import type { UiTldrLine } from "../types";
import { useT } from "../i18n";

/** 收起时显示几行（最新的）。 */
export const TLDR_COLLAPSED_LINES = 5;

/** 行尾时间：今天只写时分，更早的带上日期。 */
function lineTime(ts: number, now = Date.now()): string {
	if (!ts) return "";
	const d = new Date(ts);
	const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return d.toDateString() === new Date(now).toDateString()
		? hm
		: `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

export const TldrPanel = memo(function TldrPanel({
	lines,
	defaultShowAll = false,
}: {
	lines: UiTldrLine[] | undefined;
	/** 初始是否展开（测试用；界面上由按钮切换）。 */
	defaultShowAll?: boolean;
}) {
	const t = useT();
	const [showAll, setShowAll] = useState(defaultShowAll);
	const all = lines ?? [];
	if (all.length === 0) {
		return (
			<div className="tldr-panel">
				<p className="tldr-empty">{t("tldrEmpty")}</p>
			</div>
		);
	}
	const newestFirst = [...all].reverse();
	const shown = showAll ? newestFirst : newestFirst.slice(0, TLDR_COLLAPSED_LINES);
	return (
		<div className="tldr-panel">
			<ul className="tldr-list">
				{shown.map((l) => (
					<li key={l.id} className={l.needsYou ? "tldr-line needs-you" : "tldr-line"}>
						{l.needsYou && <span className="tldr-badge">{t("tldrNeedsYou")}</span>}
						<span className="tldr-text">{l.text}</span>
						{l.ts > 0 && (
							<time
								className="tldr-time"
								dateTime={new Date(l.ts).toISOString()}
								title={new Date(l.ts).toLocaleString()}
							>
								{lineTime(l.ts)}
							</time>
						)}
					</li>
				))}
			</ul>
			{all.length > TLDR_COLLAPSED_LINES && (
				<button type="button" className="tldr-more" onClick={() => setShowAll((v) => !v)}>
					{showAll ? t("tldrShowFewer") : t("tldrShowAll", { n: all.length })}
				</button>
			)}
		</div>
	);
});
