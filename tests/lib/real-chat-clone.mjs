/**
 * A temporary copy of a real chat, for a test that needs real-chat data (a big chat, real pictures).
 *
 * The owner's rule: tests never touch real chats; a temporary clone is fine if it goes away right
 * after. So this works only inside a sealed run (scripts/sealed.sh): the real file is read once,
 * read-only, through the fence's door (tests/lib/sealed-fence.cjs), and the copy is written into the
 * sealed temp home, which the run removes when it ends. Nothing is ever written next to the real chat.
 *
 *   import { cloneRealChat } from "./lib/real-chat-clone.mjs";
 *   const chat = cloneRealChat({ minBytes: 20e6 });                // the biggest real chat, if ≥ 20 MB
 *   const chat = cloneRealChat({ pick: (chats) => chats.find((c) => c.path.includes("pi-web-ui")) });
 *   const chat = cloneRealChat({ into: join(srv.agentDir, "sessions") });   // straight into a test server's pi folder
 *   // → { file, sessionDir, acpFile, source, bytes }: file is the copy, source the real path (for messages)
 *
 * The copy keeps the real folder and file name (<into>/<cwd folder>/<name>.jsonl), so pi and the web app
 * treat it like the original; the chat's billion-context-pi sidecar (<name>.jsonl.acp.json) comes along
 * when there is one. `into` defaults to the sealed pi folder's sessions (PI_CODING_AGENT_DIR/sessions).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const DOOR = Symbol.for("pi.sealed.fence");

function door() {
	const d = globalThis[DOOR];
	if (!process.env.PI_SEALED || !process.env.PI_SEALED_ROOT || !d) {
		throw new Error(
			"cloneRealChat works only in a sealed test run: scripts/sealed.sh node tests/<name>.mjs " +
				"(tests never read real chats directly)",
		);
	}
	return d;
}

/** The real chats, biggest first: [{ path, size, mtimeMs }]. Only the listing; nothing is read. */
export function realChats() {
	return door()
		.listRealChats()
		.sort((a, b) => b.size - a.size);
}

/** Copy one real chat into the sealed home. See the file comment for the options. */
export function cloneRealChat({ minBytes = 0, pick, into } = {}) {
	const d = door();
	const chats = realChats();
	const chosen = pick ? pick(chats) : chats.find((c) => c.size >= minBytes);
	if (!chosen) {
		throw new Error(
			`cloneRealChat: no real chat to clone${minBytes ? ` of at least ${Math.round(minBytes / 1e6)} MB` : ""} ` +
				`(${chats.length} chats, the biggest is ${Math.round((chats[0]?.size ?? 0) / 1e6)} MB)`,
		);
	}
	const root = resolve(process.env.PI_SEALED_ROOT);
	const target = resolve(into ?? join(process.env.PI_CODING_AGENT_DIR ?? join(root, "home", ".pi", "agent"), "sessions"));
	if (target !== root && !target.startsWith(root + sep)) {
		throw new Error(`cloneRealChat: ${target} is outside the sealed home (${root}); the copy must go away with the run`);
	}
	const sessionDir = join(target, basename(dirname(chosen.path)));
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, basename(chosen.path));
	writeFileSync(file, d.readRealChat(chosen.path));
	let acpFile = null;
	try {
		const acp = d.readRealChat(`${chosen.path}.acp.json`);
		acpFile = `${file}.acp.json`;
		writeFileSync(acpFile, acp);
	} catch {
		/* no sidecar */
	}
	return { file, sessionDir, acpFile, source: chosen.path, bytes: chosen.size };
}
