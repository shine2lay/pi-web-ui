import { request as proxyRequest, type IncomingMessage } from "node:http";
import type { Request, Response } from "express";

/** 通用插件代理（host.registerProxy 注册的前缀落到这里）：去前缀后原样透传到
 *  127.0.0.1:port——相对路径/Range/SSE 天然可用。PI_WEB_TOKEN 鉴权由 server/index.ts 的上游中间件覆盖。
 *  Moved out of server/index.ts (Ops #633) so tests/unit/plugin-proxy-close.test.ts can drive it. */
export type ProxyHit = { prefix: string; pluginId: string; host: string; port: number };

export function proxyForwardPath(hit: ProxyHit, url: string): string {
	let fwd = String(url ?? "/").slice(hit.prefix.length);
	if (!fwd.startsWith("/")) fwd = `/${fwd}`;
	return fwd || "/";
}

/** timeoutMs: the upstream socket idle timeout (default 30000, as before); tests pass a short one. */
export function proxyHttp(hit: ProxyHit, req: Request, res: Response, timeoutMs = 30000): void {
	const fwdPath = proxyForwardPath(hit, req.url ?? "/");
	const headers: Record<string, string | string[]> = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (v === undefined) continue;
		if (k.toLowerCase() === "host") continue;
		if (k.toLowerCase() === "content-length" && req.method !== "GET" && req.method !== "HEAD") continue;
		headers[k] = v as string | string[];
	}
	// 内页拼 SSE/资源绝对地址用（子路径反代下 import.meta 推导不到前缀，靠这个头）。
	headers["x-pi-proxy-prefix"] = hit.prefix;
	let body: Buffer | undefined;
	if (req.method !== "GET" && req.method !== "HEAD" && (req as unknown as { body?: unknown }).body !== undefined) {
		const b = (req as unknown as { body?: unknown }).body;
		if (Buffer.isBuffer(b)) body = b;
		else if (typeof b === "string") body = Buffer.from(b);
		else if (b !== undefined) {
			body = Buffer.from(JSON.stringify(b));
			if (!headers["content-type"]) headers["content-type"] = "application/json";
		}
		if (body) headers["content-length"] = String(body.length);
	}
	// Ops #633 (H-PROXY-CLOSE-1): a pipe never destroys its source when the browser goes away, and SSE keepalives
	// keep the idle timeout from firing, so a closed proxied stream used to hold its upstream socket forever.
	let clientGone = false;
	let upRes: IncomingMessage | undefined;
	const up = proxyRequest(
		{ host: hit.host, port: hit.port, method: req.method, path: fwdPath, headers, timeout: timeoutMs },
		(r) => {
			upRes = r;
			if (clientGone) {
				r.destroy();
				return;
			}
			// Upstream aborted or errored after the headers went out: break the browser's stream instead of a hang.
			r.on("error", () => {
				if (!clientGone) res.destroy();
			});
			r.on("close", () => {
				if (!r.complete && !clientGone) res.destroy();
			});
			const out: Record<string, string | string[]> = {};
			for (const [k, v] of Object.entries(r.headers)) {
				if (v === undefined) continue;
				const lk = k.toLowerCase();
				if (lk === "connection" || lk === "keep-alive" || lk === "transfer-encoding" || lk === "upgrade") continue;
				out[k] = v as string | string[];
			}
			res.writeHead(r.statusCode ?? 502, out);
			r.pipe(res);
		},
	);
	up.on("timeout", () => up.destroy(new Error("proxy timeout")));
	up.on("error", (err) => {
		if (clientGone) return; // our own destroy below, not a failure
		console.error(`[proxy:${hit.prefix}] → 127.0.0.1:${hit.port}${fwdPath} failed:`, err);
		if (!res.headersSent) res.status(502).end("proxy target unreachable");
		else res.destroy();
	});
	// Browser gone before the response finished: free the upstream request and its socket.
	res.on("close", () => {
		if (res.writableFinished) return;
		clientGone = true;
		up.destroy();
		upRes?.destroy();
	});
	if (body) up.end(body);
	else req.pipe(up);
}
