#!/usr/bin/env node
/**
 * sealed-summary.mjs: the end of scripts/sealed.sh. Reads the fence log of the run, tells what
 * happened (fence hits, processes left running, new folders in the real sessions list), writes the
 * JSON summary when PI_SEALED_REPORT_FILE was set, and prints the exit code sealed.sh should use:
 * 97 when the fence was hit in enforce mode, otherwise the command's own code.
 *
 *   node scripts/sealed-summary.mjs <fence.log> <mode> <command exit code> <report file|""> <leaked> <new dirs>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [logFile, mode, codeArg, reportFile, leakedArg = "", newDirsArg = ""] = process.argv.slice(2);
const code = Number(codeArg) || 0;
const lines = (s) =>
	s
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

const records = [];
if (logFile && existsSync(logFile)) {
	for (const line of lines(readFileSync(logFile, "utf8"))) {
		try {
			records.push(JSON.parse(line));
		} catch {
			/* a torn line */
		}
	}
}
const hits = records.filter((r) => !r.allowed);
const readonly = [...new Set(records.filter((r) => r.kind === "readonly").map((r) => r.path))];
const clones = records.filter((r) => r.kind?.startsWith("clone")).map((r) => r.path);
const leaked = lines(leakedArg);
const newSessionDirs = lines(newDirsArg);

const say = (s) => process.stderr.write(`${s}\n`);
if (hits.length > 0) {
	const verb = mode === "enforce" ? "blocked" : "recorded (report mode, not blocked)";
	say(`\n[sealed] ${hits.length} fence hit(s) ${verb}: the command touched real data`);
	for (const h of hits.slice(0, 40)) {
		say(`  - ${h.kind} ${h.fn} ${h.path}  (${h.script})${h.at ? `\n      at ${h.at}` : ""}`);
	}
	if (hits.length > 40) say(`  … and ${hits.length - 40} more`);
}
if (leaked.length > 0) {
	say(`[sealed] stopped ${leaked.length} process(es) the command left running:`);
	for (const l of leaked) say(`  - ${l}`);
}
if (newSessionDirs.length > 0) {
	say("[sealed] warning: the real sessions list gained folder(s) during the run (another chat, or a leak):");
	for (const d of newSessionDirs) say(`  - ${d}`);
}

const final = mode === "enforce" && hits.length > 0 ? 97 : code;
if (reportFile) {
	writeFileSync(
		reportFile,
		JSON.stringify({ mode, exitCode: code, finalCode: final, hits, readonly, clones, leaked, newSessionDirs }, null, 2),
	);
}
process.stdout.write(String(final));
