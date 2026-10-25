import type { RoleMessagePersistence } from "../../server/role-messages.js";

/** #539: single-instance M cases only. RoleMessages owns the live store and chain map; discard their disk
 * copies without serializing them. NOT a restart/reload fixture: no persisted bytes, log/failure simulation,
 * outside readers or cross-host/process hand-off. Those cases must keep the default file persistence. */
export function memoryRoleMessagePersistence(): RoleMessagePersistence {
	return {
		read: () => {
			throw new Error("no persisted copy in a memory-only case");
		},
		rename: () => {},
		saveStore: () => {},
		appendChains: () => {},
		replaceChains: () => {},
	};
}
