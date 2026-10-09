/** Id curto de registro operacional. OpenWA manda `false_{chat}_{serial}_{lid}`. */
export function operationalRecordId(externalId: string): string {
  const chunks = externalId.match(/[0-9A-Fa-f]{16,}/g) ?? [];
  const serial = chunks.find((chunk) => /[A-Fa-f]/.test(chunk)) ?? chunks.at(-1);
  if (serial) return `reg-${serial.slice(0, 24)}`;
  const safe = externalId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  return `reg-${safe || "msg"}`;
}
