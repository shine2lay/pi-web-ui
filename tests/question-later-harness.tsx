// Browser-only fixed cases for the ACTUAL question dialog and its keep-for-later bar (Ops #1087). Never part of the
// app bundle (rule 29): `question-later-ui-check.mjs` bundles this and serves it so ui-check can measure every state
// at 320/390/1440 in light and dark.
//
// `?state=` picks the case: dialog (a waiting question popped up, footer Later + Cancel question), bar (one question
// kept for later: the one-line bar above the composer), bar-many (two kept: count + next), reopened (the bar's
// Answer opened the dialog in place).
import { createRoot } from "react-dom/client";
import { ChatOwnerQuestion } from "../web/src/components/DshQuestionDialog";
import { LanguageProvider } from "../web/src/i18n";
import "../web/src/styles.css";

const state = new URLSearchParams(window.location.search).get("state") ?? "dialog";

const PORT = {
	id: "q-port",
	conversationId: "c-ops",
	conversationTitle: "Ops lead",
	questions: [
		{
			id: "port",
			header: "Which port should the preview server use?",
			question: "The preview server needs a port. **8080** is free today; **3000** is what the other apps use.",
			options: [
				{ label: "8080", description: "Free now; nothing else to move." },
				{ label: "3000", description: "Same as the other apps; one of them has to move first." },
			],
		},
	],
};
const RELEASE = {
	id: "q-release",
	conversationId: "c-ops",
	conversationTitle: "Ops lead",
	questions: [
		{
			id: "when",
			question: "Release the new installer tonight or wait for Monday's check?",
			options: [{ label: "Tonight" }, { label: "Monday" }],
		},
	],
};

const host = document.createElement("div");
host.style.cssText = "height:100vh;width:100%;display:flex";
document.body.style.cssText = "margin:0;height:100vh;background:var(--bg)";
document.body.append(host);

function Chat() {
	const popped = state === "dialog" ? PORT : null;
	const saved = state === "bar-many" ? [PORT, RELEASE] : state === "dialog" ? [] : [PORT];
	return (
		<main className="main" style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
			<div className="chat-header">
				<span>Ops lead</span>
			</div>
			<div style={{ flex: 1, overflow: "auto", padding: 16 }}>
				<p>I posted the port question; I will carry on with the docs while it waits.</p>
			</div>
			<ChatOwnerQuestion question={popped} savedQuestions={saved} waitingOn={null} />
			<div style={{ padding: 12 }}>
				<textarea aria-label="Message" placeholder="Message" style={{ width: "100%", boxSizing: "border-box" }} />
			</div>
		</main>
	);
}

createRoot(host).render(
	<LanguageProvider>
		<Chat />
	</LanguageProvider>,
);

// reopened: press the bar's Answer once it rendered, as the owner would.
if (state === "reopened") {
	const press = () => {
		const answer = document.querySelector<HTMLButtonElement>(".question-later-answer");
		if (answer) answer.click();
		else setTimeout(press, 20);
	};
	press();
}
