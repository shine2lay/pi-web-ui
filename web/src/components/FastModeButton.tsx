import { memo, useEffect, useReducer } from "react";
import type { UiFastMode } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";

/** fast-mode: is the chat at "normal speed for now" (ChatGPT refused fast mode) at this moment? */
export function fastCooling(fast: UiFastMode | null | undefined, now: number): boolean {
	return !!fast?.on && typeof fast.coolingUntil === "number" && fast.coolingUntil > now;
}

/**
 * fast-mode: the chat's "⚡ Fast" button, next to the model and thinking pickers.
 *
 * The server sends `fastMode` only for ChatGPT (openai-codex) models that have fast mode, so a
 * Claude chat, another model or a DSH chat gets nothing (null → no button). On = highlighted; at
 * "normal speed for now" (ChatGPT refused fast mode) = dimmed, with the reason in the tip. The
 * choice is saved with the chat on the server; clicking just asks for the other state.
 */
export const FastModeButton = memo(function FastModeButton({
	fast,
	disabled,
}: {
	fast: UiFastMode | null | undefined;
	disabled?: boolean;
}) {
	const t = useT();
	// Re-render when the cooldown runs out: the server sends nothing at that moment.
	const [, tick] = useReducer((n: number) => n + 1, 0);
	const until = fast?.on ? fast.coolingUntil : undefined;
	useEffect(() => {
		if (typeof until !== "number") return;
		const ms = until - Date.now();
		if (ms <= 0) return;
		const timer = setTimeout(tick, Math.min(ms + 250, 2_000_000_000));
		return () => clearTimeout(timer);
	}, [until]);
	if (!fast) return null;
	const cooling = fastCooling(fast, Date.now());
	const tip = cooling
		? `${t("fastTip")}\n${t("fastCooling", {
				reason: fast.reason || t("fastNormalForNow"),
				time: new Date(fast.coolingUntil as number).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
			})}`
		: t("fastTip");
	return (
		<button
			type="button"
			className={`chip fast-chip${fast.on ? " on" : ""}${cooling ? " cooling" : ""}`}
			aria-pressed={fast.on}
			aria-label={tip}
			data-tip={tip}
			disabled={disabled}
			onClick={() => appSend({ type: "set_fast_mode", on: !fast.on })}
		>
			<span className="fast-glyph" aria-hidden="true">
				⚡
			</span>
			<span className="chip-sub">{cooling ? t("fastNormalForNow") : t("fastChip")}</span>
		</button>
	);
});
