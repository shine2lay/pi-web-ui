/**
 * Frontend #365 (v2 §5l.15 + §5l clarification "Status labels use the one specialist reader"): the Explorer's slug
 * label is a thin projection of pi-identity's own `readConfig`, loaded from the pi-identity the host has installed.
 * These cases run through that real reader: the loaded function is pi-identity's own (delegation), and each stored
 * config's label follows its answer: `no config` only for E_SPEC_NOT_FOUND, `config unreadable` for any other refusal.
 * The peer is the pi-identity checkout on this machine (PI_IDENTITY_PEER=<folder> overrides it); a missing peer fails.
 */
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	loadSpecialistReader,
	specialistConfigLabel,
	type SpecialistReader,
} from "../../server/openviking/specialist-config-label.js";

const PEER = process.env.PI_IDENTITY_PEER ?? "/home/shinelay/projects/pi-identity";
const PEER_ENTRY = join(PEER, "specialists", "readonly.ts");

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

/** An agent folder whose settings install the given packages (pi's settings.json `packages`). */
function agentDirWith(packages: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "spec-agent-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages }));
	return dir;
}

async function peerReader(): Promise<SpecialistReader> {
	if (!existsSync(PEER_ENTRY))
		throw new Error(`${PEER_ENTRY} is missing; set PI_IDENTITY_PEER to a pi-identity checkout`);
	return (await import(pathToFileURL(PEER_ENTRY).href)) as SpecialistReader;
}

describe("specialist label: a projection of pi-identity's own readConfig", () => {
	it("loads pi-identity's own readConfig from the installed package (delegation, not a copy)", async () => {
		const peer = await peerReader();
		const reader = await loadSpecialistReader(agentDirWith([PEER]));
		expect(reader?.readConfig).toBe(peer.readConfig);
	});

	it("each stored config: the label follows the real reader's answer", async () => {
		const reader = await loadSpecialistReader(agentDirWith([PEER]));
		if (!reader) throw new Error("pi-identity did not load from its installed package");
		const dir = identities();
		const rows = Object.keys(STORED).map((slug) => {
			const answer = reader.readConfig(dir, "qa", slug);
			const expected =
				answer.result === "allow"
					? answer.config.status === "retired"
						? "retired"
						: null
					: answer.code === "E_SPEC_NOT_FOUND"
						? "no config"
						: "config unreadable";
			return { slug, label: specialistConfigLabel(reader, dir, "qa", slug), expected };
		});
		expect(rows.map((r) => [r.slug, r.label])).toEqual(rows.map((r) => [r.slug, r.expected]));
		// Absence and a refused file read differently; the table covers every outcome, so no constant answer passes.
		expect(Object.fromEntries(rows.map((r) => [r.slug, r.label]))).toMatchObject({
			"act-1": null,
			"ret-1": "retired",
			"none-1": "no config",
			"bad-json": "config unreadable",
			linked: "config unreadable",
			"folder-cfg": "config unreadable",
		});
	});

	it("a department or identities folder with no config: `no config`; a slug the reader refuses: unreadable", async () => {
		const reader = await loadSpecialistReader(agentDirWith([PEER]));
		const dir = identities();
		expect(specialistConfigLabel(reader, dir, "design", "act-1")).toBe("no config");
		expect(specialistConfigLabel(reader, join(dir, "missing"), "qa", "act-1")).toBe("no config");
		expect(specialistConfigLabel(reader, dir, "qa", "../qa")).toBe("config unreadable");
	});

	it("no loadable pi-identity, or a reader that throws: `config unreadable`, never a guessed `no config`", async () => {
		expect(await loadSpecialistReader(agentDirWith([]))).toBeNull();
		expect(await loadSpecialistReader(join(tmpdir(), "no-such-agent-dir"))).toBeNull();
		const dir = identities();
		expect(specialistConfigLabel(null, dir, "qa", "none-1")).toBe("config unreadable");
		const throwing: SpecialistReader = {
			readConfig: () => {
				throw new Error("EIO");
			},
		};
		expect(specialistConfigLabel(throwing, dir, "qa", "act-1")).toBe("config unreadable");
	});
});
