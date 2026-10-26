import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import type { Extension, Registry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { DurableContextResolver } from "./addon-bridges.js";
import { DurableAddonBridge, loadBillionContextExtension } from "./addon-bridges.js";

export interface DurableRegistryOptions {
	cwd: string;
	agentDir?: string;
	bridge?: DurableAddonBridge;
	extensions?: readonly Extension[];
	context?: DurableContextResolver;
}

const nativeBillionContextRegistries = new WeakSet<Registry>();
export function hasNativeBillionContext(registry: Registry): boolean {
	return nativeBillionContextRegistries.has(registry);
}

/** Built-ins first; host/plugin/MCP/SDK extension tools override by name, as in coding-agent. */
export async function setupDurableRegistry(options: DurableRegistryOptions | string): Promise<Registry> {
	const opts = typeof options === "string" ? { cwd: options } : options;
	const registry = createRegistry();
	registry.install(CodingTools);
	for (const extension of opts.extensions ?? []) registry.install(extension);
	if (opts.agentDir) {
		const extension = await loadBillionContextExtension(opts.agentDir, opts.context);
		if (extension) {
			registry.install(extension);
			nativeBillionContextRegistries.add(registry);
		}
	}
	if (opts.bridge) installAddonBridge(registry, opts.bridge);
	return registry;
}

export function hostToolsExtensionName(bridge: DurableAddonBridge): string {
	return `pi_host_tools_${bridge.options.state.conversation.id}`;
}

export function installAddonBridge(registry: Registry, bridge: DurableAddonBridge): void {
	registry.install(defineExtension({ name: hostToolsExtensionName(bridge), tools: bridge.toolRegistrations() }));
	registry.install(bridge.extension);
}
