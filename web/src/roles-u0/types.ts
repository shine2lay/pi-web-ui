// Template value types, kept apart from surface.ts so pure modules (native.ts)
// and their unit tests need no bundler-only "?raw" imports.
export type SurfaceValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| ((e: Event | Element) => void)
	| SurfaceValue[]
	| { [key: string]: SurfaceValue };
export type SurfaceValues = { [key: string]: SurfaceValue };
