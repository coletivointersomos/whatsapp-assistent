/**
 * Caminhão/motorista acompanhado na folha de pagamento (antes fixo em TFA7A94/Manoel/setembro).
 * Vem do ambiente; o padrão mantém o comportamento atual.
 *   MONITORED_PLATE=TFA7A94
 *   MONITORED_DRIVER=Manoel
 *   MONITORED_PLATE_OCR_ALIASES=TFA7A54   (leituras de OCR do papel que são a mesma placa)
 */
export type MonitoredVehicle = {
  plate: string;
  driver: string;
  ocrAliases: string[];
};

const DEFAULT_PLATE = "TFA7A94";
const DEFAULT_DRIVER = "Manoel";
const DEFAULT_ALIASES = "TFA7A54";

function compact(raw?: string): string {
  return (raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function loadMonitoredVehicle(env: Record<string, string | undefined> = process.env): MonitoredVehicle {
  const plate = compact(env.MONITORED_PLATE) || DEFAULT_PLATE;
  const driver = (env.MONITORED_DRIVER ?? "").trim() || DEFAULT_DRIVER;
  const aliasRaw = env.MONITORED_PLATE_OCR_ALIASES ?? (plate === DEFAULT_PLATE ? DEFAULT_ALIASES : "");
  const ocrAliases = aliasRaw
    .split(/[,;\s]+/)
    .map(compact)
    .filter((item) => item && item !== plate);
  return { plate, driver, ocrAliases };
}

let cached: MonitoredVehicle | undefined;

/** Leitura preguiçosa do ambiente (funções puras de planilha não recebem config). */
export function monitoredVehicle(): MonitoredVehicle {
  cached ??= loadMonitoredVehicle();
  return cached;
}

/** Só para testes. */
export function setMonitoredVehicleForTest(value?: MonitoredVehicle): void {
  cached = value;
}

export function isMonitoredDriverName(name: string | undefined, vehicle: MonitoredVehicle = monitoredVehicle()): boolean {
  const norm = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const target = norm(vehicle.driver).trim();
  return Boolean(target) && norm(name ?? "").includes(target);
}
