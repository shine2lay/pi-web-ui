#!/usr/bin/env node
// Metadata-only control. Never opens a home, sends a model turn, or prints unrelated WS frames.
import { randomUUID } from "node:crypto";

const [action, roleOrLevel, sessionId, level] = process.argv.slice(2);
if (
	!["get", "set", "default"].includes(action) ||
	(action === "get" && !roleOrLevel) ||
	(action === "set" && (!roleOrLevel || !sessionId || !level)) ||
	(action === "default" && !["high", "off"].includes(roleOrLevel))
) {
	console.error("Usage: lead-thinking-control.mjs get ROLE | set ROLE SESSION_ID LEVEL | default high|off");
	process.exit(2);
}
const requestId = randomUUID();
const request = {
	type: "lead_thinking_control",
	requestId,
	action,
	...(action === "default" ? { level: roleOrLevel === "off" ? null : roleOrLevel } : { role: roleOrLevel }),
	...(action === "set" ? { sessionId, level } : {}),
};
const socket = new WebSocket("ws://127.0.0.1:8787/ws");
let finished = false;
const finish = (code, result) => {
	if (finished) return;
	finished = true;
	clearTimeout(timeout);
	console.log(JSON.stringify(result, null, 2));
	socket.close();
	process.exitCode = code;
};
const timeout = setTimeout(
	() =>
		finish(1, {
			ok: false,
			error: "No control receipt; check installed server supports lead_thinking_control. No request was retried.",
		}),
	15000,
);
socket.addEventListener("open", () => {
	socket.send(JSON.stringify({ type: "hello", clientId: "carry-on:lead-thinking-control", locale: "en" }));
	socket.send(JSON.stringify(request));
});
socket.addEventListener("message", (event) => {
	const message = JSON.parse(String(event.data));
	if (message.type === "lead_thinking_result" && message.requestId === requestId) finish(message.ok ? 0 : 1, message);
});
socket.addEventListener("error", () =>
	finish(1, { ok: false, error: "Control connection failed; no request retried." }),
);
socket.addEventListener("close", () => {
	if (!finished)
		finish(1, {
			ok: false,
			error: "Connection closed without a control receipt; inspect before retrying a write.",
		});
});
