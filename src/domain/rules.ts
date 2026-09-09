export const PAUSE_MS = 15 * 60 * 1000;

export const ABASTECIMENTO_REQUIRED = [
  "date",
  "liters",
  "totalBrl",
  "place",
  "payment",
] as const;

export const DESPESA_REQUIRED = ["date", "amountBrl", "description", "payment"] as const;

export const VIAGEM_REQUIRED = [
  "date",
  "origin",
  "destination",
  "material",
  "quantity",
  "unit",
] as const;

export function addMinutes(from: Date, minutes: number): Date {
  return new Date(from.getTime() + minutes * 60 * 1000);
}

export function isPauseActive(
  silenceUntilIso: string | undefined,
  now: Date,
): boolean {
  if (!silenceUntilIso) return false;
  return now.getTime() < Date.parse(silenceUntilIso);
}

export function isSuspensionCovering(
  start: string,
  end: string,
  now: Date,
  status: string,
): boolean {
  if (status !== "aplicada") return false;
  const t = now.getTime();
  return t >= Date.parse(start) && t <= Date.parse(end + "T23:59:59.999Z");
}

export function dayIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
