/**
 * Backend #161: the Memory Explorer seam's pure rules (spec-explorer.md, architecture #541), green before either
 * build slice starts: the 17 roots (R-EXPLORER-ROOTS-1), the uri rule (R-EXPLORER-URI-1), the setup-file lock
 * (G8), the Kind table, operation ids, mod_time handling, the exact-search escape, the refusal statuses and the
 * fail-closed owner gate (OI-1).
 */
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import {
	assertOwner,
	assertOwnerWrite,
	escapeRegex,
	explorerKindOf,
	explorerRefusal,
	explorerRootHeaders,
	explorerRootNamed,
	isoModTime,
	isSetupFile,
	OPENVIKING_EXPLORER_REFUSAL_CODES,
	OPENVIKING_EXPLORER_REFUSAL_STATUS,
	OPENVIKING_EXPLORER_ROOTS,
	OpenVikingDashboardError,
	operationIdOf,
	OPERATION_ID_RE,
	ownerAddressAllowed,
	ownerCheckMissing,
	parseExplorerUri,
	sameModTime,
} from "../../server/openviking/index.js";

const ROLES =
	"architecture backend coo data design docs frontend marketing ops product qa rollcall security systems temper";

function refusalOf(fn: () => unknown): { code: string; status: number } {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(OpenVikingDashboardError);
		const e = err as OpenVikingDashboardError;
		return { code: e.code, status: e.statusCode };
	}
	throw new Error("expected a refusal");
}

describe("R-EXPLORER-ROOTS-1: the 17 roots", () => {
	it("are exactly 17, in constant order, with their groups and roles", () => {
		expect(OPENVIKING_EXPLORER_ROOTS.map((r) => [r.uri, r.group, r.role])).toEqual([
			["viking://resources", "projects", null],
			["viking://user/default/memories", "shared", null],
			...ROLES.split(" ").map((role) => [`viking://user/${role}/memories`, "department", role]),
		]);
	});

	it("names a root only by its exact uri", () => {
		expect(explorerRootNamed("viking://user/qa/memories")?.role).toBe("qa");
		expect(explorerRootNamed("viking://user/qa/memories/cases")).toBeNull();
		expect(explorerRootNamed("viking://agent/memories")).toBeNull();
		expect(explorerRootNamed(42)).toBeNull();
	});

	it("reads shared roots with shared headers and a role root with the role's", () => {
		const [resources, shared, architecture] = OPENVIKING_EXPLORER_ROOTS;
		expect(explorerRootHeaders(resources)).toEqual(explorerRootHeaders(shared));
		expect(explorerRootHeaders(shared)["X-OpenViking-User"]).toBe("default");
		expect(explorerRootHeaders(architecture)["X-OpenViking-Agent"]).toBe("architecture");
	});
});

describe("R-EXPLORER-URI-1", () => {
	it("returns the uri with its root, one trailing slash dropped, decoded once", () => {
		expect(parseExplorerUri("viking://user/backend/memories/cases/")).toMatchObject({
			uri: "viking://user/backend/memories/cases",
			root: { uri: "viking://user/backend/memories", group: "department", role: "backend" },
		});
		expect(parseExplorerUri("viking://resources").root.group).toBe("projects");
		expect(parseExplorerUri("viking%3A%2F%2Fuser%2Fdefault%2Fmemories%2Fa%20b.md").uri).toBe(
			"viking://user/default/memories/a b.md",
		);
	});

	it.each([
		["not a string", 7],
		["not viking://", "https://resources/x"],
		["no scheme", "resources/x"],
		["bare scheme", "viking://"],
		["'..' segment", "viking://resources/a/../b"],
		["'.' segment", "viking://resources/./b"],
		["encoded '..' segment (decoded once)", "viking://resources/a%2F..%2Fb"],
		["empty segment", "viking://resources//b"],
		["two trailing slashes", "viking://resources/a//"],
		["backslash", "viking://resources/a\\b"],
		["NUL", "viking://resources/a\0b"],
		["encoded NUL", "viking://resources/a%00b"],
		["malformed escape", "viking://resources/a%zz"],
		["over 1024 chars", `viking://resources/${"a".repeat(1006)}`],
	])("refuses %s: 400 URI_INVALID", (_case, raw) => {
		expect(refusalOf(() => parseExplorerUri(raw))).toEqual({ code: "URI_INVALID", status: 400 });
	});

	it("takes a uri of exactly 1024 chars", () => {
		const uri = `viking://resources/${"a".repeat(1005)}`;
		expect(uri).toHaveLength(1024);
		expect(parseExplorerUri(uri).uri).toBe(uri);
	});

	it.each([
		["agent alias", "viking://agent/memories/cases/c1.md"],
		["shared alias", "viking://user/memories/preferences/x.md"],
		["session", "viking://session/abc"],
		["unknown role", "viking://user/nobody/memories/x.md"],
		["role sessions", "viking://user/backend/sessions/s1"],
		["a root's prefix that is not the root", "viking://user/default/memoriesX/a.md"],
		["user default outside memories", "viking://user/default/skills/a.md"],
	])("refuses %s: 400 URI_OUTSIDE_ROOTS", (_case, raw) => {
		expect(refusalOf(() => parseExplorerUri(raw))).toEqual({ code: "URI_OUTSIDE_ROOTS", status: 400 });
	});
});

describe("R-EXPLORER-LOCK-1 (G8)", () => {
	it.each([
		"viking://user/backend/memories/identity.md",
		"viking://user/backend/memories/soul.md",
		"viking://user/backend/memories/IDENTITY.MD",
		"viking://user/backend/memories/Soul.Md",
		"viking://resources/x/identity.md",
	])("locks %s", (uri) => expect(isSetupFile(uri)).toBe(true));

	it.each([
		"viking://user/backend/memories/identity.md.bak",
		"viking://user/backend/memories/my-soul.md",
		"viking://user/backend/memories/identity/notes.md",
		"viking://user/backend/memories/soul",
	])("does not lock %s", (uri) => expect(isSetupFile(uri)).toBe(false));
});

describe("Kind table", () => {
	const shared = OPENVIKING_EXPLORER_ROOTS[1];
	const qa = OPENVIKING_EXPLORER_ROOTS.find((r) => r.role === "qa")!;
	it.each([
		["preferences/a.md", "rule"],
		["cases/a.md", "case"],
		["experiences/x/a.md", "case"],
		["entities/a.md", "fact"],
		["events/a.md", "event"],
		["tools/a.md", "other"],
		["a.md", "other"],
		["preferences", "rule"],
	])("%s under a memories root is %s", (rel, kind) => {
		expect(explorerKindOf(`${shared.uri}/${rel}`, shared)).toBe(kind);
		expect(explorerKindOf(`${qa.uri}/${rel}`, qa)).toBe(kind);
	});

	it("is document for anything under viking://resources, and other for a memories root itself", () => {
		const resources = OPENVIKING_EXPLORER_ROOTS[0];
		expect(explorerKindOf("viking://resources/pi-web-ui/preferences/a.md", resources)).toBe("document");
		expect(explorerKindOf("viking://resources", resources)).toBe("document");
		expect(explorerKindOf(shared.uri, shared)).toBe("other");
		expect(explorerKindOf(`${shared.uri}/constructor/a.md`, shared)).toBe("other");
	});
});

describe("operation ids", () => {
	it("are op-<ms>-<8 hex>", () => {
		const id = operationIdOf(1794631805120, Uint8Array.from([0x3f, 0x9a, 0x1c, 0x2e]));
		expect(id).toBe("op-1794631805120-3f9a1c2e");
		expect(OPERATION_ID_RE.test(id)).toBe(true);
		expect(OPERATION_ID_RE.test("op-1-3F9A1C2E")).toBe(false);
		expect(OPERATION_ID_RE.test("op-1-3f9a1c2")).toBe(false);
	});

	it("refuse a bad time or the wrong number of random bytes", () => {
		expect(() => operationIdOf(-1, new Uint8Array(4))).toThrow(RangeError);
		expect(() => operationIdOf(1.5, new Uint8Array(4))).toThrow(RangeError);
		expect(() => operationIdOf(1, new Uint8Array(3))).toThrow(RangeError);
	});
});

describe("mod_time", () => {
	it("parses the daemon's modTime to ISO with ms", () => {
		expect(isoModTime("2026-11-14T02:10:57Z")).toBe("2026-11-14T02:10:57.000Z");
		expect(isoModTime("2026-11-14T02:10:57.000Z")).toBe("2026-11-14T02:10:57.000Z");
		expect(isoModTime("")).toBeNull();
		expect(isoModTime("yesterday")).toBeNull();
		expect(isoModTime(null)).toBeNull();
	});

	it("compares as ms, never as strings", () => {
		expect(sameModTime("2026-11-14T02:10:57Z", "2026-11-14T02:10:57.000Z")).toBe(true);
		expect(sameModTime("2026-11-14T02:10:57.000Z", "2026-11-14T02:10:57.001Z")).toBe(false);
		expect(sameModTime("bad", "bad")).toBe(false);
	});
});

describe("exact search escape", () => {
	it("makes every regex character literal", () => {
		const query = "a.b*c+d?(e)[f]{g}^h$i|j\\k/l-m";
		const re = new RegExp(escapeRegex(query));
		expect(re.test(`x ${query} y`)).toBe(true);
		expect(re.test("aXb*c+d?(e)[f]{g}^h$i|j\\k/l-m")).toBe(false);
		expect(escapeRegex("plain words")).toBe("plain words");
	});
});

describe("refusals", () => {
	it("cover every spec code with its status", () => {
		expect(OPENVIKING_EXPLORER_REFUSAL_CODES).toHaveLength(21);
		expect(OPENVIKING_EXPLORER_REFUSAL_STATUS).toMatchObject({
			OWNER_ONLY: 403,
			SETUP_FILE_LOCKED: 403,
			CONTENT_TOO_LARGE: 413,
			NOTE_CHANGED: 409,
			DELETE_PENDING: 409,
			UNDO_REFUSED: 409,
			UNDO_WINDOW_CLOSED: 410,
			OPERATION_UNKNOWN: 404,
			NOT_FOUND: 404,
			MEMORY_UNREACHABLE: 503,
			MEMORY_ERROR: 502,
			MEMORY_WRITE_FAILED: 502,
		});
	});

	it("are the existing dashboard error with the code, status and details", () => {
		const err = explorerRefusal("NOTE_CHANGED", "changed", { current_mod_time: "2026-11-14T02:10:57.000Z" });
		expect(err).toBeInstanceOf(OpenVikingDashboardError);
		expect([err.statusCode, err.code, err.details]).toEqual([
			409,
			"NOTE_CHANGED",
			{ current_mod_time: "2026-11-14T02:10:57.000Z" },
		]);
	});
});

describe("owner gate (OI-1)", () => {
	const at = (host: string | undefined, origin?: string) => ({ headers: { host, origin } }) as unknown as Request;
	const req = at("127.0.0.1:8787");
	const write = { method: "POST", operation_id: "op-1-00000000" } as const;
	const ownerOnly = { code: "OWNER_ONLY", statusCode: 403 };

	it("fails closed with no owner check wired: every read and every write refused", async () => {
		expect(ownerCheckMissing(req, { kind: "read" })).toBe(false);
		expect(refusalOf(() => assertOwner(ownerCheckMissing, req))).toEqual({ code: "OWNER_ONLY", status: 403 });
		await expect(assertOwnerWrite(ownerCheckMissing, req, write)).rejects.toMatchObject(ownerOnly);
	});

	it("a Host or Origin whose host ends in a dot (raw or percent-encoded), or that does not parse, is refused", () => {
		for (const ok of [
			at("pi.wai2shine.com"),
			at("spark.tailbb5055.ts.net:8787", "https://spark.tailbb5055.ts.net:8787"),
		]) {
			expect(ownerAddressAllowed(ok)).toBe(true);
		}
		for (const bad of [
			at("pi.wai2shine.com."),
			at("spark.tailbb5055.ts.net.:8787"),
			at("pi.wai2shine.com%2E"),
			at(undefined),
			at(""),
			at("pi.wai2shine.com", "https://pi.wai2shine.com."),
			at("pi.wai2shine.com", "https://spark.tailbb5055.ts.net.:8787"),
			at("pi.wai2shine.com", "https://pi.wai2shine.com%2e"),
			at("pi.wai2shine.com", "null"),
		]) {
			expect(ownerAddressAllowed(bad)).toBe(false);
			expect(refusalOf(() => assertOwner(() => true, bad))).toEqual({ code: "OWNER_ONLY", status: 403 });
		}
	});

	it("a refused address never asks the gate, read or write", async () => {
		const asked: string[] = [];
		const gate = (_r: Request, access: { kind: string }) => {
			asked.push(access.kind);
			return true;
		};
		const dotted = at("pi.wai2shine.com.");
		expect(refusalOf(() => assertOwner(gate, dotted))).toEqual({ code: "OWNER_ONLY", status: 403 });
		await expect(assertOwnerWrite(gate, dotted, write)).rejects.toMatchObject(ownerOnly);
		expect(asked).toEqual([]);
	});

	it("passes a request the injected gate allows", async () => {
		expect(() => assertOwner(() => true, req)).not.toThrow();
		await expect(assertOwnerWrite(() => true, req, write)).resolves.toBeUndefined();
		await expect(assertOwnerWrite(async () => true, req, write)).resolves.toBeUndefined();
	});

	it("a read is answered synchronously: a promise, even of true, refuses it; a gate that throws refuses a write", async () => {
		expect(refusalOf(() => assertOwner(async () => true, req))).toEqual({ code: "OWNER_ONLY", status: 403 });
		const throws = () => {
			throw new Error("boom");
		};
		await expect(assertOwnerWrite(throws, req, write)).rejects.toMatchObject(ownerOnly);
		await expect(assertOwnerWrite(async () => false, req, write)).rejects.toMatchObject(ownerOnly);
	});
});
