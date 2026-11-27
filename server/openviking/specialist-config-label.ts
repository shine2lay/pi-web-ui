/**
 * Memory Explorer, a specialist node's status label (Architecture #597 v2 §5l.15, R-V2-SPMEM-20, §5l clarification
 * "Status labels use the one specialist reader"): a thin display projection of pi-identity's own
 * `specialists/files.ts::readConfig`, imported through its read-only entry `specialists/readonly.ts` from the
 * pi-identity the host has installed (configuredExtensionPaths). Never a copy of that reader (Phase 1 §5.4).
 *
 * `retired` / null (active) from the config it reads; `no config` only when it answers E_SPEC_NOT_FOUND; any other
 * refusal, a throw, or no loadable pi-identity is `config unreadable`: a read error with the row kept, never a guessed
 * absence. Display only: the label never hides, moves or locks a node, and no access depends on it.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { configuredExtensionPaths } from "../durable/addon-resources.js";
import type { OpenVikingSpecialistLabel } from "./explorer-types.js";

/** pi-identity's answer, as far as the label reads it (specialists/types.ts SpecAnswer<LoadedSpecialist>). */
type ReaderAnswer = { result: "allow"; config: { status: string } } | { result: "refuse"; code: string };
/** pi-identity `specialists/readonly.ts`: the narrow read-only entry into its one reader. */
export interface SpecialistReader {
	readConfig(identitiesDir: string, dept: string, slug: string): ReaderAnswer;
}

const PACKAGE = "pi-identity";
const READONLY_ENTRY = join("specialists", "readonly.ts");

/** The reader of the pi-identity installed for `agentDir` (its configured extensions), or null when none loads. */
export async function loadSpecialistReader(agentDir: string): Promise<SpecialistReader | null> {
	let entry: string | undefined;
	try {
		entry = configuredExtensionPaths(agentDir).find((p) => basename(dirname(p)) === PACKAGE);
	} catch {
		return null;
	}
	if (!entry) return null;
	try {
		const mod = (await import(pathToFileURL(join(dirname(entry), READONLY_ENTRY)).href)) as Partial<SpecialistReader>;
		return typeof mod.readConfig === "function" ? { readConfig: mod.readConfig } : null;
	} catch {
		return null;
	}
}

let installed: Promise<SpecialistReader | null> | null = null;
/** The host's pi-identity reader, loaded once; a failed load is retried on the next read. */
export function installedSpecialistReader(): Promise<SpecialistReader | null> {
	const loading = installed ?? loadSpecialistReader(getAgentDir());
	installed = loading;
	void loading.then((reader) => {
		if (reader === null && installed === loading) installed = null;
	});
	return loading;
}

/** The slug's label from pi-identity's own answer (see the header). */
export function specialistConfigLabel(
	reader: SpecialistReader | null,
	identitiesDir: string,
	dept: string,
	slug: string,
): OpenVikingSpecialistLabel {
	if (reader === null) return "config unreadable";
	let answer: ReaderAnswer;
	try {
		answer = reader.readConfig(identitiesDir, dept, slug);
	} catch {
		return "config unreadable";
	}
	if (answer.result === "allow") return answer.config.status === "retired" ? "retired" : null;
	return answer.code === "E_SPEC_NOT_FOUND" ? "no config" : "config unreadable";
}
