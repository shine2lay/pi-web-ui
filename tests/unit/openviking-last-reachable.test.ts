/**
 * Backend #140: `observer.last_reachable_at` (spec 895b0cb1, ruling rm-5bbe0bcc): the ISO time of the last `/health`
 * that answered ok, seen by this server process. Held while `:1933` is down, null only before the first ok, never
 * `checked_at` (request time), and it gates nothing: screen_state and health_state are the same whether
 * it is null or set.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenVikingClient, type OpenVikingOverviewResponse } from "../../server/openviking/index.js";
import { daemon, NOW, type DaemonMode } from "./openviking-daemon-fake.js";

const iso = (ms: number) => new Date(ms).toISOString();
const minutes = (m: number) => m * 60_000;
const DOWN_MODES = ["down", "hang", "unhealthy"] as const;

describe("observer.last_reachable_at (Backend #140, spec 895b0cb1)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	/** One client = one server process's transport; `clock.t` is when every request and answer happen. */
	const setup = (mode: DaemonMode) => {
		const dir = mkdtempSync(join(tmpdir(), "ov-last-reachable-"));
		dirs.push(dir);
		const fake = daemon(mode);
		const clock = { t: NOW };
		const client = createOpenVikingClient({
			stateDir: dir,
			fetchImpl: fake.fetchImpl,
			timeoutMs: 50,
			now: () => clock.t,
		});
		return { fake, clock, client };
	};

	it("is JSON null before any ok /health since start: refused, past the deadline or healthy:false", async () => {
		const { fake, clock, client } = setup("down");
		for (const mode of DOWN_MODES) {
			fake.state.mode = mode;
			clock.t += minutes(1);
			const o = await client.getOverview();
			expect(o.health_state).toBe("server-unreachable");
			expect(o.observer.last_reachable_at).toBeNull();
			expect(o.observer.checked_at).toBe(iso(clock.t));
			const wire = JSON.stringify(o);
			expect(wire).toContain('"last_reachable_at":null');
			expect(JSON.parse(wire).observer.last_reachable_at).toBeNull();
		}
	});

	it("is the time of the ok /health, advancing with each ok answer", async () => {
		const { clock, client } = setup("up");
		const first = await client.getOverview();
		expect(first.health_state).not.toBe("server-unreachable");
		expect(first.observer.last_reachable_at).toBe(iso(NOW));

		clock.t = NOW + 30_000;
		const next = await client.getOverview();
		expect(next.observer.last_reachable_at).toBe(iso(NOW + 30_000));
		expect(JSON.parse(JSON.stringify(next)).observer.last_reachable_at).toBe(iso(NOW + 30_000));
	});

	it("is held while :1933 is down (refused, hung, healthy:false)", async () => {
		const { fake, clock, client } = setup("up");
		expect((await client.getOverview()).observer.last_reachable_at).toBe(iso(NOW));

		for (const mode of DOWN_MODES) {
			fake.state.mode = mode;
			clock.t += minutes(5);
			const o = await client.getOverview();
			expect(o).toMatchObject({ screen_state: "error", health_state: "server-unreachable" });
			expect(o.observer).toMatchObject({ last_reachable_at: iso(NOW), checked_at: iso(clock.t) });
		}

		fake.state.mode = "up";
		clock.t += minutes(1);
		expect((await client.getOverview()).observer.last_reachable_at).toBe(iso(clock.t));
	});

	it("gates nothing: with :1933 down, a server that saw an ok and one that never did answer the same overview", async () => {
		const seen = setup("up");
		await seen.client.getOverview();
		seen.fake.state.mode = "down";
		const never = setup("down");

		const withField = await seen.client.getOverview();
		const withoutField = await never.client.getOverview();
		expect(withField.observer.last_reachable_at).toBe(iso(NOW));
		expect(withoutField.observer.last_reachable_at).toBeNull();

		const verdicts = (o: OpenVikingOverviewResponse) => ({
			screen_state: o.screen_state,
			health_state: o.health_state,
		});
		expect(verdicts(withField)).toEqual(verdicts(withoutField));
		const { last_reachable_at: _set, ...restSet } = withField.observer;
		const { last_reachable_at: _unset, ...restUnset } = withoutField.observer;
		expect(restSet).toEqual(restUnset);
		expect({ ...withField, observer: null }).toEqual({ ...withoutField, observer: null });
	});
});
