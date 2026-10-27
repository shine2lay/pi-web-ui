import {
	createBoardDraftIndexedDB,
	encodeBoardDraftRecord,
	encodeBoardDraftSource,
	inspectBoardDrafts,
	type BoardDraftRow,
	type BoardDraftStorage,
} from "./board-draft-store";

/** Raw UNKNOWN rows are never fed to the source codec or editor. A tagged graph
 * preserves IndexedDB values that plain JSON would erase (undefined, NaN, cycles,
 * typed arrays, dates, maps, blobs). This is export only, not a recovery/import codec.
 */
export async function exportRawBoardDraftRow(row: BoardDraftRow): Promise<string> {
	const seen = new Map<object, number>();
	async function visit(value: unknown): Promise<unknown> {
		if (value === null || typeof value === "string" || typeof value === "boolean") return value;
		if (typeof value === "number") {
			return Number.isFinite(value) && !Object.is(value, -0)
				? value
				: { type: "number", value: Object.is(value, -0) ? "-0" : String(value) };
		}
		if (typeof value === "bigint" || typeof value === "undefined") return { type: typeof value, value: String(value) };
		if (typeof value !== "object") throw new Error("Raw export contains an unsupported non-storage value.");
		const prior = seen.get(value);
		if (prior !== undefined) return { reference: prior };
		const id = seen.size;
		seen.set(value, id);
		if (value instanceof Date) return { id, type: "Date", milliseconds: await visit(value.getTime()) };
		if (value instanceof RegExp) return { id, type: "RegExp", source: value.source, flags: value.flags };
		if (value instanceof ArrayBuffer) return { id, type: "ArrayBuffer", bytes: [...new Uint8Array(value)] };
		if (ArrayBuffer.isView(value))
			return {
				id,
				type: Object.prototype.toString.call(value),
				bytes: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)],
			};
		if (typeof Blob !== "undefined" && value instanceof Blob)
			return {
				id,
				type: typeof File !== "undefined" && value instanceof File ? "File" : "Blob",
				mime: value.type,
				...(typeof File !== "undefined" && value instanceof File
					? { name: value.name, lastModified: value.lastModified }
					: {}),
				bytes: [...new Uint8Array(await value.arrayBuffer())],
			};
		if (value instanceof Map) {
			const entries = [];
			for (const [key, item] of value) entries.push([await visit(key), await visit(item)]);
			return { id, type: "Map", entries };
		}
		if (value instanceof Set) {
			const entries = [];
			for (const item of value) entries.push(await visit(item));
			return { id, type: "Set", entries };
		}
		const entries = [];
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
			if (typeof key !== "string" || !Object.hasOwn(descriptor, "value"))
				throw new Error("Raw export refused an accessor or symbol; original row is unchanged.");
			entries.push([key, await visit(descriptor.value)]);
		}
		return { id, type: Array.isArray(value) ? "Array" : Object.prototype.toString.call(value), entries };
	}
	return JSON.stringify({ format: "board-purpose-store-raw-graph-v1", row: await visit(row) }, null, 2);
}

function download(document: Document, text: string, filename: string) {
	const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Only scan is accepted: this page cannot obtain a writer from a supplied boundary. */
export function mountBoardDraftReader(
	root: HTMLElement,
	storage: Pick<BoardDraftStorage, "scan"> = {
		scan: () => createBoardDraftIndexedDB(globalThis.indexedDB, { existingOnly: true }).scan(),
	},
) {
	const document = root.ownerDocument;
	const heading = document.createElement("h1");
	heading.textContent = "Board drafts — LOOK ONLY";
	const warning = document.createElement("p");
	warning.textContent =
		"Nothing here restores, posts, closes or replays a board action. Current edits, submitted originals and retirement markers are review evidence only. Export is explicit and stays local.";
	const status = document.createElement("p");
	status.setAttribute("role", "status");
	status.dataset.boardReaderStatus = "loading";
	const refresh = document.createElement("button");
	refresh.type = "button";
	refresh.textContent = "Inspect existing draft storage";
	const entries = document.createElement("div");
	root.replaceChildren(heading, warning, refresh, status, entries);
	function showText(label: string, text: string, filename: string) {
		const section = document.createElement("section");
		const title = document.createElement("h2");
		title.textContent = label;
		const pre = document.createElement("pre");
		pre.textContent = text; // NEVER HTML, even for malformed or foreign data
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = `Export ${label}`;
		button.addEventListener("click", () => download(document, text, filename));
		section.append(title, pre, button);
		entries.append(section);
	}
	async function inspect() {
		refresh.disabled = true;
		entries.replaceChildren();
		status.dataset.boardReaderStatus = "loading";
		status.textContent = "Reading existing purpose-scoped storage; no changes requested.";
		try {
			const result = await inspectBoardDrafts(storage);
			status.dataset.boardReaderStatus = result.status;
			status.textContent = {
				missing: "Draft database is missing. No database or schema was created.",
				empty: "Existing draft database is empty. This is not proof that any authored draft was posted or closed.",
				ready: "Validated drafts found. They have NOT been restored, posted, closed or replayed.",
				corrupt: "UNKNOWN/CORRUPT rows found. They are not admitted as drafts; raw exports appear below.",
			}[result.status];
			for (const [index, record] of result.records.entries()) {
				showText(
					`Record ${index + 1}${record.retired ? " — RETIREMENT MARKER (bytes retained)" : " — active draft"}`,
					encodeBoardDraftRecord(record),
					`board-record-${index + 1}.json`,
				);
				showText(`Current ${index + 1}`, encodeBoardDraftSource(record.current), `board-current-${index + 1}.json`);
				for (const [original, source] of record.submitted.entries())
					showText(
						`Submitted original ${index + 1}.${original + 1}`,
						encodeBoardDraftSource(source),
						`board-submitted-${index + 1}-${original + 1}.json`,
					);
			}
			for (const [index, row] of result.unknown.entries())
				showText(`RAW UNKNOWN ${index + 1}`, await exportRawBoardDraftRow(row), `board-unknown-${index + 1}.json`);
		} catch {
			status.dataset.boardReaderStatus = "unavailable";
			status.textContent =
				"Inspection unavailable or failed. This is NOT an empty or successful recovery. Nothing was changed; keep the original storage and ask the host to diagnose access/format errors.";
		} finally {
			refresh.disabled = false;
		}
	}
	refresh.addEventListener("click", () => void inspect());
	return { inspect };
}

const root = typeof document === "undefined" ? null : document.querySelector<HTMLElement>("[data-board-draft-reader]");
if (root) void mountBoardDraftReader(root).inspect();
