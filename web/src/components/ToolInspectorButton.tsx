import { useEffect, useState } from "react";
import { getClientId } from "../client-id";
import { appBase } from "../base-url";

declare global {
	interface Window {
		PiToolInspector?: {
			open(options: { clientId: string; convId: string; baseUrl?: string }): Promise<void>;
			close(): void;
		};
	}
}

/** The classic script owns the drawer; React supplies only the exact current chat, never a saved
 * or guessed client id. Closing on switch prevents a stale drawer editing a different chat's tools. */
export function ToolInspectorButton({ conversationId, disabled }: { conversationId: string; disabled?: boolean }) {
	const [error, setError] = useState("");
	useEffect(() => {
		setError("");
		return () => window.PiToolInspector?.close();
	}, [conversationId]);
	return (
		<span className="slot-toolbar">
			<button
				className="btn"
				type="button"
				aria-haspopup="dialog"
				aria-label="Tool Inspector"
				title="Tool Inspector"
				disabled={disabled || !conversationId}
				onClick={() => {
					const inspector = window.PiToolInspector;
					if (!inspector) {
						setError("Tool Inspector did not load. Refresh this page and try again.");
						return;
					}
					setError("");
					void inspector.open({ clientId: getClientId(), convId: conversationId, baseUrl: appBase() }).catch(() => {
						setError("Tool Inspector could not open. Refresh this page and try again.");
					});
				}}
			>
				Tools
			</button>
			{error && <span role="alert">{error}</span>}
		</span>
	);
}
