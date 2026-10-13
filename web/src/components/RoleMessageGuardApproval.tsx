/** Isolated, opt-in dialog. CSS is deliberately not imported or registered here.
 * onDecision is ONLY a UI intent; native transport/Owner authentication belongs to #122.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { GuardRoleChoice } from "../../../server/role-message-guard-contract.js";
import type { GuardApprovalView } from "../role-message-guard-view.js";
export interface GuardApprovalIntent {
	readonly requestId: string;
	readonly generation: string;
	readonly questionId: string | null;
	readonly questionGeneration: string | null;
	readonly choice: GuardRoleChoice;
}
export function RoleMessageGuardApproval({
	view,
	onDecision,
	onClose,
}: {
	readonly view: GuardApprovalView;
	readonly onDecision: (intent: GuardApprovalIntent) => Promise<void>;
	readonly onClose: () => void;
}) {
	const id = useId();
	const dialog = useRef<HTMLElement>(null);
	const lock = useRef(false);
	const activeKey = useRef(view.key);
	activeKey.current = view.key;
	const [selected, setSelected] = useState<GuardRoleChoice | null>(null);
	const [pending, setPending] = useState(false);
	const [unknown, setUnknown] = useState(false);
	useEffect(() => {
		lock.current = false;
		setSelected(null);
		setPending(false);
		setUnknown(false);
		const previous = document.activeElement;
		dialog.current?.focus();
		return () => {
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, [view.key]);
	function close() {
		onClose();
	}
	async function submit() {
		if (lock.current || selected === null || !view.choices.some((c) => c.value === selected)) return;
		lock.current = true;
		const submittedKey = view.key;
		setPending(true);
		try {
			await onDecision({
				requestId: view.requestId,
				generation: view.generation,
				questionId: view.questionId,
				questionGeneration: view.questionGeneration,
				choice: selected,
			});
		} catch {
			if (activeKey.current === submittedKey) setUnknown(true); // Same identity query only; do not unlock and silently resend.
		}
	}
	return (
		<div className="role-guard-backdrop">
			<section
				ref={dialog}
				className="role-guard-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby={`${id}-title`}
				aria-describedby={`${id}-status ${id}-limits`}
				tabIndex={-1}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						close();
					}
					if (event.key === "Tab") {
						const targets = [
							...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []),
						].filter((element) =>
							element instanceof HTMLInputElement
								? element.checked ||
									(!dialog.current?.querySelector("input:checked") &&
										element === dialog.current?.querySelector("input"))
								: true,
						);
						const first = targets[0];
						const last = targets.at(-1);
						if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
							event.preventDefault();
							last?.focus();
						} else if (!event.shiftKey && document.activeElement === last) {
							event.preventDefault();
							first?.focus();
						}
					}
				}}
			>
				<header className="role-guard-header">
					<h2 id={`${id}-title`}>{view.title}</h2>
					<button type="button" className="role-guard-close" onClick={close}>
						{view.close}
					</button>
				</header>
				<p className="role-guard-tier">{view.tier}</p>
				<div id={`${id}-status`} className="role-guard-status" role="status" aria-live="polite" aria-atomic="true">
					<strong>{view.status}</strong>
					<p>{view.statusDetail}</p>
				</div>
				<p id={`${id}-limits`} className="role-guard-limits">
					{view.limits}
				</p>
				<div className="role-guard-context">
					{view.sections.map((section, index) => (
						<section key={section.label} aria-labelledby={`${id}-section-${index}`}>
							<h3 id={`${id}-section-${index}`}>{section.label}</h3>
							<ul>
								{section.values.map((value, i) => (
									<li key={i}>{value}</li>
								))}
							</ul>
						</section>
					))}
				</div>
				{view.choices.length > 0 && (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void submit();
						}}
					>
						<fieldset disabled={pending}>
							<legend>{view.legend}</legend>
							{view.choices.map((choice) => (
								<label className="role-guard-choice" key={choice.value}>
									<input
										type="radio"
										name={`${id}-choice`}
										value={choice.value}
										checked={selected === choice.value}
										onChange={() => setSelected(choice.value)}
										aria-describedby={`${id}-${choice.value}`}
									/>
									<span>
										<strong>{choice.label}</strong>
										<span id={`${id}-${choice.value}`} className="role-guard-choice-description">
											{choice.description}
										</span>
									</span>
								</label>
							))}
						</fieldset>
						<button
							className="role-guard-submit"
							type="submit"
							disabled={selected === null || pending}
							aria-busy={pending}
						>
							{view.submit}
						</button>
					</form>
				)}
				{(unknown || view.state === "unknown") && (
					<p role="alert" className="role-guard-error">
						{view.unknown}
					</p>
				)}
			</section>
		</div>
	);
}
