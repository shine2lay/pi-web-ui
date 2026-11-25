/**
 * `pi_web_token` cookie helpers.
 *
 * The `Secure` attribute is set only when the request arrived over TLS.
 * Always setting it would break plaintext HTTP (loopback default); never
 * setting it leaks the token over the network on HTTPS deployments.
 * requestTokens / cookieToken moved here from index.ts (Ops #1090), beside the decoding they use.
 */
import type { IncomingMessage } from "node:http";

type TlsProbe = {
	socket?: unknown;
	secure?: boolean;
	headers?: Record<string, string | string[] | undefined>;
};

/** True when the browser connection is TLS: direct (`socket.encrypted`,
 *  express `req.secure`) or via a TLS-terminating proxy (`x-forwarded-proto`
 *  / RFC 7239 `forwarded`). */
export function isTlsRequest(req: TlsProbe): boolean {
	if ((req.socket as { encrypted?: boolean } | undefined | null)?.encrypted) return true;
	if (req.secure === true) return true;
	const proto = req.headers?.["x-forwarded-proto"];
	const first = Array.isArray(proto) ? proto[0] : proto;
	if (typeof first === "string" && first.split(",")[0]?.trim().toLowerCase() === "https") return true;
	const fwd = req.headers?.forwarded;
	const fwdFirst = Array.isArray(fwd) ? fwd[0] : fwd;
	if (typeof fwdFirst === "string" && /(?:^|[;,]\s*)proto=https(?:[;,]|$)/i.test(fwdFirst)) return true;
	return false;
}

/** Build the `Set-Cookie` value for `pi_web_token`. `encodedValue` is already
 *  `encodeURIComponent`'d (or `""` when clearing). */
export function buildPiWebTokenCookie(encodedValue: string, maxAge: number, secure: boolean): string {
	return `pi_web_token=${encodedValue}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/**
 * `pi_web_token` cookie 值 → 原始口令。
 *
 * 下发时按 `encodeURIComponent` 编码（RFC 6265 的 cookie-value 只允许 ASCII，
 * `=` / `+` / 空格 / 非 ASCII 都必须转义），所以**比对前必须先解码** —— 否则
 * 含这些字符的口令永远匹配不上，表现为「`?token=` 那一次 200，之后所有资源与
 * WS 全 401」（issue #261：base64 口令尾巴上的 `=` 被存成 `%3D`，服务端却拿
 * `%3D` 去和 `=` 比）。
 *
 * 浏览器回来的一定是编码值，但手写 cookie / 旧客户端可能是明文（`=` 在值里
 * 合法，我们按首个 `=` 切分），所以调用方应把「原样」与「解码后」两种候选都
 * 试一遍（见下面的 requestTokens）。
 *
 * 不是合法百分号编码时原样返回：`decodeURIComponent` 会抛 `URIError`，
 * 而一个手写的脏 cookie 绝不该把请求打成 500。
 */
export function decodeCookieToken(raw: string): string {
	if (!raw) return "";
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** 从请求中提取候选 token：头 / 查询参数 / cookie（浏览器导航场景靠 cookie 续命）。 */
export function requestTokens(req: { headers: IncomingMessage["headers"]; url?: string }): string[] {
	const out: string[] = [];
	const auth = req.headers.authorization;
	if (typeof auth === "string" && auth.startsWith("Bearer ")) out.push(auth.slice(7).trim());
	const header = req.headers["x-pi-token"];
	if (typeof header === "string") out.push(header.trim());
	try {
		const q = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
		if (q) out.push(q.trim());
	} catch {
		/* ignore malformed url */
	}
	const cookie = req.headers.cookie;
	if (typeof cookie === "string") {
		for (const part of cookie.split(";")) {
			const [k, ...rest] = part.trim().split("=");
			if (k !== "pi_web_token") continue;
			// 我们下发的是 encodeURIComponent 后的值（issue #261），而手写 / 旧客户端的
			// 明文 cookie 也可能出现（`=` 在值里合法，按首个 = 切分）；两种候选都进池子。
			const raw = rest.join("=").trim();
			if (!raw) continue;
			out.push(raw);
			const decoded = decodeCookieToken(raw);
			if (decoded !== raw) out.push(decoded);
		}
	}
	return out.filter(Boolean);
}

/** 请求携带的 pi_web_token cookie 的**口令值**（未带/损坏时为空串）。
 *  已解码：下发时是 `encodeURIComponent` 过的（issue #261），所以这里拿到的是
 *  可直接与 `AUTH_TOKEN` 比较的原文。 */
export function cookieToken(req: { headers: IncomingMessage["headers"] }): string {
	const cookie = req.headers.cookie;
	if (typeof cookie !== "string") return "";
	for (const part of cookie.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === "pi_web_token") return decodeCookieToken(rest.join("=").trim());
	}
	return "";
}
