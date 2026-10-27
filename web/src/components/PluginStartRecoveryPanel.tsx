import { memo, useState } from "react";
import type { PluginStartOption } from "../plugin-start-checkpoint";
import type { PluginStartRecoveryView } from "../use-plugin-start-recovery";

function formatOption<T>(opt: PluginStartOption<T>): string {
	if (opt.presence !== "value") return opt.presence;
	return JSON.stringify(opt.value);
}

/** Read-only inspection and explicit local composer restoration for #584 startChat checkpoints.
 * Never auto-replays startChat, never sends a prompt, and never retires or deletes stored records. */
export const PluginStartRecoveryPanel = memo(function PluginStartRecoveryPanel({
	view,
	onRefresh,
	onExport,
	onRestorePrompt,
}: {
	view: PluginStartRecoveryView;
	onRefresh: () => void;
	onExport: () => string;
	onRestorePrompt: (prompt: string) => boolean;
}) {
	const [status, setStatus] = useState<string | null>(null);
	const hasContent =
		view.entries.length > 0 || view.rawIssues.length > 0 || view.runtimeIssues.length > 0 || Boolean(view.openFailure);
	if (!hasContent) return null;

	const handleExport = () => {
		try {
			const serialized = onExport();
			const url = URL.createObjectURL(new Blob([serialized], { type: "application/json;charset=utf-8" }));
			const link = document.createElement("a");
			link.href = url;
			link.download = "pi-web-plugin-start-recovery.json";
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 0);
			setStatus("Exported complete plugin startChat checkpoints. Stored originals were retained.");
		} catch {
			setStatus("Export failed. Stored originals were not modified.");
		}
	};

	const handleRestore = (prompt: string) => {
		try {
			const ok = onRestorePrompt(prompt);
			setStatus(
				ok
					? "Restored exact untrimmed prompt to the active composer draft. Nothing was sent; checkpoint retained."
					: "Composer already has different text or is unavailable. Stored checkpoint remains intact.",
			);
		} catch {
			setStatus("Restore failed. Stored checkpoint remains intact.");
		}
	};

	return (
		<details
			className="plugin-start-recovery"
			data-testid="plugin-start-recovery-panel"
			style={{ borderTop: "1px solid var(--border)", padding: "6px 12px" }}
		>
			<summary>Plugin startChat recovery ({view.entries.length})</summary>
			<section aria-label="Plugin startChat recovery" style={{ maxHeight: "32vh", overflow: "auto" }}>
				<p>
					Saved plugin startChat checkpoints. Reload never auto-replays a startChat sequence. Restore copies the exact
					original prompt into the composer without sending or deleting the checkpoint.
				</p>
				<div style={{ display: "flex", gap: "8px", marginBottom: "6px" }}>
					<button type="button" data-testid="plugin-start-refresh" onClick={onRefresh}>
						Refresh plugin start checkpoints
					</button>
					<button type="button" data-testid="plugin-start-export" onClick={handleExport}>
						Export plugin start checkpoints
					</button>
				</div>
				{view.openFailure && (
					<p role="alert" data-testid="plugin-start-open-failure">
						{view.openFailure.code}
					</p>
				)}
				{view.rawIssues.map((issue, idx) => (
					<p key={`raw-${idx}`} role="status" data-testid="plugin-start-raw-issue">
						{issue}
					</p>
				))}
				{view.runtimeIssues.map((issue, idx) => (
					<p key={`runtime-${idx}`} role="status" data-testid="plugin-start-runtime-issue">
						{issue.code}
					</p>
				))}
				<ol>
					{view.entries.map((entry) => (
						<li
							key={entry.key}
							data-testid="plugin-start-recovery-entry"
							data-plugin-start-key={entry.key}
							data-plugin-start-intent={entry.intent?.intentId ?? ""}
							data-plugin-start-state={entry.state ?? entry.kind}
							data-plugin-start-effects={String(entry.possibleEffects ?? false)}
						>
							<code>{entry.intent?.intentId ?? entry.key}</code> — {entry.state ?? entry.kind}
							{entry.possibleEffects ? " (possible prior effects)" : " (no begin marker)"}
							{entry.issue && <p role="status">{entry.issue}</p>}
							{entry.intent && (
								<>
									<p data-testid="plugin-start-recovery-meta">
										Plugin: {entry.intent.source.pluginId ?? "(host)"} · Session: {entry.intent.source.sessionId} ·
										Conversation: {entry.intent.source.conversationId} · newChat:{" "}
										{formatOption(entry.intent.original.newChat)} · cwd: {formatOption(entry.intent.original.cwd)} ·
										model: {formatOption(entry.intent.original.model)}
									</p>
									<pre
										data-testid="plugin-start-recovery-prompt"
										style={{ maxHeight: "10em", overflow: "auto", whiteSpace: "pre-wrap" }}
									>
										{entry.intent.original.prompt}
									</pre>
									<button
										type="button"
										data-testid="plugin-start-restore"
										onClick={() => handleRestore(entry.intent!.original.prompt)}
									>
										Restore prompt to composer
									</button>
								</>
							)}
						</li>
					))}
				</ol>
				{status && (
					<p role="status" data-testid="plugin-start-recovery-status">
						{status}
					</p>
				)}
			</section>
		</details>
	);
});
