/** Compact queue/task controls. The server validates again against the real SDK at dispatch. */
import type { UiModelInfo, UiProfilePatch, UiTaskLaunch, UiTaskProfile } from "../types";
import { useT } from "../i18n";

export function effectiveProfile(
	defaults?: UiTaskProfile,
	own?: UiTaskProfile,
	inherited?: UiTaskProfile,
	models: UiModelInfo[] = [],
): UiTaskLaunch {
	const from: UiTaskLaunch["from"] = {
		model: own?.model !== undefined ? "task" : defaults?.model !== undefined ? "queue" : "app",
		thinking: own?.thinking !== undefined ? "task" : defaults?.thinking !== undefined ? "queue" : "app",
		speed: own?.speed !== undefined ? "task" : defaults?.speed !== undefined ? "queue" : "app",
	};
	const model = own?.model ?? defaults?.model ?? inherited?.model;
	const info = models.find((m) => m.id === model);
	return {
		model,
		thinking:
			own?.thinking ??
			defaults?.thinking ??
			(model !== inherited?.model ? info?.thinkingDefault : inherited?.thinking) ??
			info?.thinkingDefault,
		speed: own?.speed ?? defaults?.speed ?? "standard",
		from,
	};
}

export function ProfileSummary({
	launch,
	models = [],
	title,
}: {
	launch: UiTaskLaunch;
	models?: UiModelInfo[];
	title?: string;
}) {
	const t = useT();
	const info = models.find((m) => m.id === launch.model);
	const sources = { task: t("queueProfileTask"), queue: t("queueProfileQueue"), app: t("queueProfileApp") };
	return (
		<div className="queue-profile-summary">
			{title && <h5>{title}</h5>}
			{(["model", "thinking", "speed"] as const).map((field) => {
				const value =
					field === "model"
						? (info?.name ?? launch.model ?? t("queueProfileApp"))
						: field === "speed"
							? t(
									launch.speed === "ultrafast"
										? "speedUltrafast"
										: launch.speed === "fast"
											? "fastChip"
											: "speedStandard",
								)
							: (launch.thinking ?? t("queueProfileApp"));
				return (
					<div
						key={field}
						data-profile-field={field}
						data-source={launch.from[field]}
						title={field === "model" ? launch.model : undefined}
					>
						<span>
							{t(
								field === "model"
									? "queueProfileModel"
									: field === "thinking"
										? "queueProfileThinking"
										: "queueProfileSpeed",
							)}
						</span>
						<strong>{value}</strong>
						<small>{sources[launch.from[field]]}</small>
					</div>
				);
			})}
		</div>
	);
}

export function ProfileEditor({
	profile,
	effective,
	models,
	disabled,
	onChange,
	label,
}: {
	profile?: UiTaskProfile;
	effective: UiTaskLaunch;
	models: UiModelInfo[];
	disabled?: boolean;
	onChange: (patch: UiProfilePatch) => void;
	label: string;
}) {
	const t = useT();
	const info = models.find((m) => m.id === effective.model);
	const levels = info?.thinkingLevels ?? [];
	const speeds = info?.speeds ?? ["standard"];
	const unavailable = !!profile?.model && !models.some((m) => m.id === profile.model);
	const invalidThinking = profile?.thinking !== undefined && !levels.includes(profile.thinking);
	const invalidSpeed = profile?.speed !== undefined && !speeds.includes(profile.speed);
	return (
		<fieldset className="queue-profile-editor" disabled={disabled} aria-label={label}>
			<label>
				<span>{t("queueProfileModel")}</span>
				<select
					aria-label={`${label} ${t("queueProfileModel")}`}
					value={profile?.model ?? ""}
					onChange={(e) => onChange({ model: e.target.value || null })}
				>
					<option value="">{t("queueProfileInherit")}</option>
					{unavailable && (
						<option value={profile?.model}>
							{profile?.model} — {t("queueProfileUnavailable")}
						</option>
					)}
					{models.map((m) => (
						<option key={m.id} value={m.id}>
							{m.name} · {m.provider}
						</option>
					))}
				</select>
			</label>
			<label>
				<span>{t("queueProfileThinking")}</span>
				<select
					aria-label={`${label} ${t("queueProfileThinking")}`}
					value={profile?.thinking ?? ""}
					onChange={(e) => onChange({ thinking: e.target.value || null })}
				>
					<option value="">{t("queueProfileInherit")}</option>
					{invalidThinking && (
						<option value={profile?.thinking}>
							{profile?.thinking} — {t("queueProfileUnsupported")}
						</option>
					)}
					{levels.map((l) => (
						<option key={l} value={l}>
							{l}
						</option>
					))}
				</select>
			</label>
			<label>
				<span>{t("queueProfileSpeed")}</span>
				<select
					aria-label={`${label} ${t("queueProfileSpeed")}`}
					value={profile?.speed ?? ""}
					onChange={(e) => onChange({ speed: (e.target.value || null) as UiProfilePatch["speed"] })}
				>
					<option value="">{t("queueProfileInherit")}</option>
					{invalidSpeed && (
						<option value={profile?.speed}>
							{profile?.speed} — {t("queueProfileUnsupported")}
						</option>
					)}
					{speeds.map((s) => (
						<option key={s} value={s}>
							{t(s === "ultrafast" ? "speedUltrafast" : s === "fast" ? "fastChip" : "speedStandard")}
						</option>
					))}
				</select>
			</label>
			{(unavailable || invalidThinking || invalidSpeed) && <p role="alert">{t("queueProfileInvalid")}</p>}
		</fieldset>
	);
}
