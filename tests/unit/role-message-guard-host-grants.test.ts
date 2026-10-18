// role-message-ladder (#122): the approval ladder wired over the native role messages, stage by stage on fixed
// cases (rule 16): which grant a send uses (chooseGrant alone, no world). Ops #230 split the one host test file so
// vitest runs its parts side by side (docs/test-speed.md).
import { describe, expect, it } from "vitest";
import { chooseGrant } from "../../server/role-message-guard-host.js";

describe("ladder: which grant a send uses", () => {
	const actor = { role: "alpha", sessionFile: "/a", task: null } as never;
	const grant = (id: string, over: Record<string, unknown> = {}) =>
		({
			id,
			state: "approved",
			expiresAt: 2_000,
			acceptedUses: 0,
			maximumUses: 5,
			binding: {
				causal: {
					kind: "rooted",
					rootId: "root-1",
					parentId: "m6",
					incomingRecordId: "m6",
					nextHop: 7,
					sourceRevision: "",
					incomingHash: "",
				},
				upperHop: 11,
				scope: { scopeId: "s", operation: "o", participants: ["alpha", "beta"], recipients: ["beta"], task: null },
			},
			...over,
		}) as never;
	const at = (hop: number, incoming: string) =>
		({
			kind: "rooted",
			rootId: "root-1",
			parentId: incoming,
			incomingRecordId: incoming,
			nextHop: hop,
			sourceRevision: "",
			incomingHash: "",
		}) as never;
	// Line: m6 <- m7 <- m8 (granted line); x5 <- x6 is a branch made before the grant's anchor.
	const line: Record<string, { hop: number; parent?: string }> = {
		m6: { hop: 6 },
		m7: { hop: 7, parent: "m6" },
		m8: { hop: 8, parent: "m7" },
		x6: { hop: 6, parent: "x5" },
		x5: { hop: 5 },
	};
	const ancestorAt = (id: string, hop: number) => {
		let r: string | undefined = id;
		while (r && line[r] && line[r].hop > hop) r = line[r].parent;
		return r && line[r]?.hop === hop ? r : undefined;
	};
	const base = { actor, to: "beta", now: 1_000, wanted: null, ancestorAt };

	it("uses the grant on its own line, later hops included", () => {
		expect(chooseGrant({ ...base, grants: [grant("g1")], causal: at(7, "m6") })).toMatchObject({ kind: "use" });
		expect(chooseGrant({ ...base, grants: [grant("g1")], causal: at(9, "m8") })).toMatchObject({ kind: "use" });
	});
	it("a branch made before the grant's anchor can't use it", () => {
		expect(chooseGrant({ ...base, grants: [grant("g1")], causal: at(7, "x6") })).toEqual({ kind: "none" });
	});
	it("a lower grant never covers hop 12; nothing below hop 7 uses a grant", () => {
		line.m11 = { hop: 11, parent: "m8" };
		expect(chooseGrant({ ...base, grants: [grant("g1")], causal: at(12, "m11") })).toEqual({ kind: "none" });
		expect(chooseGrant({ ...base, grants: [grant("g1")], causal: at(6, "m6") })).toEqual({ kind: "none" });
	});
	it("of two live grants, uses the one whose recipients fit", () => {
		const both = [
			grant("g1"),
			grant("g2", {
				expiresAt: 3_000,
				binding: {
					...(grant("g1") as { binding: object }).binding,
					scope: { scopeId: "s", operation: "o", participants: ["alpha"], recipients: ["gamma"], task: null },
				},
			}),
		];
		expect(chooseGrant({ ...base, to: "gamma", grants: both, causal: at(7, "m6") })).toMatchObject({
			kind: "use",
			grant: { id: "g2" },
		});
	});
	it("a spent grant is still handed on, so the sender hears why", () => {
		expect(
			chooseGrant({ ...base, grants: [grant("g1", { acceptedUses: 5, state: "exhausted" })], causal: at(8, "m7") }),
		).toMatchObject({ kind: "use", grant: { id: "g1" } });
	});
});
