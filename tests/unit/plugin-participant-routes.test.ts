import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService, ClientSession } from "../../server/agent-service.js";
import { PluginManager, type PluginParticipantRoute } from "../../server/plugins.js";

/** Conversation ids are deliberately not the session ids, so a test can tell which one a field carries. */
const convIdOf = (sessionId: string) => `conv-${sessionId}`;

function client(
	rows: Array<{
		id: string;
		role: string | null;
		busy?: boolean;
		ephemeral?: boolean;
		transient?: boolean;
		broken?: boolean;
	}>,
) {
	const session = Object.create(ClientSession.prototype) as ClientSession;
	Object.defineProperty(session, "convs", {
		value: new Map(
			rows.map((r) => [
				convIdOf(r.id),
				{
					id: convIdOf(r.id),
					fixtureIdentity: r.role ? { id: r.role } : null,
					isSubagent: r.ephemeral,
					session: {
						isStreaming: !!r.busy,
						sessionManager: {
							getSessionId: () => {
								if (r.broken) throw new Error("session replaced");
								return r.id;
							},
							getSessionFile: () => (r.transient ? undefined : `/sealed/${r.id}.jsonl`),
						},
					},
				},
			]),
		),
	});
	Object.assign(session, { snapshotIdentityOf: (conv: { fixtureIdentity: unknown }) => conv.fixtureIdentity });
	return session;
}

describe("metadata-only plugin participant routes", () => {
	it("keeps two participants in one process separate and excludes unidentified/ephemeral/transient routes", () => {
		const cs = client([
			{ id: "product-session", role: "product", busy: true },
			{ id: "product-task-session", role: "product" },
			{ id: "design-session", role: "design" },
			{ id: "unknown", role: null },
			{ id: "child", role: "design", ephemeral: true },
			{ id: "transient", role: "qa", transient: true },
			{ id: "broken", role: "qa", broken: true },
		]);
		const routes = cs.participantRoutesForPlugins();
		expect(routes).toEqual([
			{
				sessionId: "product-session",
				conversationId: "conv-product-session",
				role: "product",
				isHome: false,
				busy: true,
			},
			{
				sessionId: "product-task-session",
				conversationId: "conv-product-task-session",
				role: "product",
				isHome: false,
				busy: false,
			},
			{
				sessionId: "design-session",
				conversationId: "conv-design-session",
				role: "design",
				isHome: false,
				busy: false,
			},
		]);
		const productChats = routes.filter((r) => r.role === "product").map((r) => r.conversationId);
		expect(new Set(productChats).size).toBe(2);
	});

	it("aggregates all clients, deduplicates exact sessions and rejects identity conflicts", () => {
		const service = Object.create(AgentService.prototype) as AgentService;
		Object.assign(service, {
			clients: new Map([
				[
					"one",
					client([
						{ id: "product-session", role: "product" },
						{ id: "conflict", role: "design" },
					]),
				],
				[
					"two",
					client([
						{ id: "product-session", role: "product" },
						{ id: "qa-session", role: "qa" },
						{ id: "conflict", role: "product" },
					]),
				],
			]),
		});
		expect(service.participantRoutesForPlugins()).toEqual([
			{
				sessionId: "product-session",
				conversationId: "conv-product-session",
				role: "product",
				isHome: false,
				busy: false,
			},
			{ sessionId: "qa-session", conversationId: "conv-qa-session", role: "qa", isHome: false, busy: false },
		]);
	});
});

describe("plugin host participantRoutes()", () => {
	let root: string | undefined;
	let manager: PluginManager | undefined;
	afterEach(() => {
		manager?.dispose();
		if (root) rmSync(root, { recursive: true, force: true });
		delete (globalThis as Record<string, unknown>).__participantRoutesSeen;
	});

	it("hands plugins the route's conversationId and no fields beyond the route contract", async () => {
		root = mkdtempSync(join(tmpdir(), "participant-routes-host-"));
		manager = new PluginManager(root, root);
		const route: PluginParticipantRoute = {
			sessionId: "qa-session",
			conversationId: "c42",
			role: "qa",
			isHome: true,
			busy: false,
		};
		// A provider row carrying more than the contract must not leak the extra field to plugins.
		manager.participantRouteProvider = () => [{ ...route, sessionFile: "/private/qa.jsonl" } as PluginParticipantRoute];
		const dir = join(root, "plugins", "route-reader");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ id: "route-reader", name: "route-reader", apiVersion: 2, permissions: ["participants"] }),
		);
		writeFileSync(
			join(dir, "index.mjs"),
			`export default { activate(host) { globalThis.__participantRoutesSeen = host.participantRoutes(); } };`,
		);
		const loaded = await manager.ensureLoaded();
		expect(loaded.every((p) => !p.error)).toBe(true);
		expect((globalThis as Record<string, unknown>).__participantRoutesSeen).toEqual([route]);
	});
});
