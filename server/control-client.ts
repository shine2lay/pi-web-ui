// ---------------------------------------------------------------------------
// control-client.ts — the client side of the control socket (server/control-socket.ts)
// ---------------------------------------------------------------------------
// Where the socket is (controlPath) and one request/answer over it (askControl). askControl tells apart the
// three ways a request can end, because a caller that sends something (pi-web-ui notify, Ops #783) must know
// whether it may send again:
//   answered     the server answered with one JSON line;
//   unreachable  the request was never written (no socket, refused, no permission): nothing was sent;
//   no-answer    the request was written but no whole answer came (closed, timed out, not JSON): it may have
//                been acted on.
// ---------------------------------------------------------------------------

import { createConnection } from "node:net";
import { join } from "node:path";

/** Socket path (POSIX) or pipe name (Windows). */
export function controlPath(dataDir: string, port: number | string): string {
	return process.platform === "win32" ? `\\\\.\\pipe\\pi-web-ui-${port}` : join(dataDir, "pi-web-ui.sock");
}

/** How one control request ended (see the file's head). */
export type ControlOutcome =
	| { state: "answered"; answer: Record<string, unknown> }
	| { state: "unreachable"; why: string }
	| { state: "no-answer"; why: string };

/** Send one request (one JSON line) to the control socket at `path` and wait at most `timeoutMs` for its answer. */
export function askControl(path: string, request: Record<string, unknown>, timeoutMs: number): Promise<ControlOutcome> {
	if (typeof path !== "string" || !path) throw new TypeError("askControl: path is required");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("askControl: timeoutMs must be above 0");
	const line = `${JSON.stringify(request)}\n`;
	return new Promise((resolve) => {
		const sock = createConnection(path);
		let written = false;
		let done = false;
		let buf = "";
		const finish = (outcome: ControlOutcome): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolve(outcome);
		};
		const lost = (why: string): void => finish(written ? { state: "no-answer", why } : { state: "unreachable", why });
		const timer = setTimeout(
			() => lost(written ? `no answer within ${Math.round(timeoutMs / 1000)} s` : "couldn't connect in time"),
			timeoutMs,
		);
		sock.on("connect", () => {
			written = true;
			sock.write(line);
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			let answer: unknown;
			try {
				answer = JSON.parse(buf.slice(0, nl));
			} catch {
				finish({ state: "no-answer", why: "the answer wasn't JSON" });
				return;
			}
			if (answer && typeof answer === "object" && !Array.isArray(answer))
				finish({ state: "answered", answer: answer as Record<string, unknown> });
			else finish({ state: "no-answer", why: "the answer wasn't a JSON object" });
		});
		sock.on("error", (err: NodeJS.ErrnoException) => lost(err.code ?? err.message));
		sock.on("close", () => lost("the connection closed before an answer"));
	});
}
