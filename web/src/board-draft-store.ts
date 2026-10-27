import type { BoardDraftSource } from "./roles-state";

export type { BoardDraftForm, BoardDraftSource } from "./roles-state";

// Authored Board sources only. This is not a post/close wire packet, owner receipt, or replay authority.
export const BOARD_DRAFT_DATABASE = "pi-authored-board-drafts-v1";
export const BOARD_DRAFT_OBJECT_STORE = "authored-board-drafts";
export const BOARD_DRAFT_PURPOSE = "authored-board-draft";

export type BoardDraftTarget = Readonly<{ type: "board_post" }> | Readonly<{ type: "board_close"; id: string }>;

export interface BoardDraftIdentity {
	readonly editorId: string;
	readonly form?: BoardDraftTarget;
}

export interface BoardDraftRecord {
	readonly purpose: typeof BOARD_DRAFT_PURPOSE;
	readonly schemaVersion: 1;
	readonly recordId: string;
	readonly version: number;
	readonly retired: boolean;
	readonly current: BoardDraftSource;
	readonly submitted: readonly BoardDraftSource[];
}

export interface BoardDraftRow {
	readonly key: unknown;
	readonly value: unknown;
}

export interface BoardDraftScan {
	readonly status: "missing" | "present";
	readonly rows: readonly BoardDraftRow[];
}

/** read returns undefined ONLY for proven absence; a present undefined row MUST reject.
 * swap MUST compare and replace atomically, resolve only on transaction completion,
 * and preserve the prior record on abort. No delete or general-purpose snapshot API.
 */
export interface BoardDraftStorage {
	read(key: string): Promise<unknown>;
	scan(): Promise<BoardDraftScan>;
	swap(key: string, expected: string | null, replacement: BoardDraftRecord): Promise<void>;
}

export class BoardDraftError extends Error {
	constructor(
		readonly code:
			| "invalid-source"
			| "invalid-record"
			| "conflict"
			| "retired"
			| "unavailable"
			| "blocked"
			| "transaction-failed"
			| "readback-failed"
			| "readback-mismatch",
		readonly transactionCompleted: boolean | "unknown" = false,
		options?: ErrorOptions,
	) {
		super(`Board draft storage: ${code}. No board post or close action is implied.`, options);
		this.name = "BoardDraftError";
	}
}

const SOURCE_KEYS = ["editorId", "revision", "form"];
const POST_FORM_KEYS = ["type", "kind", "toAll", "picked", "title", "text"];
const CLOSE_FORM_KEYS = ["type", "id", "note"];
const RECORD_KEYS = ["purpose", "schemaVersion", "recordId", "version", "retired", "current", "submitted"];

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return (
		(proto === Object.prototype || proto === null) &&
		Reflect.ownKeys(value).length === keys.length &&
		keys.every((key) => {
			const desc = Object.getOwnPropertyDescriptor(value, key);
			return desc?.enumerable === true && Object.hasOwn(desc, "value");
		})
	);
}

function safeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function denseArray(value: unknown): value is unknown[] {
	return (
		Array.isArray(value) &&
		Object.getPrototypeOf(value) === Array.prototype &&
		Reflect.ownKeys(value).length === value.length + 1 &&
		Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))).every(
			(desc) => desc?.enumerable === true && Object.hasOwn(desc, "value"),
		)
	);
}

/** Mirrors #593's exact closed BoardDraftSource union, without a runtime React/roles-state import. */
export function copyBoardDraftSource(value: unknown): BoardDraftSource {
	try {
		if (
			!exact(value, SOURCE_KEYS) ||
			typeof value.editorId !== "string" ||
			!value.editorId ||
			!safeInteger(value.revision)
		)
			throw new Error();
		const form = value.form;
		if (!form || typeof form !== "object") throw new Error();
		const typeDesc = Object.getOwnPropertyDescriptor(form, "type");
		if (!typeDesc || typeDesc.enumerable !== true || !Object.hasOwn(typeDesc, "value")) throw new Error();
		if (typeDesc.value === "board_post") {
			if (
				!exact(form, POST_FORM_KEYS) ||
				(form.kind !== "news" && form.kind !== "order") ||
				typeof form.toAll !== "boolean" ||
				!denseArray(form.picked) ||
				!form.picked.every((item): item is string => typeof item === "string") ||
				typeof form.title !== "string" ||
				typeof form.text !== "string"
			)
				throw new Error();
			return Object.freeze({
				editorId: value.editorId,
				revision: value.revision,
				form: Object.freeze({
					type: "board_post" as const,
					kind: form.kind,
					toAll: form.toAll,
					picked: Object.freeze([...form.picked]),
					title: form.title,
					text: form.text,
				}),
			});
		}
		if (typeDesc.value === "board_close") {
			if (!exact(form, CLOSE_FORM_KEYS) || typeof form.id !== "string" || !form.id || typeof form.note !== "string")
				throw new Error();
			return Object.freeze({
				editorId: value.editorId,
				revision: value.revision,
				form: Object.freeze({
					type: "board_close" as const,
					id: form.id,
					note: form.note,
				}),
			});
		}
		throw new Error();
	} catch {
		throw new BoardDraftError("invalid-source");
	}
}

function readTarget(form: unknown): BoardDraftTarget {
	if (!form || typeof form !== "object") throw new BoardDraftError("invalid-source");
	const typeDesc = Object.getOwnPropertyDescriptor(form, "type");
	if (!typeDesc || typeDesc.enumerable !== true || !Object.hasOwn(typeDesc, "value"))
		throw new BoardDraftError("invalid-source");
	if (typeDesc.value === "board_post") return Object.freeze({ type: "board_post" as const });
	if (typeDesc.value === "board_close") {
		const idDesc = Object.getOwnPropertyDescriptor(form, "id");
		if (
			!idDesc ||
			idDesc.enumerable !== true ||
			!Object.hasOwn(idDesc, "value") ||
			typeof idDesc.value !== "string" ||
			!idDesc.value
		)
			throw new BoardDraftError("invalid-source");
		return Object.freeze({ type: "board_close" as const, id: idDesc.value });
	}
	throw new BoardDraftError("invalid-source");
}

function sameTarget(a: BoardDraftTarget, b: BoardDraftTarget): boolean {
	if (a.type !== b.type) return false;
	return a.type === "board_post" || (b.type === "board_close" && a.id === b.id);
}

export function boardDraftKey(identity: BoardDraftIdentity): string {
	if (!identity || typeof identity !== "object") throw new BoardDraftError("invalid-source");
	const editorDesc = Object.getOwnPropertyDescriptor(identity, "editorId");
	if (
		!editorDesc ||
		editorDesc.enumerable !== true ||
		!Object.hasOwn(editorDesc, "value") ||
		typeof editorDesc.value !== "string" ||
		!editorDesc.value
	)
		throw new BoardDraftError("invalid-source");
	const formDesc = Object.getOwnPropertyDescriptor(identity, "form");
	if (formDesc) {
		if (formDesc.enumerable !== true || !Object.hasOwn(formDesc, "value")) throw new BoardDraftError("invalid-source");
		if (formDesc.value !== undefined) readTarget(formDesc.value);
	}
	return editorDesc.value;
}

function integerBytes(value: number): string {
	return Object.is(value, -0) ? "-0" : String(value);
}

export function encodeBoardDraftSource(value: unknown): string {
	const source = copyBoardDraftSource(value);
	const form = source.form;
	const formBytes =
		form.type === "board_post"
			? `{"type":"board_post","kind":${JSON.stringify(form.kind)},"toAll":${form.toAll},"picked":[${form.picked.map((id) => JSON.stringify(id)).join(",")}],"title":${JSON.stringify(form.title)},"text":${JSON.stringify(form.text)}}`
			: `{"type":"board_close","id":${JSON.stringify(form.id)},"note":${JSON.stringify(form.note)}}`;
	return `{"editorId":${JSON.stringify(source.editorId)},"revision":${integerBytes(source.revision)},"form":${formBytes}}`;
}

const sourceBytes = encodeBoardDraftSource;

function sameLifetime(a: BoardDraftSource, b: BoardDraftSource): boolean {
	return a.editorId === b.editorId && sameTarget(a.form, b.form);
}

export function copyBoardDraftRecord(value: unknown): BoardDraftRecord {
	try {
		if (
			!exact(value, RECORD_KEYS) ||
			value.purpose !== BOARD_DRAFT_PURPOSE ||
			value.schemaVersion !== 1 ||
			typeof value.recordId !== "string" ||
			!value.recordId ||
			!safeInteger(value.version) ||
			typeof value.retired !== "boolean" ||
			!denseArray(value.submitted)
		)
			throw new Error();
		const current = copyBoardDraftSource(value.current);
		const submitted = value.submitted.map(copyBoardDraftSource);
		const revisions = new Set<number>();
		for (const source of submitted) {
			if (
				!sameLifetime(current, source) ||
				source.revision > current.revision ||
				revisions.has(source.revision) ||
				(source.revision === current.revision && sourceBytes(source) !== sourceBytes(current))
			)
				throw new Error();
			revisions.add(source.revision);
		}
		return Object.freeze({
			purpose: BOARD_DRAFT_PURPOSE,
			schemaVersion: 1,
			recordId: value.recordId,
			version: value.version,
			retired: value.retired,
			current,
			submitted: Object.freeze(submitted),
		});
	} catch {
		throw new BoardDraftError("invalid-record");
	}
}

export function encodeBoardDraftRecord(value: unknown): string {
	const record = copyBoardDraftRecord(value);
	return `{"purpose":${JSON.stringify(record.purpose)},"schemaVersion":1,"recordId":${JSON.stringify(record.recordId)},"version":${integerBytes(record.version)},"retired":${record.retired},"current":${sourceBytes(record.current)},"submitted":[${record.submitted.map(sourceBytes).join(",")}]}`;
}

export interface BoardDraftInspection {
	readonly status: "missing" | "empty" | "ready" | "corrupt";
	readonly records: readonly BoardDraftRecord[];
	/** Raw bytes/values remain available for explicit review/export, never silently dropped. */
	readonly unknown: readonly BoardDraftRow[];
}

export async function inspectBoardDrafts(storage: Pick<BoardDraftStorage, "scan">): Promise<BoardDraftInspection> {
	const scan = await storage.scan(); // unavailable rejects, NOT an empty recovery list
	const records: BoardDraftRecord[] = [];
	const unknown: BoardDraftRow[] = [];
	for (const row of scan.rows) {
		try {
			const record = copyBoardDraftRecord(row.value);
			if (row.key !== boardDraftKey(record.current)) throw new Error();
			records.push(record);
		} catch {
			unknown.push(row);
		}
	}
	return Object.freeze({
		status: unknown.length ? "corrupt" : scan.status === "missing" ? "missing" : records.length ? "ready" : "empty",
		records: Object.freeze(records),
		unknown: Object.freeze(unknown),
	});
}

export function createBoardDraftStore(
	storage: BoardDraftStorage,
	newRecordId: () => string = () => crypto.randomUUID(),
) {
	async function write(expected: BoardDraftRecord | null, replacement: BoardDraftRecord) {
		const next = copyBoardDraftRecord(replacement);
		const key = boardDraftKey(next.current);
		try {
			await storage.swap(key, expected ? encodeBoardDraftRecord(expected) : null, next);
		} catch (error) {
			if (error instanceof BoardDraftError) throw error;
			throw new BoardDraftError("transaction-failed", "unknown", { cause: error });
		}
		let readback: unknown;
		try {
			readback = await storage.read(key);
			if (encodeBoardDraftRecord(readback) !== encodeBoardDraftRecord(next))
				throw new BoardDraftError("readback-mismatch", true);
		} catch (error) {
			if (error instanceof BoardDraftError && error.code === "readback-mismatch") throw error;
			throw new BoardDraftError("readback-failed", true, { cause: error });
		}
		return next;
	}
	function advance(expected: unknown) {
		const record = copyBoardDraftRecord(expected);
		if (record.retired) throw new BoardDraftError("retired");
		if (!Number.isSafeInteger(record.version + 1)) throw new BoardDraftError("invalid-record");
		return record;
	}
	return {
		/** Creates initial current plus any initial submitted source(s) in one atomic record change. */
		async create(value: unknown, submitted: unknown = []): Promise<BoardDraftRecord> {
			const current = copyBoardDraftSource(value);
			let rawSubmitted: unknown[];
			if (submitted === undefined) rawSubmitted = [];
			else if (Array.isArray(submitted)) {
				if (!denseArray(submitted)) throw new BoardDraftError("invalid-source");
				rawSubmitted = submitted;
			} else rawSubmitted = [submitted];
			const submittedSources = rawSubmitted.map(copyBoardDraftSource);
			const revisions = new Set<number>();
			for (const source of submittedSources) {
				if (
					!sameLifetime(current, source) ||
					source.revision > current.revision ||
					revisions.has(source.revision) ||
					(source.revision === current.revision && sourceBytes(source) !== sourceBytes(current))
				)
					throw new BoardDraftError("conflict");
				revisions.add(source.revision);
			}
			return write(null, {
				purpose: BOARD_DRAFT_PURPOSE,
				schemaVersion: 1,
				recordId: newRecordId(),
				version: 0,
				retired: false,
				current,
				submitted: submittedSources,
			});
		},
		async load(identity: BoardDraftIdentity): Promise<BoardDraftRecord | undefined> {
			const key = boardDraftKey(identity);
			const target = identity.form !== undefined ? readTarget(identity.form) : undefined;
			const raw = await storage.read(key);
			if (raw === undefined) return undefined; // explicitly absent record, not corrupt/unavailable
			const record = copyBoardDraftRecord(raw);
			if (boardDraftKey(record.current) !== key) throw new BoardDraftError("invalid-record");
			if (target && !sameTarget(record.current.form, target)) throw new BoardDraftError("conflict");
			return record;
		},
		inspect: () => inspectBoardDrafts(storage),
		async updateCurrent(expected: unknown, value: unknown): Promise<BoardDraftRecord> {
			const record = advance(expected);
			const current = copyBoardDraftSource(value);
			if (!sameLifetime(record.current, current) || current.revision < record.current.revision)
				throw new BoardDraftError("conflict");
			if (current.revision === record.current.revision) {
				if (sourceBytes(current) !== sourceBytes(record.current)) throw new BoardDraftError("conflict");
				return write(record, record); // still an exact CAS/readback, not assumed success
			}
			return write(record, { ...record, version: record.version + 1, current });
		},
		async retainSubmitted(expected: unknown, value: unknown): Promise<BoardDraftRecord> {
			const record = advance(expected);
			const source = copyBoardDraftSource(value);
			if (!sameLifetime(record.current, source) || source.revision > record.current.revision)
				throw new BoardDraftError("conflict");
			const prior = record.submitted.find((item) => item.revision === source.revision);
			if (prior) {
				if (sourceBytes(prior) !== sourceBytes(source)) throw new BoardDraftError("conflict");
				return write(record, record);
			}
			if (source.revision === record.current.revision && sourceBytes(source) !== sourceBytes(record.current))
				throw new BoardDraftError("conflict");
			return write(record, { ...record, version: record.version + 1, submitted: [...record.submitted, source] });
		},
		/** Explicit host-only decision: marker, NEVER physical deletion or board post/close action. */
		async retire(expected: unknown): Promise<BoardDraftRecord> {
			const record = copyBoardDraftRecord(expected);
			if (record.retired) return write(record, record);
			advance(record);
			return write(record, { ...record, version: record.version + 1, retired: true });
		},
	};
}

/** Constructing this boundary performs no IO. Only writers explicitly open/create v1.
 * Existing-only readers abort an absent database's upgrade; no schema is committed.
 */
export function createBoardDraftIndexedDB(
	factory: IDBFactory | undefined,
	options: { readonly existingOnly?: boolean; readonly databaseName?: string } = {},
): BoardDraftStorage {
	const name = options.databaseName ?? BOARD_DRAFT_DATABASE;
	async function open(create: boolean): Promise<IDBDatabase | undefined> {
		if (!factory) throw new BoardDraftError("unavailable");
		return new Promise((resolve, reject) => {
			let missing = false;
			let finished = false;
			const request = create ? factory.open(name, 1) : factory.open(name);
			const fail = (error: BoardDraftError) => {
				finished = true;
				reject(error);
			};
			request.onblocked = () => fail(new BoardDraftError("blocked"));
			request.onupgradeneeded = (event) => {
				if (finished) {
					request.transaction!.abort();
					return;
				}
				if (!create) {
					missing = event.oldVersion === 0;
					request.transaction!.abort();
					return;
				}
				request.result.createObjectStore(BOARD_DRAFT_OBJECT_STORE);
			};
			request.onerror = () => {
				if (missing) resolve(undefined);
				else fail(new BoardDraftError("unavailable", false, { cause: request.error }));
			};
			request.onsuccess = () => {
				const database = request.result;
				if (finished) {
					database.close();
					return;
				}
				if (database.version !== 1 || !database.objectStoreNames.contains(BOARD_DRAFT_OBJECT_STORE)) {
					database.close();
					fail(new BoardDraftError("invalid-record"));
					return;
				}
				database.onversionchange = () => database.close();
				resolve(database);
			};
		});
	}
	async function transaction<T>(
		mode: IDBTransactionMode,
		action: (store: IDBObjectStore, set: (value: T) => void, fail: (error: unknown) => void) => void,
	): Promise<{ missing: boolean; value: T | undefined }> {
		if (options.existingOnly && mode !== "readonly") throw new BoardDraftError("unavailable");
		const database = await open(mode === "readwrite");
		if (!database) return { missing: true, value: undefined };
		try {
			return await new Promise((resolve, reject) => {
				const tx = database.transaction(BOARD_DRAFT_OBJECT_STORE, mode, { durability: "strict" });
				let value: T | undefined;
				let failure: unknown;
				const fail = (error: unknown) => {
					failure = error;
					tx.abort();
				};
				tx.onabort = () =>
					reject(
						failure instanceof BoardDraftError
							? failure
							: new BoardDraftError("transaction-failed", false, { cause: failure ?? tx.error }),
					);
				tx.onerror = () => {
					failure ??= new BoardDraftError("transaction-failed", false, { cause: tx.error });
				};
				tx.oncomplete = () => resolve({ missing: false, value });
				try {
					action(tx.objectStore(BOARD_DRAFT_OBJECT_STORE), (next) => (value = next), fail);
				} catch (error) {
					fail(error);
				}
			});
		} finally {
			database.close();
		}
	}
	return {
		async read(key) {
			return (
				await transaction<unknown>("readonly", (store, set, fail) => {
					const request = store.get(key);
					const presence = store.count(key);
					presence.onsuccess = () => {
						// Both requests share this transaction; get(undefined) alone cannot prove absence.
						if (presence.result !== 0 && request.result === undefined) fail(new BoardDraftError("invalid-record"));
						else set(request.result);
					};
				})
			).value;
		},
		async scan() {
			const result = await transaction<readonly BoardDraftRow[]>("readonly", (store, set) => {
				const keys = store.getAllKeys();
				const values = store.getAll();
				values.onsuccess = () => set(keys.result.map((key, index) => ({ key, value: values.result[index] })));
			});
			return { status: result.missing ? "missing" : "present", rows: result.value ?? [] };
		},
		async swap(key, expected, replacement) {
			await transaction<void>("readwrite", (store, _set, fail) => {
				const request = store.get(key);
				const presence = store.count(key);
				presence.onsuccess = () => {
					try {
						// Only absent keys map to null; every present value must pass the strict codec.
						const actual = presence.result === 0 ? null : encodeBoardDraftRecord(request.result);
						if (actual !== expected || boardDraftKey(replacement.current) !== key)
							throw new BoardDraftError("conflict");
						store.put(replacement, key); // request success is deliberately NOT the resolution point
					} catch (error) {
						fail(error);
					}
				};
			});
		},
	};
}
