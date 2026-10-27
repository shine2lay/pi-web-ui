import { describe, expect, it } from "vitest";
import type { ClientMessage } from "../../web/src/types";
import { isRecoveryEligible, requiresRecoveryAdmission } from "../../web/src/recovery-policy";

const message = (value: unknown) => value as ClientMessage;

describe("W2 explicit authored-payload policy", () => {
	it.each([
		{ type: "prompt", text: "  original whitespace\n", id: "p1", forSession: "s1", queue: true },
		{
			type: "schedule_save",
			task: {
				name: " raw name ",
				description: " raw description ",
				cwd: " /task ",
				kind: "interval",
				spec: "60000",
				prompt: " raw prompt ",
				model: "",
				thinkingLevel: "",
				catchUp: "once",
			},
		},
		{
			type: "set_goal",
			goal: "  exact goal\n",
			reviewModel: "fixture/model",
			maxRounds: 3,
			locked: true,
			conversationId: "c1",
		},
		{
			type: "start_goal_wizard",
			text: "  exact requirement\n",
			wizardModel: "fixture/model",
			maxRounds: 2,
			locked: false,
			conversationId: "c1",
		},
		{ type: "prompt", text: "", attachments: [{ path: "", fileData: "", name: "empty.txt", size: 0 }] },
		{
			type: "prompt",
			text: "image",
			attachments: [{ path: "", imageData: "full-bytes", mimeType: "image/png", size: 10 }],
		},
		{
			type: "prompt",
			text: "source",
			attachments: [{ path: "/selected/source.ts", mode: "lines", lines: { start: 1, end: 12 } }],
		},
		{
			type: "edit_message",
			messageId: "m1",
			text: " \n",
			attachments: [{ path: "", imageData: "bytes", imageUrl: "/api/chat-image/s1/m1/0" }],
		},
		{
			type: "run_command",
			terminalId: "t1",
			command: { name: "test", command: "  npm test\n", cwd: "/selected/work" },
			cols: 80,
			rows: 24,
			conversationId: "c1",
			reqId: "command1",
			original: {
				requestId: "command1",
				source: "terminal",
				conversationId: "c1",
				sessionId: "s1",
				workspaceCwd: "/selected/work",
				command: { name: "test", command: "  npm test\n", cwd: "/selected/work" },
				terminal: {
					id: "t1",
					title: "test",
					cwd: "/selected/work",
					cols: 80,
					rows: 24,
					mode: "new",
					running: false,
					exitCode: null,
				},
			},
		},
		...(["about", "prompt", "notebook"] as const).map((file) => ({
			type: "identity_file_save",
			id: "ops",
			file,
			text: "  authored\n",
			baseHash: "h1",
			ref: "editor",
			reqId: "r1",
		})),
		{ type: "identity_note_save", id: "ops", ref: "n1", text: "", baseHash: "h1", reqId: "r2" },
		{ type: "board_post", kind: "news", to: ["ops"], title: "title", text: "  draft\n", reqId: "r3" },
		{ type: "board_post", kind: "order", to: "all", title: "original title", text: "original owner-entered text" },
		{ type: "board_close", id: "bp1", note: "  explicit note\n", reqId: "r4" },
	])("accepts the complete known authored shape without normalization: $type", (input) => {
		const original = JSON.stringify(input);
		expect(isRecoveryEligible(message(input))).toBe(true);
		expect(requiresRecoveryAdmission(message(input))).toBe(true);
		expect(JSON.stringify(input)).toBe(original);
	});

	it.each([
		{ type: "set_provider_api_key", provider: "fixture", apiKey: "FAKE_ONLY" },
		{ type: "add_provider_key", provider: "fixture", apiKey: "FAKE_ONLY", name: "fixture" },
		{ type: "provider_oauth_reply", flowId: "f1", promptId: "p1", value: "FAKE_ONLY" },
		{ type: "role_guard_owner_answer", questionId: "q1", generation: "1", choice: "grant" },
		{ type: "roles_ask_answer", reqId: "r1", key: "k1", askId: "a1", revision: "v1", answers: [] },
		{ type: "terminal_input", terminalId: "t1", data: "raw stream" },
		{ type: "plugin_settings", pluginId: "fixture", values: { key: "FAKE_ONLY" } },
		{ type: "identity_file_save", id: "ops", file: "config", text: "arbitrary settings", baseHash: "h1" },
		{ type: "identity_draft_save", id: "ops", about: "authored", prompt: "authored", config: "unknown capabilities" },
		{ type: "identity_draft_accept", id: "ops", about: "authored", prompt: "authored", config: "{}" },
		{ type: "identity_note_delete", id: "ops", ref: "n1", baseHash: "h1" },
		{ type: "board_close", id: "bp1" },
		{ type: "board_close", id: "bp1", note: "" },
		{ type: "ping", id: "ping1" },
		{ type: "roles_watch", full: true },
		{ type: "get_state" },
		{ type: "unknown_future_form", text: "do not infer permission" },
	])("grants no new journal permission and does not demand migration of $type", (input) => {
		expect(isRecoveryEligible(message(input))).toBe(false);
		expect(requiresRecoveryAdmission(message(input))).toBe(false);
	});

	it.each([
		{ type: "prompt", text: "original", opaque: { apiKey: "FAKE_ONLY" } },
		{ type: "set_goal", goal: "original", maxRounds: 3, locked: true },
		{
			type: "schedule_save",
			task: {
				name: "n",
				description: "",
				cwd: "/task",
				kind: "interval",
				spec: "60000",
				prompt: "p",
				model: "",
				thinkingLevel: "",
				catchUp: "once",
				enabled: true,
			},
		},
		{
			type: "schedule_save",
			task: {
				name: "n",
				description: "",
				cwd: "/task",
				kind: "interval",
				spec: "Infinity",
				prompt: "p",
				model: "",
				thinkingLevel: "",
				catchUp: "once",
			},
		},
		{ type: "start_goal_wizard", text: "original", conversationId: "c1", unclassified: "not journalled" },
		{ type: "set_goal", goal: "original", maxRounds: Infinity, locked: true, conversationId: "c1" },
		{ type: "prompt", text: "" },
		{
			type: "prompt",
			text: "original",
			attachments: [{ path: "", fileData: "bytes", unknown: "not silently dropped" }],
		},
		{ type: "prompt", text: "original", attachments: [{ path: "x", lines: [1, 2] }] },
		{
			type: "prompt",
			text: "original",
			attachments: [{ path: "", imageData: "bytes", imageUrl: "https://remote.invalid/image?token=FAKE_ONLY" }],
		},
		{
			type: "prompt",
			text: "original",
			attachments: [{ path: "", imageData: "bytes", imageUrl: "//remote.invalid/api/attachment/hash" }],
		},
		{
			type: "prompt",
			text: "original",
			attachments: [{ path: "", imageData: "bytes", imageUrl: "/api/chat-image/../private" }],
		},
		{ type: "edit_message", messageId: "m1", text: "original", capability: "unknown" },
		{
			type: "run_command",
			terminalId: "t1",
			command: { name: "test", command: "true", env: { key: "FAKE_ONLY" } },
			cols: 80,
			rows: 24,
		},
		{ type: "identity_file_save", id: "ops", file: "about", text: "original", baseHash: "h1", config: "unknown" },
		{ type: "board_post", kind: "news", to: [], title: "draft", text: "draft" },
	])("refuses an invalid producer rather than permitting synchronous bypass: $type", (input) => {
		expect(isRecoveryEligible(message(input))).toBe(false);
		expect(requiresRecoveryAdmission(message(input))).toBe(true);
	});
});
