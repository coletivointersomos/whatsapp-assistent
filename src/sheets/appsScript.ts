export async function postAppsScriptRewrite(input: {
  url: string;
  token: string;
  tabName: string;
  values: string[][];
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; rowCount: number } | { ok: false; reason: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = JSON.stringify({
    token: input.token,
    tabName: input.tabName,
    values: input.values,
  });
  const headers = { "content-type": "application/json" };
  try {
    let response = await fetchImpl(input.url, { method: "POST", headers, body, redirect: "manual" });
    let hops = 0;
    while (response.status >= 300 && response.status < 400 && hops < 5) {
      const location = response.headers.get("location");
      if (!location) break;
      const next = new URL(location, input.url).href;
      hops += 1;
      response = await fetchImpl(next, { method: "GET", redirect: "manual" });
    }
    const raw = await response.text();
    if (!response.ok) return { ok: false, reason: `apps_script_http_${response.status}` };
    let parsed: { ok?: boolean; rowCount?: number; reason?: string };
    try {
      parsed = JSON.parse(raw) as { ok?: boolean; rowCount?: number; reason?: string };
    } catch {
      return { ok: false, reason: "apps_script_json_invalid" };
    }
    if (parsed.ok !== true) return { ok: false, reason: (parsed.reason ?? "apps_script_rejected").slice(0, 80) };
    return { ok: true, rowCount: Number(parsed.rowCount) || 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : "apps_script_failed";
    return { ok: false, reason: message.slice(0, 180) };
  }
}
