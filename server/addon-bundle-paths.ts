import { accessSync, constants, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	createAgentSessionServices,
	getAgentDir,
	SettingsManager,
	type CreateAgentSessionServicesOptions,
} from "@earendil-works/pi-coding-agent";

/** Local project packages only; npm/git and unrelated paths retain SDK behavior. */
export function addonBundlePath(source: string, bundle = process.env.PI_WEB_ADDONS_DIR): string {
	if (!bundle) return source;
	const name = /^\/home\/shinelay\/projects\/([^/]+)\/?$/.exec(source)?.[1];
	if (!name || name === "." || name === "..") return source;
	const target = join(resolve(bundle), name);
	try {
		if (!statSync(target).isDirectory()) throw new Error("not a directory");
		accessSync(target, constants.R_OK | constants.X_OK);
	} catch (cause) {
		throw new Error(`PI_WEB_ADDONS_DIR: staged package missing or unreadable: ${target}`, { cause });
	}
	return target;
}

/** Project/global getters are the SDK package loader's boundary, including every reload.
 * Only copies returned by getters change: no overridden paths enter persisted settings.
 */
export function addonBundleSettings(manager: SettingsManager, bundle = process.env.PI_WEB_ADDONS_DIR): SettingsManager {
	if (!bundle) return manager;
	for (const key of ["getGlobalSettings", "getProjectSettings"] as const) {
		const original = manager[key].bind(manager);
		manager[key] = () => {
			const settings = original();
			if (!settings.packages) return settings;
			return {
				...settings,
				packages: settings.packages.map((item) =>
					typeof item === "string"
						? addonBundlePath(item, bundle)
						: { ...item, source: addonBundlePath(item.source, bundle) },
				),
			};
		};
	}
	return manager;
}

/** All host SDK session factories share the same scoped package projection. */
export function createAddonSessionServices(options: CreateAgentSessionServicesOptions) {
	if (!process.env.PI_WEB_ADDONS_DIR) return createAgentSessionServices(options);
	return createAgentSessionServices({
		...options,
		settingsManager: addonBundleSettings(
			options.settingsManager ?? SettingsManager.create(options.cwd, options.agentDir ?? getAgentDir()),
		),
	});
}
