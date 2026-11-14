import { request as proxyRequest, type IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";

// The prefix rules moved here from server/plugins.ts (showtell-owner-answer, ops #883, keeps plugins.ts at its size).
/** 通用代理前缀的保留字：命中即拒绝注册（宿主自用路径，代理抢了会吞掉主站功能）。 */
export const PROXY_RESERVED_PREFIXES = [
	"/api",
	"/ws",
	"/plugins",
	"/plugins-api",
	"/assets",
	"/icons",
	"/themes",
] as const;

/** 代理目标（只允许回环，防 SSRF：插件借宿主端口只能把本机服务露出来）。 */
export interface PluginProxyTarget {
	host: string;
	port: number;
}

/** 校验并归一化代理前缀：合法返回去尾斜杠的小写形式，否则返回 null（纯函数，单测覆盖）。 */
export function normalizeProxyPrefix(prefix: string): string | null {
	if (typeof prefix !== "string") return null;
	let p = prefix.trim();
	if (!p.startsWith("/") || p.length < 2) return null;
	// 去尾斜杠（"/liveserver/" → "/liveserver"）
	while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	if (!/^[A-Za-z0-9/_-]+$/.test(p) || p.includes("//")) return null;
	const lower = p.toLowerCase();
	for (const r of PROXY_RESERVED_PREFIXES) {
		if (lower === r || lower.startsWith(`${r}/`)) return null;
	}
	return lower;
}

/** 校验代理目标：只收 127.0.0.1/localhost + 合法端口（纯函数，单测覆盖）。 */
export function normalizeProxyTarget(target: unknown): PluginProxyTarget | null {
	const port = typeof target === "number" ? target : (target as { port?: unknown })?.port;
	const hostRaw =
		typeof target === "number" ? "127.0.0.1" : String((target as { host?: unknown })?.host ?? "127.0.0.1");
	const host = hostRaw.trim().toLowerCase();
	if (host !== "127.0.0.1" && host !== "localhost") return null;
	if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
	return { host: "127.0.0.1", port: port as number };
}

/** 在请求路径上做最长前缀匹配（边界对齐：prefix 本身或 prefix + "/" 开头才算命中）。 */
export function matchProxyPrefix(path: string, prefixes: Iterable<string>): string | undefined {
	let best: string | undefined;
	for (const p of prefixes) {
		if (path === p || path.startsWith(`${p}/`)) {
			if (!best || p.length > best.length) best = p;
		}
	}
	return best;
}

/** 通用插件代理（host.registerProxy 注册的前缀落到这里）：去前缀后原样透传到
 *  127.0.0.1:port——相对路径/Range/SSE 天然可用。PI_WEB_TOKEN 鉴权由 server/index.ts 的上游中间件覆盖。
 *  Moved out of server/index.ts (Ops #633) so tests/unit/plugin-proxy-close.test.ts can drive it. */
export type ProxyHit = { prefix: string; pluginId: string; host: string; port: number };

export function proxyForwardPath(hit: ProxyHit, url: string): string {
	let fwd = String(url ?? "/").slice(hit.prefix.length);
	if (!fwd.startsWith("/")) fwd = `/${fwd}`;
	return fwd || "/";
}

/** showtell-owner-answer (ops #883): told the upstream's status and answer (its first `max` bytes) once it ended. */
export type ProxyObserver = { max: number; done(status: number, responseText: string): void };

/** What the proxy middleware needs of the plugin manager (server/plugins.ts PluginManager). */
export interface ProxyRoutes {
	findProxy(path: string): ProxyHit | undefined;
	/** showtell-owner-answer (ops #883): server/owner-front-door.ts OwnerFrontDoor. */
	ownerFrontDoor?: { observerFor(hit: ProxyHit, req: Request): ProxyObserver | undefined };
}

/** 通用插件代理（host.registerProxy 注册的前缀落到这里）：去前缀后原样透传到 127.0.0.1:port。必须站在静态资源与
 *  SPA catch-all 之前，否则子路径被 index.html 吞掉 (server/index.ts). A request that may be the owner's own
 *  action through a plugin's front door is watched to its answer (ops #883). `routesOf` is read per request. */
export function pluginProxyMiddleware(routesOf: () => ProxyRoutes) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const routes = routesOf();
		const hit = routes.findProxy(req.path);
		if (!hit) {
			next();
			return;
		}
		proxyHttp(hit, req, res, undefined, routes.ownerFrontDoor?.observerFor(hit, req));
	};
}

/** timeoutMs: the upstream socket idle timeout (default 30000, as before); tests pass a short one.
 *  observe: only for a request that may be an owner action (server/owner-front-door.ts). */
export function proxyHttp(
	hit: ProxyHit,
	req: Request,
	res: Response,
	timeoutMs = 30000,
	observe?: ProxyObserver,
): void {
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
			if (observe) {
				const chunks: Buffer[] = [];
				let size = 0;
				r.on("data", (c: Buffer) => {
					if (size >= observe.max) return;
					chunks.push(c);
					size += c.length;
				});
				r.on("end", () => {
					try {
						observe.done(r.statusCode ?? 502, Buffer.concat(chunks).subarray(0, observe.max).toString("utf8"));
					} catch (err) {
						console.error(`[proxy:${hit.prefix}] observer failed:`, err);
					}
				});
			}
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
