import type { SchedulerAdmissionSource, SchedulerTaskDraft } from "./components/SchedulerPanel";

// Authored scheduler sources only. This is not the command payload or an authority to replay it.
export const SCHEDULER_DRAFT_DATABASE = "pi-authored-scheduler-drafts-v1";
export const SCHEDULER_DRAFT_OBJECT_STORE = "authored-scheduler-drafts";
export const SCHEDULER_DRAFT_PURPOSE = "authored-scheduler-draft";
export interface SchedulerDraftIdentity {
	readonly workspace: string;
	readonly taskId: string | null;
	readonly formId: string;
}
export interface SchedulerDraftRecord {
	readonly purpose: typeof SCHEDULER_DRAFT_PURPOSE;
	readonly schemaVersion: 1;
	readonly recordId: string;
	readonly version: number;
	readonly retired: boolean;
	readonly current: SchedulerAdmissionSource;
	readonly submitted: readonly SchedulerAdmissionSource[];
}
export interface SchedulerDraftRow {
	readonly key: unknown;
	readonly value: unknown;
}
export interface SchedulerDraftScan {
	readonly status: "missing" | "present";
	readonly rows: readonly SchedulerDraftRow[];
}
/** swap MUST compare and replace atomically, resolve only on transaction completion,
 * and preserve the prior record on abort. No delete or general-purpose snapshot API.
 */
export interface SchedulerDraftStorage {
	read(key: string): Promise<unknown>;
	scan(): Promise<SchedulerDraftScan>;
	swap(key: string, expected: string | null, replacement: SchedulerDraftRecord): Promise<void>;
}
export class SchedulerDraftError extends Error {
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
		super(`Scheduler draft storage: ${code}. No schedule action is implied.`, options);
		this.name = "SchedulerDraftError";
	}
}
const TEXT = [
	"id",
	"name",
	"description",
	"cwd",
	"cron",
	"preset",
	"intervalMinutes",
	"prompt",
	"model",
	"thinkingLevel",
] as const;
const PRESETS = ["custom", "0 9 * * *", "0 * * * *", "*/30 * * * *", "0 9 * * 1-5", "0 9 * * 1"];
const SOURCE_KEYS = ["workspace", "taskId", "formId", "revision", "form"];
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
/** Mirrors #590's exact five-field/twelve-field allowlist, without a runtime React import. */
export function copySchedulerDraftSource(value: unknown): SchedulerAdmissionSource {
	try {
		if (!exact(value, SOURCE_KEYS)) throw new Error();
		const form = value.form;
		if (
			typeof value.workspace !== "string" ||
			!value.workspace ||
			(value.taskId !== null && (typeof value.taskId !== "string" || !value.taskId)) ||
			typeof value.formId !== "string" ||
			!value.formId ||
			!safeInteger(value.revision) ||
			!exact(form, [...TEXT, "kind", "catchUp"]) ||
			!TEXT.every((key) => typeof form[key] === "string") ||
			(form.kind !== "cron" && form.kind !== "interval") ||
			typeof form.catchUp !== "boolean" ||
			form.id !== (value.taskId ?? "") ||
			!PRESETS.includes(form.preset as string)
		)
			throw new Error();
		const copiedForm = Object.fromEntries(TEXT.map((key) => [key, form[key]])) as Pick<
			SchedulerTaskDraft,
			(typeof TEXT)[number]
		>;
		return Object.freeze({
			workspace: value.workspace,
			taskId: value.taskId as string | null,
			formId: value.formId,
			revision: value.revision,
			form: Object.freeze({ ...copiedForm, kind: form.kind, catchUp: form.catchUp }),
		});
	} catch {
		throw new SchedulerDraftError("invalid-source");
	}
}
export function schedulerDraftKey(identity: SchedulerDraftIdentity): string {
	for (const key of ["workspace", "taskId", "formId"] as const) {
		const desc = Object.getOwnPropertyDescriptor(identity, key);
		if (!desc || !Object.hasOwn(desc, "value")) throw new SchedulerDraftError("invalid-source");
	}
	if (
		typeof identity.workspace !== "string" ||
		!identity.workspace ||
		(identity.taskId !== null && (typeof identity.taskId !== "string" || !identity.taskId)) ||
		typeof identity.formId !== "string" ||
		!identity.formId
	)
		throw new SchedulerDraftError("invalid-source");
	return JSON.stringify([identity.workspace, identity.taskId, identity.formId]);
}
function integerBytes(value: number): string {
	return Object.is(value, -0) ? "-0" : String(value);
}
export function encodeSchedulerDraftSource(value: unknown): string {
	const source = copySchedulerDraftSource(value);
	return `{"workspace":${JSON.stringify(source.workspace)},"taskId":${JSON.stringify(source.taskId)},"formId":${JSON.stringify(source.formId)},"revision":${integerBytes(source.revision)},"form":${JSON.stringify(source.form)}}`;
}
const sourceBytes = encodeSchedulerDraftSource;
function sameLifetime(a: SchedulerAdmissionSource, b: SchedulerAdmissionSource): boolean {
	return schedulerDraftKey(a) === schedulerDraftKey(b);
}
function sourceArray(value: unknown): value is unknown[] {
	return (
		Array.isArray(value) &&
		Object.getPrototypeOf(value) === Array.prototype &&
		Reflect.ownKeys(value).length === value.length + 1 &&
		Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))).every(
			(desc) => desc?.enumerable === true && Object.hasOwn(desc, "value"),
		)
	);
}
export function copySchedulerDraftRecord(value: unknown): SchedulerDraftRecord {
	try {
		if (
			!exact(value, RECORD_KEYS) ||
			value.purpose !== SCHEDULER_DRAFT_PURPOSE ||
			value.schemaVersion !== 1 ||
			typeof value.recordId !== "string" ||
			!value.recordId ||
			!safeInteger(value.version) ||
			typeof value.retired !== "boolean" ||
			!sourceArray(value.submitted)
		)
			throw new Error();
		const current = copySchedulerDraftSource(value.current);
		const submitted = value.submitted.map(copySchedulerDraftSource);
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
			purpose: SCHEDULER_DRAFT_PURPOSE,
			schemaVersion: 1,
			recordId: value.recordId,
			version: value.version,
			retired: value.retired,
			current,
			submitted: Object.freeze(submitted),
		});
	} catch {
		throw new SchedulerDraftError("invalid-record");
	}
}
export function encodeSchedulerDraftRecord(value: unknown): string {
	const record = copySchedulerDraftRecord(value);
	return `{"purpose":${JSON.stringify(record.purpose)},"schemaVersion":1,"recordId":${JSON.stringify(record.recordId)},"version":${integerBytes(record.version)},"retired":${record.retired},"current":${sourceBytes(record.current)},"submitted":[${record.submitted.map(sourceBytes).join(",")}]}`;
}
export interface SchedulerDraftInspection {
	readonly status: "missing" | "empty" | "ready" | "corrupt";
	readonly records: readonly SchedulerDraftRecord[];
	/** Raw bytes/values remain available for explicit review/export, never silently dropped. */
	readonly unknown: readonly SchedulerDraftRow[];
}
export async function inspectSchedulerDrafts(
	storage: Pick<SchedulerDraftStorage, "scan">,
): Promise<SchedulerDraftInspection> {
	const scan = await storage.scan(); // unavailable rejects, NOT an empty recovery list
	const records: SchedulerDraftRecord[] = [];
	const unknown: SchedulerDraftRow[] = [];
	for (const row of scan.rows) {
		try {
			const record = copySchedulerDraftRecord(row.value);
			if (row.key !== schedulerDraftKey(record.current)) throw new Error();
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
export function createSchedulerDraftStore(
	storage: SchedulerDraftStorage,
	newRecordId: () => string = () => crypto.randomUUID(),
) {
	async function write(expected: SchedulerDraftRecord | null, replacement: SchedulerDraftRecord) {
		const next = copySchedulerDraftRecord(replacement);
		const key = schedulerDraftKey(next.current);
		try {
			await storage.swap(key, expected ? encodeSchedulerDraftRecord(expected) : null, next);
		} catch (error) {
			if (error instanceof SchedulerDraftError) throw error;
			throw new SchedulerDraftError("transaction-failed", "unknown", { cause: error });
		}
		let readback: unknown;
		try {
			readback = await storage.read(key);
			if (encodeSchedulerDraftRecord(readback) !== encodeSchedulerDraftRecord(next))
				throw new SchedulerDraftError("readback-mismatch", true);
		} catch (error) {
			if (error instanceof SchedulerDraftError && error.code === "readback-mismatch") throw error;
			throw new SchedulerDraftError("readback-failed", true, { cause: error });
		}
		return next;
	}
	function advance(expected: unknown) {
		const record = copySchedulerDraftRecord(expected);
		if (record.retired) throw new SchedulerDraftError("retired");
		if (!Number.isSafeInteger(record.version + 1)) throw new SchedulerDraftError("invalid-record");
		return record;
	}
	return {
		async create(value: unknown): Promise<SchedulerDraftRecord> {
			const current = copySchedulerDraftSource(value);
			return write(null, {
				purpose: SCHEDULER_DRAFT_PURPOSE,
				schemaVersion: 1,
				recordId: newRecordId(),
				version: 0,
				retired: false,
				current,
				submitted: [],
			});
		},
		async load(identity: SchedulerDraftIdentity): Promise<SchedulerDraftRecord | undefined> {
			const key = schedulerDraftKey(identity);
			const raw = await storage.read(key);
			if (raw === undefined) return undefined; // explicitly absent record, not corrupt/unavailable
			const record = copySchedulerDraftRecord(raw);
			if (schedulerDraftKey(record.current) !== key) throw new SchedulerDraftError("invalid-record");
			return record;
		},
		inspect: () => inspectSchedulerDrafts(storage),
		async updateCurrent(expected: unknown, value: unknown): Promise<SchedulerDraftRecord> {
			const record = advance(expected);
			const current = copySchedulerDraftSource(value);
			if (!sameLifetime(record.current, current) || current.revision < record.current.revision)
				throw new SchedulerDraftError("conflict");
			if (current.revision === record.current.revision) {
				if (sourceBytes(current) !== sourceBytes(record.current)) throw new SchedulerDraftError("conflict");
				return write(record, record); // still an exact CAS/readback, not assumed success
			}
			return write(record, { ...record, version: record.version + 1, current });
		},
		async retainSubmitted(expected: unknown, value: unknown): Promise<SchedulerDraftRecord> {
			const record = advance(expected);
			const source = copySchedulerDraftSource(value);
			if (!sameLifetime(record.current, source) || source.revision > record.current.revision)
				throw new SchedulerDraftError("conflict");
			const prior = record.submitted.find((item) => item.revision === source.revision);
			if (prior) {
				if (sourceBytes(prior) !== sourceBytes(source)) throw new SchedulerDraftError("conflict");
				return write(record, record);
			}
			if (source.revision === record.current.revision && sourceBytes(source) !== sourceBytes(record.current))
				throw new SchedulerDraftError("conflict");
			return write(record, { ...record, version: record.version + 1, submitted: [...record.submitted, source] });
		},
		/** Explicit host-only decision: marker, NEVER physical deletion or schedule action. */
		async retire(expected: unknown): Promise<SchedulerDraftRecord> {
			const record = copySchedulerDraftRecord(expected);
			if (record.retired) return write(record, record);
			advance(record);
			return write(record, { ...record, version: record.version + 1, retired: true });
		},
	};
}

/** Constructing this boundary performs no IO. Only writers explicitly open/create v1.
 * Existing-only readers abort an absent database's upgrade; no schema is committed.
 */
export function createSchedulerDraftIndexedDB(
	factory: IDBFactory | undefined,
	options: { readonly existingOnly?: boolean; readonly databaseName?: string } = {},
): SchedulerDraftStorage {
	const name = options.databaseName ?? SCHEDULER_DRAFT_DATABASE;
	async function open(create: boolean): Promise<IDBDatabase | undefined> {
		if (!factory) throw new SchedulerDraftError("unavailable");
		return new Promise((resolve, reject) => {
			let missing = false;
			let finished = false;
			const request = create ? factory.open(name, 1) : factory.open(name);
			const fail = (error: SchedulerDraftError) => {
				finished = true;
				reject(error);
			};
			request.onblocked = () => fail(new SchedulerDraftError("blocked"));
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
				request.result.createObjectStore(SCHEDULER_DRAFT_OBJECT_STORE);
			};
			request.onerror = () => {
				if (missing) resolve(undefined);
				else fail(new SchedulerDraftError("unavailable", false, { cause: request.error }));
			};
			request.onsuccess = () => {
				const database = request.result;
				if (finished) {
					database.close();
					return;
				}
				if (database.version !== 1 || !database.objectStoreNames.contains(SCHEDULER_DRAFT_OBJECT_STORE)) {
					database.close();
					fail(new SchedulerDraftError("invalid-record"));
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
		if (options.existingOnly && mode !== "readonly") throw new SchedulerDraftError("unavailable");
		const database = await open(mode === "readwrite");
		if (!database) return { missing: true, value: undefined };
		try {
			return await new Promise((resolve, reject) => {
				const tx = database.transaction(SCHEDULER_DRAFT_OBJECT_STORE, mode, { durability: "strict" });
				let value: T | undefined;
				let failure: unknown;
				const fail = (error: unknown) => {
					failure = error;
					tx.abort();
				};
				tx.onabort = () =>
					reject(
						failure instanceof SchedulerDraftError
							? failure
							: new SchedulerDraftError("transaction-failed", false, { cause: failure ?? tx.error }),
					);
				tx.onerror = () => {
					failure ??= new SchedulerDraftError("transaction-failed", false, { cause: tx.error });
				};
				tx.oncomplete = () => resolve({ missing: false, value });
				try {
					action(tx.objectStore(SCHEDULER_DRAFT_OBJECT_STORE), (next) => (value = next), fail);
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
				await transaction<unknown>(
					"readonly",
					(store, set) => (store.get(key).onsuccess = (e) => set((e.target as IDBRequest).result)),
				)
			).value;
		},
		async scan() {
			const result = await transaction<readonly SchedulerDraftRow[]>("readonly", (store, set) => {
				const keys = store.getAllKeys();
				const values = store.getAll();
				values.onsuccess = () => set(keys.result.map((key, index) => ({ key, value: values.result[index] })));
			});
			return { status: result.missing ? "missing" : "present", rows: result.value ?? [] };
		},
		async swap(key, expected, replacement) {
			await transaction<void>("readwrite", (store, _set, fail) => {
				const request = store.get(key);
				request.onsuccess = () => {
					try {
						const actual = request.result === undefined ? null : encodeSchedulerDraftRecord(request.result);
						if (actual !== expected || schedulerDraftKey(replacement.current) !== key)
							throw new SchedulerDraftError("conflict");
						store.put(replacement, key); // request success is deliberately NOT the resolution point
					} catch (error) {
						fail(error);
					}
				};
			});
		},
	};
}
