// The reviewed filesystem lock from role-message-guard-host.ts, shared without loading the live guard host.
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** The pid a lock file names, or null when it is missing, names none or isn't a plain file. Ops #257 (B3): one open
 *  that doesn't follow a link or wait on a pipe, checked on that open file, as readFreshStartFile() does. */
function readPid(path: string): number | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return null;
	}
	try {
		if (!fstatSync(fd).isFile()) return null;
		const buf = Buffer.alloc(32);
		const n = Number.parseInt(buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0)), 10);
		return Number.isSafeInteger(n) ? n : null;
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}
/** Ops #257 (B3): why the guard's lock can't be taken as it is: it is there and isn't a plain file (a folder, a pipe,
 *  a link), looked at with lstat, never opened or followed. null when it is a plain file or isn't there. */
function lockNotFile(path: string): string | null {
	let st: ReturnType<typeof lstatSync> | undefined;
	try {
		st = lstatSync(path);
	} catch {
		return null; // not there: the link that takes it decides
	}
	if (!st || st.isFile()) return null;
	const kind = st.isSymbolicLink()
		? "a link"
		: st.isDirectory()
			? "a folder"
			: st.isFIFO()
				? "a pipe"
				: st.isSocket()
					? "a socket"
					: "a device";
	return `the guard's lock is ${kind}, not a plain file; it was left in place`;
}
function fsyncDir(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface GuardFileLockOptions {
	dir: string;
	log: (line: string) => void;
}

/** Lifetime filesystem ownership only; the caller supplies its own in-process lease. */
export class GuardFileLock {
	private lockPath = "";
	/** Ops #257 (B1): the lock file this server linked (its device and inode) and the pid written into it (Security
	 *  B1-R), null while it holds none. */
	private lockHeld: { dev: number; ino: number; pid: number } | null = null;

	constructor(private readonly o: GuardFileLockOptions) {}

	/** Read-only preflight before takeLock(); the caller creates the directory first. */
	check(): string | null {
		this.lockPath = join(this.o.dir, "lock");
		// Ops #257 (B3): anything but a plain file at `lock` turns the start off and stays as it is.
		const notFile = lockNotFile(this.lockPath);
		if (notFile) return notFile;
		const other = this.readLock();
		if (other && other !== process.pid && pidAlive(other)) return `another server (pid ${other}) holds the guard`;
		return null;
	}

	stop(): void {
		if (!this.lockHeld) return; // never held it (off, another server's, or start() not called)
		try {
			// Ops #257 (B1): only the file this server linked, never a lock another server took since.
			if (!this.lockLost()) rmSync(this.lockPath, { force: true });
		} catch {
			/* best effort */
		}
		this.lockHeld = null;
	}

	private readLock(): number | null {
		return readPid(this.lockPath);
	}
	/** Ops #257 (B1): why `lock` is no longer the file this server linked, or null while it is: the same device and
	 *  inode, naming the pid this server wrote into it. Security B1-R: the inode alone isn't enough, as a freed inode
	 *  number is given out again at once (ext4), so another server's new lock can have it; another server's lock always
	 *  names that server's pid, written and flushed before the link. */
	lockLost(): string | null {
		const held = this.lockHeld;
		if (!held) return "this server holds no lock on the guard";
		let st: ReturnType<typeof lstatSync> | undefined;
		try {
			st = lstatSync(this.lockPath);
		} catch {
			return "the guard's lock is gone";
		}
		const pid = st?.isFile() ? this.readLock() : null;
		if (st && st.dev === held.dev && st.ino === held.ino && pid === held.pid) return null;
		return `another server (pid ${pid ?? "unknown"}) took the guard's lock`;
	}
	/** Ops #253 (Architecture A4): take the lock in one step that fails when it is there, so two servers starting at
	 *  once can't both hold it. The pid is written and flushed to a file of this process's own, then linked to `lock`: a
	 *  link fails when `lock` exists, as openSync "wx" does, and the lock is never seen empty. A lock that is there: a
	 *  live other server's turns the ladder off, as before. A gone server's (dead pid), an unreadable one or this
	 *  process's own is moved aside, and the take is tried once more; a second failure turns the ladder off. The rename
	 *  takes whatever `lock` is by then, which can be a live server's lock made after the look (Ops #257, B1): its pid is
	 *  read again, and a live server's lock is given back. When a third server linked its own in that moment, the give
	 *  back fails and the moved lock is removed; the server it was taken from then finds `lock` isn't its file at its
	 *  next check (lockLost()) and turns off. Returns why it can't, or null once held (the linked file's inode and pid
	 *  kept in lockHeld). Leaves no file of its own behind either way. */
	takeLock(): string | null {
		const mine = `${this.lockPath}.tmp-${process.pid}`;
		const aside = `${this.lockPath}.stale-${process.pid}`;
		try {
			rmSync(mine, { force: true });
			// Ops #257 (Security N1): made new ("wx"), so a link put here since the line above is never written through and
			// the file always gets mode 0600; anything there turns the start off.
			writeFileSync(mine, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
			const fd = openSync(mine, "r");
			let made: { dev: number; ino: number; pid: number };
			try {
				fsyncSync(fd);
				const st = fstatSync(fd);
				made = { dev: st.dev, ino: st.ino, pid: process.pid }; // the pid written above
			} finally {
				closeSync(fd);
			}
			if (this.linkLock(mine, made)) return null;
			// Ops #257 (B3): looked at again here, as one can appear after the start's first look; never moved.
			const notFile = lockNotFile(this.lockPath);
			if (notFile) return notFile;
			const other = this.readLock();
			if (other && other !== process.pid && pidAlive(other)) return `another server (pid ${other}) holds the guard`;
			let moved = false;
			try {
				renameSync(this.lockPath, aside);
				moved = true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // ENOENT: gone already
			}
			const was = moved ? readPid(aside) : null;
			if (was && was !== process.pid && pidAlive(was)) {
				// A live server took the lock between the look above and the move: give it back.
				try {
					linkSync(aside, this.lockPath);
				} catch {
					/* yet another server holds it now */
				}
				return `another server (pid ${was}) holds the guard`;
			}
			if (this.linkLock(mine, made)) return null;
			return `another server (pid ${this.readLock() ?? "unknown"}) took the guard as this one started`;
		} finally {
			// Ops #257 (B3): best effort, so a removal that fails can't hide the outcome above.
			for (const left of [mine, aside]) {
				try {
					rmSync(left, { force: true });
				} catch {
					/* left behind */
				}
			}
		}
	}
	/** Ops #257 (Architecture B5): once this server holds the lock, remove the lock.tmp-<pid> and lock.stale-<pid> files
	 *  of servers that are gone (a crash inside takeLock() leaves them). A live server's (one taking the lock right now)
	 *  and anything but a plain file stay. Best effort: a file that can't be removed stays; logs what went. */
	sweepLockLeftovers(): void {
		const removed: string[] = [];
		try {
			for (const name of readdirSync(this.o.dir)) {
				const m = /^lock\.(?:tmp|stale)-(\d+)$/.exec(name);
				if (!m) continue;
				const pid = Number(m[1]);
				if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || pidAlive(pid)) continue;
				const path = join(this.o.dir, name);
				try {
					if (!lstatSync(path).isFile()) continue;
					rmSync(path);
					removed.push(name);
				} catch {
					/* left behind */
				}
			}
		} catch {
			/* the folder can't be listed: nothing removed */
		}
		if (removed.length)
			this.o.log(`approval ladder: removed ${removed.sort().join(", ")} (left by a server that is gone)`);
	}
	/** Link this process's flushed lock file to `lock`: true once held (the folder flushed, the file's inode kept),
	 *  false when one is there. */
	private linkLock(mine: string, made: { dev: number; ino: number; pid: number }): boolean {
		try {
			linkSync(mine, this.lockPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw err;
		}
		this.lockHeld = made;
		fsyncDir(this.o.dir);
		return true;
	}
}
