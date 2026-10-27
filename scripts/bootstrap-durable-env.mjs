#!/usr/bin/env node
/**
 * Wave 3.3 (#603): CLI to bootstrap a clean environment directly on
 * `@earendil-works/pi-durable` SQLite WAL (`durable-sessions.db`, schema v2)
 * with zero `.jsonl` session files.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const help = `Usage: node scripts/bootstrap-durable-env.mjs [options]

Initialize a brand-new environment directly on @earendil-works/pi-durable SQLite WAL
(durable-sessions.db, schema v2) with zero .jsonl session files.

Options:
  --home-dir, --home DIR          Target HOME directory (defaults to $HOME)
  --data-dir DIR                  Target pi-web-ui data directory (defaults to <home>/.pi-web-ui)
  --agent-dir DIR                 Target pi agent directory (defaults to <home>/.pi/agent)
  --db-path FILE                  Explicit SQLite database path (defaults to <data-dir>/durable-sessions.db)
  --template-settings FILE        Optional template settings.json to make $HOME-portable
  --seed-roles ROLES              Comma-separated role IDs to seed if identities/ is empty
  --cwd DIR                       Default working directory for bootstrapped role homeChats
  --help, -h                      Show this help message
`;

export function parseBootstrapCliArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			return { help: true, options };
		}
		const nextValue = () => {
			const val = argv[++i];
			if (!val || val.startsWith("--")) {
				throw new Error(`Missing value for ${arg}`);
			}
			return val;
		};
		if (arg === "--home-dir" || arg === "--home") {
			options.homeDir = nextValue();
		} else if (arg === "--data-dir") {
			options.dataDir = nextValue();
		} else if (arg === "--agent-dir") {
			options.agentDir = nextValue();
		} else if (arg === "--db-path") {
			options.dbPath = nextValue();
		} else if (arg === "--template-settings") {
			options.templateSettingsPath = nextValue();
		} else if (arg === "--cwd") {
			options.cwd = nextValue();
		} else if (arg === "--seed-roles") {
			options.seedRoleIds = nextValue()
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return { help: false, options };
}

async function loadBootstrapModule() {
	const compiled = new URL("../dist/server/durable-env-bootstrap.js", import.meta.url);
	if (existsSync(compiled)) {
		return import(compiled.href);
	}
	const { tsImport } = await import("tsx/esm/api");
	return tsImport(fileURLToPath(new URL("../server/durable-env-bootstrap.ts", import.meta.url)), import.meta.url);
}

async function main() {
	const { help: showHelp, options } = parseBootstrapCliArgs(process.argv.slice(2));
	if (showHelp) {
		process.stdout.write(help);
		return;
	}
	const mod = await loadBootstrapModule();
	const result = await mod.bootstrapDurableEnvironment(options);
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	main().catch((error) => {
		process.stderr.write(`Bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
