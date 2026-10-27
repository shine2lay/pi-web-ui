import { memo, useRef, useState } from "react";
import { composerRecovery } from "../recovery-composer";
import type { ComposerCheckpointInspection, ComposerCheckpointInspectionEntry } from "../composer-checkpoint";

/** Explicit local inspection/restoration only. No startup replay, deletion, or sending.
 * The independent retained reader is still required when this bundle is unavailable. */
export const ComposerRecoveryPanel = memo(function ComposerRecoveryPanel() {
	const [inspection, setInspection] = useState<ComposerCheckpointInspection | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const restoring = useRef(false);
	const refresh = () => {
		try {
			setInspection(composerRecovery().inspect());
		} catch {
			setMessage(
				"Composer recovery storage is unavailable. Keep all originals and use the retained reader when storage is accessible.",
			);
		}
	};
	const restore = (entry: ComposerCheckpointInspectionEntry) => {
		if (restoring.current || !entry.record || entry.status !== "active") return;
		restoring.current = true;
		try {
			const api = composerRecovery();
			setMessage(
				api.restore(entry.record) === true
					? "Restored to the original session's editable composer. Nothing was sent; saved originals were retained."
					: (api.problem ?? "Draft not restored. The complete original remains saved."),
			);
		} finally {
			restoring.current = false;
		}
	};
	const exportRaw = () => {
		try {
			const value = composerRecovery().inspect();
			const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: "application/json;charset=utf-8" }));
			const link = document.createElement("a");
			link.href = url;
			link.download = "pi-web-composer-recovery.json";
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 0);
			setMessage("Exported complete raw records. No original was deleted or retired.");
		} catch {
			setMessage("Export failed. Saved originals were not changed.");
		}
	};
	return (
		<details
			className="composer-recovery"
			onToggle={(event) => {
				if (event.currentTarget.open) refresh();
			}}
			style={{ padding: "4px 12px" }}
		>
			<summary>Composer draft recovery</summary>
			<section aria-label="Composer draft recovery" style={{ maxHeight: "32vh", overflow: "auto" }}>
				<p>
					Injected drafts only. Restore is an explicit local edit, not a send, approval, or replay. Open the original
					session first.
				</p>
				<button type="button" onClick={refresh}>
					Refresh saved composer drafts
				</button>
				<button type="button" onClick={exportRaw}>
					Export complete composer originals
				</button>
				{inspection?.errors.map((error, index) => (
					<p key={index} role="status">
						{error}
					</p>
				))}
				<ol>
					{inspection?.entries.map((entry) => (
						<li key={entry.key} data-composer-record={entry.record?.recordId}>
							<code>{entry.record?.recordId ?? entry.key}</code> — {entry.status}
							{entry.record && (
								<>
									<p>Session: {entry.record.binding.sessionId}</p>
									<pre style={{ maxHeight: "10em", overflow: "auto", whiteSpace: "pre-wrap" }}>
										{entry.record.effective.text}
									</pre>
									<p>{entry.record.effective.attachments.map((attachment) => attachment.name).join(", ")}</p>
									{entry.status === "active" && (
										<button type="button" onClick={() => restore(entry)}>
											Restore this composer draft
										</button>
									)}
								</>
							)}
						</li>
					))}
				</ol>
				{message && <p role="status">{message}</p>}
			</section>
		</details>
	);
});
