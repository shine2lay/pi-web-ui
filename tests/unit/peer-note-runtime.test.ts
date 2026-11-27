import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	createAgentSessionServices,
	createAgentSessionFromServices,
	type AgentSession,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { makeRuntimePeerNoteTool } from "../../server/peer-note-runtime.js";
import { installSpecialistRawGuard } from "../../server/specialist-raw-runtime.js";
import { identityRegistry } from "../../server/identities.js";
import { RoleMessages } from "../../server/role-messages.js";

const previousIdentityDir = process.env.PI_IDENTITY_DIR;
afterEach(() => {
	if (previousIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
	else process.env.PI_IDENTITY_DIR = previousIdentityDir;
	identityRegistry(true);
});
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const message = (
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-completions",
	provider: "openai",
	model: "fixture",
	stopReason,
	timestamp: 0,
	usage,
});

// Real SDK lifecycle; synthetic OUTPUT only. Never inspect model inputs or call a provider.
it.each([
	"valid",
	"role",
	"user",
	"agent_id",
	"agentId",
	"specialist",
	"slug",
	"unknown",
	"coerced",
	"prepared",
	"no-raw",
	"no-schema",
])(
	"native peer original arguments: %s",
	async (variant) => {
		const root = mkdtempSync(join(tmpdir(), "peer-native-"));
		let session: AgentSession | undefined;
		let store: RoleMessages | undefined;
		let details: unknown;
		let deliveries = 0;
		const sender = { role: "qa", title: "QA", chat: "private task", file: "", handling: 0 };
		const tool = makeRuntimePeerNoteTool({
			session: () => session,
			store: () => store,
			sender: () => sender,
			guard: () => undefined,
		});
		const registered: ToolDefinition = {
			...tool,
			parameters: { ...tool.parameters, additionalProperties: true },
			prepareArguments: (input) => {
				const p = { ...(input as Record<string, unknown>) };
				for (const key of ["role", "user", "agent_id", "agentId", "specialist", "slug", "unknown"]) delete p[key];
				p.to_task = Number(p.to_task);
				if (variant === "prepared") p.text = "Changed";
				return p;
			},
			execute: async (...args) => {
				const out = await tool.execute(...args);
				details = out.details;
				return out;
			},
		};
		try {
			const services = await createAgentSessionServices({
				cwd: root,
				agentDir: join(root, "agent"),
				resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true },
			});
			const manager = SessionManager.create(root, root);
			manager.appendMessage(message([{ type: "text", text: "Synthetic ready" }]));
			({ session } = await createAgentSessionFromServices({
				services,
				sessionManager: manager,
				customTools: [registered],
			}));
			sender.file = manager.getSessionFile()!;
			const home = join(root, "home.jsonl"),
				target = join(root, "target.jsonl"),
				roles = join(root, "roles");
			mkdirSync(join(roles, "qa"), { recursive: true });
			writeFileSync(join(roles, "qa", "identity.json"), JSON.stringify({ id: "qa", name: "QA", homeChat: home }));
			writeFileSync(target, "");
			process.env.PI_IDENTITY_DIR = roles;
			const plan = {
				title: "Private",
				goal: "Synthetic",
				doneWhen: "Synthetic",
				decided: "Synthetic",
				steps: "Synthetic",
				verify: "Synthetic",
				mustNot: "No live writes",
			};
			const ops = [
				[1, sender.file],
				[2, target],
			].flatMap(([id, file]) => [
				{ op: "add", id, plan },
				{ op: "start", id, lane: true },
				{ op: "chat", id, file },
			]);
			writeFileSync(
				home,
				ops
					.map((data) => JSON.stringify({ type: "custom", customType: "queue", data: { v: 1, ts: 1, ...data } }))
					.join("\n") + "\n",
			);
			manager.appendCustomEntry("identity", { v: 1, id: "qa", via: "queue", from: home });
			manager.appendCustomEntry("queue", { v: 1, ts: 1, op: "assigned", id: 1, plan, from: { file: home } });
			expect(identityRegistry(true).identities.find((row) => row.id === "qa")?.homeChat).toBe(home);
			store = new RoleMessages(
				join(root, "mail.json"),
				{
					roles: () => [],
					chatState: () => "idle",
					deliver: async () => {
						deliveries++;
						throw Error("Unexpected delivery");
					},
					note: async () => ({ ok: false, error: "Private fixture" }),
					log: () => {},
				},
				() => 1,
			);
			if (variant !== "no-raw") installSpecialistRawGuard(session);
			if (variant === "no-schema") {
				const original = session.getToolDefinition.bind(session);
				session.getToolDefinition = (name) => ({ ...original(name)!, parameters: undefined! });
			}
			const originalArgs = {
				to_task: variant === "coerced" ? "2" : 2,
				kind: "fyi",
				text: "Private fixture",
				...(["role", "user", "agent_id", "agentId", "specialist", "slug", "unknown"].includes(variant)
					? { [variant]: "ops" }
					: {}),
			};
			session.agent.state.model = {
				id: "fixture",
				name: "fixture",
				api: "openai-completions",
				provider: "openai",
				baseUrl: "http://unused.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			};
			session.setActiveToolsByName(["peer_note"]);
			session.agent.getApiKey = () => "synthetic";
			session.agent.finishTurn = () => ({ action: "end" });
			session.agent.streamFunction = () => {
				const stream = createAssistantMessageEventStream();
				stream.push({
					type: "done",
					reason: "toolUse",
					message: message(
						[{ type: "toolCall", id: "private-call", name: "peer_note", arguments: originalArgs }],
						"toolUse",
					),
				});
				return stream;
			};
			await session.agent.prompt("Synthetic invocation");
			expect(details).toMatchObject({
				result: variant === "valid" ? "allow" : "refuse",
				records_added: variant === "valid" ? 1 : 0,
			});
			expect(store.recent(-Infinity)).toHaveLength(variant === "valid" ? 1 : 0);
			expect(deliveries).toBe(0);
		} finally {
			store?.stop();
			session?.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);
