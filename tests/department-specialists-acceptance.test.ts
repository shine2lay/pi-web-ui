// Department specialists, pi-web-ui acceptance (Ops #1097, Rule 18 Task 1; Architecture #591 §4, §5.1).
// Every case is read by id from the shared cases (tests/fixtures/department-specialists.cases.json, sha256-pinned in
// tests/lib/department-specialists-cases.ts) and asserted at pi-web-ui's real host code: the identity entry reader
// (identities.ts), the `/identity` writers (agent-service.ts), the role message store (role-messages.ts), the queue
// row and the chat header. Groups: C-ENTRY, C-BIND, C-MSG, C-CHIP, C-PARITY, C-NOSPEC.
// Task 1 keeps this file outside tests/unit with its own config (red until Task 2):
//   TZ=UTC scripts/sealed.sh npx vitest run --config tests/department-specialists-acceptance.config.ts
// Task 2 builds the seams, moves this file into tests/unit/ and may not delete or weaken any assertion.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	IDENTITY_ENTRY_TYPE,
	identityCommandLine,
	identityIdOfEntry,
	identityIdOnBranch,
	liveChatIdentityId,
	loadIdentities,
	type IdentityDef,
	type IdentityEntryLike,
} from "../server/identities.js";
import {
	RoleMessages,
	roleMessageHeader,
	roleMessageText,
	type RoleMessageHost,
	type RoleMessageRecord,
	type RoleMessageSender,
} from "../server/role-messages.js";
import {
	E_SPEC_BINDING_CONFLICT,
	identityCommandRefusal,
	identityOfEntry,
	specialistBindingOnBranch,
} from "../server/specialist-entry.js";
import {
	NO_ROUTE,
	noRouteError,
	specialistShownTo,
	specialistStamp,
	type SpecialistFrom,
	type SpecialistRow,
	type SpecialistSender,
} from "../server/specialist-messages.js";
import { IdentityTag } from "../web/src/components/IdentityTag.js";
import { renderTaskQueueRow } from "../web/src/components/TaskQueueRow.js";
import { LanguageProvider } from "../web/src/i18n.js";
import {
	specialistChip,
	type ChipViewer,
	type SpecialistChatIdentity,
	type SpecialistTaskFields,
} from "../web/src/specialist-chip.js";
import type { UiChatIdentity, UiTaskQueue, UiTaskQueueTask } from "../web/src/types.js";
import {
	caseById,
	parityFiles,
	piWebUiCases,
	REPO_ROOT,
	type SpecialistCase,
} from "./lib/department-specialists-cases.js";

/** The 15 departments (department-specialists index, "Canonical departments"). */
const ROLES = [
	"architecture",
	"backend",
	"coo",
	"data",
	"design",
	"docs",
	"frontend",
	"marketing",
	"ops",
	"product",
	"qa",
	"rollcall",
	"security",
	"systems",
	"temper",
] as const;

const GROUPS = {
	"C-ENTRY": ["C-ENTRY-1", "C-ENTRY-2", "C-ENTRY-3", "C-ENTRY-4", "C-ENTRY-5", "C-ENTRY-6"],
	"C-BIND": ["C-BIND-1", "C-BIND-4", "C-BIND-6"],
	"C-MSG": ["C-MSG-1", "C-MSG-2", "C-MSG-3", "C-MSG-4"],
	"C-CHIP": ["C-CHIP-1", "C-CHIP-2", "C-CHIP-3", "C-CHIP-4"],
	"C-PARITY": ["C-PARITY-1"],
} as const;
/** C-NOSPEC: the R-SPEC-NOSPEC-1 cases pi-web-ui takes part in (absent specialist = today, byte for byte). */
const NOSPEC = ["C-ENTRY-2", "C-MSG-4", "C-CHIP-4", "C-BIND-6"] as const;
/** pi-web-ui cases outside the six §5.1 groups: ASK answers and the lead-home privacy read are pi-identity's tool
 *  answers (§2.3, §1.4), the model composition is pi-queue's launch (C-MODEL, §5.1 pi-queue row); pi-web-ui passes
 *  them through untouched. Listed so a new case can't go unowned. */
const OUTSIDE_GROUPS = ["C-PRIV-2", "C-ASK-1", "C-ASK-2", "C-MODEL-1", "C-MODEL-3"];

let dir = "";
const stops: Array<{ stop(): void }> = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dept-specialists-"));
});
afterEach(() => {
	for (const s of stops.splice(0)) s.stop();
	rmSync(dir, { recursive: true, force: true });
});

const entry = (data: unknown): IdentityEntryLike => ({ type: "custom", customType: IDENTITY_ENTRY_TYPE, data });
/** A case's binding entry as pi-identity's queue writes it (§4.1). */
const queueEntry = (e: { id: string; specialist?: string }): IdentityEntryLike =>
	entry({ v: 1, id: e.id, via: "queue", from: "/q/qa.jsonl", ...(e.specialist ? { specialist: e.specialist } : {}) });

function chatFile(name: string): string {
	const file = join(dir, "chats", `${name}.jsonl`);
	mkdirSync(join(dir, "chats"), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: name, cwd: dir })}\n`);
	return file;
}

/** The 15 roles on disk, each with a home chat, and QA's specialist "flaky-hunter" in its specialists folder
 *  (§1.1 layout). Read back with the host's own loadIdentities. */
function rolesOnDisk(): IdentityDef[] {
	const ids = join(dir, "identities");
	for (const id of ROLES) {
		mkdirSync(join(ids, id), { recursive: true });
		const identity = { id, title: id.toUpperCase(), homeChat: chatFile(`${id}-home`) };
		writeFileSync(join(ids, id, "identity.json"), JSON.stringify(identity));
	}
	const spec = join(ids, "qa", "specialists", "flaky-hunter");
	mkdirSync(spec, { recursive: true });
	const config = { v: 1, id: "flaky-hunter", title: "Flaky test hunter", status: "active" };
	writeFileSync(join(spec, "specialist.json"), JSON.stringify(config));
	return loadIdentities(ids).identities;
}

function store(roles: IdentityDef[]) {
	const host: RoleMessageHost = {
		roles: () => roles,
		chatState: () => "closed",
		deliver: async () => ({ ok: true }),
		note: async () => ({ ok: true }),
	};
	mkdirSync(join(dir, "data"), { recursive: true });
	const s = new RoleMessages(join(dir, "data", "role-messages.json"), host, () => 1_000_000);
	stops.push(s);
	return s;
}

/** A queued task's chat, as the server binds it (the specialist from the chat's identity entry, never the tool's). */
function taskSender(dept: string, task: number, specialist?: string): RoleMessageSender & SpecialistSender {
	return {
		role: dept,
		title: dept.toUpperCase(),
		chat: `Queue #${task}`,
		file: chatFile(`${dept}-task-${task}`),
		handling: 0,
		guard: { bindingId: `c-${task}`, isHome: false, task: { queueId: dept, taskId: task }, lastUserText: "" },
		...(specialist ? { specialist } : {}),
	};
}
function homeSender(dept: string, roles: IdentityDef[]): RoleMessageSender {
	const home = roles.find((r) => r.id === dept)?.homeChat;
	if (!home) throw new Error(`${dept} has no home chat`);
	return { role: dept, title: dept.toUpperCase(), chat: "home chat", file: home, handling: 0 };
}

describe("the shared cases pi-web-ui owns (§5.1)", () => {
	it("every pi-web-ui case is driven here or named as outside the six groups", () => {
		const driven = new Set<string>([...Object.values(GROUPS).flat(), ...NOSPEC]);
		const mine = piWebUiCases().map((c) => c.id);
		expect(mine.filter((id) => !driven.has(id)).sort()).toEqual([...OUTSIDE_GROUPS].sort());
		for (const id of driven) expect(caseById(id).id).toBe(id);
	});

	it("C-NOSPEC is every R-SPEC-NOSPEC-1 case pi-web-ui reads or writes", () => {
		const nospec = piWebUiCases()
			.filter((c) => c.req.includes("R-SPEC-NOSPEC-1") && !OUTSIDE_GROUPS.includes(c.id))
			.map((c) => c.id);
		expect([...nospec, "C-BIND-6"].sort()).toEqual([...NOSPEC].sort());
	});
});

describe("C-ENTRY: the identity entry's specialist (R-SPEC-ENTRY-1)", () => {
	for (const id of GROUPS["C-ENTRY"]) {
		const c = caseById(id);
		const want = c.expect.identity as { id: string; specialist?: string } | "unusable";
		/** What the host's id reader must give: the department, or null (no usable identity, never the plain one). */
		const wantId = want === "unusable" ? null : want.id;

		it(`${id}: specialist-entry reads ${JSON.stringify(c.input.data)} as ${JSON.stringify(want)}`, () => {
			expect(identityOfEntry(entry(c.input.data))).toEqual(want);
		});

		it(`${id}: identityIdOfEntry / identityIdOnBranch give ${JSON.stringify(wantId)}`, () => {
			expect(identityIdOfEntry(entry(c.input.data))).toBe(wantId);
			// An earlier plain entry never shows through a later unusable one.
			const earlier = entry({ v: 1, id: "ops", via: "command" });
			expect(identityIdOnBranch([earlier, entry(c.input.data)])).toBe(wantId);
			// Nor does the department's home chat: a written (unusable) entry is not "never written".
			const qaHome = join(dir, "qa-home.jsonl");
			const qa = { id: "qa", title: "QA", homeChat: qaHome, pastHomeChats: [] } as unknown as IdentityDef;
			expect(liveChatIdentityId(identityIdOnBranch([entry(c.input.data)]), qaHome, [qa])).toBe(wantId);
		});
	}

	it("C-ENTRY-1/3: the twins differ only by the slug's validity", () => {
		const good = caseById("C-ENTRY-1");
		expect(good.twin).toBe("C-ENTRY-3");
		expect(identityOfEntry(entry(good.input.data))).toEqual({ id: "qa", specialist: "flaky-hunter" });
		const bad = { ...(good.input.data as Record<string, unknown>), specialist: "../x" };
		expect(identityOfEntry(entry(bad))).toBe("unusable");
		expect(identityIdOfEntry(entry(bad))).toBeNull();
	});
});

describe("C-BIND: sticky specialist binding and `/identity` (R-SPEC-BIND-2)", () => {
	for (const id of GROUPS["C-BIND"]) {
		const c = caseById(id);
		const entries = (c.input.entries as Array<{ id: string; specialist?: string }>).map(queueEntry);
		const binding = c.expect.binding as { id: string; specialist?: string };

		it(`${id}: binding ${JSON.stringify(binding)}, conflict ${String(c.expect.conflict)}`, () => {
			expect(specialistBindingOnBranch(entries)).toEqual({ binding, conflict: c.expect.conflict });
			expect(identityIdOnBranch(entries)).toBe(binding.id);
		});

		it(`${id}: \`/identity\` is ${binding.specialist ? `refused with ${E_SPEC_BINDING_CONFLICT}` : "allowed, as today"}`, () => {
			const refusal = identityCommandRefusal(entries);
			if (binding.specialist) {
				expect(refusal).toEqual({ code: "E_SPEC_BINDING_CONFLICT", message: expect.any(String) });
				expect(refusal?.message).toMatch(/^E_SPEC_BINDING_CONFLICT: /);
			} else expect(refusal).toBeNull();
		});
	}

	it("C-BIND-1: a `/identity` attempt on a bound branch leaves the binding as it was", () => {
		const c = caseById("C-BIND-1");
		const entries = (c.input.entries as Array<{ id: string; specialist?: string }>).map(queueEntry);
		const tried = [...entries, entry({ v: 1, id: "ops", via: "command" })];
		expect(specialistBindingOnBranch(tried)).toEqual({ binding: c.expect.binding, conflict: true });
		expect(identityCommandRefusal(tried)?.code).toBe(E_SPEC_BINDING_CONFLICT);
	});

	it("both of pi-web-ui's `/identity` writers ask identityCommandRefusal before writing (agent-service.ts)", () => {
		const src = readFileSync(join(REPO_ROOT, "server", "agent-service.ts"), "utf8");
		expect(src).toMatch(/import \{[^}]*\bidentityCommandRefusal\b[^}]*\} from "\.\/specialist-entry\.js"/);
		// The durable chat's own `/identity <id>` handler: the refusal comes before its appendEntry.
		const at = src.indexOf('trimmed.startsWith("/identity ")');
		expect(at).toBeGreaterThan(0);
		const write = src.indexOf("appendEntry(", at);
		expect(src.slice(at, write)).toContain("identityCommandRefusal(");
		// setChatIdentity (chat menu, header label, picker): the refusal comes before it runs `/identity`.
		const set = src.indexOf("async setChatIdentity(");
		expect(set).toBeGreaterThan(0);
		const run = src.indexOf("session.prompt(line)", set);
		expect(src.slice(set, run)).toContain("identityCommandRefusal(");
	});
});

describe("C-MSG: messages from a specialist's task chat (R-SPEC-MSG-1, R-SPEC-MSG-2, R-SPEC-PRIV-1)", () => {
	const send = (s: RoleMessages, sender: RoleMessageSender, to: string, extra: Record<string, unknown> = {}) =>
		s.send(sender, { to, kind: "fyi", text: "Found the flaky run.", ...extra });

	it("C-MSG-1: the server stamps from.specialist; the recipient's header is today's", () => {
		const c = caseById("C-MSG-1");
		const input = c.input as { to: string; sender: { dept: string; specialist: string; task: number } };
		const roles = rolesOnDisk();
		const s = store(roles);
		const r = send(s, taskSender(input.sender.dept, input.sender.task, input.sender.specialist), input.to);
		if (!r.ok) throw new Error(r.error);
		const want = c.expect.record as { from: { role: string; specialist: string } };
		const from = r.record.from as RoleMessageRecord["from"] & SpecialistFrom;
		expect({ role: from.role, specialist: from.specialist }).toEqual(want.from);
		// The recipient (another department) sees "<dept> · Queue #N", never the specialist.
		const [dept, chat] = String(c.expect.recipient_header).split(" · ");
		for (const shown of [roleMessageHeader(r.record), roleMessageText(r.record)]) {
			expect(shown).toContain(`from ${dept} (`);
			expect(shown).toContain(`sent from its ${chat}`);
			expect(shown).not.toMatch(new RegExp(`\\b${input.sender.specialist}\\b`));
		}
		// The owner's message list shows it.
		const row = s.rows()[0] as ReturnType<RoleMessages["rows"]>[number] & SpecialistRow;
		expect(row.id).toBe(r.record.id);
		expect(row.fromSpecialist).toBe(input.sender.specialist);
		// The sending department's own views and the owner: yes; any other department: no.
		expect(specialistShownTo(r.record as never, { kind: "owner" })).toBe(input.sender.specialist);
		expect(specialistShownTo(r.record as never, { kind: "role", role: input.sender.dept })).toBe(
			input.sender.specialist,
		);
		for (const other of ROLES.filter((x) => x !== input.sender.dept)) {
			expect(specialistShownTo(r.record as never, { kind: "role", role: other })).toBeUndefined();
		}
	});

	it("C-MSG-1/4: the stamp comes from the server's binding only", () => {
		expect(specialistStamp({ specialist: "fh" })).toEqual({ specialist: "fh" });
		expect(specialistStamp({})).toEqual({});
	});

	for (const id of ["C-MSG-2", "C-MSG-3"] as const) {
		it(`${id}: a specialist target is refused as an unknown recipient (E_NO_ROUTE, one fixed text)`, () => {
			const c = caseById(id);
			const input = c.input as { to: string; sender: { dept: string } };
			expect(c.expect.result).toBe("refuse");
			expect(NO_ROUTE).toEqual(c.expect.payload);
			const roles = rolesOnDisk();
			const s = store(roles);
			const sender = homeSender(input.sender.dept, roles);
			const prepared = s.prepare(sender, { to: input.to, kind: "question", text: "Can you look?" });
			const sent = send(s, sender, input.to);
			for (const r of [prepared, sent]) {
				expect(r.ok).toBe(false);
				if (r.ok) continue;
				expect(r.error.startsWith(`${NO_ROUTE.code}: ${NO_ROUTE.message}`)).toBe(true);
				expect(r.error).not.toContain(input.to);
				expect(r.error).toBe(noRouteError(roles.map((x) => x.id)));
			}
			expect(s.rows()).toEqual([]);
		});
	}

	it("C-MSG-2/3: existing and missing specialists, and any non-role target, get byte-identical refusals", () => {
		expect(caseById("C-MSG-2").twin).toBe("C-MSG-1");
		const roles = rolesOnDisk();
		const s = store(roles);
		const sender = homeSender("ops", roles);
		const targets = [
			caseById("C-MSG-2").input.to as string, // qa/flaky-hunter: exists on disk
			caseById("C-MSG-3").input.to as string, // qa/ghost: doesn't
			"flaky-hunter",
			"QA/Flaky-Hunter",
			"nobody",
		];
		const errors = targets.map((to) => {
			const r = s.prepare(sender, { to, kind: "request", text: "Please run it." });
			return r.ok ? "allowed" : r.error;
		});
		expect(new Set(errors).size).toBe(1);
		expect(errors[0]).toMatch(/^E_NO_ROUTE: no such role/);
	});

	it("C-MSG-4: no specialist: the record is today's, and a `specialist` tool argument stamps nothing", () => {
		const c = caseById("C-MSG-4");
		const input = c.input as { to: string; sender: { dept: string; task: number } };
		const roles = rolesOnDisk();
		const s = store(roles);
		const r = send(s, taskSender(input.sender.dept, input.sender.task), input.to, { specialist: "fh", slug: "fh" });
		if (!r.ok) throw new Error(r.error);
		expect(Object.keys(r.record.from).sort()).toEqual(["chat", "file", "role", "title"]);
		expect({ role: r.record.from.role }).toEqual((c.expect.record as { from: unknown }).from);
		const [dept, chat] = String(c.expect.recipient_header).split(" · ");
		expect(roleMessageHeader(r.record)).toContain(`from ${dept} (`);
		expect(roleMessageHeader(r.record)).toContain(`sent from its ${chat}`);
		expect("fromSpecialist" in s.rows()[0]).toBe(false);
		expect(specialistShownTo(r.record as never, { kind: "owner" })).toBeUndefined();
	});
});

const PLAN = {
	title: "Hunt the flaky test",
	goal: "g",
	doneWhen: "d",
	decided: "x",
	steps: "s",
	verify: "v",
	mustNot: "m",
};
const noop = () => {};
type RowProps = Parameters<typeof renderTaskQueueRow>[0];
function Row(props: RowProps) {
	return renderTaskQueueRow(props);
}
function rowMarkup(task: SpecialistTaskFields): string {
	const t = { id: 7, status: "ready", plan: PLAN, addedAt: 1_000, ...task } as UiTaskQueueTask & SpecialistTaskFields;
	const queue: UiTaskQueue = { queueId: "qa", running: false, available: true, tasks: [t] };
	const props: RowProps = {
		task: t,
		kind: "ready",
		readyCount: 1,
		queue,
		expanded: false,
		flash: null,
		laneNo: new Map(),
		busy: false,
		pendingSetting: false,
		removing: null,
		setRemoving: noop,
		run: noop,
		toggle: noop,
		changeProfile: noop,
		models: [],
		showTask: noop,
	};
	return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(Row, props)));
}
function headerMarkup(identity: UiChatIdentity & SpecialistChatIdentity): string {
	const props: ComponentProps<typeof IdentityTag> = { identity, onClick: noop, className: "chat-header-identity" };
	return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(IdentityTag, props)));
}
/** The chips in some markup: the words of each element marked data-specialist-chip. */
const chipsIn = (html: string) => [...html.matchAll(/<[^>]*\bdata-specialist-chip\b[^>]*>([^<]*)</g)].map((m) => m[1]);

describe("C-CHIP: one small chip on the queue row and the task chat's header (R-SPEC-UI-1)", () => {
	for (const id of GROUPS["C-CHIP"]) {
		const c = caseById(id);
		const input = c.input as { viewer: ChipViewer; task: SpecialistTaskFields };
		const chip = c.expect.chip as string | null;

		it(`${id}: ${input.viewer} sees ${chip === null ? "no chip" : `the chip "${chip}"`}`, () => {
			expect(specialistChip(input.task, input.viewer)).toBe(chip);
		});

		// The page is the owner's (and shows the department's own queue): the chip is on the row and the header.
		if (input.viewer !== "other_dept") {
			it(`${id}: the queue row and the task chat's header show exactly ${chip === null ? "no" : "one"} chip`, () => {
				const want = chip === null ? [] : [chip];
				expect(chipsIn(rowMarkup(input.task))).toEqual(want);
				const slug = input.task.specialist;
				const identity = {
					id: "qa",
					title: "QA",
					...(slug ? { specialist: { slug, ...(input.task.launch?.specialist ?? {}) } } : {}),
				};
				expect(chipsIn(headerMarkup(identity))).toEqual(want);
			});
		}
	}

	it("C-CHIP-4: a task without a specialist renders byte-identical to today's row", () => {
		expect(rowMarkup({ specialist: undefined })).toBe(rowMarkup({}));
		expect(headerMarkup({ id: "qa", title: "QA" })).not.toContain("data-specialist-chip");
	});

	it("roster stays 15 and no specialist becomes a role or an `/identity` choice (§4.3, §4.4)", () => {
		const roster = rolesOnDisk();
		expect(roster.map((r) => r.id)).toEqual([...ROLES]);
		for (const id of GROUPS["C-CHIP"]) expect(roster.length).toBe(caseById(id).expect.roster);
		for (const choice of ["flaky-hunter", "qa/flaky-hunter", "fh"])
			expect(identityCommandLine(choice, roster)).toBeNull();
	});

	it("§4.4: no prototype-only specialist chrome in the web app (only the chip's own module)", () => {
		const files: string[] = [];
		const walk = (d: string) => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				if (e.isDirectory()) walk(join(d, e.name));
				else files.push(join(d, e.name).slice(REPO_ROOT.length + 1));
			}
		};
		walk(join(REPO_ROOT, "web", "src"));
		const named = files.filter((f) => /specialist/i.test(f));
		expect(named.filter((f) => !/(^|\/)(specialist-chip\.ts|SpecialistChip\.tsx)$/.test(f))).toEqual([]);
	});
});

describe("C-PARITY: the identity-config copy (R-SPEC-PARITY-1)", () => {
	it("C-PARITY-1: server/identity-config.ts is byte-identical to pi-identity's config.ts", () => {
		const c: SpecialistCase = caseById("C-PARITY-1");
		const { own, peer } = parityFiles(c);
		const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
		expect(sha(own) === sha(peer)).toBe(c.expect.identical);
	});
});

describe("C-NOSPEC: absent specialist = today, byte for byte (R-SPEC-NOSPEC-1)", () => {
	it("C-ENTRY-2: a plain queue entry reads as today's department", () => {
		const data = caseById("C-ENTRY-2").input.data;
		expect(identityIdOfEntry(entry(data))).toBe("qa");
		expect(identityOfEntry(entry(data))).toEqual({ id: "qa" });
	});

	it("C-BIND-6: a plain branch has no binding conflict and `/identity` is allowed", () => {
		const entries = (caseById("C-BIND-6").input.entries as Array<{ id: string }>).map(queueEntry);
		expect(identityCommandRefusal(entries)).toBeNull();
		expect(identityIdOnBranch(entries)).toBe("qa");
	});

	it("C-MSG-4 / C-CHIP-4: no stamp, no chip", () => {
		expect(specialistStamp({})).toEqual({});
		expect(specialistChip(caseById("C-CHIP-4").input.task as SpecialistTaskFields, "own_dept")).toBeNull();
	});
});
