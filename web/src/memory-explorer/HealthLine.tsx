/** The health line: is memory up, when it last saved, how many notes it keeps, when this was checked. */

import type { MemoryHealth } from "./explorer-api.js";
import { ago, clock, countWords } from "./explorer-text.js";
import type { Load } from "./use-load.js";

export function HealthLine({ health, nowMs, onRetry }: { health: Load<MemoryHealth>; nowMs: number; onRetry(): void }) {
	if (health.status === "loading" && !health.data) {
		return (
			<p className="mx-health" data-tone="wait" role="status">
				<span className="mx-dot" aria-hidden="true" />
				<b>Checking memory…</b>
			</p>
		);
	}
	if (health.status === "failed" && health.code === "OWNER_ONLY") {
		return (
			<p className="mx-health" data-tone="wait" role="status">
				<span className="mx-dot" aria-hidden="true" />
				<b>Signed out</b>
				<span>memory opens with your passkey</span>
			</p>
		);
	}
	const h = health.data;
	if (health.status === "failed" || !h || h.state === "down") {
		const seen = h?.lastSeenUpAt ?? (h?.state !== "down" ? h?.checkedAt : null);
		const age = seen ? ` · last seen ${Math.max(0, Math.floor((nowMs - Date.parse(seen)) / 60_000))} min ago` : "";
		return (
			<p className="mx-health" data-tone="down" role="status">
				<span className="mx-dot" aria-hidden="true" />
				<b>Memory isn't answering{age}</b>
				<button type="button" className="mx-btn" onClick={onRetry}>
					Try again
				</button>
			</p>
		);
	}
	const parts = [
		`last save ${ago(h.lastSaveAt, nowMs)}`,
		h.totalNotes == null ? null : countWords(h.totalNotes, "note", "notes"),
		`checked ${clock(h.checkedAt)}`,
	].filter(Boolean);
	return (
		<p className="mx-health" data-tone={h.state === "degraded" ? "warn" : "ok"} role="status">
			<span className="mx-dot" aria-hidden="true" />
			<b>Memory is up</b>
			<span>
				{parts.join(" · ")}
				{h.state === "degraded" ? " · some places couldn't be read" : ""}
			</span>
		</p>
	);
}

/** Editing and deleting need memory to answer. */
export function memoryAnswers(health: Load<MemoryHealth>): boolean {
	return health.status === "ready" && health.data.state !== "down";
}
