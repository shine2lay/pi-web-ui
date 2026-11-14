// @vitest-environment jsdom
/**
 * Memory explorer (design #316): the owner's passkey sign-in on the Memory tab, from Design lead's
 * decision on #316 (spec-explorer-owner.md): signed out -> sign in; no passkey yet -> add one with
 * the 7-word Telegram code; a session that ended while reading -> sign in again, same note still
 * open; Sign out and Passkeys in the header. The server and the browser's passkey prompt are faked.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryExplorerPage } from "../../web/src/components/MemoryExplorerPage.js";
import type { OwnerWebAuthn } from "../../web/src/memory-explorer/owner-session.js";
import {
	byRole,
	click,
	flush,
	maybeByRole,
	oneByRole,
	pressKey,
	text,
	typeInto,
} from "./memory-explorer/explorer-dom.js";

const SHARED = "viking://user/default/memories";
const NOTE = `${SHARED}/preferences/ui_ux_design.md`;
const AT = "2026-11-14T01:21:00.000Z";
const PASSKEY = { id: "pk-1", rp_id: "pi.wai2shine.com", created_at: "2026-11-13T22:00:00.000Z" };
const CEREMONY = { challenge_id: "ch-1", expires_at: AT, options: { challenge: "c" } };
const KINDS = { rule: 1, case: 0, fact: 0, event: 0, document: 0, other: 0 };

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
	"GET /audit": { panel_updated_at: AT, health_state: "healthy", stale_badge: null, events: [] },
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

/** The server: reads answer only with a session; the owner routes as spec-explorer-owner.md says. */
function fakeServer(options: { signedIn?: boolean; passkeys?: number } = {}) {
	const state = { signedIn: options.signedIn ?? false, passkeys: options.passkeys ?? 1, codeOk: true };
	const sent: string[] = [];
	const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
		const path = url.replace(/^.*\/api\/openviking/, "").replace(/\?.*$/, "");
		const key = `${init.method ?? "GET"} ${path}`;
		sent.push(key);
		const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
		const refuse = () => answer(403, { error: { code: "OWNER_ONLY", message: "owner only" } });
		switch (key) {
			case "POST /owner/session/options":
				return state.passkeys > 0 ? answer(200, CEREMONY) : refuse();
			case "POST /owner/session/verify":
				state.signedIn = true;
				return answer(200, { expires_at: AT, idle_ms: 900_000, passkey_id: "pk-1", passkeys: [PASSKEY] });
			case "POST /owner/session/logout":
				state.signedIn = false;
				return answer(200, { signed_out: true });
			case "POST /owner/passkey/code":
				return answer(202, { sent: true, rp_id: "pi.wai2shine.com", expires_at: AT });
			case "POST /owner/passkey/enroll/options":
				return state.codeOk ? answer(200, CEREMONY) : refuse();
			case "POST /owner/passkey/enroll/verify":
				state.passkeys++;
				return answer(201, { passkey: PASSKEY });
			case "POST /owner/write/options":
				return state.signedIn ? answer(200, CEREMONY) : refuse();
			case "DELETE /owner/passkey":
				state.passkeys--;
				state.signedIn = false;
				return answer(200, { removed: "pk-1" });
		}
		if (!state.signedIn) return refuse();
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

describe("signed out", () => {
	it("opens a modal sign-in naming why, and shows memory once the passkey answers", async () => {
		const server = fakeServer();
		const webauthn = passkeyPrompt();
		const page = await mountPage(server, webauthn);
		const box = dialog() as HTMLElement;
		expect(box.getAttribute("aria-modal")).toBe("true");
		expect(text(oneByRole(box, "heading"))).toBe("Sign in to see memory");
		expect(text(box)).toContain("only you can open it");
		expect(box.contains(document.activeElement)).toBe(true);
		await click(oneByRole(box, "button", "Sign in with passkey"));
		await flush();
		expect(webauthn.authenticate).toHaveBeenCalledWith(CEREMONY.options);
		expect(dialog()).toBeNull();
		expect(byRole(page, "button").some((b) => b.getAttribute("data-note") === NOTE)).toBe(true);
		expect(maybeByRole(page, "button", "Sign out")).not.toBeNull();
	});

	it("a cancelled prompt keeps the sign-in open and says so", async () => {
		const webauthn = passkeyPrompt();
		webauthn.authenticate.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
		await mountPage(fakeServer(), webauthn);
		await click(oneByRole(dialog() as HTMLElement, "button", "Sign in with passkey"));
		expect(text(oneByRole(dialog() as HTMLElement, "alert"))).toContain("Sign-in was cancelled.");
	});

	it("a refused sign-in points to adding a passkey on this device", async () => {
		await mountPage(fakeServer({ passkeys: 0 }), passkeyPrompt());
		await click(oneByRole(dialog() as HTMLElement, "button", "Sign in with passkey"));
		expect(text(oneByRole(dialog() as HTMLElement, "alert"))).toContain(
			"Couldn't sign in. If this device has no passkey for this address yet, add one first.",
		);
	});

	it("Not now closes the sign-in, returns focus, and leaves a Sign in button on the page", async () => {
		const page = await mountPage(fakeServer(), passkeyPrompt());
		await click(oneByRole(dialog() as HTMLElement, "button", "Not now"));
		expect(dialog()).toBeNull();
		expect(text(oneByRole(page, "heading", "Sign in to see memory"))).toBe("Sign in to see memory");
		await click(oneByRole(page, "button", "Sign in"));
		expect(dialog()).not.toBeNull();
		await pressKey(document.activeElement as Element, "Escape");
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(oneByRole(page, "button", "Sign in"));
	});
});

describe("no passkey yet", () => {
	it("adds one with the 7-word Telegram code, then signs in", async () => {
		const server = fakeServer({ passkeys: 0 });
		const webauthn = passkeyPrompt();
		const page = await mountPage(server, webauthn);
		await click(oneByRole(dialog() as HTMLElement, "button", "Add a passkey"));
		expect(text(dialog())).toContain("Telegram");
		await click(oneByRole(dialog() as HTMLElement, "button", "Send code"));
		expect(server.sent).toContain("POST /owner/passkey/code");
		const box = oneByRole(dialog() as HTMLElement, "textbox", "7-word code from Telegram") as HTMLInputElement;
		await typeInto(box, "apple river stone cloud lamp seven tide");
		await click(oneByRole(dialog() as HTMLElement, "button", "Add passkey"));
		await flush();
		expect(webauthn.register).toHaveBeenCalledWith(CEREMONY.options);
		expect(server.sent).toContain("POST /owner/session/verify");
		expect(dialog()).toBeNull();
		expect(maybeByRole(page, "button", "Sign out")).not.toBeNull();
	});

	it("a wrong code says how codes work and keeps what was typed", async () => {
		const server = fakeServer({ passkeys: 0 });
		server.state.codeOk = false;
		await mountPage(server, passkeyPrompt());
		await click(oneByRole(dialog() as HTMLElement, "button", "Add a passkey"));
		await click(oneByRole(dialog() as HTMLElement, "button", "Send code"));
		const box = oneByRole(dialog() as HTMLElement, "textbox", "7-word code from Telegram") as HTMLInputElement;
		await typeInto(box, "wrong words");
		await click(oneByRole(dialog() as HTMLElement, "button", "Add passkey"));
		expect(text(oneByRole(dialog() as HTMLElement, "alert"))).toContain(
			"That code didn't work. A code works once, for 10 minutes.",
		);
		expect(box.value).toBe("wrong words");
	});
});

describe("signed in", () => {
	it("a session that ended while reading asks to sign in again and keeps the note open", async () => {
		const server = fakeServer({ signedIn: true });
		const page = await mountPage(server, passkeyPrompt());
		expect(dialog()).toBeNull();
		server.state.signedIn = false;
		await click(byRole(page, "button").find((b) => b.getAttribute("data-note") === NOTE) as HTMLElement);
		await click(oneByRole(dialog() as HTMLElement, "button", "Sign in with passkey"));
		await flush();
		expect(dialog()).toBeNull();
		expect(text(page)).toContain("Body 16 px or more.");
	});

	it("Sign out ends the session and shows the sign-in on the page", async () => {
		const server = fakeServer({ signedIn: true });
		const page = await mountPage(server, passkeyPrompt());
		await click(oneByRole(page, "button", "Sign out"));
		expect(server.sent).toContain("POST /owner/session/logout");
		expect(maybeByRole(page, "heading", "Sign in to see memory")).not.toBeNull();
		expect(dialog()).toBeNull();
	});

	it("Passkeys lists this address's passkeys and removes one after a confirm and the passkey prompt", async () => {
		const server = fakeServer();
		const webauthn = passkeyPrompt();
		const page = await mountPage(server, webauthn);
		await click(oneByRole(dialog() as HTMLElement, "button", "Sign in with passkey"));
		await flush();
		await click(oneByRole(page, "button", "Passkeys"));
		const list = dialog() as HTMLElement;
		expect(text(list)).toContain("Added Nov 13");
		expect(text(list)).toContain("this one");
		await click(oneByRole(list, "button", /^Remove/));
		const confirm = dialog() as HTMLElement;
		expect(text(confirm)).toContain("Remove this passkey?");
		expect(server.sent).not.toContain("DELETE /owner/passkey");
		await click(oneByRole(confirm, "button", "Remove passkey"));
		await flush();
		expect(server.sent).toContain("POST /owner/write/options");
		expect(server.sent).toContain("DELETE /owner/passkey");
		expect(maybeByRole(page, "heading", "Sign in to see memory")).not.toBeNull();
	});
});
