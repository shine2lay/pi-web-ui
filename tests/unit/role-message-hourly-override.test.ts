// Ops #1103 (Shine via COO rm-3b189c22): a per-role, time-boxed hourly cap override that reverts by itself.
// Fixed inputs, real native + approvals writers, synthetic chats; the override file lives in the test's own data dir.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ROLE_MESSAGE_HOURLY_OVERRIDES_FILE,
	roleMessageHourlyOverridesFile,
	roleMessagesHourlyCapFor,
	roleMessagesHourlyLimitFor,
} from "../../server/role-message-hourly-limit.js";
import { GUARD_POLICY_V2 } from "../../server/role-message-limits.js";
import {
	chat,
	data,
	now,
	role,
	send,
	setNow,
	useGuardWorld,
	who,
	world,
	type World,
} from "./role-message-guard-host-harness.js";

useGuardWorld();
const DAY = 86_400_000;
let savedDataDir: string | undefined;
beforeEach(() => {
	savedDataDir = process.env.PI_WEB_DATA_DIR;
	process.env.PI_WEB_DATA_DIR = data;
	mkdirSync(data, { recursive: true });
});
afterEach(() => {
	if (savedDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
	else process.env.PI_WEB_DATA_DIR = savedDataDir;
});

function writeOverrides(overrides: Record<string, unknown>, mode = 0o600, raw?: string): string {
	const file = join(data, ROLE_MESSAGE_HOURLY_OVERRIDES_FILE);
	writeFileSync(file, raw ?? JSON.stringify({ v: 1, overrides }));
	chmodSync(file, mode);
	return file;
}
const arch100 = (expiresAt: number) => ({
	architecture: { acceptedPerOrigin: 100, expiresAt, reason: "Ops #1103 Shine via COO rm-3b189c22" },
});
const refusal = (id: string, sent: number, limit: number) =>
	`Not sent: ${id} has sent ${sent} role messages in the last hour (the limit is ${limit}). Ask the owner before sending more.`;

async function v2World(...ids: string[]): Promise<{ w: World; homes: Record<string, string> }> {
	const w = await world(undefined, { policy: GUARD_POLICY_V2 });
	const homes: Record<string, string> = {};
	for (const id of ids) {
		const known = w.roles.find((r) => r.id === id);
		if (known) homes[id] = known.homeChat!;
		else w.roles.push(role(id, (homes[id] = chat(`${id}-home`))));
	}
	return { w, homes };
}

describe("roleMessagesHourlyLimitFor", () => {
	it("an active override sets the role's limit; others keep the policy's 40; ops/temper stay exempt", () => {
		const file = writeOverrides({
			...arch100(now + DAY),
			ops: { acceptedPerOrigin: 100, expiresAt: now + DAY },
			temper: { acceptedPerOrigin: 100, expiresAt: now + DAY },
		});
		expect(roleMessagesHourlyLimitFor("architecture", GUARD_POLICY_V2, now, file)).toBe(100);
		for (const id of ["backend", "frontend", "coo", "qa"])
			expect(roleMessagesHourlyLimitFor(id, GUARD_POLICY_V2, now, file)).toBe(40);
		for (const id of ["ops", "temper"]) expect(roleMessagesHourlyLimitFor(id, GUARD_POLICY_V2, now, file)).toBeNull();
	});

	it("reverts to 40 at exactly expiresAt, with no restart or edit", () => {
		const file = writeOverrides(arch100(now + DAY));
		expect(roleMessagesHourlyLimitFor("architecture", GUARD_POLICY_V2, now + DAY - 1, file)).toBe(100);
		expect(roleMessagesHourlyLimitFor("architecture", GUARD_POLICY_V2, now + DAY, file)).toBe(40);
		expect(roleMessagesHourlyLimitFor("architecture", GUARD_POLICY_V2, now + DAY + 1, file)).toBe(40);
	});

	it.each([
		["missing file", null],
		["bad JSON", "{not json"],
		["wrong version", JSON.stringify({ v: 2, overrides: arch100(Date.parse("2026-10-13T12:00:00Z")) })],
		["0", JSON.stringify({ v: 1, overrides: { architecture: { acceptedPerOrigin: 0, expiresAt: 9e15 } } })],
		["501", JSON.stringify({ v: 1, overrides: { architecture: { acceptedPerOrigin: 501, expiresAt: 9e15 } } })],
		["1.5", JSON.stringify({ v: 1, overrides: { architecture: { acceptedPerOrigin: 1.5, expiresAt: 9e15 } } })],
		["string", JSON.stringify({ v: 1, overrides: { architecture: { acceptedPerOrigin: "100", expiresAt: 9e15 } } })],
		["no expiry", JSON.stringify({ v: 1, overrides: { architecture: { acceptedPerOrigin: 100 } } })],
	])("falls back to 40 on %s", (_why, raw) => {
		const file = raw === null ? join(data, "absent.json") : writeOverrides({}, 0o600, raw);
		expect(roleMessagesHourlyLimitFor("architecture", GUARD_POLICY_V2, now, file)).toBe(40);
	});

	it("ignores a file that others may read or write (it must be 0600)", () => {
		const file = writeOverrides(arch100(now + DAY), 0o644);
		expect(roleMessagesHourlyLimitFor("architecture", GUARD_POLICY_V2, now, file)).toBe(40);
	});

	it("an explicit null file means no override", () => {
		writeOverrides(arch100(now + DAY));
		expect(roleMessagesHourlyLimitFor("architecture", GUARD_POLICY_V2, now, null)).toBe(40);
	});

	it("rollback mode still caps at 20; exempt roles stay exempt in it", () => {
		const file = writeOverrides(arch100(now + DAY));
		expect(roleMessagesHourlyCapFor("architecture", GUARD_POLICY_V2, now, "rollback_depth_6", file)).toBe(20);
		expect(roleMessagesHourlyCapFor("architecture", GUARD_POLICY_V2, now, "enabled", file)).toBe(100);
		expect(roleMessagesHourlyCapFor("backend", GUARD_POLICY_V2, now, "enabled", file)).toBe(40);
		expect(roleMessagesHourlyCapFor("ops", GUARD_POLICY_V2, now, "rollback_depth_6", file)).toBe(Infinity);
	});

	it("the default file is the data dir's; a sealed run never resolves the live one", () => {
		expect(roleMessageHourlyOverridesFile()).toBe(join(data, ROLE_MESSAGE_HOURLY_OVERRIDES_FILE));
		if (process.env.PI_SEALED) {
			delete process.env.PI_WEB_DATA_DIR;
			const resolved = roleMessageHourlyOverridesFile();
			expect(resolved === null || !resolved.startsWith(join(userInfo().homedir, ".pi-web"))).toBe(true);
		}
	});
});

describe("message_role with Architecture's override (approval host, live path)", () => {
	it("passes 100 sends in an hour and refuses the 101st naming (the limit is 100)", async () => {
		writeOverrides(arch100(now + DAY));
		const { w, homes } = await v2World("architecture");
		for (let n = 1; n <= 100; n++)
			expect(await send(w, "architecture", homes.architecture, "beta", {}, ""), `send ${n}`).toMatchObject({
				ok: true,
			});
		expect(await send(w, "architecture", homes.architecture, "beta", {}, "")).toEqual({
			ok: false,
			error: refusal("architecture", 100, 100),
			reason: "ordinary_hourly",
		});
	});

	it("at expiresAt the next send is refused naming (the limit is 40), with no restart or edit", async () => {
		writeOverrides(arch100(now + 60_000));
		const { w, homes } = await v2World("architecture");
		for (let n = 1; n <= 45; n++)
			expect(await send(w, "architecture", homes.architecture, "beta", {}, ""), `send ${n}`).toMatchObject({
				ok: true,
			});
		setNow(now + 60_000);
		expect(await send(w, "architecture", homes.architecture, "beta", {}, "")).toEqual({
			ok: false,
			error: refusal("architecture", 45, 40),
			reason: "ordinary_hourly",
		});
		// The native fallback store (approvals unavailable) reads the same limit.
		expect(w.rm.send(who(w, "architecture", homes.architecture, ""), { to: "beta", kind: "fyi", text: "x" })).toEqual({
			ok: false,
			error: refusal("architecture", 45, 40),
		});
	});

	it.each(["backend", "frontend", "coo"])("%s stays at 40 while Architecture's override is active", async (id) => {
		writeOverrides(arch100(now + DAY));
		const { w, homes } = await v2World(id);
		const file = homes[id];
		for (let n = 1; n <= 40; n++)
			expect(await send(w, id, file, "beta", {}, ""), `send ${n}`).toMatchObject({ ok: true });
		expect(await send(w, id, file, "beta", {}, "")).toEqual({
			ok: false,
			error: refusal(id, 40, 40),
			reason: "ordinary_hourly",
		});
	});
});
