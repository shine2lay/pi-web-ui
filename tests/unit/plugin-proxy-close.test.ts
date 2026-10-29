/**
 * Ops #633 (H-PROXY-CLOSE-1): the plugin proxy (server/plugin-proxy.ts proxyHttp) frees the upstream
 * connection when the browser goes away before the response has finished, and still behaves as before
 * for finished requests and live SSE. In-process fake upstream + express proxy on 127.0.0.1, no model calls.
 * The existing tests/unit/plugin-proxy.test.ts covers prefix registration and stays millisecond-fast.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { proxyForwardPath, proxyHttp, type ProxyHit } from "../../server/plugin-proxy.js";

type UpClose = { path: string; finished: boolean; at: number };
type UpSeen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
type Upstream = { port: number; server: Server; closes: UpClose[]; seen: UpSeen[]; connections: () => Promise<number> };
type ProxyWrite = { what: string; afterClose: boolean };
type Proxy = { port: number; server: Server; writeHeads: unknown[][]; writes: ProxyWrite[] };

const servers: Server[] = [];
const timers: NodeJS.Timeout[] = [];
const PREFIX = "/px";

function listen(server: Server): Promise<number> {
	servers.push(server);
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	for (;;) {
		if (await pred()) return true;
		if (Date.now() >= end) return false;
		await sleep(20);
	}
}

function every(ms: number, fn: () => void): NodeJS.Timeout {
	const t = setInterval(fn, ms);
	timers.push(t);
	return t;
}

async function startUpstream(): Promise<Upstream> {
	const closes: UpClose[] = [];
	const seen: UpSeen[] = [];
	const server = createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0] ?? "/";
		res.on("close", () => closes.push({ path, finished: res.writableFinished, at: Date.now() }));
		let body = "";
		req.on("data", (c: Buffer) => (body += c.toString()));
		req.on("end", () => {
			seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
			route(path, req, res, body);
		});
	});
	const port = await listen(server);
	const connections = () => new Promise<number>((r, j) => server.getConnections((e, n) => (e ? j(e) : r(n))));
	return { port, server, closes, seen, connections };
}

function route(path: string, req: IncomingMessage, res: ServerResponse, body: string): void {
	if (path === "/finite") {
		res.writeHead(200, { "content-type": "text/plain", "x-up": "1" });
		res.end("hello world");
	} else if (path === "/echo" || path.startsWith("/echo/")) {
		res.writeHead(200, {
			"content-type": "application/json",
			upgrade: "test-upgrade",
			"keep-alive": "timeout=77",
			"x-up": "echo",
		});
		res.end(JSON.stringify({ method: req.method, url: req.url, body }));
	} else if (path.startsWith("/status/")) {
		res.writeHead(Number(path.slice("/status/".length)), { "content-type": "text/plain" });
		res.end("status body");
	} else if (path === "/sse") {
		// Show&Tell-like stream: one event at once, then keepalive comments every 100 ms.
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write("data: hello\n\n");
		const t = every(100, () => res.write(": ka\n\n"));
		res.on("close", () => clearInterval(t));
	} else if (path === "/sse-count") {
		res.writeHead(200, { "content-type": "text/event-stream" });
		let n = 0;
		const t = every(100, () => res.write(`data: ${n++}\n\n`));
		res.on("close", () => clearInterval(t));
	} else if (path === "/slow") {
		// Finite response that takes 5 s: half now, the rest later.
		res.writeHead(200, { "content-type": "text/plain", "content-length": "10" });
		res.write("12345");
		const t = setTimeout(() => res.end("67890"), 5000);
		timers.push(t);
		res.on("close", () => clearTimeout(t));
	} else if (path === "/die") {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write("data: 1\n\n");
		const t = setTimeout(() => res.socket?.destroy(), 100);
		timers.push(t);
	} else if (path === "/late-headers") {
		const t = setTimeout(() => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("late");
		}, 1500);
		timers.push(t);
		res.on("close", () => clearTimeout(t));
	} else {
		res.writeHead(404).end();
	}
}

async function startProxy(upPort: number, timeoutMs?: number): Promise<Proxy> {
	const writeHeads: unknown[][] = [];
	const writes: ProxyWrite[] = [];
	const hit: ProxyHit = { prefix: PREFIX, pluginId: "t", host: "127.0.0.1", port: upPort };
	const app = express();
	app.use(express.json({ limit: "10mb" }));
	app.use((req, res) => {
		let closed = false;
		res.on("close", () => (closed = true));
		const origWriteHead = res.writeHead.bind(res) as (...a: unknown[]) => unknown;
		(res as unknown as { writeHead: (...a: unknown[]) => unknown }).writeHead = (...a: unknown[]) => {
			writeHeads.push(a);
			writes.push({ what: `writeHead ${String(a[0])}`, afterClose: closed });
			return origWriteHead(...a);
		};
		const origStatus = res.status.bind(res);
		res.status = (code: number) => {
			writes.push({ what: `status ${code}`, afterClose: closed });
			return origStatus(code);
		};
		if (timeoutMs === undefined) proxyHttp(hit, req, res);
		else proxyHttp(hit, req, res, timeoutMs);
	});
	const server = createServer(app);
	const port = await listen(server);
	return { port, server, writeHeads, writes };
}

type ClientRes = { status: number; headers: IncomingMessage["headers"]; body: string };
function fetchVia(
	port: number,
	path: string,
	opts: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<ClientRes> {
	return new Promise((resolve, reject) => {
		const req = request(
			{ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers, agent: false },
			(res) => {
				let body = "";
				res.on("data", (c: Buffer) => (body += c.toString()));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.end(opts.body);
	});
}

/** Opens a request through the proxy; resolves once `ready` sees the received text (or at once for "sent"). */
function openVia(port: number, path: string, until: string | null) {
	let text = "";
	let ended = false;
	let errored = false;
	const req = request({ host: "127.0.0.1", port, path, agent: false });
	req.on("error", () => (errored = true));
	const ready = new Promise<void>((resolve) => {
		if (until === null) resolve();
		req.on("response", (res) => {
			res.on("data", (c: Buffer) => {
				text += c.toString();
				if (until !== null && text.includes(until)) resolve();
			});
			res.on("end", () => (ended = true));
			res.on("error", () => (errored = true));
			res.on("close", () => (ended = true));
		});
	});
	req.end();
	return {
		ready,
		abort: () => req.destroy(),
		text: () => text,
		done: () => ended || errored,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const t of timers.splice(0)) clearTimeout(t);
	for (const s of servers.splice(0)) {
		s.closeAllConnections();
		await new Promise<void>((r) => s.close(() => r()));
	}
});

describe("plugin proxy: upstream freed when the client goes away (H-PROXY-CLOSE-1)", () => {
	it("case 1: finite GET completes with body and status intact, upstream response finished normally", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const up = await startUpstream();
		const px = await startProxy(up.port);
		const r = await fetchVia(px.port, `${PREFIX}/finite`);
		expect(r.status).toBe(200);
		expect(r.body).toBe("hello world");
		expect(r.headers["x-up"]).toBe("1");
		expect(await waitFor(() => up.closes.length === 1, 1000)).toBe(true);
		expect(up.closes[0]?.finished).toBe(true);
		expect(err).not.toHaveBeenCalled();
	});

	it("case 2: POST JSON body forwarded intact", async () => {
		const up = await startUpstream();
		const px = await startProxy(up.port);
		const sent = { a: 1, text: "héllo", list: [1, 2, 3] };
		const r = await fetchVia(px.port, `${PREFIX}/echo`, {
			method: "POST",
			body: JSON.stringify(sent),
			headers: { "content-type": "application/json" },
		});
		expect(r.status).toBe(200);
		const echoed = JSON.parse(r.body) as { method: string; body: string };
		expect(echoed.method).toBe("POST");
		expect(JSON.parse(echoed.body)).toEqual(sent);
		expect(up.seen[0]?.headers["content-type"]).toBe("application/json");
	});

	it("case 3: SSE client aborting after the first event frees the upstream within 1 s, 10 times over", async () => {
		const up = await startUpstream();
		const px = await startProxy(up.port);
		const baseline = await up.connections();
		const closedInTime: boolean[] = [];
		for (let i = 0; i < 10; i++) {
			const c = openVia(px.port, `${PREFIX}/sse`, "data: hello");
			await c.ready;
			const before = up.closes.length;
			c.abort();
			closedInTime.push(await waitFor(() => up.closes.length > before, 1000));
		}
		const settled = await waitFor(async () => (await up.connections()) === baseline, 1000);
		const after = await up.connections();
		expect({ closedInTime: closedInTime.filter(Boolean).length, connections: after, settled }).toEqual({
			closedInTime: 10,
			connections: baseline,
			settled: true,
		});
		expect(up.closes.every((c) => !c.finished)).toBe(true);
	}, 30000);

	it("case 4: client aborting during a slow finite response destroys the upstream", async () => {
		const up = await startUpstream();
		const px = await startProxy(up.port);
		const c = openVia(px.port, `${PREFIX}/slow`, "12345");
		await c.ready;
		c.abort();
		expect(await waitFor(() => up.closes.length === 1, 1000)).toBe(true);
		expect(up.closes[0]?.finished).toBe(false);
		expect(await waitFor(async () => (await up.connections()) === 0, 1000)).toBe(true);
	}, 15000);

	it("case 5: live SSE with keepalives shorter than timeoutMs stays open past several timeout periods", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const up = await startUpstream();
		const px = await startProxy(up.port, 300);
		const c = openVia(px.port, `${PREFIX}/sse-count`, "data: 0");
		await c.ready;
		await sleep(1300);
		const events = (c.text().match(/^data: \d+$/gm) ?? []).length;
		expect(events).toBeGreaterThanOrEqual(8);
		expect(c.done()).toBe(false);
		expect(up.closes.length).toBe(0);
		expect(err).not.toHaveBeenCalled();
		c.abort();
	}, 15000);

	it("case 6: upstream dying mid-stream after headers ends the client response within 1 s", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const up = await startUpstream();
		const px = await startProxy(up.port);
		const c = openVia(px.port, `${PREFIX}/die`, "data: 1");
		await c.ready;
		expect(await waitFor(() => c.done(), 1100)).toBe(true);
		c.abort();
	}, 15000);

	it("case 7: unreachable upstream answers 502 'proxy target unreachable'", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const probe = createServer();
		const deadPort = await listen(probe);
		servers.pop();
		await new Promise<void>((r) => probe.close(() => r()));
		const px = await startProxy(deadPort);
		const r = await fetchVia(px.port, `${PREFIX}/anything`);
		expect(r.status).toBe(502);
		expect(r.body).toBe("proxy target unreachable");
		expect(err).toHaveBeenCalledTimes(1);
	});

	it("case 8: client aborting before upstream headers closes the upstream within 1 s, writes nothing, logs nothing", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const up = await startUpstream();
		const px = await startProxy(up.port);
		const c = openVia(px.port, `${PREFIX}/late-headers`, null);
		await waitFor(() => up.seen.length === 1, 1000);
		await sleep(100);
		c.abort();
		const closedInTime = await waitFor(() => up.closes.length === 1, 1000);
		await sleep(800); // past the upstream's 1.5 s header time
		expect({
			closedInTime,
			upstreamFinished: up.closes[0]?.finished,
			writesAfterClose: px.writes.filter((w) => w.afterClose).map((w) => w.what),
			errorLogs: err.mock.calls.length,
		}).toEqual({ closedInTime: true, upstreamFinished: false, writesAfterClose: [], errorLogs: 0 });
	}, 15000);

	it("case 9: forwarding strips the prefix, keeps the query, adds x-pi-proxy-prefix, drops host and hop-by-hop headers", async () => {
		const up = await startUpstream();
		const px = await startProxy(up.port);
		const raw = '{ "a" :   1 }';
		const r = await fetchVia(px.port, `${PREFIX}/echo/a?x=1&y=two`, {
			method: "POST",
			body: raw,
			headers: { "content-type": "application/json", "x-test": "a" },
		});
		expect(r.status).toBe(200);
		const s = up.seen[0];
		expect(s?.url).toBe("/echo/a?x=1&y=two");
		expect(s?.headers["x-pi-proxy-prefix"]).toBe(PREFIX);
		expect(s?.headers["x-test"]).toBe("a");
		expect(s?.headers.host).toBe(`127.0.0.1:${up.port}`);
		expect(s?.body).toBe('{"a":1}');
		expect(s?.headers["content-length"]).toBe("7");
		// The proxy hands writeHead the upstream's headers minus the hop-by-hop ones.
		const out = px.writeHeads[0]?.[1] as Record<string, unknown>;
		expect(out["x-up"]).toBe("echo");
		for (const h of ["connection", "keep-alive", "transfer-encoding", "upgrade"]) expect(out[h]).toBeUndefined();
		expect(r.headers.upgrade).toBeUndefined();
		expect(r.headers["keep-alive"]).not.toBe("timeout=77");
		for (const code of [404, 418, 503]) expect((await fetchVia(px.port, `${PREFIX}/status/${code}`)).status).toBe(code);
		expect(proxyForwardPath({ prefix: PREFIX, pluginId: "t", host: "127.0.0.1", port: 1 }, PREFIX)).toBe("/");
	});
});
