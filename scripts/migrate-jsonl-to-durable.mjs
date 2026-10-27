#!/usr/bin/env node
/**
 * Wave 3.3 / 3.5 CLI: Lossless .jsonl -> @earendil-works/pi-durable SQLite WAL migrator.
 *
 * Creates a timestamped pre-cutover backup of all .jsonl session files and role
 * identity.json configs with SHA-256 checksums, imports every session into
 * durable-sessions.db (schema v2, WAL mode), and verifies 100% session/entry/leaf/branch
 * parity while leaving all original .jsonl files untouched on disk.
 *
 * Usage:
 *   node scripts/migrate-jsonl-to-durable.mjs [options]
 *     --sessions-dir <dir>         Source .jsonl sessions root (default: ~/.pi/agent/sessions)
 *     --data-dir <dir>             Target pi-web-ui data dir (default: ~/.pi-web-ui)
 *     --agent-dir <dir>            Target .pi/agent dir (default: ~/.pi/agent)
 *     --db-path <file>             Explicit SQLite DB path (default: <data-dir>/durable-sessions.db)
 *     --backup-dir <dir>           Explicit backup directory
 *     --update-identities          Rewrite role identity.json homeChat to durable:<sessionId>
 *     --no-update-identities       Preserve role identity.json homeChat paths on disk
 *     --verify-only                Run verification only against --manifest <file>
 *     --rollback                   Run rollbackToJsonl against --manifest <file>
 *     --manifest <file>            Path to migration-manifest.json (for --verify-only / --rollback)
 *     --quiet                      Suppress JSON summary output
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

async function loadMigratorModule() {
	const distCandidate = join(repoRoot, "dist", "server", "durable-jsonl-migrator.js");
	const srcCandidate = join(repoRoot, "server", "durable-jsonl-migrator.ts");
	if (existsSync(distCandidate)) {
		return await import(pathToFileURL(distCandidate).href);
	}
	const { tsImport } = await import("tsx/esm/api");
	return await tsImport(srcCandidate, import.meta.url);
}

function parseCliArgs(argv) {
	const home = process.env.HOME || homedir();
	const opts = {
		sessionsDir: process.env.PI_SESSIONS_DIR || join(home, ".pi", "agent", "sessions"),
		dataDir: process.env.PI_WEB_UI_DATA_DIR || join(home, ".pi-web-ui"),
		agentDir: process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"),
		dbPath: undefined,
		backupDir: undefined,
		updateRoleIdentities: undefined,
		verifyOnly: false,
		rollback: false,
		manifestPath: undefined,
		quiet: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--sessions-dir" && argv[i + 1]) {
			opts.sessionsDir = resolve(argv[++i]);
		} else if (arg === "--data-dir" && argv[i + 1]) {
			opts.dataDir = resolve(argv[++i]);
		} else if (arg === "--agent-dir" && argv[i + 1]) {
			opts.agentDir = resolve(argv[++i]);
		} else if (arg === "--db-path" && argv[i + 1]) {
			opts.dbPath = resolve(argv[++i]);
		} else if (arg === "--backup-dir" && argv[i + 1]) {
			opts.backupDir = resolve(argv[++i]);
		} else if (arg === "--manifest" && argv[i + 1]) {
			opts.manifestPath = resolve(argv[++i]);
		} else if (arg === "--update-identities") {
			opts.updateRoleIdentities = true;
		} else if (arg === "--no-update-identities") {
			opts.updateRoleIdentities = false;
		} else if (arg === "--verify-only") {
			opts.verifyOnly = true;
		} else if (arg === "--rollback") {
			opts.rollback = true;
		} else if (arg === "--quiet" || arg === "-q") {
			opts.quiet = true;
		} else if (arg === "--help" || arg === "-h") {
			console.log(
				"Usage: node scripts/migrate-jsonl-to-durable.mjs [--sessions-dir <dir>] [--data-dir <dir>] [--agent-dir <dir>] [--db-path <file>] [--backup-dir <dir>] [--update-identities|--no-update-identities] [--verify-only --manifest <file>] [--rollback --manifest <file>] [--quiet]",
			);
			process.exit(0);
		}
	}
	return opts;
}

async function main() {
	const opts = parseCliArgs(process.argv.slice(2));
	const { migrateJsonlToDurable, verifyMigration, rollbackToJsonl } = await loadMigratorModule();
	const dbPath = opts.dbPath || join(opts.dataDir, "durable-sessions.db");

	if (opts.verifyOnly) {
		if (!opts.manifestPath) {
			throw new Error("--verify-only requires --manifest <path-to-migration-manifest.json>");
		}
		const verification = await verifyMigration({
			dbPath,
			manifest: opts.manifestPath,
		});
		if (!opts.quiet) {
			console.log(JSON.stringify(verification, null, 2));
		}
		process.exit(verification.ok ? 0 : 1);
	}

	if (opts.rollback) {
		if (!opts.manifestPath) {
			throw new Error("--rollback requires --manifest <path-to-migration-manifest.json>");
		}
		const rb = await rollbackToJsonl({
			dbPath,
			manifest: opts.manifestPath,
		});
		if (!opts.quiet) {
			console.log(JSON.stringify(rb, null, 2));
		}
		process.exit(rb.ok ? 0 : 1);
	}

	const result = await migrateJsonlToDurable({
		sessionsDir: opts.sessionsDir,
		dataDir: opts.dataDir,
		agentDir: opts.agentDir,
		dbPath: opts.dbPath,
		backupDir: opts.backupDir,
		updateRoleIdentities: opts.updateRoleIdentities,
	});

	if (!opts.quiet) {
		const totalEntries = result.migratedSessions.reduce((acc, s) => acc + s.entryCount, 0);
		console.log(
			JSON.stringify(
				{
					ok: result.ok,
					dbPath: result.dbPath,
					backupDir: result.manifest?.backupDir,
					manifestPath: result.manifest?.manifestPath,
					sessionsMigrated: result.migratedSessions.length,
					entriesMigrated: totalEntries,
					rolledBack: result.rolledBack,
					verification: result.verification,
				},
				null,
				2,
			),
		);
	}

	if (!result.ok || !result.verification.ok) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Failed to migrate .jsonl sessions to durable SQLite environment:", err);
	process.exit(1);
});
