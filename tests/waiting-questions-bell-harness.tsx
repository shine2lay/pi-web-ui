// Browser-only fixed cases for the waiting-questions bell's list and its Answer dialog (Ops #1090). Never part of the
// app bundle (rule 29): `waiting-questions-bell-ui-test.mjs` bundles this and serves it so ui-check can measure every
// state at 320/390/1440 in light and dark (the real app's top bar is checked on the app itself).
//
// `?state=` picks the case: list (three questions: a role's, a regular chat's kept for later, an approval only its
// chat can answer), empty (nothing waiting), answer (the list's Answer opened the in-place form).
import { createRoot } from "react-dom/client";
import { setAppSend } from "../web/src/app-globals";
import { WaitingQuestionsModal } from "../web/src/components/WaitingQuestionsModal";
import { LanguageProvider } from "../web/src/i18n";
import { receiveOwnerAsks } from "../web/src/owner-asks-state";
import { receiveRoleAnswer } from "../web/src/roles-answer-state";
import type { ClientMessage, UiOwnerAskItem, UiRoleAskView } from "../web/src/types";
import "../web/src/styles.css";

const state = new URLSearchParams(window.location.search).get("state") ?? "list";
const now = Date.now();

const ASKS: UiOwnerAskItem[] = [
	{
		askId: "q-7",
		kind: "question",
		title: "Question",
		summary: "Which port should the preview server use? 8080 is free today; 3000 is what the other apps use.",
		createdAt: now - 4 * 60_000,
		answerable: true,
		roleId: "ops",
		roleTitle: "ops/tooling",
		conversationId: "c-ops",
		conversationTitle: "Ops lead",
		sessionFile: "/data/sessions/ops-lead.jsonl",
	},
	{
		askId: "q-5",
		kind: "question",
		title: "Release timing",
		summary: "Release the new installer tonight or wait for Monday's check?",
		createdAt: now - 3 * 3_600_000,
		later: true,
		answerable: true,
		conversationId: "c-plain",
		conversationTitle: "Installer release notes and the Monday check",
		sessionFile: "/data/sessions/plain.jsonl",
	},
	{
		askId: "ap-2",
		kind: "approval",
		title: "Run a command",
		summary: "rm -rf build && npm run build",
		createdAt: now - 26 * 3_600_000,
		answerable: false,
		conversationId: "c-build",
		conversationTitle: "Build fix",
		sessionFile: "/data/sessions/build.jsonl",
	},
];

const VIEW: UiRoleAskView = {
	id: "q-7",
	revision: "a".repeat(64), // projectRoleAsk wants a 64-hex revision, else "cannot be shown safely" (QA #244 F5)
	kind: "question",
	title: "Which port should the preview server use?",
	fields: [
		{
			id: "port",
			text: "Which port should the preview server use?",
			options: [
				{ value: "8080", label: "8080", description: "Free now; nothing else to move." },
				{ value: "3000", label: "3000", description: "Same as the other apps; one of them has to move first." },
			],
			multi: false,
			allowText: true,
		},
	],
};

setAppSend((msg: ClientMessage) => {
	if (msg.type === "owner_ask_open")
		setTimeout(() => receiveRoleAnswer({ type: "owner_ask", reqId: msg.reqId, ok: true, ask: VIEW }), 10);
	return true;
});
receiveOwnerAsks({ type: "owner_asks", asks: state === "empty" ? [] : ASKS });

const host = document.createElement("div");
document.body.style.cssText = "margin:0;min-height:100vh;background:var(--bg);color:var(--text)";
host.innerHTML = "<p style='padding:16px'>The chat you were reading stays behind the list.</p>";
document.body.append(host);
const root = document.createElement("div");
document.body.append(root);

createRoot(root).render(
	<LanguageProvider>
		<WaitingQuestionsModal connected onClose={() => {}} onOpenChat={() => {}} />
	</LanguageProvider>,
);

// answer: press the first Answer once it rendered, as the owner would.
if (state === "answer") {
	const press = () => {
		const answer = document.querySelector<HTMLButtonElement>(".wq-answer");
		if (answer) answer.click();
		else setTimeout(press, 20);
	};
	press();
}
