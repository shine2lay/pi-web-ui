/// <reference lib="dom" />
/**
 * role-message-ladder (#122): the owner's open approval questions (role messages 12 and above, the COO asking
 * for itself, or the COO's one escalation), a module-level store.
 *
 * The server sends `role_guard_questions` to every window when they change, and to a window that asks
 * (`role_guard_get`, on every connect). The owner's answer goes back as `role_guard_owner_answer`; the server
 * answers this window with the same message plus `result`. Same pattern as subs-limits-state.ts.
 */
import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { ServerMessage, UiRoleGuardQuestion } from "./types";

export type RoleGuardPayload = Extract<ServerMessage, { type: "role_guard_questions" }>;

export interface RoleGuardState {
	questions: UiRoleGuardQuestion[];
	/** Question ids the owner closed in this window (they come back after a reload). */
	dismissed: string[];
}

/** An answer the server never confirms counts as unknown after this long (the dialog says so). */
export const ANSWER_TIMEOUT_MS = 30_000;

let state: RoleGuardState = { questions: [], dismissed: [] };
const listeners = new Set<() => void>();
const waiting = new Map<
	string,
	{ resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

function set(next: RoleGuardState): void {
	state = next;
	for (const l of listeners) l();
}

/** On every (re)connect. */
export function requestRoleGuard(): void {
	appSend({ type: "role_guard_get" });
}

/** `role_guard_questions` from the server. */
export function receiveRoleGuard(msg: RoleGuardPayload): void {
	const questions = Array.isArray(msg.questions) ? msg.questions : [];
	const open = new Set(questions.map((q) => q.questionId));
	set({ questions, dismissed: state.dismissed.filter((id) => open.has(id)) });
	const r = msg.result;
	if (!r) return;
	const w = waiting.get(r.questionId);
	if (!w) return;
	waiting.delete(r.questionId);
	clearTimeout(w.timer);
	if (r.ok) w.resolve();
	else w.reject(new Error(r.error ?? "not recorded"));
}

/** The owner's answer. Resolves once the server recorded it; rejects (unknown outcome) otherwise. */
export function answerRoleGuard(questionId: string, generation: string, choice: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (waiting.has(questionId)) return reject(new Error("already sending"));
		if (!appSend({ type: "role_guard_owner_answer", questionId, generation, choice }))
			return reject(new Error("not connected"));
		const timer = setTimeout(() => {
			waiting.delete(questionId);
			reject(new Error("no answer from the server"));
		}, ANSWER_TIMEOUT_MS);
		waiting.set(questionId, { resolve, reject, timer });
	});
}

/** Close the dialog for now (the question stays open on the server and in Telegram). */
export function dismissRoleGuard(questionId: string): void {
	if (!state.dismissed.includes(questionId)) set({ ...state, dismissed: [...state.dismissed, questionId] });
}

export function getRoleGuard(): RoleGuardState {
	return state;
}

function subscribe(l: () => void): () => void {
	listeners.add(l);
	return () => listeners.delete(l);
}

export function useRoleGuard(): RoleGuardState {
	return useSyncExternalStore(subscribe, getRoleGuard, getRoleGuard);
}

/** Tests only. */
export function resetRoleGuardForTest(): void {
	for (const w of waiting.values()) clearTimeout(w.timer);
	waiting.clear();
	state = { questions: [], dismissed: [] };
}
