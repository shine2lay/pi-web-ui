/**
 * 切换对话时盖在聊天区上的状态层（switch-loading 补丁）。
 *
 *  - 打开中：转圈 + 「正在打开「标题」…」；超过几秒再加一行「大对话要多等一会儿 · 已等 N 秒」，
 *    让人知道不是卡死。可「隐藏」（遮罩消失，左栏目标行仍标着打开中）。
 *  - 失败：原因 + 「重试」/「留在这里」。留在原对话上，什么都没动。
 *
 * 遮罩盖住整个 .main（消息 + 输入框）而不只是消息列表：切换进行中往输入框打字，
 * 那条消息会落到「服务端收到它那一刻的当前对话」—— 切换若恰好先完成，就发进了新对话。
 * 盖住输入框把这个竞态从界面上消掉。
 *
 * switch-cache：切回看过的对话时底下已经显示着它的缓存（preview）。这时遮罩透明、照样挡住
 * 点击和输入（服务端还在原对话上），只在顶上留一张小卡片；快的切换连卡片都不出来（CSS 延迟淡入）。
 * 「隐藏」要等到慢了才给：看着的是目标对话，隐藏却是回到原对话。
 */
import { useEffect, useState } from "react";
import { FiAlertCircle } from "react-icons/fi";
import { useI18n, useT } from "../i18n";
import type { PendingSwitch, SwitchError } from "../switch-pending";

/** 超过这个时长开始显示「已等 N 秒」（大会话序列化通常 2–10 秒）。 */
const SLOW_AFTER_MS = 3000;

export function SwitchOverlay({
	pending,
	error,
	title,
	onHide,
	onRetry,
	onDismissError,
	preview = false,
}: {
	pending: PendingSwitch | null;
	/** switch-cache：底下显示的是目标对话的缓存。 */
	preview?: boolean;
	error: SwitchError | null;
	/** 目标对话的显示名（由 App 从会话/对话列表里解出；解不出给路径尾巴）。 */
	title: string;
	onHide: () => void;
	onRetry: () => void;
	onDismissError: () => void;
}) {
	const t = useT();
	const { locale } = useI18n();
	// 只在打开中才计时；每秒一跳，只为「已等 N 秒」那行。
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!pending || pending.hidden) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [pending]);

	if (pending && !pending.hidden) {
		const waited = Math.max(0, now - pending.startedAt);
		const slow = waited >= SLOW_AFTER_MS;
		return (
			<div
				className={preview ? "switch-overlay switch-overlay-preview" : "switch-overlay"}
				role="status"
				aria-live="polite"
				data-switch-state="loading"
				{...(preview ? { "data-switch-preview": "1" } : {})}
			>
				<div className="switch-card">
					<span className="switch-spinner" aria-hidden />
					<div className="switch-text">
						<div className="switch-title">{t("switchOpening", { title })}</div>
						{slow && <div className="switch-sub">{t("switchSlow", { s: Math.floor(waited / 1000) })}</div>}
					</div>
					{(!preview || slow) && (
						<button type="button" className="btn switch-hide" onClick={onHide}>
							{t("switchHide")}
						</button>
					)}
				</div>
			</div>
		);
	}

	if (error) {
		const reason = locale !== "zh" && error.errorEn ? error.errorEn : error.error;
		return (
			<div className="switch-overlay" role="alert" data-switch-state="error">
				<div className="switch-card switch-card-error">
					<FiAlertCircle className="switch-error-icon" aria-hidden />
					<div className="switch-text">
						<div className="switch-title">{t("switchFailedTitle", { title })}</div>
						<div className="switch-reason">{reason}</div>
					</div>
					<div className="switch-actions">
						<button type="button" className="btn" onClick={onDismissError}>
							{t("switchStay")}
						</button>
						<button type="button" className="btn primary" onClick={onRetry}>
							{t("retryNow")}
						</button>
					</div>
				</div>
			</div>
		);
	}

	return null;
}
