/**
 * role-message-ladder (#122): shows the owner's oldest open approval question in A's dialog
 * (RoleMessageGuardApproval, viewer "owner"). The answer goes to the server over this page's socket
 * (role_guard_owner_answer); the server checks it again before anything is granted.
 */
import { useEffect, useState } from "react";
import "../role-message-guard.css";
import { answerRoleGuard, dismissRoleGuard, useRoleGuard } from "../role-guard-state";
import { guardApprovalView } from "../role-message-guard-view";
import { RoleMessageGuardApproval } from "./RoleMessageGuardApproval";

export function RoleGuardOwnerQuestions({ connected, language }: { connected: boolean; language: "en" | "zh" }) {
	const { questions, dismissed } = useRoleGuard();
	const [now, setNow] = useState(() => Date.now());
	const q = questions.find((x) => !dismissed.includes(x.questionId));
	useEffect(() => {
		if (!q) return;
		const t = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(t);
	}, [q]);
	if (!q) return null;
	const view = guardApprovalView({
		request: q.request,
		ownerQuestion: q.ownerQuestion,
		viewer: "owner",
		eligible: true,
		connected,
		nowMs: now,
		language,
	});
	return (
		<RoleMessageGuardApproval
			view={view}
			onDecision={(intent) => answerRoleGuard(q.questionId, q.generation, intent.choice)}
			onClose={() => dismissRoleGuard(q.questionId)}
		/>
	);
}
