/** Complete, synchronous ownership boundary for public boolean composer injection.
 * Import/attachment alone never reads storage, changes a draft, or sends a message. */
import {
	createComposerCheckpointStore,
	inspectComposerCheckpoints,
	snapshotComposerCheckpoint,
	type FrozenComposerCheckpoint,
	type ComposerCheckpointBinding,
	type ComposerCheckpointStorage,
} from "./composer-checkpoint";
import type { ComposerPayload } from "./composer-bridge";
import { appendDraftAttachments, mergeRecalledDraft, type DraftAttachment } from "./composer-draft";

export interface ComposerConnection {
	ownerId: string;
	conversationId: string;
	sessionId: string;
	/** Actual native session lifetime, never inferred from displayed text. */
	lifetime: object;
	attachments: DraftAttachment[];
	attachmentRevision: number;
}
export interface ComposerAttachmentHost {
	read(): ComposerConnection | null;
	replace(original: ComposerConnection, attachments: DraftAttachment[]): boolean;
}

export interface ComposerHostSnapshot {
	binding: ComposerCheckpointBinding;
	draft: FrozenComposerCheckpoint["source"];
}
export interface ComposerHostPort {
	/** Bound to the real exclusive recovery owner and actual current composer. */
	snapshot(): ComposerHostSnapshot | null;
	/** One complete synchronous sink. No await or independent text/attachment API. */
	apply(original: ComposerHostSnapshot, record: FrozenComposerCheckpoint): boolean;
	problem(message: string): void;
}
export interface ComposerRecoveryOptions {
	storage?: () => ComposerCheckpointStorage;
	now?: () => number;
	newId?: () => string;
}
export function sameComposerBinding(a: ComposerCheckpointBinding, b: ComposerCheckpointBinding): boolean {
	return (
		a.ownerId === b.ownerId &&
		a.composerId === b.composerId &&
		a.conversationId === b.conversationId &&
		a.sessionId === b.sessionId &&
		a.revision === b.revision
	);
}

function requiredSnapshot(value: unknown): FrozenComposerCheckpoint {
	const result = snapshotComposerCheckpoint(value);
	if (!result.ok) throw new Error(result.detail);
	return result.record;
}

export function createComposerRecovery(options: ComposerRecoveryOptions = {}) {
	let port: ComposerHostPort | null = null;
	let busy = false;
	let problem: string | null = null;
	const storage = options.storage ?? (() => globalThis.localStorage);
	const report = (message: string, target = port): false => {
		problem = message;
		try {
			target?.problem(message);
		} catch {
			/* A notice is never ownership. */
		}
		return false;
	};
	const capture = (): ComposerHostSnapshot | null => {
		try {
			return port?.snapshot() ?? null;
		} catch {
			return null;
		}
	};
	const api = {
		attach(next: ComposerHostPort): () => void {
			port = next;
			return () => {
				if (port === next) port = null;
			};
		},
		ready(): boolean {
			return capture() !== null;
		},
		get problem(): string | null {
			return problem;
		},
		compose(payload: ComposerPayload): boolean {
			if (busy) return report("A composer checkpoint is already in progress. Keep the original draft.");
			const owner = port;
			const original = capture();
			if (!owner || !original)
				return report("Composer recovery is not ready for this session. Keep the original draft.");
			busy = true;
			try {
				// The first strict snapshot validates and captures even the fields which a merge
				// may deduplicate. Never normalize a hostile/unsupported input before validation.
				const captured = requiredSnapshot({
					kind: "pi-web-ui/composer-checkpoint",
					version: 1,
					purpose: "composer-injection",
					recordId: options.newId?.() ?? crypto.randomUUID(),
					createdAt: options.now?.() ?? Date.now(),
					binding: original.binding,
					nextRevision: original.binding.revision + 1,
					source: original.draft,
					incoming: payload,
					effective: original.draft,
				});
				if (!captured.incoming.text?.trim() && !captured.incoming.attachments?.length) return false;
				const record = requiredSnapshot({
					...captured,
					effective: {
						text: mergeRecalledDraft(captured.source.text, captured.incoming.text ?? ""),
						attachments: appendDraftAttachments(
							[...captured.source.attachments],
							[...(captured.incoming.attachments ?? [])],
						),
					},
				});
				const owns = (binding: ComposerCheckpointBinding): boolean => {
					const now = capture();
					return port === owner && !!now && sameComposerBinding(now.binding, binding);
				};
				const store = createComposerCheckpointStore({ enabled: true, storage: storage(), owns });
				const result = store.checkpoint(record);
				if (!result.ok)
					return report(
						`Composer checkpoint refused (${result.code}). Keep the complete original; any committed copy remains recoverable.`,
						owner,
					);
				if (!owns(result.record.binding))
					return report(
						"The original composer changed. Its complete saved copy is retained; nothing was placed in another session.",
						owner,
					);
				if (owner.apply({ binding: result.record.binding, draft: result.record.source }, result.record) !== true)
					return report(
						"The original composer did not accept the full draft. The complete checkpoint remains available for recovery.",
						owner,
					);
				const after = capture();
				if (
					port !== owner ||
					!after ||
					!sameComposerBinding(after.binding, { ...result.record.binding, revision: result.record.nextRevision }) ||
					JSON.stringify(after.draft) !== JSON.stringify(result.record.effective)
				)
					return report(
						"The full composer placement could not be confirmed. The complete checkpoint remains recoverable.",
						owner,
					);
				problem = null;
				return true;
			} catch {
				return report(
					"Composer checkpoint or placement failed. Keep the complete original; saved copies remain available for recovery.",
					owner,
				);
			} finally {
				busy = false;
			}
		},
		/** Call only for an explicit user recovery action. No replay, grant, or retirement. */
		restore(input: unknown): boolean {
			try {
				const record = requiredSnapshot(input);
				const current = capture();
				if (!current || current.binding.sessionId !== record.binding.sessionId)
					return report(
						"Open the original session before restoring this composer draft. The saved original is unchanged.",
					);
				if (JSON.stringify(current.draft) === JSON.stringify(record.effective)) return true;
				// Existing text-only L1 recovery can already have restored the original words.
				// Rehydrate its missing attachments without appending those same words twice.
				if (current.draft.text === record.effective.text) {
					if (!record.effective.attachments.length) return true;
					return api.compose({ attachments: [...record.effective.attachments] });
				}
				return api.compose({ text: record.effective.text, attachments: [...record.effective.attachments] });
			} catch {
				return report(
					"This composer record is incomplete or unsupported. Preserve its raw export; it was not applied.",
				);
			}
		},
		inspect() {
			return inspectComposerCheckpoints(storage());
		},
	};
	return api;
}

let documentRecovery: ReturnType<typeof createComposerRecovery> | undefined;
export function composerRecovery() {
	return (documentRecovery ??= createComposerRecovery());
}
