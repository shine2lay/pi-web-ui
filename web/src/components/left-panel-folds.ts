// left-panel-folds.ts — the left panel's remembered folds (its sections, queue chats' task chats), kept in
// localStorage. Moved unchanged out of LeftPanel.tsx (Ops #1090: room for the waiting-questions "?" on saved chats
// without growing that file; WT-SIZE-500's legacy ratchet).
import { useCallback, useState } from "react";
import { LS_QUEUE_FOLDED, parseQueueFolds, toggledQueueFolds } from "../queue-folds";

export function useCollapsed(key: string, defaultCollapsed = false): [boolean, () => void] {
	const [collapsed, setCollapsed] = useState(() => {
		try {
			const v = localStorage.getItem(key);
			if (v === "1") return true;
			if (v === "0") return false;
		} catch {}
		return defaultCollapsed;
	});
	const toggle = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(key, next ? "1" : "0");
			} catch {}
			return next;
		});
	}, [key]);
	return [collapsed, toggle];
}

/** queue-grouping: the queue chats whose task chats are folded away (queue-folds.ts), kept in localStorage. */
export function useQueueFolds(): [ReadonlySet<string>, (key: string) => void] {
	const [folds, setFolds] = useState<ReadonlySet<string>>(() => {
		try {
			return parseQueueFolds(localStorage.getItem(LS_QUEUE_FOLDED));
		} catch {
			return new Set();
		}
	});
	const toggle = useCallback((key: string) => {
		setFolds((prev) => {
			const next = toggledQueueFolds(prev, key);
			try {
				localStorage.setItem(LS_QUEUE_FOLDED, JSON.stringify(next));
			} catch {}
			return new Set(next);
		});
	}, []);
	return [folds, toggle];
}
