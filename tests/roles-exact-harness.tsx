// Browser-only fixed cases for the ACTUAL component. Never part of the app bundle.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { RolesExactView } from "../web/src/components/RolesExactView";
import { resetRolesState, receiveRoles } from "../web/src/roles-state";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../web/src/app-globals";
import type { RolesPayload } from "../web/src/roles-state";
import type { UsefulOpenTarget } from "../web/src/roles-useful-model";

const names = [
	["architecture", "Architecture"],
	["backend", "Backend"],
	["coo", "COO"],
	["data", "Data"],
	["design", "Design"],
	["docs", "Docs"],
	["frontend", "Frontend"],
	["marketing", "Marketing"],
	["ops", "Ops"],
	["product", "Product"],
	["qa", "QA"],
	["rollcall", "RollCall"],
	["security", "Security"],
	["systems", "Systems"],
	["temper", "Temper"],
];
const home = (id: string) => `/tmp/roles-exact-fixture/${id}.jsonl`;
let lastOpen: UsefulOpenTarget | null = null;
let about: string | null = null;
const sent: string[] = [];
let active = true;
let badFonts = false;
let stamp = Date.now();
const host = document.createElement("div");
host.style.cssText = "height:100vh;width:100%;";
document.body.style.cssText = "margin:0;height:100vh;background:white";
document.body.append(host);
const root = createRoot(host);
resetAppGlobals();
setAppGlobals({ status: "open" });
setAppSend((message) => {
	sent.push(message.type);
	return true;
});
function render() {
	flushSync(() =>
		root.render(
			<RolesExactView
				active={active}
				fonts={badFonts ? { geist: new Uint8Array(), mono: new Uint8Array() } : undefined}
				onOpen={(target) => {
					lastOpen = target;
				}}
				onAbout={(id) => {
					about = id;
				}}
			/>,
		),
	);
}
function deliver(mode = "ready") {
	stamp += 10;
	const at = stamp;
	const roles = names.map(([id, title], i) => ({
		id,
		title,
		status: i % 4 === 0 ? "busy" : "idle",
		focus: `The ${title} department's current scope.`,
		workMode: "request-only",
		workModeFrom: "rules",
		spend:
			id === "design" ? { state: "ok", spent: "$1,240.50", budget: "$2,000", age: "2 min ago" } : { state: "none" },
		homeChat: { file: home(id), where: "home" },
		goals: [],
		requests: { open: i % 3 },
		tldr: [{ id: "progress", text: `${title} is working through its current request.`, ts: at - 60_000 }],
		report: {
			state: "report",
			date: "2026-10-17",
			sections: [
				{
					heading: "Done",
					text:
						mode === "long-report"
							? Array(1100).fill("line").join("\n")
							: "Checked the received request.\nRecorded the next step.",
				},
			],
		},
		queue: {
			running: true,
			active: [
				{
					id: 1,
					title: "Implement the supplied design",
					status: "working",
					busy: true,
					latest: { text: "Connecting the supplied page to existing data" },
					chat: { file: `/tmp/roles-exact-fixture/task-${id}.jsonl`, where: 1 },
				},
			],
			queued: [{ id: 2, title: "Connect missing tracking data afterwards", status: "ready" }],
			counts: { active: 1, queued: 1, done: 3 },
		},
	}));
	let asks = ["ops", "frontend"].map((id) => ({
		key: `${id}:tldr:question`,
		role: id,
		kind: "tldr",
		text: `A recorded question for ${id}`,
		since: at - 180_000,
		chat: { file: home(id), where: "home" },
	}));
	if (mode === "empty-inbox") asks = [];
	if (mode === "crowded")
		asks = Array.from({ length: 55 }, (_, i) => ({ ...asks[0], key: `ops:tldr:${i}`, text: `Recorded question ${i}` }));
	flushSync(() => {
		setAppGlobals({ status: "open" });
		if (mode === "loading" || mode === "first-error") resetRolesState();
		if (mode === "loading") return;
		if (mode === "first-error" || mode === "error") {
			receiveRoles({ type: "roles", error: "CANARY-PATH /private/do-not-render", asks: 0 } as RolesPayload);
			return;
		}
		const overview = {
			at,
			roles: mode === "empty" ? [] : roles,
			asks,
			work: { initiatives: [], projects: [], state: "ok" },
		};
		if (mode === "unsafe") {
			roles[8].focus = "<img src=x onerror=evil()>";
			roles[8].queue.active[0].title = "BAD\u202eTITLE";
		}
		if (mode === "partial") (roles[7].queue as unknown as Record<string, unknown>).active = "unreadable";
		const clock = Date.now;
		try {
			if (mode === "stale") Date.now = () => clock() - 180_000;
			receiveRoles({ type: "roles", overview, checkedAt: at } as unknown as RolesPayload);
			receiveRoles({ type: "roles", asks: asks.length, checkedAt: at + 1 } as RolesPayload);
		} finally {
			Date.now = clock;
		}
		if (mode === "disconnected") setAppGlobals({ status: "closed" });
	});
}
render();
Object.assign(window, {
	rolesExactTest: {
		deliver,
		getState: () => ({ sent: [...sent], lastOpen, about }),
		active: (value: boolean) => {
			active = value;
			render();
		},
		badFonts: () => {
			badFonts = true;
			render();
		},
		unmount: () => flushSync(() => root.unmount()),
	},
});
