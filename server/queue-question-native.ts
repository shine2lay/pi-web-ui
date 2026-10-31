/** Host-only native identity resolution; caller fields never supply a role or its home. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { identityIdOnBranch, liveChatIdentityId, samePath, type IdentityDef } from "./identities.js";
import { QuestionCommitCoordinator } from "./queue-question-commit.js";
import { QuestionCardDelivery } from "./queue-question-card.js";
import { supportsNativeQuestionWrite } from "./queue-question-durability.js";
import { questionEndpoint, type QuestionBinding, type QuestionCommitResult } from "./queue-question-port.js";
import { ownerQuestionChange } from "./queue-question-owner.js";
import { UnboundOwnerAcceptance, type QuestionAcceptanceSource } from "./queue-question-acceptance.js";
import { taskQueueAll } from "./task-queue.js";

/** Unsupported adapters keep legacy answers; recall is explicitly refused by the coordinator there. */
export function nativeOwnerQuestionBinding(session: AgentSession, id: number): QuestionBinding | undefined {
	if (!supportsNativeQuestionWrite(session.sessionManager)) return undefined;
	const endpoint = questionEndpoint(session.sessionManager.getSessionId());
	if (!endpoint) return undefined;
	// An owner-specific absence is authoritative: a retained recall receipt is not an active owner ask.
	return endpoint.ownerBinding ? endpoint.ownerBinding(id) : endpoint.binding(id);
}

export interface NativeQuestionHost {
	session(file: string): AgentSession | null;
	roles(): IdentityDef[];
	prepare(file: string): Promise<void>;
	dispatch(file: string, command: string): Promise<boolean>;
}
export function nativeQuestionHost(
	host: NativeQuestionHost,
	now: () => number = Date.now,
): {
	commits: QuestionCommitCoordinator;
	cards: QuestionCardDelivery;
	admitOwnerAnswer(binding: QuestionBinding, text: string, from: string): Promise<QuestionCommitResult>;
	observeUnboundOwnerAnswer(source: QuestionAcceptanceSource | undefined): void;
} {
	const acceptance = new UnboundOwnerAcceptance(now);
	const registered = (sessionId: string): AgentSession | undefined => {
		const endpoint = questionEndpoint(sessionId);
		const session = endpoint ? host.session(endpoint.file) : undefined;
		return session?.sessionManager.getSessionId() === sessionId &&
			session.sessionManager.getSessionFile() === endpoint?.file
			? session
			: undefined;
	};
	const roleOf = (session: AgentSession, roles: IdentityDef[]) =>
		liveChatIdentityId(
			identityIdOnBranch(session.sessionManager.getBranch()),
			session.sessionManager.getSessionFile(),
			roles,
		);
	const actor = (sourceSessionId: string, binding: QuestionBinding) => {
		const source = registered(sourceSessionId);
		const queue = registered(binding.queueId);
		if (!source || !queue || queue.sessionManager.getSessionFile() !== binding.queue) return undefined;
		const roles = host.roles();
		const department = roleOf(queue, roles);
		if (!department || roleOf(source, roles) !== department) return undefined;
		const homes = roles.filter((r) => r.id === department && r.homeChat);
		const home = homes.length === 1 ? homes[0].homeChat : undefined;
		const file = source.sessionManager.getSessionFile();
		return home && file ? { sessionId: sourceSessionId, file, department, home } : undefined;
	};
	const commits = new QuestionCommitCoordinator({
		actor,
		session: (file) => {
			const session = host.session(file);
			const manager = session?.sessionManager;
			return manager ? { file: manager.getSessionFile() ?? "", sessionId: manager.getSessionId(), manager } : undefined;
		},
		prepare: host.prepare,
		dispatch: host.dispatch,
		recallRefusal: ({ binding, actor }) => {
			// A validated owner_record can originate in a distinct parent queue, not only the lead home.
			// The coordinator already opened the bound queue and revalidated both native identities.
			return acceptance.refusalForSources(
				[...new Set([binding.queue, actor.home])].map((file) => host.session(file)?.sessionManager),
				binding.at,
			);
		},
	});
	return {
		commits,
		observeUnboundOwnerAnswer: (source) => {
			try {
				if (!source) throw new Error("accepted generic dialog has no native source identity");
				const session = host.session(source.file);
				if (
					!session ||
					session.sessionManager.getSessionId() !== source.sessionId ||
					session.sessionManager.getSessionFile() !== source.file
				)
					throw new Error("accepted generic dialog's native source session changed");
				// Reuse native queue replay, not a title/task-text match. Workers never gain root authority.
				if (taskQueueAll(session.sessionManager.getBranch()).from) return;
				const roles = host.roles();
				const department = roleOf(session, roles);
				const owners = roles.filter((role) => role.id === department && role.homeChat);
				const homes = roles.filter((role) => samePath(source.file, role.homeChat));
				if (
					registered(source.sessionId) !== session ||
					owners.length !== 1 ||
					homes.length > 1 ||
					(homes.length === 1 && homes[0].id !== department)
				)
					throw new Error("accepted generic dialog's native queue root or department home is missing or ambiguous");
				// Any registered native root may hold a parent owner_record; the marker grants no consent.
				acceptance.accepted(source, session.sessionManager);
			} catch (error) {
				acceptance.uncertain(source?.file, error);
			}
		},
		// Only native owner acceptance calls this; opening an arbitrary caller is NOT part of commitQuestion.
		admitOwnerAnswer: async (binding, text, from) => {
			await host.prepare(binding.worker);
			return commits.commitQuestion(binding.workerId, binding, ownerQuestionChange(binding, text, from));
		},
		cards: new QuestionCardDelivery({
			actor,
			prepare: host.prepare,
			source: (id) => {
				const source = registered(id);
				if (!source) return undefined;
				const roles = host.roles();
				const role = roleOf(source, roles);
				const homes = roles.filter((r) => r.id === role && r.homeChat);
				return homes.length === 1 && samePath(source.sessionManager.getSessionFile(), homes[0].homeChat)
					? source
					: undefined;
			},
		}),
	};
}
