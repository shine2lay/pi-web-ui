/**
 * Memory Explorer — the passkey enrollment code (OI-1, Security rm-8841fede point 2). Single use, 7 random words
 * (crypto RNG, 256 words: 56 bits), valid 10 minutes, one live code at a time, held in memory only as a sha256.
 * Sent ONLY to the owner's Telegram through the Telegram plugin's telegram_send (the bot token stays in the plugin);
 * a send that is not confirmed (ok:false, maybeSent included) leaves no code. The code is never written to disk, a
 * log, a response or the environment: nothing here logs, and callers get back only an expiry or a reason code.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OwnerTelegramSender } from "../owner-telegram.js";
import { OWNER_ENROLL_CODE_MS, OWNER_ENROLL_CODE_WORDS, type OwnerRelyingParty } from "./owner-session-types.js";

const WORDS = `
acid acorn actor adult agent alarm album alert alley amber angle ankle apple apron arena armor arrow atlas
attic audio aunt award bacon badge bagel baker balm bamboo banjo barn basin basket beach beard beast bench
berry bike birch bison blade blanket blaze bloom board boat bonus boot bottle bowl brain branch brave bread
brick bridge broom brush bucket buddy bugle bunny cabin cable cactus camel camera candle canoe canvas cargo
carpet carrot castle cedar chair chalk cherry chess chief cider circle claw clay cliff clock cloud clover
coach coast cobra cocoa comet coral cotton couch crane crayon cream creek crown cube cushion daisy dance
delta denim desert diner dingo dolphin donkey door dragon drum eagle easel echo elbow ember engine fable
falcon feather fence fern ferry fiddle field flag flame flute forest fossil fox frost fudge garden gecko
giant ginger glove goat gold grape gravel guitar hammer harbor harp hazel helmet heron hippo honey hornet
hotel igloo iron island ivory jacket jaguar jelly jewel jungle kayak kettle kiwi koala ladder lagoon lake
lamp lantern lemon lily lion llama lobster locket lotus magnet mango maple marble meadow melon mirror mitten
moose motor mouse muffin nectar needle nickel noodle north oasis ocean olive onion orbit otter owl paddle
panda paper parrot peach pebble pencil pepper piano pickle pillow pilot planet plum pocket pony puzzle quail
quilt rabbit radar radio raft rain raven ribbon river robin rocket rose ruby saddle salmon sandal satin scarf
shell shovel silver sketch sled snail spark spider spoon squid stamp star stone sugar
`
	.trim()
	.split(/\s+/);

if (WORDS.length !== 256 || new Set(WORDS).size !== 256) throw new Error("owner code word list must be 256 words");

/** The words, for tests that check a code's shape. */
export const OWNER_CODE_WORDS: readonly string[] = WORDS;

/** Wrong guesses a live code survives before it is voided. */
export const OWNER_CODE_MAX_MISSES = 5;

/** Why no code is live, as a log reason code. */
export type OwnerCodeIssueResult = { ok: true; expiresAt: number } | { ok: false; reason: "telegram_failed" };

interface LiveCode {
	rpID: string;
	digest: Buffer;
	expiresAt: number;
	misses: number;
}

const digestOf = (code: string) => createHash("sha256").update(code, "utf8").digest();

/** Lowercase words separated by one space, whatever the owner typed between them. */
export function normalizeOwnerCode(raw: unknown): string {
	if (typeof raw !== "string" || raw.length > 400) return "";
	return raw
		.toLowerCase()
		.split(/[^a-z]+/)
		.filter((w) => w !== "")
		.join(" ");
}

export interface OwnerEnrollCodeDeps {
	telegram: OwnerTelegramSender;
	now: () => number;
	/** Crypto RNG; tests may pass a fixed source. */
	randomBytes?: (n: number) => Uint8Array;
}

export class OwnerEnrollCodes {
	private live: LiveCode | null = null;

	constructor(private readonly deps: OwnerEnrollCodeDeps) {}

	/** Voids any live code, makes a new one for `rp` and sends it to the owner's Telegram. */
	async issue(rp: OwnerRelyingParty): Promise<OwnerCodeIssueResult> {
		this.live = null;
		const bytes = (this.deps.randomBytes ?? randomBytes)(OWNER_ENROLL_CODE_WORDS);
		const code = Array.from(bytes, (b) => WORDS[b]).join(" ");
		const text =
			`Passkey code for ${rp.rpID}:\n\n${code}\n\n` +
			"Type it on the memory explorer's enroll page. It works once, for 10 minutes. " +
			"If you didn't ask for one, ignore this message.";
		let delivered = false;
		try {
			const sent = await this.deps.telegram({ text, from: "pi-web-ui owner check" });
			delivered = sent.ok;
		} catch {
			delivered = false;
		}
		if (!delivered) return { ok: false, reason: "telegram_failed" };
		const expiresAt = this.deps.now() + OWNER_ENROLL_CODE_MS;
		this.live = { rpID: rp.rpID, digest: digestOf(code), expiresAt, misses: 0 };
		return { ok: true, expiresAt };
	}

	/** true (and the code is used up) when `raw` is the live code for `rpID` within its 10 minutes. */
	take(rpID: string, raw: unknown): boolean {
		const live = this.live;
		if (!live) return false;
		if (this.deps.now() > live.expiresAt) {
			this.live = null;
			return false;
		}
		const typed = normalizeOwnerCode(raw);
		const match = typed !== "" && timingSafeEqual(digestOf(typed), live.digest) && live.rpID === rpID;
		if (match) {
			this.live = null;
			return true;
		}
		live.misses += 1;
		if (live.misses >= OWNER_CODE_MAX_MISSES) this.live = null;
		return false;
	}
}
