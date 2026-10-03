/** queue-task-profiles: pure contract mirrored by pi-queue/queue.ts. No global settings writes. */
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { speedSupported } from "./fast-mode.js";
import type { UiTaskProfile, UiProfilePatch, UiTaskLaunch, ChatSpeed } from "./protocol.js";

export const PROFILE_FIELDS = ["model", "thinking", "speed"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export function normModel(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const m = raw.trim();
	return /^[^\s/]+\/\S+$/.test(m) && m.length <= 200 ? m : undefined;
}
export function checkPatch(raw: unknown): { patch: UiProfilePatch; problems: string[] } {
	const patch: UiProfilePatch = {};
	const problems: string[] = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { patch, problems: ["Profile must be an object"] };
	const p = raw as Record<string, unknown>;
	if (p.model !== undefined) {
		if (p.model === null) patch.model = null;
		else if (normModel(p.model)) patch.model = normModel(p.model);
		else problems.push("Model must be an exact provider/id");
	}
	if (p.thinking !== undefined) {
		if (p.thinking === null) patch.thinking = null;
		else if (THINKING_LEVELS.includes(p.thinking as (typeof THINKING_LEVELS)[number]))
			patch.thinking = p.thinking as string;
		else problems.push("Unknown thinking level");
	}
	if (p.speed !== undefined) {
		if (p.speed === null) patch.speed = null;
		else if (p.speed === "standard" || p.speed === "fast" || p.speed === "ultrafast") patch.speed = p.speed;
		else problems.push("Unknown speed");
	}
	return { patch, problems };
}
export function normProfile(raw: unknown): UiTaskProfile | undefined {
	const { patch } = checkPatch(raw);
	return patchProfile(undefined, patch);
}
export function patchProfile(base: UiTaskProfile | undefined, patch: UiProfilePatch): UiTaskProfile | undefined {
	const out: UiTaskProfile = { ...base };
	if (patch.model === null) delete out.model;
	else if (patch.model !== undefined) out.model = patch.model;
	if (patch.thinking === null) delete out.thinking;
	else if (patch.thinking !== undefined) out.thinking = patch.thinking;
	if (patch.speed === null) delete out.speed;
	else if (patch.speed !== undefined) out.speed = patch.speed;
	return Object.keys(out).length ? out : undefined;
}
export function normLaunch(raw: unknown): UiTaskLaunch | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const l = raw as Partial<UiTaskLaunch>;
	if (!l.from || typeof l.from !== "object") return undefined;
	const from: UiTaskLaunch["from"] = { model: "app", thinking: "app", speed: "app" };
	for (const f of PROFILE_FIELDS) if (l.from[f] === "task" || l.from[f] === "queue") from[f] = l.from[f];
	return { ...normProfile(l), from };
}
export function resolveLaunch(
	defaults?: UiTaskProfile,
	override?: UiTaskProfile,
	app: UiTaskProfile = {},
): UiTaskLaunch {
	const out: UiTaskLaunch = { from: { model: "app", thinking: "app", speed: "app" } };
	for (const f of PROFILE_FIELDS) {
		const src = override?.[f] !== undefined ? "task" : defaults?.[f] !== undefined ? "queue" : "app";
		out.from[f] = src;
		const value = (src === "task" ? override : src === "queue" ? defaults : app)?.[f];
		if (value !== undefined) Object.assign(out, { [f]: value });
	}
	return out;
}
export class QueueLaunchRefused extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "QueueLaunchRefused";
	}
}
/** The exact SDK/catalog helpers used by the chat controls. Standard works on every model. */
export function profileChoices(model: Model<Api>) {
	return {
		thinkingLevels: getSupportedThinkingLevels(model),
		speeds: (["standard", "fast", "ultrafast"] as ChatSpeed[]).filter(
			(s) => s === "standard" || speedSupported(model, s),
		),
	};
}
export function defaultThinking(model: Model<Api>, requested = "medium"): string {
	const levels = getSupportedThinkingLevels(model);
	return levels.includes(requested as (typeof levels)[number])
		? requested
		: clampThinkingLevel(model, requested as (typeof levels)[number]);
}
/** Validate before calling SDK setters, which can otherwise silently clamp thinking. */
export function validateProfile(profile: UiTaskProfile, model: Model<Api> | undefined): void {
	if (!model) throw new QueueLaunchRefused("No available model for this task");
	if (
		profile.thinking !== undefined &&
		!getSupportedThinkingLevels(model).includes(
			profile.thinking as ReturnType<typeof getSupportedThinkingLevels>[number],
		)
	) {
		throw new QueueLaunchRefused(`${model.provider}/${model.id} does not support thinking ${profile.thinking}`);
	}
	if (profile.speed && profile.speed !== "standard" && !speedSupported(model, profile.speed)) {
		throw new QueueLaunchRefused(`${model.provider}/${model.id} does not support ${profile.speed} speed`);
	}
}
/** Install on the child only, then durably record BEFORE its first prompt. Never used on resume. */
export async function prepareLaunch(
	request: UiTaskLaunch,
	child: {
		selectModel: (id: string | undefined, strict: boolean) => Promise<void>;
		model: () => Model<Api> | undefined;
		thinking: () => string;
		preferredThinking?: () => string;
		setThinking: (level: string) => void;
		speed: () => ChatSpeed;
		setSpeed: (speed: ChatSpeed) => void;
		record: (launch: UiTaskLaunch) => void;
	},
): Promise<UiTaskLaunch> {
	await child.selectModel(request.model, request.from.model !== "app");
	if (request.from.model !== "app" && request.model !== `${child.model()?.provider}/${child.model()?.id}`) {
		throw new QueueLaunchRefused("Configured model could not be applied");
	}
	const strict: UiTaskProfile = {
		...(request.from.thinking !== "app" ? { thinking: request.thinking } : {}),
		speed: request.speed ?? "standard",
	};
	validateProfile(strict, child.model());
	const thinking = request.thinking ?? child.preferredThinking?.();
	if (thinking !== undefined) {
		child.setThinking(thinking);
		if (request.from.thinking !== "app" && child.thinking() !== request.thinking)
			throw new QueueLaunchRefused("Thinking level could not be applied");
	}
	child.setSpeed(request.speed ?? "standard");
	if (child.speed() !== (request.speed ?? "standard"))
		throw new QueueLaunchRefused("Configured speed could not be applied");
	const model = child.model();
	const resolved: UiTaskLaunch = {
		...request,
		model: model ? `${model.provider}/${model.id}` : undefined,
		thinking: child.thinking(),
		speed: request.speed ?? "standard",
	};
	child.record(resolved);
	return resolved;
}
