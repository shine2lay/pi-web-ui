/**
 * work-registry-drop (Ops #1065, H-STALL-WHOLE-3; docs/stall-watch-registry-missing.md; QA L6/O9): the work
 * registry reader's last known count, and the owner alarm when a complete read finds no tasks where the last
 * known count was above 0. The read stays complete; this only tells the owner, once.
 *
 * The last known count is this process's last complete read, else the heartbeat on disk (`readRegistryHeartbeat`
 * through `registryWatchOf`). The alarm is awaited inside the read, so it goes out before the round rewrites the
 * heartbeat to 0: a crash in between leaves it owed (the heartbeat still says the old count), never lost.
 * H-STALL-WHOLE-4 (Ops #1068, QA L10/N1; docs/stall-watch-drop-owed.md): a send that surely failed stays owed and is tried at the next read, and
 * while it is owed the round doesn't rewrite the heartbeat (`owed`, `registryWatchOf`): the old count stays on
 * disk, so a restart before a send succeeds still owes it and sends it. Any drop to exactly 0 counts; a
 * drop to a smaller count doesn't (the store compacts and projects get dropped). A file put back after the
 * "missing" alarm is the way back to healthy, not a second drop.
 */

import type { OwnerTelegramNotice, OwnerTelegramSender } from "./owner-telegram.js";
import type { RegistryComplete, RegistryHeartbeat } from "./work-registry-reader.js";

/** What the reader tells the owner through: the watch's alarm route and log. */
export interface RegistryDropHooks {
	alarm?: OwnerTelegramSender;
	log?: (line: string) => void;
}

export class RegistryDrop {
	/** The last complete read in this process: its time and count. */
	private known: RegistryHeartbeat | undefined;
	/** The last read was "missing" (the owner had that alarm): a file put back, even empty, isn't a drop. */
	private afterMissing = false;
	/** The alarm being sent, so two reads at once send it once. */
	private telling: Promise<boolean> | undefined;
	/** The last complete read owes the alarm (its send surely failed): the count it is owed for. */
	private owing: RegistryHeartbeat | undefined;

	constructor(
		private readonly file: () => string,
		private readonly lastBeat: () => RegistryHeartbeat | undefined,
		private readonly hooks: RegistryDropHooks,
	) {}

	/** The last known count: this process's last complete read, else the heartbeat (throws when it can't be read). */
	lastKnown(): RegistryHeartbeat | undefined {
		return this.known ?? this.lastBeat();
	}

	/** The count the drop alarm is owed for while its last send surely failed (the heartbeat keeps it), else undefined. */
	owed(): RegistryHeartbeat | undefined {
		return this.owing;
	}

	/** The read was incomplete, "missing". */
	missing(): void {
		this.afterMissing = true;
	}

	/** A complete read: a drop from above 0 to none tells the owner first; then it is the last known count. */
	async complete(read: RegistryComplete): Promise<void> {
		while (this.telling) await this.telling;
		const afterMissing = this.afterMissing;
		this.afterMissing = false;
		const last = read.tasksRead || afterMissing ? undefined : this.beforeNone();
		if (last && this.hooks.alarm) {
			const telling = (this.telling = this.tell(last, this.hooks.alarm));
			const sent = await telling;
			this.telling = undefined;
			if (!sent) {
				// Owed: the last known count stays (here and in the heartbeat), so the next read tries again.
				this.owing = last;
				return;
			}
		}
		this.owing = undefined;
		this.known = { at: read.at, tasksRead: read.tasksRead };
	}

	/** The last known count when it was above 0, else undefined (a heartbeat that can't be read shows no drop). */
	private beforeNone(): RegistryHeartbeat | undefined {
		try {
			const last = this.lastKnown();
			return last?.tasksRead ? last : undefined;
		} catch {
			return undefined;
		}
	}

	/** Whether the alarm went out or may have (false: it surely didn't). */
	private async tell(last: RegistryHeartbeat, alarm: OwnerTelegramSender): Promise<boolean> {
		const what = `stall: work registry dropped from ${last.tasksRead} linked tasks to none`;
		const log = this.hooks.log ?? ((line: string) => console.log(line));
		let why: string;
		try {
			const r = await alarm(registryEmptiedAlarm(this.file(), last));
			if (r.ok || r.maybeSent) {
				log(`${what}; owner alarm ${r.ok ? "sent" : `may have gone out (${r.error}); not sent again`}`);
				return true;
			}
			why = r.error;
		} catch (err) {
			why = err instanceof Error ? err.message : String(err);
		}
		log(`${what}; owner alarm not sent: ${why}; tried again at the next read`);
		return false;
	}
}

/** The owner's alarm for a work list that dropped to none (Rule 26: telegram_send, never a question dialog). */
export function registryEmptiedAlarm(file: string, last: RegistryHeartbeat): OwnerTelegramNotice {
	const when = new Date(last.at).toISOString();
	return {
		text:
			`The work list went from ${last.tasksRead} linked tasks (last complete read at ${when}) to none. ` +
			`If that was a deliberate reset, nothing is needed. If not, restore ${file} from the backup. ` +
			"The stuck-work watch keeps running. This alarm comes once.",
		from: "ops",
		url: "/",
		linkLabel: "Open pi-web-ui",
	};
}
