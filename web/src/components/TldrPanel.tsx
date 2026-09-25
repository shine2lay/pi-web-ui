/**
 * 右栏的 TL;DR tab（tldr-panel）。
 *
 * 长任务里 agent 用 pi-tldr 的 `tldr` 工具边做边写一句大白话进展；这里把当前对话的
 * 这些行倒过来列（最新的在最上面），默认只显示最新几行，「显示全部」展开整份。
 * 「需要你」的行（要用户出手或拍板）高亮。
 *
 * tldr-collapse：看过的行可以折叠（每行右上角的 ▾，或顶上的「全部折叠」）。连着的折叠行
 * 并成一行「N 行已读」，点它重新展开。折叠状态存在服务端的会话里（UiTldrLine.collapsed），
 * 所有窗口、所有设备一致；点下去先在本地生效，等服务端的行对上。
 */

import { memo, useEffect, useState } from "react";
import type { UiTldrLine } from "../types";
import { useT } from "../i18n";

/** 收起时显示几行（最新的；一行「N 行已读」也算一行）。 */
export const TLDR_COLLAPSED_LINES = 5;

/** 点了还没等到服务端回的折叠 / 展开，过了这么久还对不上（服务端没收）就回到服务端的状态。 */
const PENDING_MS = 5000;

/** 列表里的一行：一条 TL;DR，或者一串连着的已折叠行并成的「N 行已读」。 */
export type TldrRow = { kind: "line"; line: UiTldrLine } | { kind: "folded"; lines: UiTldrLine[] };

/** 最新在上的行 → 显示用的行：连着的已折叠行并成一行。 */
export function tldrRows(newestFirst: readonly UiTldrLine[], isFolded: (l: UiTldrLine) => boolean): TldrRow[] {
	const rows: TldrRow[] = [];
	for (const line of newestFirst) {
		if (!isFolded(line)) {
			rows.push({ kind: "line", line });
			continue;
		}
		const last = rows.at(-1);
		if (last?.kind === "folded") last.lines.push(line);
		else rows.push({ kind: "folded", lines: [line] });
	}
	return rows;
}

/** 行尾时间：今天只写时分，更早的带上日期（队列 tab 也用）。 */
export function lineTime(ts: number, now = Date.now()): string {
	if (!ts) return "";
	const d = new Date(ts);
	const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return d.toDateString() === new Date(now).toDateString()
		? hm
		: `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

type Pending = Record<string, { folded: boolean; at: number }>;

export const TldrPanel = memo(function TldrPanel({
	lines,
	defaultShowAll = false,
	onCollapse,
}: {
	lines: UiTldrLine[] | undefined;
	/** 初始是否展开（测试用；界面上由按钮切换）。 */
	defaultShowAll?: boolean;
	/** 折叠（collapsed=true）或重新展开这些行：发给服务端记进会话。不给就不出折叠按钮。 */
	onCollapse?: (ids: string[], collapsed: boolean) => void;
}) {
	const t = useT();
	const [showAll, setShowAll] = useState(defaultShowAll);
	const [pending, setPending] = useState<Pending>({});
	const all = lines ?? [];
	// 服务端的行对上了（或者等太久了）的本地改动就丢掉。
	useEffect(() => {
		setPending((p) => {
			const ids = Object.keys(p);
			if (ids.length === 0) return p;
			const server = new Map((lines ?? []).map((l) => [l.id, l.collapsed === true]));
			const now = Date.now();
			const keep = ids.filter((id) => server.has(id) && server.get(id) !== p[id].folded && now - p[id].at < PENDING_MS);
			return keep.length === ids.length ? p : Object.fromEntries(keep.map((id) => [id, p[id]]));
		});
	}, [lines]);
	if (all.length === 0) {
		return (
			<div className="tldr-panel">
				<p className="tldr-empty">{t("tldrEmpty")}</p>
			</div>
		);
	}
	const now = Date.now();
	const isFolded = (l: UiTldrLine) => {
		const p = pending[l.id];
		return p && now - p.at < PENDING_MS ? p.folded : l.collapsed === true;
	};
	const fold = (ids: string[], folded: boolean) => {
		if (!onCollapse || ids.length === 0) return;
		const at = Date.now();
		setPending((p) => ({ ...p, ...Object.fromEntries(ids.map((id) => [id, { folded, at }])) }));
		onCollapse(ids, folded);
	};
	const newestFirst = [...all].reverse();
	const rows = tldrRows(newestFirst, isFolded);
	const shown = showAll ? rows : rows.slice(0, TLDR_COLLAPSED_LINES);
	const openIds = newestFirst.filter((l) => !isFolded(l)).map((l) => l.id);
	return (
		<div className="tldr-panel">
			{onCollapse && openIds.length > 0 && (
				<div className="tldr-toolbar">
					<button type="button" className="tldr-collapse-all" onClick={() => fold(openIds, true)}>
						{t("tldrCollapseAll")}
					</button>
				</div>
			)}
			<ul className="tldr-list">
				{shown.map((row) =>
					row.kind === "folded" ? (
						<li key={`folded:${row.lines[0].id}`} className="tldr-folded">
							<button
								type="button"
								className="tldr-unfold"
								disabled={!onCollapse}
								title={t("tldrUnfold")}
								onClick={() =>
									fold(
										row.lines.map((l) => l.id),
										false,
									)
								}
							>
								{row.lines.length === 1 ? t("tldrFoldedOne") : t("tldrFolded", { n: row.lines.length })}
							</button>
						</li>
					) : (
						<li key={row.line.id} className={row.line.needsYou ? "tldr-line needs-you" : "tldr-line"}>
							{row.line.needsYou && <span className="tldr-badge">{t("tldrNeedsYou")}</span>}
							<span className="tldr-text">{row.line.text}</span>
							{row.line.ts > 0 && (
								<time
									className="tldr-time"
									dateTime={new Date(row.line.ts).toISOString()}
									title={new Date(row.line.ts).toLocaleString()}
								>
									{lineTime(row.line.ts)}
								</time>
							)}
							{onCollapse && (
								<button
									type="button"
									className="tldr-fold"
									title={t("tldrFoldLine")}
									aria-label={t("tldrFoldLine")}
									onClick={() => fold([row.line.id], true)}
								>
									▾
								</button>
							)}
						</li>
					),
				)}
			</ul>
			{rows.length > TLDR_COLLAPSED_LINES && (
				<button type="button" className="tldr-more" onClick={() => setShowAll((v) => !v)}>
					{showAll ? t("tldrShowFewer") : t("tldrShowAll", { n: all.length })}
				</button>
			)}
		</div>
	);
});
