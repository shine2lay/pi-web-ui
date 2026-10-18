import { useT } from "../i18n";
import type { UsefulSpend } from "../roles-useful-model";

/** Display the existing role-reported tally; never infer a budget or claim to enforce it. */
export function RoleSpend({ spend, details = false }: { spend?: UsefulSpend | null; details?: boolean }) {
	const t = useT();
	return (
		<section className={`roles-spend${spend?.state === "over" ? " roles-spend-over" : ""}`}>
			<h3>{t("raSpend")}</h3>
			<p>{spend ? <q className="roles-useful-agent">{spend.line}</q> : t("raSpendUnknown")}</p>
			{spend?.state === "over" && spend.amounts && <p>{spend.amounts}</p>}
			{details && (
				<>
					<p className="roles-useful-note">{t("raSpendReported")}</p>
					{spend && spend.initiatives.length > 0 && (
						<ul>
							{spend.initiatives.map((row) => (
								<li key={row.id}>
									<q className="roles-useful-agent">{row.id}</q>
									{" · "}
									{row.amount}
								</li>
							))}
						</ul>
					)}
				</>
			)}
		</section>
	);
}
