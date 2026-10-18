import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	OWNER_CONTACTS_WINDOW_MS,
	OwnerContacts,
	excerptOf,
	foldOwnerContacts,
	ownerContactEventOf,
	ownerInputIds,
	type OwnerContactEvent,
} from "../../server/owner-contacts.js";
import { projectContacts } from "../../web/src/roles-exact-model.js";

const T = 1_760_000_000_000;
const B = "ri-0123abcd-0000-4000-8000-000000000001";
const G = "rs-0123abcd-0000-4000-8000-000000000002";

describe("owner-contacts (Roles D3)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("checks every event field and drops anything else", () => {
		expect(ownerContactEventOf({ e: "contact", id: B, at: T, role: "ops", channel: "browser", text: "hi" })).toEqual({
			e: "contact",
			id: B,
			at: T,
			role: "ops",
			channel: "browser",
			text: "hi",
		});
		expect(
			ownerContactEventOf({ e: "contact", id: "rm-1234abcd", at: T, role: "ops", channel: "browser" }),
		).toBeUndefined();
		expect(ownerContactEventOf({ e: "contact", id: B, at: T, role: "../x", channel: "browser" })).toBeUndefined();
		expect(ownerContactEventOf({ e: "contact", id: B, at: T, role: "ops", channel: "email" })).toBeUndefined();
		expect(ownerContactEventOf({ e: "settled", id: B, at: T, outcome: "maybe" })).toBeUndefined();
		expect(ownerContactEventOf({ e: "transport", id: G, at: T, ok: "yes" })).toBeUndefined();
		expect(ownerContactEventOf({ e: "taken", id: B, at: -1 })).toBeUndefined();
		// a reply excerpt is kept only for a reply with text
		expect(ownerContactEventOf({ e: "settled", id: B, at: T, outcome: "error", reply: "x" })).toEqual({
			e: "settled",
			id: B,
			at: T,
			outcome: "error",
		});
		expect(excerptOf("  a\n\n b  ", 10)).toBe("a b");
		expect(excerptOf("abcdef", 4)).toBe("abc…");
		expect(excerptOf("   ", 4)).toBeUndefined();
	});

	it("folds stages: first record wins, a send result only for Telegram, the window drops old contacts", () => {
		const ev: OwnerContactEvent[] = [
			{ e: "contact", id: B, at: T, role: "ops", channel: "browser", text: "browser one" },
			{ e: "contact", id: G, at: T + 10, role: "coo", channel: "telegram" },
			{ e: "taken", id: B, at: T + 1 },
			{ e: "taken", id: B, at: T + 5 },
			{ e: "settled", id: B, at: T + 2, outcome: "text", reply: "done" },
			{ e: "settled", id: B, at: T + 6, outcome: "error" },
			{ e: "transport", id: B, at: T + 3, ok: true },
			{ e: "transport", id: G, at: T + 11, ok: false },
			{ e: "transport", id: G, at: T + 12, ok: true },
			{ e: "taken", id: "ri-ffffffff-0000-4000-8000-000000000009", at: T + 1 },
			{
				e: "contact",
				id: "ri-eeeeeeee-0000-4000-8000-000000000008",
				at: T - OWNER_CONTACTS_WINDOW_MS - 1,
				role: "ops",
				channel: "browser",
			},
		];
		expect(foldOwnerContacts(ev, T + 20)).toEqual([
			{ id: G, role: "coo", channel: "telegram", askedAt: T + 10, sentAt: T + 12 },
			{
				id: B,
				role: "ops",
				channel: "browser",
				askedAt: T,
				text: "browser one",
				takenAt: T + 1,
				settledAt: T + 2,
				outcome: "text",
				reply: "done",
			},
		]);
		expect(
			ownerInputIds({ requesterInputs: [{ kind: "owner", channel: "telegram", id: G }, { kind: "unknown" }] }),
		).toEqual([G]);
		expect(ownerInputIds(undefined)).toEqual([]);
	});

	it("the store writes 0600 lines, skips stages of unknown contacts and torn lines, and lists newest first", () => {
		const dir = mkdtempSync(join(tmpdir(), "owner-contacts-"));
		dirs.push(dir);
		const file = join(dir, "owner-contacts.jsonl");
		let now = T;
		const store = new OwnerContacts(file, () => now);
		expect(store.list()).toEqual([]);
		store.note({ e: "taken", id: B, at: T });
		expect(() => statSync(file)).toThrow();
		store.note({ e: "contact", id: B, at: T, role: "ops", channel: "browser", text: "x".repeat(400) });
		store.note({ e: "contact", id: B, at: T + 1, role: "ops", channel: "browser" });
		store.note({ e: "taken", id: B, at: T + 2 });
		store.note({ e: "settled", id: B, at: T + 3, outcome: "noText" });
		store.note({ e: "bogus", id: B, at: T });
		expect(statSync(file).mode & 0o777).toBe(0o600);
		writeFileSync(file, `${readFileSync(file, "utf8")}{"e":"taken",\n`);
		now = T + 60_001;
		const [c] = store.list();
		expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(4);
		expect(c).toMatchObject({ id: B, askedAt: T, takenAt: T + 2, settledAt: T + 3, outcome: "noText" });
		expect(Array.from(c!.text!)).toHaveLength(280);
		// a fresh store (after a restart) knows the contacts already in the file
		new OwnerContacts(file, () => now).note({ e: "taken", id: B, at: T + 9 });
		expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(5);
	});

	it("the page keeps only well-formed contacts and never invents a stage", () => {
		expect(projectContacts(undefined)).toBeNull();
		expect(
			projectContacts([
				{ id: G, role: "coo", channel: "telegram", askedAt: T, outcome: "text", reply: "r", sentAt: T + 1 },
				{
					id: B,
					role: "ops",
					channel: "browser",
					askedAt: T,
					sentAt: T + 1,
					settledAt: T + 2,
					outcome: "text",
					reply: "ok",
				},
				{ id: "x", role: "ops", channel: "browser", askedAt: T },
				{ id: B, role: "ops", channel: "fax", askedAt: T },
			]),
		).toEqual([
			{
				id: G,
				role: "coo",
				channel: "telegram",
				askedAt: T,
				text: null,
				takenAt: null,
				settledAt: null,
				outcome: null,
				reply: null,
				sentAt: T + 1,
				sendFailedAt: null,
			},
			{
				id: B,
				role: "ops",
				channel: "browser",
				askedAt: T,
				text: null,
				takenAt: null,
				settledAt: T + 2,
				outcome: "text",
				reply: "ok",
				sentAt: null,
				sendFailedAt: null,
			},
		]);
	});
});
