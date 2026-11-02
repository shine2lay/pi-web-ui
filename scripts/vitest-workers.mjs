/** Local runner default only; CI and explicit diagnostic settings keep their precedence. */
export function localVitestWorkers(env = process.env) {
	const value = env.VITEST_MAX_WORKERS;
	if (value !== undefined) {
		if (!["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].includes(value)) {
			throw new Error("VITEST_MAX_WORKERS must be a canonical integer from 1 to 10");
		}
		return Number(value);
	}
	return env.CI === undefined ? 10 : undefined;
}
