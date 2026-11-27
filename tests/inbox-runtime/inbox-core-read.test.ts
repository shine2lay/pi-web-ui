import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeInboxView } from "../../server/shared/inbox-wire.js";
import { B, setNow, useGuardWorld } from "../unit/role-message-guard-host-harness.js";
import { core, seed, view } from "./inbox-core-fixture.js";
import { setup } from "./inbox-world.js";

useGuardWorld();
for (const id of ["C-SCHEMA-1", "C-SCHEMA-2", "C-SCHEMA-3", "C-SCHEMA-4", "C-SCHEMA-5"]) {
	it(`${id} canonical view codec`, () => {
		const c = core(id),
			decoded = decodeInboxView(c.input);
		expect(decoded.ok).toBe(c.expect.result === "allow");
		if (!decoded.ok) expect(decoded.code).toBe(c.expect.code);
		else expect(decoded.value).toEqual(c.input);
	});
}
for (const id of ["C-PRI-7", "C-PRI-8", "C-PRI-9", "C-PRI-10", "C-PRI-11", "C-PRI-12", "C-PRI-13", "C-ROUTE-3"]) {
	it(`${id} canonical role-message classification`, async () => {
		const c = core(id),
			h = await setup();
		await seed(h, (records) => {
			const r = records.find((r) => r.id === h.id)!;
			Object.assign(r, c.input.record);
			if (r.kind === "reply") {
				r.replyTo = "rm-original";
				if (c.input.original)
					records.push({
						...r,
						id: r.replyTo,
						kind: "question",
						replyTo: undefined,
						from: { ...r.from, role: "beta", file: B },
						to: { ...r.to, role: "alpha" },
						forOwner: (c.input.original as { forOwner: boolean }).forOwner,
					});
			}
		});
		const actual = view(h);
		for (const [expected, field] of [
			["class", "class"],
			["base", "basePriority"],
			["route", "route"],
			["reason", "reason"],
		] as const)
			if (expected in c.expect) expect(actual[field]).toBe(c.expect[expected]);
	});
}
for (const id of ["C-AGE-1", "C-AGE-2", "C-AGE-3", "C-AGE-4"]) {
	it(`${id} reader derives aging from source time`, async () => {
		const c = core(id),
			input = c.input.item as { base: string; at: number };
		const h = await setup();
		await seed(h, (records) =>
			Object.assign(
				records.find((r) => r.id === h.id)!,
				{
					at: input.at,
					kind: input.base === "P3" ? "fyi" : "request",
					forOwner: input.base === "P1",
					state: "waiting",
					sends: 0,
					deliveredAt: undefined,
					hash: undefined,
					scanFrom: undefined,
				},
			),
		);
		setNow(Number(c.input.now));
		const actual = view(h);
		expect(actual.basePriority).toBe(input.base);
		expect(actual.lifecycle.state).toBe("open");
		expect(actual.effectivePriority).toBe(c.expect.effectivePriority);
		if ("promotedAt" in c.expect) expect(actual.promotedAt).toBe(c.expect.promotedAt);
	});
}
for (const id of ["C-READ-6", "C-READ-7"]) {
	it(`${id} canonical ledger sequence reader`, async () => {
		const c = core(id),
			h = await setup();
		const item = view(h);
		writeFileSync(
			h.ledgerFile,
			(c.input.seqs as number[])
				.map((seq) =>
					JSON.stringify({
						v: "rpi/1",
						seq,
						at: item.at,
						key: h.key,
						contentHash: item.contentHash,
						op: "alarm",
						attempts: 3,
						cause: "unanswered",
					}),
				)
				.join("\n") + "\n",
		);
		expect(h.runtime.read("beta").status).toBe(c.expect.result === "allow" ? "ok" : "unknown");
		if (c.expect.code)
			expect(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B })).toMatchObject({
				code: c.expect.code,
			});
	});
}
