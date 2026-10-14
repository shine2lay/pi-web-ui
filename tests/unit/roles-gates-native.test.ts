// Actual production seams, NO mocks. No server, chat, store, network or native capability is opened.
import { expect, it } from "vitest";
import { rtpiCanonical } from "../../server/rtpi-core.js";
import { g0ArtifactProblem, g0ArtifactRef, g0Producer, g0Ref } from "../../server/roles-artifact.js";
import {
	rolesArtifactConfirmation,
	rolesArtifactCoverage,
	rolesArtifactLifecycle,
	rolesRequiredGateContract,
} from "../../server/roles-gates.js";

it("G0 production is off; forced enable stays unavailable even with fixture/capability flags", () => {
	for (const adapter of [rolesRequiredGateContract, ...Object.values(rolesArtifactLifecycle)]) {
		expect(adapter().state).toBe("off");
		expect(adapter({ enabled: true, fixture: true, capability: {}, qualification: {}, contract: {} } as never)).toEqual(
			{
				state: "unavailable",
				reason: "native-outbox-issuer-missing",
				native: false,
				verdict: null,
			},
		);
	}
	expect(rolesArtifactConfirmation({ action: "confirm" } as never, {} as never).state).toBe("off");
	expect(rolesArtifactConfirmation({ action: "confirm" } as never, {} as never, { enabled: true }).state).toBe(
		"unavailable",
	);
	expect(rolesArtifactCoverage(null, [], [])).toMatchObject({
		state: "unknown",
		nativeLifecycle: false,
		ownerConfirmed: false,
		synthetic: false,
	});
});

const key = {
	gitHead: "a".repeat(40),
	assetsSha256: "b".repeat(64),
	version: "1.0.1",
	manifestRevision: 2,
	targetEnvironment: "fixture-only",
	environmentEpoch: "e-1",
};
it("TS shares the exact 235-byte pinned artifact join with MJS/independent Python", () => {
	expect(Buffer.byteLength(rtpiCanonical(key))).toBe(235);
	expect(g0ArtifactRef(key, "rtpi-fixture")).toEqual({
		namespace: "rtpi-fixture",
		kind: "artifact",
		id: "ak-7765dc8016f16ee64cd2e9ee94f4ed273575252af7eeb4a9c749207d901b8302",
		revision: "2",
	});
	expect(g0ArtifactRef({ ...key, assetsSha256: "c".repeat(64) }, "rtpi-fixture").id).not.toBe(
		g0ArtifactRef(key, "rtpi-fixture").id,
	);
});
it("R07 full strings: no LF/CR/CRLF, path, plus version, partial source triplet", () => {
	for (const version of ["1.0.1+build.7", "v\n", "v\r", "v\r\n", "/tmp/v", ""])
		expect(g0ArtifactProblem({ ...key, version })).toBe("artifact-version-unsupported");
	expect(g0ArtifactProblem({ ...key, gitHead: key.gitHead + "\n" })).toBe("artifact-key-invalid");
	expect(g0ArtifactProblem({ ...key, targetEnvironment: "fixture-only\n" })).toBe("artifact-target-unsupported");
	const r = { namespace: "rtpi-fixture" as const, kind: "queue", id: "Q1", revision: "1" };
	expect(g0Ref({ ...r, id: "Q1\n" }, "queue", "rtpi-fixture")).toBe(false);
	expect(
		g0Producer(
			{ queue: null, taskId: 143, planRevision: null, run: { ...r, kind: "run" }, attempt: { ...r, kind: "attempt" } },
			"rtpi-fixture",
		),
	).toBe(false);
});
