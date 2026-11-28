// H-only portion of frozen Ops1154 adapter. Unsupported combined/archive/live-load cases FAIL.
import { nativeFixture } from "./lead-compaction-fixture.js";
export async function runCase(id: string, _input: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
	if (id === "A2-sends-in-flight") {
		let release!: () => void;
		const f = await nativeFixture({
			inputHold: new Promise<void>((resolve) => {
				release = resolve;
			}),
		});
		const other = await nativeFixture({ admission: f.host.admission });
		let aborts = 0;
		const abort = f.session.abort.bind(f.session);
		f.session.abort = async () => {
			aborts++;
			await abort();
		};
		try {
			const prompt = f.session.prompt("isolated pending work");
			await f.host.tryApply(f.ticket());
			const cutsWhileBusy = f.manager.getEntries().filter((e) => e.type === "compaction").length;
			await other.host.tryApply(other.ticket());
			release();
			await prompt;
			return {
				cutsWhileBusy,
				aborts,
				inputLost: Math.max(0, 1 - f.handledInputs()),
				inputDuplicated: Math.max(0, f.handledInputs() - 1),
				otherHomeProgress: other.manager.getEntries().some((e) => e.type === "compaction"),
				modelCalls: f.modelCalls() + other.modelCalls(),
			};
		} finally {
			release();
			f.close();
			other.close();
		}
	}
	if (["A3-generation", "A3-branch", "A3-post-validation-append"].includes(id)) {
		const f = await nativeFixture();
		try {
			const ticket = f.ticket();
			if (id === "A3-post-validation-append") f.manager.appendCustomEntry("checkpoint", { retained: true });
			else f.manager.branch(f.boundary);
			const status = await f.host.tryApply(ticket);
			return {
				staleTicketCuts: f.manager.getEntries().filter((e) => e.type === "compaction").length,
				refusalRecorded: status.state === "blocked" && status.errorCode === "stale-fence",
			};
		} finally {
			f.close();
		}
	}
	throw new Error(`H_ADAPTER_INTEGRATION_REQUIRED:${id}`);
}
