import { useEffect, useRef, type MutableRefObject } from "react";
import {
	composerRecovery,
	sameComposerBinding,
	type ComposerAttachmentHost,
	type ComposerConnection,
	type ComposerHostSnapshot,
} from "./recovery-composer";

interface Props {
	host?: ComposerAttachmentHost;
	text: MutableRefObject<string>;
	textRevision: MutableRefObject<number>;
	setText(text: string): void;
	conversationId?: string;
	sessionId?: string;
	problem(text: string): void;
	applied?(): void;
}
interface Cursor {
	connection: ComposerConnection;
	composerId: string;
	revision: number;
	textRevision: number;
	attachmentRevision: number;
}
const sameConnection = (a: ComposerConnection, b: ComposerConnection) =>
	a.ownerId === b.ownerId &&
	a.conversationId === b.conversationId &&
	a.sessionId === b.sessionId &&
	a.lifetime === b.lifetime;

/** Keep authoritative refs ahead of React scheduling; publish a complete draft in one
 * guarded callback. The document's native recovery owner supplies cross-tab exclusion. */
export function useComposerRecovery(props: Props): void {
	const latest = useRef(props);
	latest.current = props;
	const cursor = useRef<Cursor | null>(null);
	useEffect(() => {
		let live = true;
		const connection = () => {
			const p = latest.current;
			const next = live ? p.host?.read() : null;
			return next && next.conversationId === p.conversationId && next.sessionId === p.sessionId ? next : null;
		};
		const snapshot = (): ComposerHostSnapshot | null => {
			const next = connection();
			if (!next) return null;
			const p = latest.current;
			let current = cursor.current;
			if (!current || !sameConnection(current.connection, next)) {
				current = {
					connection: next,
					composerId: crypto.randomUUID(),
					revision: 0,
					textRevision: p.textRevision.current,
					attachmentRevision: next.attachmentRevision,
				};
				cursor.current = current;
			} else if (
				current.textRevision !== p.textRevision.current ||
				current.attachmentRevision !== next.attachmentRevision
			) {
				current.revision++;
				current.textRevision = p.textRevision.current;
				current.attachmentRevision = next.attachmentRevision;
			}
			return {
				binding: {
					ownerId: next.ownerId,
					conversationId: next.conversationId,
					sessionId: next.sessionId,
					composerId: current.composerId,
					revision: current.revision,
				},
				draft: { text: p.text.current, attachments: next.attachments },
			};
		};
		const detach = composerRecovery().attach({
			snapshot,
			apply(original, record) {
				const before = snapshot();
				const target = connection();
				const p = latest.current;
				if (!before || !target || !p.host || !sameComposerBinding(before.binding, original.binding)) return false;
				// The data is already strictly validated and frozen. Give React fresh, complete
				// owned copies, never plugin-owned objects. The full original is saved first.
				const effective = structuredClone(record.effective);
				if (!p.host.replace(target, [...effective.attachments])) return false;
				p.setText(effective.text);
				const after = connection();
				if (!after || !sameConnection(after, target)) return false;
				cursor.current = {
					connection: after,
					composerId: record.binding.composerId,
					revision: record.nextRevision,
					textRevision: p.textRevision.current,
					attachmentRevision: after.attachmentRevision,
				};
				p.applied?.();
				return true;
			},
			problem: (message) => latest.current.problem(message),
		});
		return () => {
			live = false;
			detach();
			cursor.current = null;
		};
	}, []);
}
