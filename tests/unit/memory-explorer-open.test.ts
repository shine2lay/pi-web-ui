// @vitest-environment jsdom
/**
 * Memory explorer, Ops #1080 (owner Shine 2026-11-22, dr-c54a3286d823: "Remove sign-in only, keep for edits";
 * spec-explorer-owner.md R-OWNER-READ-2, R-OWNER-WRITE-1/2): the Memory tab opens straight to the notes with no
 * sign-in, every change still asks for the passkey, an address with no passkey offers "Add a passkey" and then
 * finishes the change, and the header's Passkeys box lists, adds and removes passkeys. Server and prompt faked.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryExplorerPage } from "../../web/src/components/MemoryExplorerPage.js";
import type { OwnerWebAuthn } from "../../web/src/memory-explorer/owner-session.js";
import { byRole, click, flush, maybeByRole, oneByRole, text, typeInto } from "./memory-explorer/explorer-dom.js";

const SHARED = "viking://user/default/memories";
const NOTE = `${SHARED}/preferences/ui_ux_design.md`;
const AT = "2026-11-14T01:21:00.000Z";
const PASSKEY = { id: "pk-1", rp_id: "pi.wai2shine.com", created_at: "2026-11-13T22:00:00.000Z" };
const CEREMONY = { challenge_id: "ch-1", expires_at: AT, options: { challenge: "c" } };
const KINDS = { rule: 1, case: 0, fact: 0, event: 0, document: 0, other: 0 };
const CODE = "apple river stone cloud lamp seven tide";

const READS: Record<string, unknown> = {
	"GET /overview": {
		health_state: "healthy",
		observer: { checked_at: AT, last_commit_at: AT, last_reachable_at: AT },
	},
	"GET /tree/roots": {
		checked_at: AT,
		health_state: "healthy",
		notes_total: 1,
		unread_count: 0,
		roots_partial: false,
		roots: [{ uri: SHARED, group: "shared", role: null, read: true, notes: 1, folders: 1, kinds: KINDS }],
		recent: [{ uri: NOTE, root: SHARED, kind: "rule", size: 120, mod_time: AT, locked: false }],
	},
	"GET /audit": {
		panel_updated_at: AT,
		health_state: "healthy",
		stale_badge: null,
		events: [],
		owner_events: "included",
	},
	"GET /note": {
		uri: NOTE,
		root: SHARED,
		kind: "rule",
		is_folder: false,
		size: 120,
		mod_time: AT,
		level: "full",
		text: "Body 16 px or more.",
		text_reason: null,
		text_of: NOTE,
		last_write: null,
	},
};

/** The server after #1080: reads always answer; a write needs a passkey of this host and its assertion. */
function fakeServer(options: { passkeys?: number } = {}) {
	const state = { passkeys: options.passkeys ?? 1, saved: null as string | null };
	const sent: string[] = [];
	const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
		const path = url.replace(/^.*\/api\/openviking/, "").replace(/\?.*$/, "");
		const key = `${init.method ?? "GET"} ${path}`;
		const headers = new Headers(init.headers);
		sent.push(key);
		const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
		const refuse = () => answer(403, { error: { code: "OWNER_ONLY", message: "owner only" } });
		switch (key) {
			case "GET /owner/passkeys":
				return answer(200, { rp_id: PASSKEY.rp_id, passkeys: state.passkeys > 0 ? [PASSKEY] : [] });
			case "POST /owner/passkey/code":
				return answer(202, { sent: true, rp_id: PASSKEY.rp_id, expires_at: AT });
			case "POST /owner/passkey/enroll/options":
				return answer(200, CEREMONY);
			case "POST /owner/passkey/enroll/verify":
				state.passkeys++;
				return answer(201, { passkey: PASSKEY });
			case "POST /owner/write/options":
				return state.passkeys > 0 && headers.get("X-Owner-Write") === "1" ? answer(200, CEREMONY) : refuse();
			case "DELETE /owner/passkey":
				if (!headers.get("X-Owner-Assertion")) return refuse();
				state.passkeys--;
				return answer(200, { removed: "pk-1" });
			case "PUT /note": {
				if (!headers.get("X-Owner-Assertion") || state.passkeys === 0) return refuse();
				state.saved = JSON.parse(init.body as string).content;
				return answer(200, {
					operation_id: "op-1",
					uri: NOTE,
					changed: true,
					mod_time: AT,
					undo_until: AT,
					before_sha256: "a",
					after_sha256: "b",
					audit_recorded: true,
				});
			}
		}
		if (key.startsWith("POST /owner/session")) return answer(404, { error: { code: "NOT_FOUND" } });
		return key in READS ? answer(200, READS[key]) : answer(404, { error: { code: "NOT_FOUND" } });
	});
	return { fetch, sent, state };
}

function passkeyPrompt() {
	return {
		register: vi.fn(async () => ({ id: "new" })),
		authenticate: vi.fn(async () => ({ id: "cred" })),
	} satisfies OwnerWebAuthn;
}

let mounted: { container: HTMLElement; root: Root } | null = null;
afterEach(() => {
	if (mounted) {
		const { root, container } = mounted;
		act(() => root.unmount());
		container.remove();
	}
	mounted = null;
	sessionStorage.clear();
});

async function mountPage(server: ReturnType<typeof fakeServer>, webauthn: OwnerWebAuthn): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () =>
		root.render(createElement(MemoryExplorerPage, { active: true, fetch: server.fetch, webauthn })),
	);
	await flush();
	return container;
}

const dialog = () => byRole(document.body, "dialog")[0] ?? null;
const noteButton = (page: HTMLElement) =>
	byRole(page, "button").find((b) => b.getAttribute("data-note") === NOTE) as HTMLElement;

/** Opens the note, edits it and confirms "Save" in the named confirm. */
async function saveEdit(page: HTMLElement, value: string): Promise<void> {
	await click(noteButton(page));
	await click(oneByRole(page, "button", "Edit"));
	await typeInto(oneByRole(page, "textbox", /^Full text of /) as HTMLTextAreaElement, value);
	await click(oneByRole(page, "button", "Save changes"));
	await click(oneByRole(dialog() as HTMLElement, "button", "Save"));
	await flush();
}

describe("Memory opens with no sign-in", () => {
	it("shows the notes, health and recent changes straight away; no sign-in box, button or session call", async () => {
		const server = fakeServer();
		const webauthn = passkeyPrompt();
		const page = await mountPage(server, webauthn);
		expect(dialog()).toBeNull();
		expect(noteButton(page)).toBeTruthy();
		expect(text(page)).not.toMatch(/Sign in|sign in|Sign out|Signed out|memory opens with your passkey/);
		expect(maybeByRole(page, "button", "Sign in")).toBeNull();
		expect(maybeByRole(page, "button", "Sign out")).toBeNull();
		oneByRole(page, "button", "Passkeys");
		expect(text(oneByRole(page, "status"))).not.toContain("sign in");
		expect(server.sent.some((k) => k.includes("/owner/session"))).toBe(false);
		expect(webauthn.authenticate).not.toHaveBeenCalled();
		await click(noteButton(page));
		expect(text(page)).toContain("Body 16 px or more.");
		expect(dialog()).toBeNull();
	});
});

describe("changes still ask for the passkey", () => {
	it("Save runs the passkey prompt on a challenge bound to the edit, then saves", async () => {
		const server = fakeServer();
		const webauthn = passkeyPrompt();
		const page = await mountPage(server, webauthn);
		await saveEdit(page, "Body 18 px or more.");
		expect(webauthn.authenticate).toHaveBeenCalledWith(CEREMONY.options);
		expect(server.sent).toContain("POST /owner/write/options");
		expect(server.state.saved).toBe("Body 18 px or more.");
		expect(text(oneByRole(page, "status", /Saved/))).toContain("Saved");
	});

	it("no passkey on this address: Save opens Add a passkey, and once added the edit is saved", async () => {
		const server = fakeServer({ passkeys: 0 });
		const webauthn = passkeyPrompt();
		const page = await mountPage(server, webauthn);
		await saveEdit(page, "Body 18 px or more.");
		const box = dialog() as HTMLElement;
		expect(text(oneByRole(box, "heading"))).toBe("Add a passkey");
		expect(text(box)).toContain("Telegram");
		expect(server.state.saved).toBeNull();
		await click(oneByRole(box, "button", "Send code"));
		await typeInto(
			oneByRole(dialog() as HTMLElement, "textbox", "7-word code from Telegram") as HTMLInputElement,
			CODE,
		);
		await click(oneByRole(dialog() as HTMLElement, "button", "Add passkey"));
		await flush();
		expect(webauthn.register).toHaveBeenCalledWith(CEREMONY.options);
		expect(webauthn.authenticate).toHaveBeenCalledWith(CEREMONY.options);
		expect(server.state.saved).toBe("Body 18 px or more.");
		expect(dialog()).toBeNull();
		expect(text(oneByRole(page, "status", /Saved/))).toContain("Saved");
	});

	it("closing Add a passkey keeps the edit and says it wasn't saved", async () => {
		const server = fakeServer({ passkeys: 0 });
		const page = await mountPage(server, passkeyPrompt());
		await saveEdit(page, "Body 18 px or more.");
		await click(oneByRole(dialog() as HTMLElement, "button", "Cancel"));
		await flush();
		expect(server.state.saved).toBeNull();
		expect((oneByRole(page, "textbox", /^Full text of /) as HTMLTextAreaElement).value).toBe("Body 18 px or more.");
	});
});

describe("Passkeys box", () => {
	it("lists this address's passkeys and removes one after a confirm and the passkey prompt", async () => {
		const server = fakeServer();
		const webauthn = passkeyPrompt();
		const page = await mountPage(server, webauthn);
		await click(oneByRole(page, "button", "Passkeys"));
		await flush();
		const list = dialog() as HTMLElement;
		expect(server.sent).toContain("GET /owner/passkeys");
		expect(text(list)).toContain("Added Nov 13");
		await click(oneByRole(list, "button", /^Remove/));
		const confirm = dialog() as HTMLElement;
		expect(text(confirm)).toContain("Remove this passkey?");
		expect(server.sent).not.toContain("DELETE /owner/passkey");
		await click(oneByRole(confirm, "button", "Remove passkey"));
		await flush();
		expect(server.sent).toContain("POST /owner/write/options");
		expect(server.sent).toContain("DELETE /owner/passkey");
		expect(text(dialog() as HTMLElement)).toContain("No passkeys on this address yet");
		expect(noteButton(page)).toBeTruthy();
	});

	it("adds a passkey with the 7-word Telegram code at any time", async () => {
		const server = fakeServer({ passkeys: 0 });
		const webauthn = passkeyPrompt();
		const page = await mountPage(server, webauthn);
		await click(oneByRole(page, "button", "Passkeys"));
		await flush();
		await click(oneByRole(dialog() as HTMLElement, "button", "Add a passkey"));
		await click(oneByRole(dialog() as HTMLElement, "button", "Send code"));
		expect(server.sent).toContain("POST /owner/passkey/code");
		await typeInto(
			oneByRole(dialog() as HTMLElement, "textbox", "7-word code from Telegram") as HTMLInputElement,
			CODE,
		);
		await click(oneByRole(dialog() as HTMLElement, "button", "Add passkey"));
		await flush();
		expect(webauthn.register).toHaveBeenCalledWith(CEREMONY.options);
		expect(text(dialog() as HTMLElement)).toContain("Added Nov 13");
		expect(webauthn.authenticate).not.toHaveBeenCalled();
	});
});
