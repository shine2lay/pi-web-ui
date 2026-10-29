// Ops #639 (docs/gate-time.md): vi.waitFor and vi.waitUntil give up after 1 s of wall-clock by default, so a
// condition that comes true, only later because the machine is busy, failed the test. Their default becomes the
// hang guard: they still wait for the same condition, and still fail when it never comes. A call that passes its
// own timeout keeps it.
import { vi } from "vitest";
import { HANG_GUARD_MS } from "./load-independent.js";

type Options = number | { timeout?: number; interval?: number } | undefined;
const guarded = (options: Options) =>
	typeof options === "number" ? options : { ...options, timeout: options?.timeout ?? HANG_GUARD_MS };

const waitFor = vi.waitFor.bind(vi);
const waitUntil = vi.waitUntil.bind(vi);
vi.waitFor = ((callback: Parameters<typeof waitFor>[0], options?: Options) =>
	waitFor(callback, guarded(options))) as typeof vi.waitFor;
vi.waitUntil = ((callback: Parameters<typeof waitUntil>[0], options?: Options) =>
	waitUntil(callback, guarded(options))) as typeof vi.waitUntil;
