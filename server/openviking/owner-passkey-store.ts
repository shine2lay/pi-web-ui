/**
 * Memory Explorer — the owner's passkeys (OI-1, Security rm-8841fede point 1): public keys only, one file
 * `<data dir>/owner-passkeys.json`, mode 0600, each write atomic (temp file in the same folder, fsync, rename).
 * Each passkey belongs to one RP ID (host). A missing file is zero passkeys; an unreadable one throws (fail closed:
 * the caller refuses every request).
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export const OWNER_PASSKEYS_FILE = "owner-passkeys.json";

/** One enrolled passkey. `public_key`: base64url COSE key; `counter`: the authenticator's last signature count. */
export interface OwnerPasskey {
	id: string;
	rp_id: string;
	public_key: string;
	counter: number;
	transports: string[];
	created_at: string;
}

interface OwnerPasskeyFile {
	version: 1;
	passkeys: OwnerPasskey[];
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function checkedPasskey(raw: unknown): OwnerPasskey {
	const p = raw as Partial<OwnerPasskey> | null;
	const ok =
		p !== null &&
		typeof p === "object" &&
		typeof p.id === "string" &&
		B64URL.test(p.id) &&
		typeof p.rp_id === "string" &&
		p.rp_id !== "" &&
		typeof p.public_key === "string" &&
		B64URL.test(p.public_key) &&
		Number.isSafeInteger(p.counter) &&
		(p.counter as number) >= 0 &&
		Array.isArray(p.transports) &&
		p.transports.every((t) => typeof t === "string") &&
		typeof p.created_at === "string";
	if (!ok) throw new Error(`${OWNER_PASSKEYS_FILE}: an entry is malformed`);
	return {
		id: p.id as string,
		rp_id: p.rp_id as string,
		public_key: p.public_key as string,
		counter: p.counter as number,
		transports: [...(p.transports as string[])],
		created_at: p.created_at as string,
	};
}

export class OwnerPasskeyStore {
	readonly path: string;

	constructor(dataDir: string) {
		this.path = join(dataDir, OWNER_PASSKEYS_FILE);
	}

	/** Every passkey, all hosts. Throws when the file exists but is not a valid passkey file. */
	all(): OwnerPasskey[] {
		let text: string;
		try {
			text = readFileSync(this.path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		const parsed = JSON.parse(text) as Partial<OwnerPasskeyFile> | null;
		if (parsed?.version !== 1 || !Array.isArray(parsed.passkeys)) {
			throw new Error(`${OWNER_PASSKEYS_FILE}: not a version 1 passkey file`);
		}
		return parsed.passkeys.map(checkedPasskey);
	}

	/** The passkeys of one host. */
	forRp(rpID: string): OwnerPasskey[] {
		return this.all().filter((p) => p.rp_id === rpID);
	}

	/** Adds a passkey; refuses an id already stored (any host). */
	add(passkey: OwnerPasskey): void {
		const all = this.all();
		if (all.some((p) => p.id === passkey.id)) throw new Error("passkey already enrolled");
		this.write([...all, checkedPasskey(passkey)]);
	}

	/** Removes one host's passkey; false when it was not there. */
	remove(rpID: string, id: string): boolean {
		const all = this.all();
		const kept = all.filter((p) => !(p.rp_id === rpID && p.id === id));
		if (kept.length === all.length) return false;
		this.write(kept);
		return true;
	}

	/** Records the signature count a verified assertion reported. */
	setCounter(rpID: string, id: string, counter: number): void {
		const all = this.all();
		const at = all.findIndex((p) => p.rp_id === rpID && p.id === id);
		if (at === -1 || all[at].counter === counter) return;
		all[at] = { ...all[at], counter };
		this.write(all);
	}

	private write(passkeys: OwnerPasskey[]): void {
		const body: OwnerPasskeyFile = { version: 1, passkeys };
		const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		const fd = openSync(tmp, "wx", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
			fsyncSync(fd);
		} catch (err) {
			closeSync(fd);
			rmSync(tmp, { force: true });
			throw err;
		}
		closeSync(fd);
		renameSync(tmp, this.path);
	}
}
