/**
 * record-file-reads.ts: a vitest setup file that records, for the read map, which repo files each unit test file
 * reads, lists, runs or loads (scripts/test-read-map.mjs, docs/gate-selected-tests.md, Ops #693).
 *
 * It does nothing unless PI_TEST_READ_MAP is set, which only scripts/test-read-map.mjs does. Then the recording
 * itself is tests/lib/file-read-recorder.cjs; this file names the test file and, after the file's tests, adds the
 * modules vitest ran for it (its imports, the dynamic ones and the `?raw` ones included).
 */
import { createRequire } from "node:module";
import { relative } from "node:path";
import { afterAll } from "vitest";

interface EvaluatedModule {
	evaluated?: boolean;
}
interface WorkerState {
	filepath?: string;
	evaluatedModules?: { fileToModulesMap?: Map<string, Set<EvaluatedModule>> };
}
interface Recorder {
	startInTestWorker(testOf: () => string | undefined): boolean;
	finishTestFile(test: string, loadedPaths: string[]): void;
}

const root = process.env.PI_TEST_READ_MAP_ROOT;
if (process.env.PI_TEST_READ_MAP && root) {
	const worker = () => (globalThis as { __vitest_worker__?: WorkerState }).__vitest_worker__;
	const testOf = () => {
		const file = worker()?.filepath;
		return file === undefined ? undefined : relative(root, file);
	};
	const recorder = createRequire(import.meta.url)("./file-read-recorder.cjs") as Recorder;
	const test = testOf();
	if (test !== undefined && recorder.startInTestWorker(testOf)) {
		afterAll(() => {
			const loaded: string[] = [];
			for (const [file, nodes] of worker()?.evaluatedModules?.fileToModulesMap ?? []) {
				// A module of an earlier test file in this process stays listed, marked not evaluated.
				if ([...nodes].some((node) => node.evaluated === true)) loaded.push(file);
			}
			recorder.finishTestFile(test, loaded);
		});
	}
}
