// Fictional metadata cases, sealed tests only; never imported from web/.
import { FIELD_ROWS, missingFields, type FieldId, type NativeField, type NativeFields } from "../../web/src/roles-u0/fields.js";
import type { RtpiRef } from "../../server/rtpi-core.js";
export interface FieldCase {
  readonly id: FieldId;
  readonly missing: NativeField;
  readonly known: NativeField;
  readonly stale: NativeField;
  readonly unknown: NativeField;
}
const source = (id: FieldId): RtpiRef => ({ namespace: "rtpi-fixture", kind: "fixture", id: "field-" + id, revision: "1" });
export const ROW_CASES: readonly FieldCase[] = FIELD_ROWS.map(([id]) => ({
  id, missing: missingFields()[id],
  known: { state: "known", value: "Fictional " + id, source: source(id), asOf: "2026-10-11T12:46:10.000Z" },
  stale: { state: "last-known", value: "Fictional " + id, source: source(id), asOf: "2026-10-11T12:31:00.000Z" },
  unknown: { state: "unknown", reason: "incomplete prospective source index" },
}));
export function fixtureFields(which: "known" | "stale"): NativeFields {
  return Object.fromEntries(ROW_CASES.map(row => [row.id, row[which]])) as Record<FieldId, NativeField>;
}
