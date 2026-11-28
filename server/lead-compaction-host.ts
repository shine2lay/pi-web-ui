import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { performance } from "node:perf_hooks";
import { LeadAdmission, type FileAdmission } from "./lead-compaction-admission.js";
import type { Fence, LeadNativeHost, Prepared, Status, Ticket, VerifiedCommit } from "./lead-compaction-contract.js";
import { appliedEntry, nativeDetails, syncNativeFile, validateDraft } from "./lead-compaction-native.js";
import { fenceSession } from "./lead-compaction-session.js";

export interface LeadSparseHostPorts {
	validate(verified: VerifiedCommit): void;
	apply(session: AgentSession, verified: VerifiedCommit): Promise<{ nativeEntryId: string }>;
	findApplied(session: AgentSession, verified: VerifiedCommit): string | undefined;
}
export interface LeadHostPorts {
	sparse?: LeadSparseHostPorts;
	/** Canonical registry reader, not data from a caller or model. */
	resolveHome(sessionId: string): { source: string; role: string; bindingEpoch: number } | undefined;
	busy(session: AgentSession): boolean;
	invalidate(session: AgentSession): void;
	acknowledge(prepared: Prepared, result: { nativeEntryId: string; fence: Fence; recovered: boolean }): Promise<void>;
	/** Local native worker only. No archive/network in this exclusive interval. */
	coldApply(verified: VerifiedCommit): Promise<{ nativeEntryId: string; afterEstimate?: number }>;
	/** Canonical off-thread v3/truncation check before public native reopen, without writes. */
	verifySource(source: string, sessionId: string): Promise<void>;
	/** Must rebuild/rebind the SAME home and preserve host-owned UI/work/unread state. */
	reconstruct(source: string, previous: AgentSession): Promise<AgentSession>;
}
function sameFence(a: Fence, b: Fence): boolean {
	return (
		a.sessionId === b.sessionId &&
		a.source === b.source &&
		a.generation === b.generation &&
		a.mutationRevision === b.mutationRevision &&
		a.bindingEpoch === b.bindingEpoch &&
		a.leafId === b.leafId &&
		a.cached === b.cached
	);
}
/** H owns this object; give issueTicket only to the trusted E bridge, not an RPC route. */
export class LeadCompactionHost implements LeadNativeHost {
	readonly admission: LeadAdmission;
	private readonly tickets = new WeakMap<Ticket, VerifiedCommit>();
	private readonly owed = new Map<string, { verified: VerifiedCommit; nativeEntryId?: string }>();
	private readonly spans = new Map<string, number>();
	constructor(
		private readonly ports: LeadHostPorts,
		admission = new LeadAdmission(),
	) {
		this.admission = admission;
	}
	markSparsePending(sessionId: string, pending: {applicationId:string;applicationHash:string}): void {
		const fence = this.captureFence(sessionId), file = this.admission.file(fence.source);
		if (file.pendingSparse && (file.pendingSparse.applicationId !== pending.applicationId || file.pendingSparse.applicationHash !== pending.applicationHash))
			throw new Error("conflicting-native-recovery");
		file.pendingSparse = { ...pending };
		file.recovery = true;
	}
	clearSparsePending(sessionId: string, planId: string, planHash: string): void {
		const file = this.admission.file(this.captureFence(sessionId).source);
		if (!file.recovery && !file.pendingSparse) return;
		if (file.locked || file.session || file.pendingSparse?.applicationId !== planId || file.pendingSparse.applicationHash !== planHash)
			throw new Error("native-recovery-not-confirmed");
		file.pendingSparse = undefined;
		file.recovery = false;
		this.admission.release(file);
	}
	attach(session: AgentSession): void {
		fenceSession(session, this.admission);
	}
	captureFence(sessionId: string): Fence {
		const home = this.ports.resolveHome(sessionId);
		if (!home) throw new Error("not-canonical-home");
		const file = this.admission.file(home.source);
		if (file.bindingEpoch !== home.bindingEpoch) {
			file.bindingEpoch = home.bindingEpoch;
			file.generation++;
		}
		const session = file.session;
		if (session && (session.sessionId !== sessionId || session.sessionManager.getSessionFile() !== home.source))
			throw new Error("native-binding-drift");
		return Object.freeze({
			sessionId,
			source: home.source,
			generation: file.generation,
			mutationRevision: file.revision,
			bindingEpoch: file.bindingEpoch,
			leafId: session?.sessionManager.getLeafId() ?? null,
			cached: !!session,
		});
	}
	private validate(verified: VerifiedCommit): void {
		if (verified.prepared.strategy === "sparse" || verified.draft.strategy === "sparse") {
			if (verified.prepared.strategy !== "sparse" || verified.draft.strategy !== "sparse" || !this.ports.sparse)
				throw new Error("sparse-strategy-mismatch");
			this.ports.sparse.validate(verified);
		} else validateDraft(verified.prepared, verified.draft);
	}
	issueTicket(verified: VerifiedCommit): Ticket {
		this.validate(verified);
		if (!sameFence(verified.fence, this.captureFence(verified.fence.sessionId))) throw new Error("stale-fence");
		if (
			verified.prepared.originalFence.sessionId !== verified.fence.sessionId ||
			verified.prepared.originalFence.source !== verified.fence.source
		)
			throw new Error("plan-source-drift");
		const ticket = Object.freeze({}) as Ticket;
		this.tickets.set(ticket, structuredClone(verified));
		return ticket;
	}
	private status(verified: VerifiedCommit, state: Status["state"], errorCode?: string, nativeEntryId?: string, afterEstimate?: number): Status {
		return {
			sessionId: verified.fence.sessionId,
			state,
			planId: verified.prepared.planId,
			planHash: verified.prepared.planHash,
			errorCode,
			nativeEntryId,
			...(afterEstimate !== undefined ? { afterEstimate } : {}),
			at: new Date().toISOString(),
		};
	}
	async tryApply(ticket: Ticket): Promise<Status> {
		const verified = this.tickets.get(ticket);
		if (!verified) return { sessionId: "", state: "blocked", errorCode: "invalid-ticket" };
		this.tickets.delete(ticket);
		let file: FileAdmission;
		try {
			if (!sameFence(verified.fence, this.captureFence(verified.fence.sessionId)))
				return this.status(verified, "blocked", "stale-fence");
			file = this.admission.file(verified.fence.source);
		} catch {
			return this.status(verified, "blocked", "authority-drift");
		}
		const session = file.session;
		const sparseRecovery = verified.prepared.strategy === "sparse" && file.recovery &&
			file.pendingSparse?.applicationId === verified.prepared.planId && file.pendingSparse.applicationHash === verified.prepared.planHash;
		if (
			(session &&
				(!session.isIdle || session.isStreaming || session.pendingMessageCount || this.ports.busy(session))) ||
			!(sparseRecovery ? this.admission.acquireRecovery(file) : this.admission.acquire(file))
		)
			return this.status(verified, "waiting_busy", "admission-busy");
		let nativeEntryId: string | undefined;
		let afterEstimate: number | undefined;
		try {
			// Final scalar CAS and native pair deliberately contain NO await.
			if (!sameFence(verified.fence, this.captureFence(verified.fence.sessionId)))
				return this.status(verified, "blocked", "stale-fence");
			if (session && verified.draft.strategy === "sparse") {
				const began = performance.now();
				this.owed.set(file.source, { verified });
				file.recovery = true;
				try {
					nativeEntryId = await this.admission.owned(file, async () => {
						const result = await this.ports.sparse!.apply(session, verified);
						await syncNativeFile(file.source);
						session.refreshContext();
						return result.nativeEntryId;
					});
					this.owed.set(file.source, { verified, nativeEntryId });
					this.ports.invalidate(session);
				} finally { this.spans.set(file.source, performance.now() - began); }
			} else if (session) {
				const draft = verified.draft;
				if (draft.strategy === "sparse") throw new Error("prefix-draft-required");
				const began = performance.now();
				file.internal = true;
				this.owed.set(file.source, { verified });
				try {
					nativeEntryId =
						appliedEntry(session, verified.prepared) ??
						session.sessionManager.appendCompaction(
							draft.summary,
							draft.firstKeptEntryId,
							draft.tokensBefore,
							nativeDetails(verified.prepared, verified.draft),
						);
					this.owed.set(file.source, { verified, nativeEntryId });
					session.refreshContext();
				} finally {
					file.internal = false;
					this.spans.set(file.source, performance.now() - began);
				}
				this.ports.invalidate(session);
				await syncNativeFile(file.source);
			} else {
				this.owed.set(file.source, { verified });
				const coldResult = await this.ports.coldApply(verified);
				nativeEntryId = coldResult.nativeEntryId;
				afterEstimate = coldResult.afterEstimate;
				this.owed.set(file.source, { verified, nativeEntryId });
				file.revision++;
			}
			if (session) {
				try { const tokens = session.getContextUsage()?.tokens; if (typeof tokens === "number" && Number.isFinite(tokens)) afterEstimate = tokens; }
				catch { /* Missing measurement is not permission for a second native effect. */ }
			}
			await this.ports.acknowledge(verified.prepared, {
				nativeEntryId,
				fence: this.captureFence(verified.fence.sessionId),
				recovered: false,
			});
			file.recovery = false;
			file.pendingSparse = undefined;
			this.owed.delete(file.source);
			return this.status(verified, "applied", undefined, nativeEntryId, afterEstimate);
		} catch {
			// Even an uncertain worker outcome is recovery-required; never issue a blind retry cut.
			file.recovery = true;
			return this.status(verified, "blocked", "native-recovery-required", nativeEntryId);
		} finally {
			this.admission.release(file);
		}
	}
	/** Retains the admission hold on any failure. No provider may enter through input until repaired. */
	async recover(sessionId: string): Promise<void> {
		const fence = this.captureFence(sessionId);
		const file = this.admission.file(fence.source);
		const owed = this.owed.get(file.source);
		if (!file.recovery || file.locked || !owed) throw new Error("recovery-not-ready");
		file.locked = true;
		try {
			if (!file.session) {
				const result = await this.ports.coldApply(owed.verified);
				await this.ports.acknowledge(owed.verified.prepared, { ...result, fence, recovered: true });
				file.recovery = false;
				file.pendingSparse = undefined;
				file.generation++;
				file.revision++;
				this.owed.delete(file.source);
				return;
			}
			await this.ports.verifySource(file.source, sessionId);
			const replacement = await this.admission.owned(file, () => this.ports.reconstruct(file.source, file.session!));
			const recoveredId = owed.verified.draft.strategy === "sparse"
				? await this.admission.owned(file, async () => {
					const result = await this.ports.sparse!.apply(replacement, owed.verified);
					await syncNativeFile(file.source);
					replacement.refreshContext();
					return result.nativeEntryId;
				})
				: appliedEntry(replacement, owed.verified.prepared);
			if (replacement.sessionId !== sessionId || (owed.nativeEntryId && recoveredId !== owed.nativeEntryId))
				throw new Error("native-recovery-mismatch");
			await syncNativeFile(file.source);
			if (recoveredId)
				await this.ports.acknowledge(owed.verified.prepared, { nativeEntryId: recoveredId, fence, recovered: true });
			this.admission.recovered(file, replacement);
			file.pendingSparse = undefined;
			this.admission.owned(file, () => this.attach(replacement));
			this.ports.invalidate(replacement);
			this.owed.delete(file.source);
		} catch (error) {
			file.recovery = true;
			throw error;
		} finally {
			this.admission.release(file);
		}
	}
	nativePairMilliseconds(source: string): number | undefined {
		return this.spans.get(source);
	}
}
