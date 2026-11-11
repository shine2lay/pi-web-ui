/**
 * OpenViking Memory Dashboard — the Task 1 seam's single unimplemented marker (frontend #261).
 *
 * Every view-model function in this folder is declared with its final signature and throws here, so
 * Task 2 (#258) builds against a fixed contract and the acceptance suite in
 * `tests/openviking-dashboard/` fails for exactly one reason: nothing is implemented yet.
 *
 * Task 2 deletes this file (Rule 23: no shims). The acceptance suite asserts the code below is gone
 * from `web/src/openviking-dashboard/**`.
 */

/** Grep marker: while this code exists in the folder, the seam has no implementation. */
export const OPENVIKING_SEAM_NOT_IMPLEMENTED_CODE = "OPENVIKING_SEAM_NOT_IMPLEMENTED";

export class OpenVikingSeamNotImplementedError extends Error {
	constructor(readonly operation: string) {
		super(
			`${OPENVIKING_SEAM_NOT_IMPLEMENTED_CODE}: "${operation}" is a Task 1 seam declaration; Task 2 (#258) implements it.`,
		);
		this.name = "OpenVikingSeamNotImplementedError";
	}
}

export function notImplemented(operation: string): never {
	throw new OpenVikingSeamNotImplementedError(operation);
}
