/**
 * own-server.mjs: start the test's own pi-web-ui server (dist/server/index.js) on a free port, with
 * its own temp data, agent and work folders, and stop it when the test exits. Tests never attach
 * to a server someone has running: that one holds real chats.
 *
 *   const srv = await ownServer({ name: "commands-test" });
 *   srv.port, srv.http ("http://localhost:<port>"), srv.ws ("ws://localhost:<port>/ws")
 *   srv.dataDir, srv.agentDir, srv.workdir, srv.root
 *   await srv.restart();   // same folders, same port (a server restart)
 *   await srv.stop();
 *
 * Options: name (temp folder prefix), port, model ("fastfail" default: a model that can't be reached,
 * so a prompt only saves the user message; "none": no model at all; or a function(agentDir) that
 * writes its own), mock (a reply function for tests/lib/mock-model.mjs: the server gets that
 * stand-in model as its only model, reachable as srv.mock; it replaces `model`), env (extra server
 * environment), verbose (server output to this process), prepare (an async function({ root, dataDir,
 * agentDir, workdir }) run once before the first start, after the model is set up: put plugins or
 * settings in place), stdout (keep the server's standard output too, as srv.stdout(); its
 * console.log lines go there, srv.stderr() has only its error output).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { freeTcpPort } from "./port-utils.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { noRetries, startMockModel, writeFastFailModelConfig, writeMockModelConfig } from "./mock-model.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

export { freeTcpPort };

export async function ownServer(opts = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), `${opts.name ?? "own-server"}-`)));
	const dataDir = join(root, "data");
	const agentDir = join(root, "agent");
	const workdir = join(root, "work");
	for (const d of [dataDir, agentDir, workdir]) mkdirSync(d, { recursive: true });
	let mock = null;
	if (opts.mock) {
		mock = await startMockModel(opts.mock);
		mock.unref();
		writeMockModelConfig(agentDir, mock.port);
		noRetries(agentDir);
	} else {
		const model = opts.model ?? "fastfail";
		if (model === "fastfail") writeFastFailModelConfig(agentDir);
		else if (typeof model === "function") await model(agentDir);
	}
	if (opts.prepare) await opts.prepare({ root, dataDir, agentDir, workdir });
	const port = opts.port ?? (await freeTcpPort());
	let proc = null;
	let stderr = "";
	let stdout = "";

	const start = async () => {
		proc = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
			cwd: REPO,
			env: {
				...process.env,
				PI_WEB_PORT: String(port),
				PI_WEB_DATA_DIR: dataDir,
				PI_CODING_AGENT_DIR: agentDir,
				PI_WEB_CWD: workdir,
				PI_WEB_PLUGIN_CATALOG_URL: process.env.PI_WEB_PLUGIN_CATALOG_URL ?? "",
				...opts.env,
			},
			stdio: ["ignore", opts.stdout ? "pipe" : opts.verbose ? "inherit" : "ignore", "pipe"],
			detached: process.platform !== "win32",
		});
		proc.stderr.on("data", (d) => {
			stderr = (stderr + d).slice(-8000);
			if (opts.verbose) process.stderr.write(d);
		});
		proc.stdout?.on("data", (d) => {
			stdout = (stdout + d).slice(-64000);
			if (opts.verbose) process.stdout.write(d);
		});
		const started = Date.now();
		while (Date.now() - started < (opts.startTimeoutMs ?? 30_000)) {
			if (proc.exitCode !== null) throw new Error(`own server exited (${proc.exitCode}): ${stderr.slice(-2000)}`);
			try {
				if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
			} catch {
				/* starting */
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`own server did not start on ${port}: ${stderr.slice(-2000)}`);
	};

	const kill = (p, signal) => {
		try {
			if (process.platform === "win32") p.kill(signal);
			else process.kill(-p.pid, signal);
		} catch {
			/* gone */
		}
	};
	const stop = async () => {
		const p = proc;
		if (!p || p.exitCode !== null || p.signalCode !== null) return;
		const exited = new Promise((r) => p.once("exit", r));
		kill(p, "SIGTERM");
		const t = setTimeout(() => kill(p, "SIGKILL"), 8000);
		await exited;
		clearTimeout(t);
	};
	process.on("exit", () => {
		if (proc && proc.exitCode === null && proc.signalCode === null) kill(proc, "SIGKILL");
	});

	await start();
	return {
		port,
		http: `http://localhost:${port}`,
		ws: `ws://localhost:${port}/ws`,
		root,
		dataDir,
		agentDir,
		workdir,
		mock,
		stop,
		restart: async () => {
			await stop();
			await start();
		},
		stderr: () => stderr,
		stdout: () => stdout,
	};
}
