/**
 * roles-by-project failing-first cases (frontend #293 seam; spec-acceptance.md, spec-build.md "Build order").
 * notBuilt(name, fn) passes only while fn fails with the seam stubs' exact "roles-by-project: not built (<owner> task)"
 * error. Any other outcome fails: once a builder implements a module, its cases fail here until the builder turns
 * `notBuilt(` into `it(` and makes them pass. Builders may never delete, skip or weaken a case (spec-build.md);
 * a case they think wrong goes to Architecture.
 *
 * ROLES_BY_PROJECT_SHOW=1 runs every case as a plain `it` so the run shows each case's real failure (the seam
 * task's failing-reason table; a builder's progress view).
 */
import { it } from "vitest";

export const NOT_BUILT = /^roles-by-project: not built \((?:Backend task|Frontend #294 task)\)$/;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function notBuilt(name: string, fn: () => unknown): void {
	if (process.env.ROLES_BY_PROJECT_SHOW === "1") {
		it(name, async () => {
			await fn();
		});
		return;
	}
	it(`[not built] ${name}`, async () => {
		let failure: unknown;
		let threw = false;
		try {
			await fn();
		} catch (error) {
			threw = true;
			failure = error;
		}
		if (threw && NOT_BUILT.test(messageOf(failure))) return;
		throw new Error(
			`${name}: ${threw ? `failed otherwise: ${messageOf(failure)}` : "passes now"}. ` +
				"Built: turn this notBuilt( into it( and keep every assertion (spec-build.md).",
			{ cause: failure },
		);
	});
}
