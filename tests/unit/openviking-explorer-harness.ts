/**
 * Backend #161: one Memory Explorer server for the acceptance tests — the real routes (`registerOpenVikingRoutes`)
 * on an ephemeral port, over the daemon fake (`daemon(mode, { explorer: true })`), with an injected owner gate,
 * the fake's manual clock and a captured shutdown hook. No live daemon is ever called.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { registerOpenVikingRoutes, type OpenVikingDashboardOptions } from "../../server/openviking/index.js";
import { daemon, type DaemonCall, type DaemonMode } from "./openviking-daemon-fake.js";

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export interface ExplorerReply {
	status: number;
	// Answers are checked field by field against the spec; a loose shape keeps a wrong answer readable.
	body: any;
}

export interface ExplorerHarness {
	fake: ReturnType<typeof daemon>;
	stateDir: string;
	changelogPath: string;
	/** Hooks the routes handed to `onShutdown`; `shutdown()` runs them as the server's stop would. */
	shutdown(): Promise<void>;
	call(method: string, path: string, body?: unknown): Promise<ExplorerReply>;
	/** Daemon calls to `path` (and `method`, when given), in order. */
	daemonCalls(path: string, method?: string): DaemonCall[];
	/** The change record's lines, parsed; [] when the file does not exist. */
	changelog(): Record<string, unknown>[];
	seedChangelog(rows: object[]): void;
	close(): Promise<void>;
}

export async function explorerHarness(
	opts: { gate?: "allow" | "deny"; mode?: DaemonMode } = {},
): Promise<ExplorerHarness> {
	const fake = daemon(opts.mode ?? "up", { explorer: true });
	const stateDir = mkdtempSync(join(tmpdir(), "ov-explorer-"));
	const changelogPath = join(stateDir, "memory-changelog.jsonl");
	const hooks: (() => Promise<void>)[] = [];
	const options: OpenVikingDashboardOptions = {
		stateDir,
		fetchImpl: fake.fetchImpl,
		now: fake.clock.now,
		explorer: {
			ownerGate: opts.gate === "deny" ? () => false : () => true,
			clock: fake.clock,
			onShutdown: (hook) => hooks.push(hook),
		},
	};
	const app = express();
	// As server/index.ts: every body already parsed, up to 10 MB.
	app.use(express.json({ limit: "10mb" }));
	registerOpenVikingRoutes(app, options);
	const server: Server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		fake,
		stateDir,
		changelogPath,
		shutdown: async () => {
			for (const hook of hooks) await hook();
		},
		call: async (method, path, body) => {
			const init: RequestInit =
				body === undefined
					? { method }
					: { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
			const res = await fetch(`${base}${path}`, init);
			const text = await res.text();
			// A route not built yet answers Express's HTML 404: keep it as text so the assertion names the status.
			const json = (res.headers.get("content-type") ?? "").includes("application/json");
			return { status: res.status, body: text === "" ? null : json ? JSON.parse(text) : text };
		},
		daemonCalls: (path, method) =>
			fake.calls.filter((c) => c.url.pathname === path && (method === undefined || c.method === method)),
		changelog: () =>
			existsSync(changelogPath)
				? readFileSync(changelogPath, "utf8")
						.split("\n")
						.filter((l) => l.trim() !== "")
						.map((l) => JSON.parse(l) as Record<string, unknown>)
				: [],
		seedChangelog: (rows) => writeFileSync(changelogPath, rows.map((r) => `${JSON.stringify(r)}\n`).join("")),
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(stateDir, { recursive: true, force: true });
		},
	};
}

/** `?uri=` for a query string. */
export const q = (uri: string) => encodeURIComponent(uri);

/** Retries `check` until it passes (work the server does after a timer fires), up to `ms` of real time. */
export async function eventually(check: () => void, ms = 2000): Promise<void> {
	const until = Date.now() + ms;
	for (;;) {
		try {
			check();
			return;
		} catch (err) {
			if (Date.now() > until) throw err;
			await new Promise((r) => setTimeout(r, 10));
		}
	}
}

/** Lets the server finish whatever a fired timer started, before asserting that nothing happened. */
export const settle = () => new Promise((r) => setTimeout(r, 50));
