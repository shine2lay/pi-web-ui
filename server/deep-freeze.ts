/**
 * Freezes a value and everything it holds, so readers can share it without one changing what the next one sees: in
 * a module (strict mode) a change throws a TypeError. An object that is frozen already is taken as frozen all the way
 * down and not walked again, so freezing a new value built on frozen parts costs only the new part. Returns the same
 * value.
 */
export function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}
