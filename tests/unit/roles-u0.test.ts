import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	assertNativeFields,
	FIELD_ROWS,
	fieldDisplay,
	missingFields,
	type NativeFields,
	type NativeReadModel,
} from "../../web/src/roles-u0/fields.js";
import {
	createNativeRolesView,
	nativeOperationalState,
	NATIVE_CONTACT_LABEL,
	NATIVE_RECEIPT_LABEL,
	PRESERVED_ROUTES,
	type NativeClock,
	type NativeSnapshot,
	type NativeRoute,
} from "../../web/src/roles-u0/native.js";
import { ringAnchor, ringLayout } from "../../web/src/roles-u0/layout.js";
import { ROW_CASES, fixtureFields } from "../roles-u0/fields.js";
import { ReferenceModel } from "../roles-u0/reference-model.js";
import type { UiRoleOverview } from "../../server/protocol.js";

function role(id = "test", title = "A fictional test department"): UiRoleOverview {
	return {
		id,
		title,
		workMode: "request-only",
		workModeFrom: "rules",
		goals: [],
		goalsFrom: "rules",
		status: "busy",
		asks: [],
		tldr: [],
		requests: { open: 0 },
		report: { state: "unavailable" },
	};
}
const metadata = (fields: NativeFields = missingFields()): NativeReadModel => ({
	schema: "roles-u0/read-model/1",
	namespace: "rtpi-native",
	fields,
});
function snapshot(ids = ["test"], connection: NativeSnapshot["connection"] = "connected"): NativeSnapshot {
	return {
		namespace: "rtpi-native",
		registryComplete: true,
		checkedAt: null,
		connection,
		roles: ids.map((id) => ({ role: role(id), metadata: metadata() })),
	};
}
const routes = {
	canOpen: () => false,
	open: () => {
		throw new Error("not admitted");
	},
};
const clock: NativeClock = {
	raf: (fn) => fn(),
	setTimeout: (fn) => {
		fn();
		return 0;
	},
	clearTimeout: () => {},
};
const view = (s: NativeSnapshot | (() => NativeSnapshot), r: Parameters<typeof createNativeRolesView>[1] = routes) =>
	createNativeRolesView(typeof s === "function" ? s : () => s, r, clock);
type Box = {
	id: string;
	name: string;
	state: string;
	onYou: boolean;
	lanesText: string;
	lanesLabel: string;
	glance: string;
	taskSrc: string;
};
const boxes = (v: Record<string, unknown>) => (v.glance as { boxes: Box[] }).boxes;
const here = fileURLToPath(new URL("../../web/src/roles-u0/", import.meta.url));
const nativeSource = (namespace = "rtpi-native") => ({ namespace, kind: "test", id: "test-1", revision: "1" });
const knownField = (value: unknown) => ({
	state: "known",
	value,
	asOf: "2026-10-11T12:46:10.000Z",
	source: nativeSource(),
});

describe("U0: closed 64-row metadata and fixture/native separation", () => {
	it("covers the 64 matrix rows exactly, four states each", () => {
		expect(FIELD_ROWS).toHaveLength(64);
		expect(ROW_CASES).toHaveLength(64);
		expect(new Set(FIELD_ROWS.map((x) => x[0])).size).toBe(64);
		for (const row of ROW_CASES) {
			expect(fieldDisplay(row.missing)).toMatch(/^Not (recorded|reported)$/);
			expect(fieldDisplay(row.unknown)).toBe("Unknown");
			expect(fieldDisplay(row.known)).toBe("Fictional " + row.id);
			expect(fieldDisplay(row.stale)).toBe("Last known: Fictional " + row.id);
		}
	});
	it("admits missing native metadata, never the fictional namespace", () => {
		expect(assertNativeFields(metadata())).toEqual(missingFields());
		for (const which of ["known", "stale"] as const) {
			expect(() => assertNativeFields({ ...metadata(), fields: fixtureFields(which) })).toThrow(/fixture source/);
		}
		expect(() =>
			assertNativeFields({ ...metadata(), namespace: "rtpi-fixture" } as unknown as NativeReadModel),
		).toThrow(/fixture/);
	});
	it("refuses simulation flags, rows, extra keys and unsupported versions", () => {
		for (const extra of [{ scenario: "live" }, { fixture: false }, { simulate: false }]) {
			expect(() => assertNativeFields({ ...metadata(), ...extra })).toThrow(/keys/);
		}
		expect(() =>
			assertNativeFields({ ...metadata(), schema: "roles-u0/read-model/2" } as unknown as NativeReadModel),
		).toThrow(/unsupported/);
		expect(() =>
			assertNativeFields({
				...metadata(),
				fields: { ...missingFields(), A99: { state: "unknown" } },
			} as unknown as NativeReadModel),
		).toThrow(/coverage/);
	});
	it("metadata values cannot contain executable/simulation keys or nonfinite numbers", () => {
		const bad = [Infinity, { scenario: "live" }, { simulate: false }, () => {}, Object.create(null)];
		for (const value of bad) {
			const fields = { ...missingFields(), A01: knownField(value) };
			expect(() => assertNativeFields({ ...metadata(), fields } as unknown as NativeReadModel)).toThrow();
		}
	});
	it("busy legacy status is not a new operational state, lane count or receipt", () => {
		const s = snapshot();
		expect(s.roles[0].role.status).toBe("busy");
		expect(nativeOperationalState(s.roles[0].metadata.fields)).toBe("unknown");
		const b = boxes(view(s).values(1400, 780))[0];
		expect(b.state).toBe("unknown");
		expect(b.onYou).toBe(false);
		expect(b.lanesText).toBe("Not recorded");
		expect(b.glance).toBe("Not recorded");
	});
	it("uses the registry, not a fixed cohort; partial registries say so", () => {
		for (const count of [0, 1, 7, 17]) {
			const v = view(snapshot(Array.from({ length: count }, (_, i) => "role-" + i))).values(1400, 780);
			expect(boxes(v)).toHaveLength(count);
			expect(v.headingSummary).toMatch(new RegExp("^" + count + " departments"));
		}
		expect(view({ ...snapshot(), registryComplete: false }).values(1400, 780).headingSummary).toMatch(
			/^Department count not recorded/,
		);
	});
	it("closed snapshot rejects fiction knobs and fixture roots", () => {
		for (const s of [
			{ ...snapshot(), scenario: "live" },
			{ ...snapshot(), namespace: "rtpi-fixture" },
		]) {
			expect(() => view(s as NativeSnapshot).values(1400, 780)).toThrow();
		}
	});
	it("neutral contacts and qualified settlement labels, individual figures only", () => {
		expect(NATIVE_CONTACT_LABEL).toBe("Your contacts");
		expect(NATIVE_RECEIPT_LABEL).toBe("Processed in a settled turn");
		const v = view(snapshot()).values(1400, 780);
		expect(v.contactsHeading).toBe("Your contacts");
		expect(v.spendAmountText).toBe("Not reported");
		expect(v.spendRoleText).toBe("Not reported");
		expect(v.spendNoteText).toContain("no total across departments");
		expect(v.spendBarColor).toBe("transparent");
		expect(v.arrowMeaning).toContain("processed in a settled turn");
		expect(JSON.stringify(v)).not.toMatch(
			/318\.10|6 of 12|confirmed 12:46|actually handled|Nothing waiting on you|Telegram/,
		);
	});
	it("shows one department's spend only as its own figure; several stay individual", () => {
		const s = snapshot(["a", "b"]);
		s.roles[0].role.spend = { state: "ok", line: "", spent: "$10.00", budget: "$40.00" };
		let v = view(s).values(1400, 780);
		expect(v.spendAmountText).toBe("$10.00");
		expect(v.spendBudgetText).toBe("of $40.00");
		expect(v.spendBarWidth).toBe("25%");
		s.roles[1].role.spend = { state: "ok", line: "", spent: "$5.00", budget: "$40.00" };
		v = view(s).values(1400, 780);
		expect(v.spendAmountText).toBe("Not reported");
		expect(JSON.stringify(v)).not.toContain("$15.00");
	});
	it("keeps long labels and every task; does not infer a requester", () => {
		const s = snapshot();
		const r = s.roles[0].role;
		r.title = "A long department title ".repeat(12);
		r.queue = {
			running: true,
			active: [1, 2, 3].map((id) => ({ id, title: "A very long task title ".repeat(10), status: "working" as const })),
			queued: [{ id: 4, title: "Later", status: "ready" }],
			counts: { active: 3, queued: 1, done: 0 },
		};
		const vw = view(s);
		vw.select(r.id);
		const v = vw.values(1400, 780),
			ex = v.ex as { name: string; taskSrc: string; taskGroups: { label: string; items: { srcText: string }[] }[] };
		expect(v.exOpen).toBe(true);
		expect(ex.name).toBe(r.title);
		expect(ex.taskGroups.map((g) => [g.label, g.items.length])).toEqual([
			["Running", 3],
			["Ready to start", 1],
		]);
		expect(ex.taskGroups.flatMap((g) => g.items).every((x) => x.srcText === "Not recorded")).toBe(true);
		expect(ex.taskSrc).toBe("· requester not recorded");
		expect(boxes(v)[0].glance).toBe("#1 " + r.queue.active[0].title);
	});
	it("partial native fields show what is recorded and keep the rest missing", () => {
		const f = {
			...missingFields(),
			A05: knownField("working"),
			A06: knownField(["working", "free", "free"]),
			A08: knownField(true),
		} as unknown as NativeFields;
		const s: NativeSnapshot = { ...snapshot([]), roles: [{ role: role(), metadata: metadata(f) }] };
		const b = boxes(view(s).values(1400, 780))[0];
		expect(b.state).toBe("working");
		expect(b.onYou).toBe(true);
		expect(b.lanesText).toBe("1/3 working");
		expect(b.lanesLabel).toBe("3 task lanes: 1 working, 2 free");
		expect(b.taskSrc).toBe("· requester not recorded");
	});
	it("disconnected and loading are stated, never stale or idle", () => {
		const d = view({ ...snapshot([], "disconnected"), checkedAt: "2026-10-11T12:46:10.000Z" }).values(1400, 780);
		expect(d.offline).toBe(true);
		expect((d.banner as { show: boolean; hasAction: boolean }).show).toBe(true);
		expect((d.banner as { hasAction: boolean }).hasAction).toBe(false);
		expect((d.fresh as { text: string }).text).toMatch(/^Disconnected · last known/);
		const l = view(snapshot(["a"], "loading")).values(1400, 780);
		expect(l.loading).toBe(true);
		expect(l.ready).toBe(false);
		expect(boxes(l)).toHaveLength(0);
		expect(l.footerText).toBe("Waiting for first update");
		expect(JSON.stringify(view(snapshot()).values(1400, 780))).not.toMatch(/Stale|Idle/);
	});
	it("rechecks the current registry and native route, with no missing-home fallback", () => {
		let s = snapshot();
		const opened: [string, NativeRoute][] = [];
		const vw = view(() => s, { canOpen: () => true, open: (id, route) => opened.push([id, route]) });
		expect(vw.navigate("home")).toBe(false);
		vw.select("test");
		expect(vw.navigate("home")).toBe(false);
		expect(vw.navigate("queue")).toBe(false);
		s.roles[0].role.homeChat = { file: "/fictional-test-only/home.jsonl" };
		s.roles[0].role.queue = { running: false, active: [], queued: [], counts: { active: 0, queued: 0, done: 0 } };
		for (const route of PRESERVED_ROUTES) expect(vw.navigate(route)).toBe(true);
		expect(opened.map((x) => x[1])).toEqual(PRESERVED_ROUTES);
		expect(vw.navigate("nowhere" as NativeRoute)).toBe(false);
		s = { ...s, roles: [] };
		expect(vw.navigate("home")).toBe(false);
	});
	it("the ring matches the supplied source number for number", () => {
		const model = new ReferenceModel({ scenario: "live", view: "glance", showProto: false });
		const ref = model.renderVals() as {
			glance: { boxes: { id: string; name: string; px: string; py: string }[] };
			nodeW: string;
		};
		const lay = ringLayout(ref.glance.boxes.map((b) => ({ id: b.id, name: b.name })));
		expect(lay.nodeW + "px").toBe(ref.nodeW);
		for (const b of ref.glance.boxes) expect(ringAnchor(lay, b.id)).toEqual({ px: b.px, py: b.py });
	});
	it("native files contain no mock model, amount, dynamic HTML or simulation import", () => {
		for (const file of ["native.ts", "fields.ts", "layout.ts", "mount.ts", "types.ts", "surface.html", "surface.ts"]) {
			const source = readFileSync(here + file, "utf8");
			expect(source).not.toMatch(
				/reference-model|fixture-entry|318\.10|6 of 12|15 departments|12:46:10|new Function|\beval\(/,
			);
		}
	});
});
