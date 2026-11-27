/**
 * Frontend #364 (v2 §5l.15): the Explorer's slug label reads specialist configs with a copy of pi-identity's Phase 1
 * reader (`readConfig`, specialists/files.ts + schema.ts). Rule 23 parity: for each stored config below, the label is
 * `no config` exactly when pi-identity's own reader refuses, else the status it reads (`retired`, or null for active).
 * The peer is the pi-identity checkout on this machine (PI_IDENTITY_PEER=<folder> overrides it); a missing peer fails.
 */
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { specialistConfigLabel } from "../../server/openviking/specialist-config-label.js";

const PEER = process.env.PI_IDENTITY_PEER ?? "/home/shinelay/projects/pi-identity";
const PEER_FILES = join(PEER, "specialists", "files.ts");
type PeerAnswer = { result: "allow"; config: { status: string } } | { result: "refuse"; code: string };
type ReadConfig = (identities: string, dept: string, slug: string) => PeerAnswer;

const good = (slug: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ v: 1, id: slug, title: `Specialist ${slug}`, status: "active", ...extra });

/** Stored file per slug: text, a symlink to another slug's file, a folder, or no file at all (null). */
const STORED: Record<string, string | { symlinkTo: string } | { folder: true } | null> = {
	"act-1": good("act-1", { tier: "high", thinking: "low", tools: { allow: ["read"] }, skills: ["s-1"] }),
	"ret-1": good("ret-1", { status: "retired" }),
	"none-1": null,
	"bad-json": "{ not json",
	"bad-id": good("other"),
	"bad-status": good("bad-status", { status: "paused" }),
	"bad-v": JSON.stringify({ v: 2, id: "bad-v", title: "T", status: "active" }),
	"no-title": JSON.stringify({ v: 1, id: "no-title", status: "retired" }),
	"long-title": good("long-title", { title: "x".repeat(81) }),
	authority: good("authority", { owner: "me" }),
	"unknown-key": good("unknown-key", { color: "red" }),
	"bad-tier": good("bad-tier", { tier: "ultra" }),
	"bad-model": good("bad-model", { model: "no-slash" }),
	"bad-tools": good("bad-tools", { tools: { allow: ["read"], extra: [] } }),
	"bad-skills": good("bad-skills", { skills: ["Bad Skill"] }),
	"too-large": good("too-large", { title: "T", tools: { allow: Array.from({ length: 900 }, (_, i) => `tool_${i}`) } }),
	"array-doc": "[]",
	linked: { symlinkTo: "ret-1" },
	"folder-cfg": { folder: true },
};

function identities(): string {
	const dir = mkdtempSync(join(tmpdir(), "spec-label-"));
	for (const [slug, stored] of Object.entries(STORED)) {
		const folder = join(dir, "qa", "specialists", slug);
		mkdirSync(folder, { recursive: true });
		const file = join(folder, "specialist.json");
		if (stored === null) continue;
		if (typeof stored === "string") writeFileSync(file, stored);
		else if ("symlinkTo" in stored)
			symlinkSync(join(dir, "qa", "specialists", stored.symlinkTo, "specialist.json"), file);
		else mkdirSync(file);
	}
	return dir;
}

describe("specialist label: parity with pi-identity's readConfig (rule 23)", () => {
	it("each stored config: `no config` exactly when the peer refuses, else the peer's status", async () => {
		if (!existsSync(PEER_FILES))
			throw new Error(`${PEER_FILES} is missing; set PI_IDENTITY_PEER to a pi-identity checkout`);
		const peer = (await import(pathToFileURL(PEER_FILES).href)) as { readConfig: ReadConfig };
		const dir = identities();
		const rows = Object.keys(STORED).map((slug) => {
			const answer = peer.readConfig(dir, "qa", slug);
			const expected = answer.result === "refuse" ? "no config" : answer.config.status === "retired" ? "retired" : null;
			return { slug, label: specialistConfigLabel(dir, "qa", slug), expected };
		});
		expect(rows.map((r) => [r.slug, r.label])).toEqual(rows.map((r) => [r.slug, r.expected]));
		// The table covers all three outcomes, so parity is not met by one constant answer.
		expect(new Set(rows.map((r) => r.expected))).toEqual(new Set([null, "retired", "no config"]));
	});

	it("an invalid slug or a department with no specialists folder: `no config`, never a throw", () => {
		const dir = identities();
		expect(specialistConfigLabel(dir, "qa", "Bad_Name")).toBe("no config");
		expect(specialistConfigLabel(dir, "qa", "../qa")).toBe("no config");
		expect(specialistConfigLabel(dir, "design", "act-1")).toBe("no config");
		expect(specialistConfigLabel(join(dir, "missing"), "qa", "act-1")).toBe("no config");
	});
});
