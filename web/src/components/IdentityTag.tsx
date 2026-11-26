/**
 * identities: the small tag that shows a chat's identity (pi-identity) by its title.
 *
 * Used in the chat list (running chats and History, inside the row title) and in the chat header.
 * In the header it's a button (onClick opens the identity menu); in the list it's a plain span —
 * the row itself is the button there.
 * department-specialists (Ops #1101): in a specialist's task chat the header tag also carries the specialist's
 * chip (`identity.specialist`, set for the header only); the chat list never shows it (§4.4).
 */
import type { MouseEvent } from "react";
import { useT } from "../i18n";
import type { UiChatIdentity } from "../types";
import type { SpecialistChatIdentity } from "../specialist-chip";
import { SpecialistChip } from "./SpecialistChip";

export function IdentityTag({
	identity,
	onClick,
	className,
}: {
	identity: UiChatIdentity & SpecialistChatIdentity;
	/** Given = the tag is a button (the chat header). */
	onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
	className?: string;
}) {
	const t = useT();
	const tip = t("identityTagTip", { title: identity.title, id: identity.id });
	const cls = `identity-tag${className ? ` ${className}` : ""}`;
	if (onClick)
		return (
			<button
				type="button"
				className={`${cls} identity-tag-btn`}
				title={tip}
				aria-label={tip}
				aria-haspopup="menu"
				data-identity={identity.id}
				onClick={onClick}
			>
				<span aria-hidden="true">👤</span>
				<span className="identity-tag-title">{identity.title}</span>
				{identity.specialist && (
					<SpecialistChip
						task={{ specialist: identity.specialist.slug, launch: { specialist: identity.specialist } }}
					/>
				)}
			</button>
		);
	return (
		<span className={cls} title={tip} data-identity={identity.id}>
			{identity.title}
		</span>
	);
}
