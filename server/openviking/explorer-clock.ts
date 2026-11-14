/** Memory Explorer — the server's real clock for the undo window and the held delete (explorer-types.ts). */
import type { OpenVikingExplorerClock } from "./explorer-types.js";

export const systemExplorerClock: OpenVikingExplorerClock = {
	now: () => Date.now(),
	setTimer: (ms, fn) => {
		const timer = setTimeout(fn, ms);
		// A held delete must not keep a stopping server alive; the shutdown hook ends it instead.
		timer.unref();
		return timer;
	},
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
