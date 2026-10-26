import type { ClientMessage } from "./types";

/** Local admission, not server persistence or authority to discard a recoverable copy. */
export type AppAdmit = (msg: ClientMessage) => Promise<boolean>;

let admitImpl: AppAdmit | null = null;

/** Install or clear the handler for subsequent calls; in-flight calls keep their handler. */
export function setAppAdmit(fn: AppAdmit | null): void {
	admitImpl = fn;
}

/** Await one captured handler with the exact message; never fall back to appSend. */
export async function appAdmit(msg: ClientMessage): Promise<boolean> {
	const admit = admitImpl;
	if (!admit) return false;
	return (await admit(msg)) === true;
}
