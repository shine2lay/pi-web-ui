import type { UiTaskRequester, UiTaskRequesterInput } from "./protocol.js";

export const REQUESTER_INPUTS_MAX = 32;
const exact = (re: RegExp, value: unknown): value is string =>
	typeof value === "string" && re.exec(value)?.[0] === value;
const inputId = (value: unknown): value is string => exact(/^(?:ri|rs)-[a-f0-9-]{8,64}$/u, value);
const keys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

/** Same optional display-only wire record as pi-queue/queue-requester.ts. Never authority. */
export function requesterInputOf(raw: unknown): UiTaskRequesterInput | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	const o = raw as Record<string, unknown>;
	if (o.kind === "unknown" && keys(o, ["kind"])) return { kind: "unknown" };
	if (
		o.kind === "owner" &&
		keys(o, ["kind", "channel", "id"]) &&
		(o.channel === "browser" || o.channel === "telegram") &&
		inputId(o.id)
	) {
		return { kind: "owner", channel: o.channel, id: o.id };
	}
	if (
		o.kind !== "role" ||
		!keys(o, ["kind", "role", "id", "message", "forOwner", "ownerIds"]) ||
		!exact(/^[a-z0-9][a-z0-9-]{0,39}$/u, o.role) ||
		!exact(/^rm-[a-f0-9-]{8,64}$/u, o.id) ||
		(o.message !== "question" && o.message !== "request" && o.message !== "reply") ||
		(o.forOwner !== undefined && o.forOwner !== true)
	)
		return;
	if (
		o.ownerIds !== undefined &&
		(o.forOwner !== true ||
			!Array.isArray(o.ownerIds) ||
			o.ownerIds.length > 10 ||
			o.ownerIds.some((id) => !inputId(id) || !id.startsWith("rs-")))
	)
		return;
	return {
		kind: "role",
		role: o.role,
		id: o.id,
		message: o.message,
		...(o.forOwner === true ? { forOwner: true as const } : {}),
		...(Array.isArray(o.ownerIds) ? { ownerIds: [...o.ownerIds] as string[] } : {}),
	};
}

export function requesterOf(raw: unknown): UiTaskRequester | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	const o = raw as Record<string, unknown>;
	if (
		!keys(o, ["v", "inputs"]) ||
		o.v !== 1 ||
		!Array.isArray(o.inputs) ||
		!o.inputs.length ||
		o.inputs.length > REQUESTER_INPUTS_MAX
	)
		return;
	const inputs: UiTaskRequesterInput[] = [];
	const seen = new Set<string>();
	for (const rawInput of o.inputs) {
		const input = requesterInputOf(rawInput);
		if (!input) return;
		const key = JSON.stringify(input);
		if (!seen.has(key)) {
			inputs.push(input);
			seen.add(key);
		}
	}
	return { v: 1, inputs };
}

/** Called with admitted host metadata, never with a browser/tool-supplied identity. */
export function requesterForAdmission(input: {
	cause?: string;
	source?: string;
	ownerChannel?: string;
	sendId?: string;
	requester?: UiTaskRequesterInput;
	inputId: string;
}): UiTaskRequesterInput {
	if (input.requester !== undefined) {
		return input.source === "extension" && input.cause === "role"
			? (requesterInputOf(input.requester) ?? { kind: "unknown" })
			: { kind: "unknown" };
	}
	if ((input.ownerChannel === "browser" || input.ownerChannel === "telegram") && input.cause === input.ownerChannel) {
		return (
			requesterInputOf({ kind: "owner", channel: input.ownerChannel, id: input.sendId ?? input.inputId }) ?? {
				kind: "unknown",
			}
		);
	}
	return { kind: "unknown" };
}

/** A turn may have several accepted inputs. Unknown is retained; overflow is not a partial list. */
export interface RequesterTurn {
	requesterInputs?: UiTaskRequesterInput[];
	requesterOverflow?: true;
}
export function collectRequesterInput(turn: RequesterTurn, raw: unknown): void {
	if (turn.requesterOverflow) return;
	const input = requesterInputOf(raw) ?? { kind: "unknown" as const };
	const inputs = (turn.requesterInputs ??= []);
	const key = JSON.stringify(input);
	if (inputs.some((existing) => JSON.stringify(existing) === key)) return;
	if (inputs.length >= REQUESTER_INPUTS_MAX) {
		turn.requesterOverflow = true;
		delete turn.requesterInputs;
	} else inputs.push(input);
}
export function mergeRequesterTurn(into: RequesterTurn, from: RequesterTurn): void {
	if (from.requesterOverflow) {
		into.requesterOverflow = true;
		delete into.requesterInputs;
		return;
	}
	for (const input of from.requesterInputs ?? []) collectRequesterInput(into, input);
}
export function requesterOfTurn(turn: RequesterTurn | undefined): UiTaskRequester | undefined {
	return turn && !turn.requesterOverflow ? requesterOf({ v: 1, inputs: turn.requesterInputs }) : undefined;
}

/** Plain text only; identifiers that trace inputs never reach display text. */
export function requesterText(raw: unknown, roleLabel: (id: string) => string = (id) => id): string | undefined {
	const record = requesterOf(raw);
	if (!record || record.inputs.every((input) => input.kind === "unknown")) return;
	const labels = record.inputs.map((input) =>
		input.kind === "owner"
			? `You (${input.channel === "browser" ? "browser" : "Telegram"})`
			: input.kind === "role"
				? `${input.forOwner ? "You via " : ""}${roleLabel(input.role)}`
				: "Not recorded",
	);
	return [...new Set(labels)].join(" · ");
}
