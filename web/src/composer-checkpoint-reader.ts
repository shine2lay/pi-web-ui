import { inspectComposerCheckpoints } from "./composer-checkpoint";
import type { ComposerCheckpointInspection, ComposerCheckpointStorage } from "./composer-checkpoint";

/** Independent look-only entry. No App, SDK, socket, replay or reference resolver. */
export function readComposerCheckpointRecovery(storage: ComposerCheckpointStorage): ComposerCheckpointInspection {
	return inspectComposerCheckpoints(storage);
}

/** Complete raw originals are included, even for unknown, corrupt and retired entries. */
export function exportComposerCheckpointRecovery(inspection: ComposerCheckpointInspection): string {
	return JSON.stringify({ kind: "pi-web-ui/composer-checkpoint-export", version: 1, inspection }, null, 2);
}

export interface ComposerCheckpointReaderOptions {
	/** Invoked only after the explicit read button. Access can throw, e.g. blocked storage. */
	getStorage: () => ComposerCheckpointStorage;
}

export function mountComposerCheckpointReader(root: HTMLElement, options: ComposerCheckpointReaderOptions): () => void {
	const document = root.ownerDocument;
	const readButton = document.createElement("button");
	readButton.type = "button";
	readButton.textContent = "Read this origin's checkpoints";
	readButton.dataset.action = "read";
	const exportButton = document.createElement("button");
	exportButton.type = "button";
	exportButton.textContent = "Export complete inspection JSON";
	exportButton.dataset.action = "export";
	exportButton.disabled = true;
	const status = document.createElement("p");
	status.setAttribute("role", "status");
	status.textContent = "Not read. No storage is accessed until you choose Read.";
	const records = document.createElement("section");
	records.setAttribute("aria-label", "Complete checkpoint originals");
	root.replaceChildren(readButton, exportButton, status, records);
	let inspection: ComposerCheckpointInspection | undefined;

	const read = () => {
		try {
			inspection = readComposerCheckpointRecovery(options.getStorage());
		} catch {
			inspection = { ok: false, entries: [], errors: ["This origin's checkpoint storage is unavailable"] };
		}
		records.replaceChildren();
		status.textContent = `${inspection.entries.length} stored entries. ${inspection.ok ? "Inspection complete." : "Inspection incomplete: " + inspection.errors.join("; ")}`;
		for (const entry of inspection.entries) {
			const article = document.createElement("article");
			const heading = document.createElement("h2");
			heading.textContent = `${entry.status}: ${entry.key}`;
			const warning = document.createElement("p");
			warning.textContent =
				"References are opaque metadata, not recovered target bytes or access grants. Retired does not mean sent/consumed.";
			const pre = document.createElement("pre");
			pre.textContent = JSON.stringify(entry, null, 2);
			article.append(heading, warning, pre);
			records.append(article);
		}
		exportButton.disabled = false;
	};
	const download = () => {
		if (!inspection) return;
		const url = URL.createObjectURL(
			new Blob([exportComposerCheckpointRecovery(inspection)], { type: "application/json;charset=utf-8" }),
		);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = "composer-checkpoint-inspection.json";
		anchor.click();
		URL.revokeObjectURL(url);
	};
	readButton.addEventListener("click", read);
	exportButton.addEventListener("click", download);
	return () => {
		readButton.removeEventListener("click", read);
		exportButton.removeEventListener("click", download);
		root.replaceChildren();
	};
}

// This is the standalone HTML entry only, not a host installation or automatic recovery.
if (typeof document !== "undefined") {
	const root = document.querySelector<HTMLElement>("[data-composer-checkpoint-reader]");
	if (root) mountComposerCheckpointReader(root, { getStorage: () => window.localStorage });
}
