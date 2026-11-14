/**
 * showtell-owner-answer (ops #883): the wiring around server/owner-front-door.ts. The plugin proxy (proxyHttp) hands
 * a watched request's answer to the front door without changing what the browser gets; a request without the
 * browser's same-origin header, or one straight to the plugin's server, gets no receipt; a chat's file is found by
 * its session id. In-process fake upstream + express proxy on 127.0.0.1, real DecisionRecords on a temp dir.
 */
import express from "express";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionRecords } from "../../server/decision-records.js";
import { type OwnerActionReceipt, OwnerFrontDoor, sessionFileIn } from "../../server/owner-front-door.js";
import { proxyForwardPath, proxyHttp, type ProxyHit } from "../../server/plugin-proxy.js";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const listen = (server: Server): Promise<number> => {
	servers.push(server);
	return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));
};
const UP_ANSWER = JSON.stringify({ ok: true, status: "done", batch_id: "b_proxy00001" });

async function rig() {
	const upPort = await listen(
		createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(req.url === "/api/docs/d_proxy0001/status" ? UP_ANSWER : "{}");
			});
		}),
	);
	const dir = mkdtempSync(join(tmpdir(), "owner-front-door-proxy-"));
	dirs.push(dir);
	const records = new DecisionRecords(dir);
	const door = new OwnerFrontDoor({ records });
	const receipts: OwnerActionReceipt[] = [];
	door.watch(
		"show-and-tell",
		{
			answeredIn: "showtell",
			actions: [{ method: "POST", path: "/api/docs/:doc/status", body: { status: "done" }, refField: "batch_id" }],
		},
		(r) => receipts.push(r),
	);
	const hit: ProxyHit = { prefix: "/showtell", pluginId: "show-and-tell", host: "127.0.0.1", port: upPort };
	const app = express();
	app.use(express.json());
	app.use((req, res) => {
		const observe = door.observerFor({
			pluginId: hit.pluginId,
			method: req.method,
			path: proxyForwardPath(hit, req.url),
			headers: req.headers,
			body: (req as { body?: unknown }).body,
		});
		proxyHttp(hit, req, res, undefined, observe);
	});
	const port = await listen(createServer(app));
	return { door, receipts, port, upPort };
}

const post = (port: number, path: string, headers: Record<string, string>) =>
	fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ status: "done" }),
	});

async function until(pred: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe("owner front door wiring (ops #883)", () => {
	it("a browser's Mark done through the proxy: the browser gets the upstream's answer unchanged, the plugin one receipt", async () => {
		const r = await rig();
		const res = await post(r.port, "/showtell/api/docs/d_proxy0001/status", { "sec-fetch-site": "same-origin" });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(UP_ANSWER);
		await until(() => r.receipts.length > 0);
		expect(r.receipts.map((x) => [x.ref, x.params.doc, x.path])).toEqual([
			["showtell:b_proxy00001", "d_proxy0001", "/api/docs/d_proxy0001/status"],
		]);
	});

	it("no receipt without the browser's header, nor for a call straight to the plugin's server", async () => {
		const r = await rig();
		expect((await post(r.port, "/showtell/api/docs/d_proxy0001/status", {})).status).toBe(200);
		expect((await post(r.upPort, "/api/docs/d_proxy0001/status", { "sec-fetch-site": "same-origin" })).status).toBe(
			200,
		);
		await new Promise((res) => setTimeout(res, 50));
		expect(r.receipts).toEqual([]);
	});

	it("a GET is never watched, so the proxy keeps nothing", async () => {
		const r = await rig();
		expect(
			r.door.observerFor({ pluginId: "show-and-tell", method: "GET", path: "/api/docs/d_proxy0001", headers: {} }),
		).toBeUndefined();
		expect(r.door.observerFor({ pluginId: "notes", method: "POST", path: "/x", headers: {} })).toBeUndefined();
	});

	it("sessionFileIn finds a chat's file by its session id", () => {
		const root = mkdtempSync(join(tmpdir(), "owner-front-door-sessions-"));
		dirs.push(root);
		mkdirSync(join(root, "--home--"));
		const name = "2025-01-02T11-00-00-000Z_01a00000-0000-7000-8000-000000000315.jsonl";
		writeFileSync(join(root, "--home--", name), "");
		expect(sessionFileIn(root, "01a00000-0000-7000-8000-000000000315")).toBe(join(root, "--home--", name));
		expect(sessionFileIn(root, "01a00000-0000-7000-8000-000000000999")).toBeUndefined();
		expect(sessionFileIn(root, "../etc")).toBeUndefined();
	});
});
