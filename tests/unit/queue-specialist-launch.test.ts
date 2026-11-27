import { describe, expect, it } from "vitest";
import { parseQueueChatStart } from "../../server/queue-host.js";
import { normLaunch, prepareLaunch } from "../../server/queue-profile.js";

// Transport must not interpret, rebuild or project pi-identity's signed authority.
const specialist = {
	v: 1,
	dept: "ops",
	slug: "builder",
	title: "Builder",
	effectiveTools: ["ask_lead", "bash", "queue_blocked", "queue_done", "queue_wait"],
	effectiveToolsSha256: "opaque-tool-hash",
	snapshotSha256: "opaque-snapshot-hash",
	limits: { specialist: { allow: ["bash"] }, ceiling: null },
	futureAuthorityField: { preserved: true },
};
const launch = { from: { model: "app", thinking: "app", speed: "app" }, specialist };
const options = { cwd: "/tmp/specialist-launch", name: "Fresh specialist", prompt: "Harmless check", entries: [] };

describe("fresh specialist dispatch transport", () => {
	it("preserves the complete sealed authority through parsing and preparation", async () => {
		const parsed = parseQueueChatStart({ ...options, launch });
		if (typeof parsed === "string") throw new Error(parsed);
		expect(parsed.launch).toHaveProperty("specialist", specialist);
		const model = { provider: "test", id: "fixture", api: "openai-completions", reasoning: false };
		let recorded: unknown;
		const prepared = await prepareLaunch(parsed.launch!, {
			selectModel: async () => {},
			model: () => model as never,
			thinking: () => "off",
			setThinking: () => {},
			speed: () => "standard",
			setSpeed: () => {},
			record: (value) => {
				recorded = value;
			},
		});
		expect(prepared).toHaveProperty("specialist", specialist);
		expect(recorded).toEqual(prepared);
		// agent-service persists this prepared value as assigned.launch.
		expect(JSON.parse(JSON.stringify({ op: "assigned", launch: prepared })).launch.specialist).toEqual(specialist);
	});

	it("keeps display projection separate from dispatch authority", () => {
		expect(normLaunch(launch)).toHaveProperty("specialist", { slug: "builder", title: "Builder" });
	});

	it("does not invent authority for an ordinary worker", () => {
		const parsed = parseQueueChatStart({ ...options, launch: { from: launch.from } });
		if (typeof parsed === "string") throw new Error(parsed);
		expect(parsed.launch).not.toHaveProperty("specialist");
	});

	it("does not repair malformed authority into an ordinary worker", () => {
		const malformed = { slug: "builder" };
		const parsed = parseQueueChatStart({ ...options, launch: { ...launch, specialist: malformed } });
		if (typeof parsed === "string") throw new Error(parsed);
		expect(parsed.launch).toHaveProperty("specialist", malformed);
	});
});
