/**
 * Thinking for all chats, pi's settings side: move one thinking level to another in pi's global
 * settings file (once, under the SDK's own lock) and in each live SettingsManager's in-memory
 * copy, so a chat's next model or account switch can't bring the old level back from a stale map.
 * Only `defaultThinkingLevel` and `modelThinkingLevels` entries equal to `from` change; every
 * other setting and every other level stays as it is. No public SDK setter does this: each one
 * writes the file, and setModelThinkingLevel writes a chat's whole (possibly stale) map.
 */
import { SettingsManager } from "@earendil-works/pi-coding-agent";

type SettingsScope = "global" | "project";
interface LevelSettings {
	defaultThinkingLevel?: unknown;
	modelThinkingLevels?: Record<string, unknown>;
}
/** The SDK 1.0.1 SettingsManager fields this relies on (private there, checked here). */
interface ManagerInternals {
	storage: { withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void };
	globalSettings: LevelSettings;
	projectSettings: LevelSettings;
	settings: LevelSettings;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

function internals(manager: unknown): ManagerInternals {
	const m = manager as Partial<ManagerInternals> | null;
	if (
		!m ||
		typeof m.storage?.withLock !== "function" ||
		!isRecord(m.globalSettings) ||
		!isRecord(m.projectSettings) ||
		!isRecord(m.settings)
	)
		throw new Error(
			"pi SDK SettingsManager changed shape (storage, globalSettings, projectSettings, settings); update server/thinking-level-settings.ts",
		);
	return m as ManagerInternals;
}

/** Keys holding `from` ("defaultThinkingLevel", "modelThinkingLevels.<provider/id>"); with
 * `apply`, set them to `to`. `keep` names keys another layer owns (left alone). */
function moveLevels(
	settings: LevelSettings,
	from: string,
	to: string,
	apply: boolean,
	keep: (key: string) => boolean = () => false,
): string[] {
	const moved: string[] = [];
	if (settings.defaultThinkingLevel === from && !keep("defaultThinkingLevel")) {
		moved.push("defaultThinkingLevel");
		if (apply) settings.defaultThinkingLevel = to;
	}
	const levels = settings.modelThinkingLevels;
	if (isRecord(levels)) {
		for (const [modelKey, level] of Object.entries(levels)) {
			const key = `modelThinkingLevels.${modelKey}`;
			if (level !== from || keep(key)) continue;
			moved.push(key);
			if (apply) levels[modelKey] = to;
		}
	}
	return moved;
}

const definesKey = (settings: LevelSettings) => (key: string) =>
	key === "defaultThinkingLevel"
		? settings.defaultThinkingLevel !== undefined
		: isRecord(settings.modelThinkingLevels) &&
			settings.modelThinkingLevels[key.slice("modelThinkingLevels.".length)] !== undefined;

/** pi's global settings file: one read-modify-write under the SDK's lock, written only when an
 * entry changes (and never on a dry run). Returns the entries that hold (or held) `from`. */
export function moveThinkingInSettingsFile(manager: SettingsManager, from: string, to: string, apply = true): string[] {
	let moved: string[] = [];
	internals(manager).storage.withLock("global", (current) => {
		if (current === undefined) return undefined;
		const bom = current.startsWith("\uFEFF");
		let parsed: unknown;
		try {
			parsed = JSON.parse(bom ? current.slice(1) : current);
		} catch (err) {
			throw new Error(`pi's settings.json is not valid JSON, nothing changed: ${(err as Error).message}`);
		}
		if (!isRecord(parsed)) throw new Error("pi's settings.json is not a JSON object, nothing changed");
		moved = moveLevels(parsed, from, to, apply);
		if (!apply || moved.length === 0) return undefined;
		return (bom ? "\uFEFF" : "") + JSON.stringify(parsed, null, 2) + (current.endsWith("\n") ? "\n" : "");
	});
	return moved;
}

/** A live chat's SettingsManager, in memory only (no write). The effective view moves too, except
 * where the chat's project settings set that key themselves. Non-SDK stand-ins (mock sessions)
 * have no such copy and are left alone. */
export function moveThinkingInMemory(manager: unknown, from: string, to: string, apply = true): string[] {
	const sdkShaped =
		manager instanceof SettingsManager || (isRecord(manager) && "globalSettings" in manager && "settings" in manager);
	if (!sdkShaped) return [];
	const m = internals(manager);
	const moved = new Set(moveLevels(m.globalSettings, from, to, apply));
	for (const key of moveLevels(m.settings, from, to, apply, definesKey(m.projectSettings))) moved.add(key);
	return [...moved];
}
