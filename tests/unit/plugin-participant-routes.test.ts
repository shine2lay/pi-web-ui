import { describe, expect, it } from "vitest";
import { AgentService, ClientSession } from "../../server/agent-service.js";

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
				r.id,
				{
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
			{ id: "design-session", role: "design" },
			{ id: "unknown", role: null },
			{ id: "child", role: "design", ephemeral: true },
			{ id: "transient", role: "qa", transient: true },
			{ id: "broken", role: "qa", broken: true },
		]);
		expect(cs.participantRoutesForPlugins()).toEqual([
			{ sessionId: "product-session", role: "product", isHome: false, busy: true },
			{ sessionId: "design-session", role: "design", isHome: false, busy: false },
		]);
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
			{ sessionId: "product-session", role: "product", isHome: false, busy: false },
			{ sessionId: "qa-session", role: "qa", isHome: false, busy: false },
		]);
	});
});
