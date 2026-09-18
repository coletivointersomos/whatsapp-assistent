/** Id curto de registro operacional. OpenWA manda `false_{chat}_{serial}_{lid}`. */
export function operationalRecordId(externalId: string): string {
  const hex = externalId.match(/([0-9A-Fa-f]{16,})/);
  if (hex) return `reg-${hex[1].slice(0, 24)}`;
  const safe = externalId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  return `reg-${safe || "msg"}`;
}
