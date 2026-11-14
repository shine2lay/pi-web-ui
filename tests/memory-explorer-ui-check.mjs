/**
 * ui-check for the Memory explorer (design #316): bundles the browser-only harness
 * (`memory-explorer-harness.tsx`, the real view on the tests' fake store), serves it on a random
 * local port and runs ui-check on every state at 320/390/1440 in light and dark.
 *
 *   node tests/memory-explorer-ui-check.mjs [out-dir]
 *
 * Light is the White theme's palette (themes/white.css) under prefers-color-scheme: light, the way
 * the app's own light themes re-declare the root colours; dark is the bundled default.
 * The built harness is also written to `<out-dir>/harness/` (index.html, app.js, app.css), so other
 * checkers (axe) can open the same page as a file. Exit 0 when every state passes, 1 otherwise.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const outDir = process.argv[2] ?? "/tmp/memory-explorer-ui-check";
const STATES = process.argv[3]?.split(",") ?? [
	"live",
	"loading",
	"empty",
	"error",
	"down",
	"degraded",
	"signed-out",
	"results",
	"reader",
	"confirm",
	"checking",
	"signed-in",
];

/** The fake store's `vi.fn` wrapper is only a spy: in the browser it is the function itself. */
const vitestStub = {
	name: "vitest-stub",
	setup(b) {
		b.onResolve({ filter: /^vitest$/ }, () => ({ path: "vitest", namespace: "stub" }));
		b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const vi = { fn: (f) => f };" }));
	},
};

const result = await build({
	absWorkingDir: root,
	entryPoints: ["tests/memory-explorer-harness.tsx"],
	bundle: true,
	write: false,
	outdir: "/harness",
	format: "iife",
	platform: "browser",
	jsx: "automatic",
	loader: { ".woff2": "dataurl", ".woff": "dataurl", ".svg": "dataurl", ".png": "dataurl" },
	plugins: [vitestStub],
	define: { "process.env.NODE_ENV": '"production"' },
	logLevel: "error",
});
const js = result.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
const light = readFileSync(`${root}themes/white.css`, "utf8");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Memory</title><link rel="stylesheet" href="app.css"><style>@media (prefers-color-scheme: light) { ${light} }</style></head><body><script src="app.js"></script></body></html>`;
mkdirSync(`${outDir}/harness`, { recursive: true });
writeFileSync(`${outDir}/harness/index.html`, html);
writeFileSync(`${outDir}/harness/app.js`, js);
writeFileSync(`${outDir}/harness/app.css`, css);

const server = createServer((req, res) => {
	const path = new URL(req.url ?? "/", "http://x").pathname;
	const [type, body] =
		path === "/app.js" ? ["text/javascript", js] : path === "/app.css" ? ["text/css", css] : ["text/html", html];
	res.setHeader("Content-Type", type);
	res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();

let failed = 0;
for (const state of STATES) {
	// Async: the harness server runs in this same process and must keep answering.
	const run = await new Promise((done) =>
		execFile(
			"ui-check",
			[`http://127.0.0.1:${port}/?state=${state}`, "--out-dir", `${outDir}/${state}`, "--json"],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => done({ status: error ? (error.code ?? 1) : 0, stdout, stderr }),
		),
	);
	let verdict = `exit ${run.status}`;
	try {
		const report = JSON.parse(run.stdout);
		verdict = `${report.verdict ?? report.status ?? verdict}`;
	} catch {}
	console.log(`${run.status === 0 ? "✓" : "✗"} ${state}: ${verdict}`);
	if (run.status !== 0) {
		failed++;
		console.log((run.stdout || run.stderr).slice(0, 4000));
	}
}
server.close();
process.exit(failed === 0 ? 0 : 1);
