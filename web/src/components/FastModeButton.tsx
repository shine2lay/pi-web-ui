import { memo, useEffect, useId, useReducer, useRef, useState } from "react";
import type { ChatSpeed, UiFastMode } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";

export function fastCooling(fast: UiFastMode | null | undefined, now: number): boolean {
	return fast?.mode !== "standard" && typeof fast?.coolingUntil === "number" && fast.coolingUntil > now;
}

/** One compact, keyboard/touch-accessible selector; eligibility is not inferred from the model. */
export const FastModeButton = memo(function FastModeButton({
	fast,
	disabled,
	conversationId,
}: {
	fast: UiFastMode | null | undefined;
	disabled?: boolean;
	conversationId?: string;
}) {
	const t = useT();
	const id = useId();
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const [, tick] = useReducer((n: number) => n + 1, 0);
	const until = fast?.coolingUntil;
	useEffect(() => {
		if (typeof until !== "number" || until <= Date.now()) return;
		const timer = setTimeout(tick, Math.min(until - Date.now() + 250, 2_000_000_000));
		return () => clearTimeout(timer);
	}, [until]);
	useEffect(() => {
		setOpen(false);
	}, [conversationId, disabled, fast?.ultrafastAvailable]);
	useEffect(() => {
		if (!open) return;
		root.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
		const outside = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [open]);
	if (!fast) return null;
	const blocked = disabled || !conversationId;
	const cooling = fastCooling(fast, Date.now());
	const supported = fast.mode !== "ultrafast" || fast.ultrafastAvailable;
	const expired = typeof until === "number" && until <= Date.now() && !disabled;
	const effective = expired && supported ? fast.mode : fast.effective;
	const temporary = effective === "standard" && fast.mode !== "standard";
	const label = (mode: ChatSpeed) =>
		t(mode === "standard" ? "speedStandard" : mode === "fast" ? "fastChip" : "speedUltrafast");
	const reason = cooling
		? `${fast.reason ?? t("speedUnavailable")}. ${t("speedRetryAt", { time: new Date(until!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) })}`
		: supported
			? ""
			: fast.reason;
	// This is the selected request setting, not a claim about the provider's returned tier.
	const tip = `${label(effective)}${temporary ? ` — ${t("speedTemporary")}: ${reason}` : ""}`;
	return (
		<div
			className="speed-control"
			ref={root}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					setOpen(false);
					trigger.current?.focus();
					e.stopPropagation();
				}
			}}
		>
			<button
				ref={trigger}
				type="button"
				className={`chip fast-chip${effective !== "standard" ? " on" : ""}${temporary ? " cooling" : ""}`}
				aria-label={`${t("fastMode")}: ${tip}`}
				aria-expanded={open}
				aria-controls={`${id}-panel`}
				aria-haspopup="dialog"
				title={tip}
				disabled={blocked}
				onClick={() => setOpen(!open)}
			>
				<span className="fast-glyph" aria-hidden="true">
					⚡
				</span>
				<span className="fast-label">
					{label(effective)}
					{temporary ? " · now" : ""}
				</span>
			</button>
			{open && (
				<div id={`${id}-panel`} className="speed-menu" role="dialog" aria-label={t("fastMode")}>
					<fieldset disabled={blocked}>
						<legend>{t("speedThisChat")}</legend>
						<div className="speed-options">
							{(["standard", "fast", ...(fast.ultrafastAvailable ? ["ultrafast"] : [])] as ChatSpeed[]).map((mode) => (
								<label key={mode}>
									<input
										type="radio"
										name={id}
										value={mode}
										checked={(supported ? fast.mode : "standard") === mode}
										onChange={() => {
											if (!blocked) appSend({ type: "set_fast_mode", mode, conversationId: conversationId! });
										}}
									/>
									{label(mode)}
								</label>
							))}
						</div>
					</fieldset>
					{temporary && (
						<p className="speed-status" role="status">
							{t("speedTemporary")}: {reason}
						</p>
					)}
				</div>
			)}
		</div>
	);
});
