#!/usr/bin/env node
/** Offline only. Source JSONL and ACP sidecars are read-only rollback backups. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const help = `Usage: node scripts/migrate-sessions-to-durable.mjs --source-dir DIR --target-dir DIR [--dry-run | --verify]

Recursively read version-3 JSONL sessions and adjacent .jsonl.acp.json sidecars.
Write workspace session-<cwd-hash>.sqlite databases and migration-manifest.json.
Stop the target durable engine before migrating; source files are never written.
--dry-run  Validate/project sources and report counts; create no target files.
--verify   Compare existing databases to sources, including raw history, ACP and
           active context. Uses read-only SQLite backups (including WAL pages);
           no migration or manifest write. Missing/corrupt data exits nonzero.
Re-running migration skips unchanged sessions and appends only new raw entries.
A resumed target or rewritten source is refused rather than silently reset.
`;

async function main() {
	const args = process.argv.slice(2);
	const options = {};
	for (let at = 0; at < args.length; at++) {
		const arg = args[at];
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(help);
			return;
		}
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--verify") options.verify = true;
		else if (arg === "--source-dir" || arg === "--target-dir") {
			const value = args[++at];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
			options[arg === "--source-dir" ? "sourceDir" : "targetDir"] = value;
		} else throw new Error(`Unknown option: ${arg}`);
	}
	if (!options.sourceDir || !options.targetDir)
		throw new Error("Both --source-dir and --target-dir are required (see --help)");
	// Installed builds use JS; a fresh checkout can run without a build via its local tsx.
	const compiled = new URL("../dist/server/durable-migrator.js", import.meta.url);
	let module;
	if (existsSync(compiled)) module = await import(compiled.href);
	else {
		const { tsImport } = await import("tsx/esm/api");
		module = await tsImport(fileURLToPath(new URL("../server/durable-migrator.ts", import.meta.url)), import.meta.url);
	}
	const report = await module.migrateSessionsToDurable(options);
	// Counts/IDs only. Never echo prompt content, source entries or block summaries.
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
	process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
