/**
 * Run one smoke run under one planted break (README.md "Proof that the smoke can fail"):
 *
 *   node tests/release-smoke/fixtures/plant.mjs <plant>      exit code = the smoke run's
 *
 * before:<break>  the before-run on a broken copy of this folder's build (a COPY_BREAKS name), or
 *                 before:model-silent (the stand-in model never answers); before:none is the good build.
 * live:<break>    live.mjs, unchanged, on an own-server copy reached through its two address settings
 *                 (a COPY_BREAKS name, live:model-silent, or live:none: the live run's own proof).
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ownServer } from "../../lib/own-server.mjs";
import { freeTcpPort } from "../../lib/port-utils.mjs";
import { beforeRun, standInReply } from "../before.mjs";
import { brokenCopy } from "./broken-copy.mjs";

const [kind, name] = (process.argv[2] ?? "").split(":");
if (!["before", "live"].includes(kind) || !name) throw new Error("usage: plant.mjs before:<plant>|live:<plant>");
const appDir = resolve(process.env.PI_WEB_SMOKE_APP_DIR ?? process.cwd());
const silent = name === "model-silent";
const copyBreak = name === "none" || silent ? null : name;

/** A model that never answers a turn (side requests still get a title). */
const silentModel = (c) => (c.sideRequest ? "Smoke title" : new Promise(() => {}));
/** The live run's tiny prompt gets a tiny answer. */
const liveModel = (c) => (c.sideRequest ? "Smoke title" : "OK");

const copy = brokenCopy(appDir, copyBreak);
let code;
try {
	if (kind === "before") code = await beforeRun({ appDir: copy.dir, respond: silent ? silentModel : standInReply });
	else {
		let srv = null;
		try {
			srv = await ownServer({
				name: "release-smoke-live-copy",
				appDir: copy.dir,
				mock: silent ? silentModel : liveModel,
			});
		} catch (err) {
			console.log(`own-server copy didn't start: ${String(err.message).split("\n")[0]}`);
		}
		// Nothing listens on the addresses when the copy didn't start: the live run must say so in red.
		const port = srv?.port ?? (await freeTcpPort());
		const live = fileURLToPath(new URL("../live.mjs", import.meta.url));
		// Not spawnSync: the stand-in model answers from this process, so its event loop must keep running.
		const child = spawn(process.execPath, [live], {
			cwd: appDir,
			stdio: "inherit",
			env: {
				...process.env,
				PI_WEB_SMOKE_PUBLIC_URL: `http://localhost:${port}/`,
				PI_WEB_SMOKE_LOCAL_URL: `http://127.0.0.1:${port}/`,
				PI_WEB_SMOKE_AGENT_DIR: srv?.agentDir ?? copy.dir,
			},
		});
		code = await new Promise((done) => child.on("exit", (c) => done(c ?? 1)));
		await srv?.stop();
		if (srv) rmSync(srv.root, { recursive: true, force: true });
	}
} finally {
	copy.remove();
}
process.exit(code);
