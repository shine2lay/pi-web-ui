import { memo, useRef, useState } from "react";
import { useT } from "../i18n";
import type { RecoveryView } from "../recovery-client";

/** A retained original is not proof of execution, persistence, or permission to replay.
 * Export is read-only; never remove a last copy merely because it was downloaded. */
export const PendingRecoveryPanel = memo(function PendingRecoveryPanel({
	view,
	exportArtifact,
}: {
	view: RecoveryView;
	exportArtifact: () => Promise<string>;
}) {
	const t = useT();
	const exporting = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (view.state === "starting" || (!view.items.length && !view.issues.length && !view.problem)) return null;
	const download = async () => {
		if (exporting.current) return;
		exporting.current = true;
		setBusy(true);
		setError(null);
		try {
			const artifact = await exportArtifact();
			const url = URL.createObjectURL(new Blob([artifact], { type: "application/json;charset=utf-8" }));
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "pi-web-pending-recovery.json";
			anchor.click();
			// A later task releases only the temporary URL, never the source records.
			setTimeout(() => URL.revokeObjectURL(url), 0);
		} catch {
			setError(t("recoveryExportFailed"));
		} finally {
			exporting.current = false;
			setBusy(false);
		}
	};
	return (
		<details className="pending-recovery" style={{ borderTop: "1px solid var(--border)", padding: "6px 12px" }}>
			<summary>{t("savedRecovery", { n: view.items.length })}</summary>
			<div role="region" aria-label={t("savedRecoveryRegion")} style={{ maxHeight: "32vh", overflow: "auto" }}>
				<p>{t("savedRecoveryExplanation")}</p>
				{view.problem && <p role="status">{view.problem}</p>}
				{view.issues.map((issue, i) => (
					<p key={i}>{issue}</p>
				))}
				<ol>
					{view.items.map((item) => (
						<li
							key={JSON.stringify([item.prepared.kind, item.prepared.sessionId, item.prepared.id])}
							data-recovery-id={item.prepared.id}
							data-recovery-complete={item.complete}
						>
							<code>{item.prepared.id}</code>
							{" — "}
							{item.prepared.kind}
							{" / "}
							{item.delivery}
							{!item.complete && (
								<span>
									{" — "}
									{t("savedRecoveryIncomplete")}
								</span>
							)}
						</li>
					))}
				</ol>
				<button type="button" onClick={() => void download()} disabled={busy}>
					{t("exportSavedRecovery")}
				</button>
				{error && <p role="alert">{error}</p>}
			</div>
		</details>
	);
});
