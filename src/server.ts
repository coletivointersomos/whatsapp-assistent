import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfig, startupIssues, describeSendMode } from "./runtime/config.ts";
import { createAppServer, logStartup } from "./runtime/http.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultChannel = join(root, "config/channel.example.json");

const runtime = loadRuntimeConfig(process.env, { defaultChannelFile: process.env.CHANNEL_FILE || defaultChannel });
const issues = startupIssues(runtime);
if (issues.length) {
  for (const issue of issues) {
    console.error(JSON.stringify({ event: "startup_refused", ...issue }));
  }
  process.exit(1);
}

logStartup(runtime);
console.error(describeSendMode(runtime));

const { server } = createAppServer(runtime);
server.listen(runtime.port, "0.0.0.0", () => {
  console.error(JSON.stringify({ event: "listening", port: runtime.port, path: "/webhook" }));
});
