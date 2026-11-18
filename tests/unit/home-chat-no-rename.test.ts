// home-chat-no-rename (Ops #1007). Owner 2026-11-18, Data home chat m05309: "can you remove the chat renaming
// tool from leads? i dont like that my lead sometimes change the chat name". Role home chats (identities.ts
// homeChatOf) get no [[conv:rename:...]] guidance and a conv marker in their AI text renames nothing and says
// nothing; manual rename and every other chat keep working. Synthetic chats only, no SDK run or model.
import { describe, expect, it, vi } from "vitest";
import type { ClientStateStore } from "../../server/client-state.js";
import { MarkerService, type MarkerHost } from "../../server/marker-service.js";
import { stripMarkers } from "../../server/markers/marker.js";

const fixtures = vi.hoisted(() => ({ home: "/fixture/data-home.jsonl", other: "/fixture/plain-chat.jsonl" }));
vi.mock("../../server/identities.js", async (original) => ({
	...(await original<typeof import("../../server/identities.js")>()),
	identityRegistry: () => ({
		identities: [{ id: "data", title: "Data", homeChat: fixtures.home, pastHomeChats: [] }],
	}),
}));
const { ClientSession } = await import("../../server/agent-service.js");

const clientCall = <T>(target: object, name: string, ...args: unknown[]): T =>
	Reflect.get(ClientSession.prototype, name).apply(target, args) as T;

/** A live chat as ClientSession keeps it: a transcript file and a session manager. */
function chat(id: string, file: string) {
	const appendSessionInfo = vi.fn();
	return {
		id,
		title: "Data lead",
		durableHandle: {},
		session: {
			sessionFile: file,
			sessionManager: { appendSessionInfo, getBranch: () => [], getSessionFile: () => file },
		},
		appendSessionInfo,
	};
}

type Chat = ReturnType<typeof chat>;

/** A ClientSession with just the fields the rename and the prompt compose read. */
function session(...chats: Chat[]) {
	const ctx = Object.assign(Object.create(ClientSession.prototype), {
		activeId: chats[0]?.id ?? "",
		emit: vi.fn(),
		emitConversations: vi.fn(),
		invalidateSessionInfos: vi.fn(),
		refreshSessions: vi.fn(async () => {}),
	});
	Object.defineProperty(ctx, "convs", { value: new Map(chats.map((c) => [c.id, c])) });
	return ctx;
}

/** The MarkerService the way ClientSession wires it: chats' session managers by conversation id. */
function markers(...chats: Chat[]) {
	const emit = vi.fn();
	const renameConversation = vi.fn();
	const host = {
		clientId: "test-client",
		stateStore: {
			getMarkerSettings: () => ({ markersEnabled: true, disabledMarkers: [] }),
			saveMarkerSettings: () => {},
		} as unknown as ClientStateStore,
		emit,
		isDisposed: () => false,
		getActiveConversationId: () => chats[0]?.id ?? "",
		getSessionManager: (id: string) => chats.find((c) => c.id === id)?.session.sessionManager,
		renameConversation,
		refreshMarkers: () => {},
	} satisfies MarkerHost;
	return { svc: new MarkerService(host), emit, renameConversation };
}

const REPLY = "Done with the audit. [[conv:rename:Marketing AI research]]";

describe("home-chat-no-rename", () => {
	it("(a) a home chat's guidance has no conv rename; an ordinary chat's still has it", () => {
		const { svc } = markers();
		const homeGuidance = svc.buildGuidance(fixtures.home);
		expect(homeGuidance).not.toContain("[[conv:rename:");
		expect(homeGuidance).toContain("[[notify:");
		expect(svc.buildGuidance(fixtures.other)).toContain("[[conv:rename:");
	});

	it("(a) the system prompt ClientSession composes for a home chat has no conv rename", () => {
		const home = chat("home", fixtures.home);
		const owner = session(home);
		Object.assign(owner, {
			markerSvc: markers(home).svc,
			settingsSvc: { current: {} },
			getLang: () => "en",
		});
		const inputs = (sessionFile?: string) =>
			clientCall<{ markersGuidance: string }>(owner, "composeInputs", {
				cwd: "/fixture",
				selectedTools: [],
				toolSnippets: {},
				toolGuidelines: [],
				contextFiles: [],
				skills: [],
				preset: "standard",
				role: "data",
				sessionFile,
			});
		expect(inputs(fixtures.home).markersGuidance).not.toContain("[[conv:rename:");
		expect(inputs(undefined).markersGuidance).not.toContain("[[conv:rename:"); // the active chat is the home chat
		expect(inputs(fixtures.other).markersGuidance).toContain("[[conv:rename:");
	});

	it("(b) a conv marker in a home chat's AI text renames nothing, says nothing, and is stripped from the text", async () => {
		const { svc, emit, renameConversation } = markers(chat("home", fixtures.home));
		await svc.handleAssistantText("home", REPLY);
		expect(renameConversation).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
		expect(stripMarkers(REPLY)).toBe("Done with the audit. ");
	});

	it("(b) other markers in a home chat still run", async () => {
		const { svc, emit } = markers(chat("home", fixtures.home));
		await svc.handleAssistantText("home", "ok [[notify:info:hello]]");
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "notice", text: "hello" }));
	});

	it("(c) a manual rename of a home chat still works", async () => {
		const home = chat("home", fixtures.home);
		await clientCall<Promise<void>>(session(home), "renameConversation", "home", "Marketing lead");
		expect(home.title).toBe("Marketing lead");
		expect(home.appendSessionInfo).toHaveBeenCalledWith("Marketing lead");
	});

	it("(d) an ordinary chat still renames via the marker", async () => {
		const { svc, renameConversation } = markers(chat("plain", fixtures.other));
		await svc.handleAssistantText("plain", REPLY);
		expect(renameConversation).toHaveBeenCalledWith("plain", "Marketing AI research");
	});
});
