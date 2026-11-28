// External isolated SDK harness. Never imported by production or pointed at a real chat.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import { LeadCompactionHost, type LeadHostPorts } from "../../server/lead-compaction-host.js";
import type { Prepared } from "../../server/lead-compaction-contract.js";
import type { LeadAdmission } from "../../server/lead-compaction-admission.js";

export async function nativeFixture(
	options: { inputHold?: Promise<void>; admission?: LeadAdmission; leadingProtected?: boolean } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "lead-host-"));
	const settingsManager = SettingsManager.inMemory();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "lead-host-no-call", models: [{ id: "m" }] });
	modelRuntime.registerNativeProvider(faux.provider);
	let modelCalls = 0;
	faux.setResponses([
		() => {
			modelCalls++;
			throw new Error("unexpected-model-call");
		},
	]);
	let handledInputs = 0;
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: options.inputHold
			? [
					(api) => {
						api.on("input", async () => {
							await options.inputHold;
							handledInputs++;
							return { action: "handled" };
						});
					},
				]
			: [],
	});
	await resourceLoader.reload();
	const manager = SessionManager.create(root, root);
	if (options.leadingProtected)
		manager.appendCustomMessageEntry("protected-injection", "keep native protection", true, { protected: true });
	manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "old reply" }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const boundary = manager.appendMessage({ role: "user", content: "current work checkpoint", timestamp: 3 });
	const create = async (sessionManager: SessionManager) =>
		(
			await createAgentSession({
				cwd: root,
				agentDir: root,
				modelRuntime,
				model: faux.getModel("m"),
				tools: [],
				resourceLoader,
				sessionManager,
				settingsManager,
			})
		).session;
	const session = await create(manager);
	await session.bindExtensions({});
	const source = manager.getSessionFile()!;
	let busy = false;
	let epoch = 0;
	let acknowledgements = 0;
	let ackGate: Promise<void> | undefined;
	const ports: LeadHostPorts = {
		resolveHome: (id) => (id === session.sessionId ? { source, role: "ops", bindingEpoch: epoch } : undefined),
		busy: () => busy,
		invalidate: () => {},
		acknowledge: async () => {
			if (ackGate) await ackGate;
			acknowledgements++;
		},
		coldApply: async () => {
			throw new Error("unexpected-cold");
		},
		verifySource: async () => {
			for (const line of readFileSync(source, "utf8").trim().split("\n")) JSON.parse(line);
		},
		reconstruct: async (_source, previous) => {
			previous.dispose();
			return create(SessionManager.open(source));
		},
	};
	const host = new LeadCompactionHost(ports, options.admission);
	host.attach(session);
	const summary = "archived old exchange";
	const ticket = () => {
		const fence = host.captureFence(session.sessionId);
		const prepared: Prepared = {
			planId: "one",
			planHash: "hash",
			originalFence: fence,
			bindingFingerprint: "binding",
			archiveFingerprints: ["archive"],
			boundary,
			summaryHash: createHash("sha256").update(summary).digest("hex"),
			sourceHash: "source",
			anchorHash: "anchor",
			protectedHash: "protected",
			tailHash: "tail",
			checkpointHash: "checkpoint",
		};
		return host.issueTicket({
			prepared,
			fence,
			draft: { summary, firstKeptEntryId: boundary, tokensBefore: 200000, details: {} },
		});
	};
	return {
		host,
		configurePorts: (update: Partial<LeadHostPorts>) => Object.assign(ports, update),
		create,
		session,
		manager,
		source,
		boundary,
		ticket,
		modelCalls: () => modelCalls,
		handledInputs: () => handledInputs,
		busy: () => {
			busy = true;
		},
		drift: () => {
			epoch++;
		},
		acknowledgements: () => acknowledgements,
		holdAck: (gate: Promise<void>) => {
			ackGate = gate;
		},
		close: () => {
			const file = host.admission.file(source);
			host.admission.owned(file, () => file.session?.dispose());
			rmSync(root, { recursive: true, force: true });
		},
	};
}
