import { appendFileSync, readFileSync } from "node:fs";
import { InboxHelperHost, type InboxHelperHostPorts } from "../../server/inbox-helper-host.js";
import { InboxRuntime, type InboxQueuePort } from "../../server/inbox-runtime.js";
import { runQueueCloseChat } from "../../server/queue-chat-lane.js";
import { startTaskChat } from "../../server/task-chat-start.js";
import { B, chat, who, world } from "../unit/role-message-guard-host-harness.js";
import { fixture } from "./inbox-queue-fixture.js";
import { setup, claimOf } from "./inbox-world.js";
import { inboxRepoFile } from "./inbox-repo-roots.js";
const { canonSha, sortNames, toolSetSha } = (await import(
	inboxRepoFile("pi-identity", "specialists/canon.ts").href
)) as typeof import("../../../pi-identity/specialists/canon.ts");

export function journal(file: string) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}
export function adds(file: string): number {
	return journal(file).filter((e) => e.customType === "queue" && e.data.op === "add").length;
}
export async function replayFixture(autoApprove = true, paused = false) {
	const q = fixture(autoApprove, paused);
	const queue: InboxQueuePort = {
		homeSession: q.home.file,
		async accept(intent) {
			await q.home.command(q.mint(intent));
			const result = q.results.at(-1);
			if (!result) throw new Error("HOME did not finish capability");
			return result;
		},
		async find(opKey) {
			for (const task of q.home.state().tasks) {
				const input = (task.origin?.inputs as Array<{ opKey?: string; payloadSha256?: string }> | undefined)?.find(
					(i) => i.opKey === opKey,
				);
				if (input?.payloadSha256) return { queuedTask: task.id, payloadSha256: input.payloadSha256 };
			}
			return undefined;
		},
	};
	const h = await setup(queue);
	const sessions = new Map<string, string>();
	const launched: string[] = [],
		closed: string[] = [],
		archived: string[] = [];
	let busy = false,
		failClose = false,
		serial = 0;
	const tools = sortNames(["read", "message_role", "queue_add", "inbox_release"]);
	const ports: InboxHelperHostPorts = {
		runtime: h.runtime,
		allocate: () => {
			const id = `replay-${++serial}`;
			const file = chat(id);
			sessions.set(id, file);
			return { sessionId: id, sessionFile: file };
		},
		seal: async () => ({
			tools,
			toolSetSha: toolSetSha(tools),
			ceilingPolicySha: canonSha({ allowed: tools }),
			rolesConfigSha: canonSha({ beta: {} }),
		}),
		// No tool policy is simulated. Tests in this slice never call this port.
		decideTool: async () => {
			throw new Error("Canonical tool resolver not wired in this fixture");
		},
		append: (file, customType, data) =>
			appendFileSync(file, `${JSON.stringify({ type: "custom", customType, data })}\n`),
		launch: async (binding, hostHooks) => {
			await startTaskChat({
				ranTurn: () => false,
				send: async (hooks) => {
					launched.push(binding.sessionId);
					hostHooks.gate("started");
					hooks.gate("started");
					hostHooks.ended();
					hooks.ended();
				},
			});
		},
		working: () => busy,
		close: (id) =>
			runQueueCloseChat(
				{
					clients: new Map([
						[
							"replay",
							{
								releaseQueueChat: (file) => {
									if (failClose) return false;
									closed.push(file);
									return true;
								},
							},
						],
					]),
					stateStore: { removeRecent: () => {} },
					queueSessionFor: () => null,
					queueLaneRoles: { roleOfHomeChat: () => "beta" },
				},
				sessions.get(id)!,
				() => {},
			),
		archive: async (id) => {
			archived.push(id);
		},
	};
	const host = new InboxHelperHost(ports);
	return {
		h,
		q,
		queue,
		host,
		ports,
		sessions,
		launched,
		closed,
		archived,
		busy: (v: boolean) => {
			busy = v;
		},
		failClose: (v: boolean) => {
			failClose = v;
		},
		admit: (homeWorking = true, k: 3 | 4 = 3) => host.admit({ role: "beta", homeChat: B, homeWorking, k }),
		claim: async () =>
			claimOf(await h.runtime.claim(h.key, { kind: "helper", role: "beta", session: chat("replay-direct") })),
	};
}
export type ReplayFixture = Awaited<ReturnType<typeof replayFixture>>;
export function item(f: ReplayFixture, runtime = f.h.runtime) {
	const read = runtime.read("beta");
	if (read.status !== "ok") throw new Error("Expected qualified inbox read");
	const found = read.items.find((i) => i.key === f.h.key);
	if (!found) throw new Error("Original request missing");
	return found;
}
export async function reboot(f: ReplayFixture) {
	f.h.w.rm.stop();
	f.h.w.host.stop();
	const w = await world(f.h.w);
	return { w, runtime: new InboxRuntime({ ...f.h.runtime.ports, messages: w.rm, guard: w.host }) };
}
export function reply(f: ReplayFixture, lease: Awaited<ReturnType<ReplayFixture["claim"]>>, text = "Technical answer") {
	return f.h.runtime.reply(
		lease,
		who(f.h.w, "beta", lease.session),
		{ kind: "reply", to: "alpha", replyTo: f.h.id, text },
		`reply-${text}`,
	);
}
