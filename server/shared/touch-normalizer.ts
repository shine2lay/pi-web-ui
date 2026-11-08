// ---------------------------------------------------------------------------
// server/shared/touch-normalizer.ts — Deterministic touch string normalizer
// ---------------------------------------------------------------------------

import type { TouchKind, UiNormalizedTouch } from "../protocol.js";

export type { TouchKind, UiNormalizedTouch };

const GENERIC_REPO_RE = /^([a-z0-9][a-z0-9-]*) repo$/;
const GENERIC_FOLDER_RE = /^([a-z0-9][a-z0-9-]*) (?:contract|doc|work|proof) folder$/;

function matchesPathPrefix(norm: string, absPrefix: string, homePrefix: string): boolean {
	return (
		norm === absPrefix ||
		norm.startsWith(`${absPrefix}/`) ||
		norm.startsWith(`${absPrefix}-`) ||
		norm === homePrefix ||
		norm.startsWith(`${homePrefix}/`) ||
		norm.startsWith(`${homePrefix}-`)
	);
}

/**
 * Deterministically normalizes a single raw touch string into a canonical UiNormalizedTouch descriptor.
 * Pure function with zero I/O or model calls (AGENTS.md Rule 17).
 */
export function normalizeTouch(raw: string): UiNormalizedTouch {
	const norm = String(raw ?? "")
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase();

	if (
		norm === "pi-web-ui repo" ||
		norm === "pi-web-ui" ||
		matchesPathPrefix(norm, "/home/shinelay/projects/pi-web-ui", "~/projects/pi-web-ui")
	) {
		return { raw, appOrSystem: "pi-web-ui", repo: "pi-web-ui", kind: "repo", shareable: true };
	}
	if (norm === "pi-web-deploy" || norm === "wt deploy pi-web-ui") {
		return { raw, appOrSystem: "pi-web-ui", repo: "pi-web-ui", kind: "deploy", shareable: true };
	}

	if (
		norm === "rollcall repo" ||
		norm === "rollcall" ||
		matchesPathPrefix(norm, "/home/shinelay/rollcall", "~/rollcall")
	) {
		return { raw, appOrSystem: "rollcall", repo: "rollcall", kind: "repo", shareable: true };
	}
	if (norm === "rollcall-deploy" || norm === "wt deploy rollcall") {
		return { raw, appOrSystem: "rollcall", repo: "rollcall", kind: "deploy", shareable: true };
	}

	if (
		norm === "inkflow repo" ||
		norm === "inkflow" ||
		matchesPathPrefix(norm, "/home/shinelay/projects/inkflow", "~/projects/inkflow")
	) {
		return { raw, appOrSystem: "inkflow", repo: "inkflow", kind: "repo", shareable: true };
	}
	if (norm === "inkflow-deploy" || norm === "wt deploy inkflow") {
		return { raw, appOrSystem: "inkflow", repo: "inkflow", kind: "deploy", shareable: true };
	}

	if (
		norm === "temper-ai repo" ||
		norm === "temper repo" ||
		norm === "temper-ai" ||
		norm === "temper" ||
		matchesPathPrefix(norm, "/home/shinelay/temper-ai", "~/temper-ai")
	) {
		return { raw, appOrSystem: "temper", repo: "temper-ai", kind: "repo", shareable: true };
	}
	if (norm === "temper-deploy" || norm === "wt deploy temper-ai" || norm === "wt deploy temper") {
		return { raw, appOrSystem: "temper", repo: "temper-ai", kind: "deploy", shareable: true };
	}
	if (norm === "temper-dev") {
		return { raw, appOrSystem: "temper", repo: "temper-ai", kind: "service", shareable: false };
	}

	if (
		norm === "show-and-tell repo" ||
		norm === "showtell repo" ||
		norm === "show-and-tell" ||
		norm === "showtell" ||
		matchesPathPrefix(norm, "/home/shinelay/projects/show-and-tell", "~/projects/show-and-tell")
	) {
		return { raw, appOrSystem: "show-and-tell", repo: "show-and-tell", kind: "repo", shareable: true };
	}
	if (
		norm === "showtell-deploy" ||
		norm === "show-and-tell-deploy" ||
		norm === "wt deploy show-and-tell" ||
		norm === "wt deploy showtell"
	) {
		return { raw, appOrSystem: "show-and-tell", repo: "show-and-tell", kind: "deploy", shareable: true };
	}

	if (
		norm === "agent-tools repo" ||
		norm === "agent-tools" ||
		matchesPathPrefix(norm, "/home/shinelay/projects/agent-tools", "~/projects/agent-tools")
	) {
		return { raw, appOrSystem: "agent-tools", repo: "agent-tools", kind: "repo", shareable: true };
	}

	if (norm === "standee") {
		return { raw, appOrSystem: "standee", kind: "service", shareable: false };
	}
	if (norm === "scheduler") {
		return { raw, appOrSystem: "scheduler", kind: "service", shareable: false };
	}

	if (
		norm === "pi settings.json" ||
		norm === "pi's settings.json" ||
		norm === "settings.json" ||
		norm === "~/.pi/agent/settings.json" ||
		norm === "/home/shinelay/.pi/agent/settings.json"
	) {
		return { raw, appOrSystem: "pi-agent", kind: "config", shareable: false };
	}
	if (norm === "wt.yaml") {
		return { raw, appOrSystem: "agent-tools", kind: "config", shareable: false };
	}

	const repoMatch = GENERIC_REPO_RE.exec(norm);
	if (repoMatch) {
		const slug = repoMatch[1]!;
		return { raw, appOrSystem: slug, repo: slug, kind: "repo", shareable: true };
	}

	const folderMatch = GENERIC_FOLDER_RE.exec(norm);
	if (folderMatch) {
		const slug = folderMatch[1]!;
		return { raw, appOrSystem: slug, kind: "artifact", shareable: false };
	}

	const firstToken = norm.split(/\s+/)[0] ?? "";
	const slug =
		firstToken
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "workspace";
	return { raw, appOrSystem: slug, kind: "artifact", shareable: false };
}

/**
 * Normalizes an optional list of raw touch strings, deduplicating by normalized form while preserving first-seen order.
 */
export function normalizeTouches(raw: ReadonlyArray<string> | undefined): UiNormalizedTouch[] {
	if (!Array.isArray(raw) || raw.length === 0) return [];
	const seen = new Set<string>();
	const out: UiNormalizedTouch[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const key = item.trim().replace(/\s+/g, " ").toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(normalizeTouch(item));
	}
	return out;
}
