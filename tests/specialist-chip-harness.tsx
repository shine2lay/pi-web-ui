// Browser-only fixed cases for the specialist chip (department-specialists, Ops #1101): the REAL TaskQueuePanel and
// the REAL header IdentityTag. Never part of the app bundle (rule 29): `specialist-chip-ui-check.mjs` bundles this and
// serves it so ui-check can measure every state at 320/390/1440 in light and dark.
//
// `?state=` picks the case: queue (a header in a specialist's task chat above a Queue with a started specialist task
// (title chip), a waiting one (slug chip), a long-titled one and a plain one), long (a very long specialist title and
// task title, to prove the chip shrinks instead of overflowing), plain (no specialist anywhere: no chip).
import { createRoot } from "react-dom/client";
import { IdentityTag } from "../web/src/components/IdentityTag";
import { TaskQueuePanel } from "../web/src/components/TaskQueuePanel";
import { LanguageProvider } from "../web/src/i18n";
import type { SpecialistChatIdentity, SpecialistTaskFields } from "../web/src/specialist-chip";
import type { UiChatIdentity, UiTaskQueue, UiTaskQueueTask } from "../web/src/types";
import "../web/src/styles.css";

const state = new URLSearchParams(window.location.search).get("state") ?? "queue";
const plan = (title: string) => ({
	title,
	goal: "Find why the checkout test fails one run in twenty",
	doneWhen: "Twenty runs in a row pass",
	decided: "Look at timing first",
	steps: "1. Run it 50 times\n2. Read the failures",
	verify: "50 green runs",
	mustNot: "Skip the test",
});
type Task = UiTaskQueueTask & SpecialistTaskFields;
const LONG = "Payment suite flaky-test hunter with a very long name that keeps going";
const launch = (title: string) => ({ from: { model: "app", thinking: "app", speed: "app" }, specialist: { title } });
const tasks: Task[] =
	state === "plain"
		? [
				{ id: 7, status: "working", plan: plan("Hunt the flaky checkout test"), addedAt: 1, lane: true },
				{ id: 8, status: "ready", plan: plan("Write the release notes"), addedAt: 2 },
			]
		: [
				{
					id: 7,
					status: "working",
					plan: plan("Hunt the flaky checkout test"),
					addedAt: 1,
					lane: true,
					specialist: "flaky-hunter",
					launch: launch(state === "long" ? LONG : "Flaky Hunter"),
				} as Task,
				{
					id: 8,
					status: "ready",
					plan: plan(state === "long" ? `${LONG} and then some more words for the task title` : "Re-run the suite"),
					addedAt: 2,
					specialist: state === "long" ? "a-very-long-specialist-slug-that-is-forty" : "flaky-hunter",
				},
				{ id: 9, status: "ready", plan: plan("Write the release notes"), addedAt: 3 },
			];
const queue: UiTaskQueue = { queueId: "qa", running: true, available: true, tasks };
const identity: UiChatIdentity & SpecialistChatIdentity =
	state === "plain"
		? { id: "qa", title: "QA" }
		: { id: "qa", title: "QA", specialist: { slug: "flaky-hunter", title: state === "long" ? LONG : "Flaky Hunter" } };

const host = document.createElement("div");
document.body.style.cssText = "margin:0;min-height:100vh;background:var(--bg)";
document.body.append(host);

function Page() {
	return (
		<main className="main" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
			<div className="chat-header">
				<h1 className="chat-header-title" title="QA · Queue #7">
					QA · Queue #7
				</h1>
				<div className="chat-header-tools" role="toolbar" aria-label="Chat header">
					<IdentityTag identity={identity} onClick={() => {}} className="chat-header-identity" />
				</div>
			</div>
			<div style={{ padding: 8 }}>
				<TaskQueuePanel queue={queue} conversationId="c-qa" onCommand={() => {}} />
			</div>
		</main>
	);
}

createRoot(host).render(
	<LanguageProvider>
		<Page />
	</LanguageProvider>,
);
