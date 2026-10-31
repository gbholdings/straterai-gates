import { mask } from "../privacy/mask";

export function peopleRow(p: { id: string; email: string; fullName: string; createdAt: Date }) {
  return {
    id: p.id,
    email: mask(p.email),
    // governance: export-ok the partner contract requires the full name on the invoice export
    fullName: p.fullName,
    createdAt: p.createdAt.toISOString(),
  };
}
