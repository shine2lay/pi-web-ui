// terminal-bridge.ts — terminal output from the socket to live xterm instances. Moved unchanged out of use-chat.ts
// (Ops #1090: room for the waiting-questions bell without growing that file; WT-SIZE-500's legacy ratchet).

const MAX_TERM_BUFFER = 200_000;

/**
 * Bridges terminal output from the socket to live xterm instances. Output for
 * a terminal whose component isn't mounted yet (or that this tab doesn't know
 * about) is buffered (capped) so nothing is lost during mount/reconnect.
 */
export interface TerminalWriter {
	write: (data: string) => void;
	dispose: () => void;
}

export function makeTerminalBridge() {
	/** Multiple writers may subscribe to the same (conversation, terminal) pair —
	 *  e.g. the SCM panel's hidden query terminal parses output through its own
	 *  writer while a (hidden) xterm instance may also be registered for it.
	 *  A Set keeps them all: later registrations no longer shadow earlier ones. */
	const writers = new Map<string, Set<TerminalWriter>>();
	const buffers = new Map<string, string>();
	const key = (conversationId: string, terminalId: string) => `${conversationId}:${terminalId}`;
	return {
		write(conversationId: string, terminalId: string, data: string): void {
			const writerKey = key(conversationId, terminalId);
			const set = writers.get(writerKey);
			if (set && set.size > 0) {
				for (const w of set) {
					try {
						w.write(data);
					} catch {
						// best effort
					}
				}
				return;
			}
			const prev = buffers.get(writerKey) ?? "";
			const next = prev.length + data.length > MAX_TERM_BUFFER ? data : prev + data;
			buffers.set(writerKey, next);
		},
		/** Register a writer (xterm instance / output parser); flushes buffered
		 *  output to the new subscriber. Returns an unregister fn. */
		register(conversationId: string, terminalId: string, writer: TerminalWriter): () => void {
			const writerKey = key(conversationId, terminalId);
			let set = writers.get(writerKey);
			if (!set) {
				set = new Set();
				writers.set(writerKey, set);
			}
			set.add(writer);
			const buffered = buffers.get(writerKey);
			if (buffered) {
				try {
					writer.write(buffered);
				} catch {
					// best effort
				}
				buffers.delete(writerKey);
			}
			return () => {
				const s = writers.get(writerKey);
				if (s) {
					s.delete(writer);
					if (s.size === 0) writers.delete(writerKey);
				}
				buffers.delete(writerKey);
			};
		},
		clear(): void {
			writers.clear();
			buffers.clear();
		},
	};
}
