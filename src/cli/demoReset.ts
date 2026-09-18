import { loadState, saveState } from "../persistence/store.ts";
import { applyDemoSessionReset, backupStoreFile } from "../domain/demoSession.ts";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function main() {
  const args = process.argv.slice(2);
  const file = flag(args, "--file") ?? process.env.STORE_PATH ?? "data/store.json";
  const conversationId =
    flag(args, "--conversation") ?? process.env.TEST_GROUP_JID ?? "";
  const dryRun = has(args, "--dry-run");
  if (!conversationId) {
    console.log("skip=true");
    console.log("reason=missing_test_group");
    process.exitCode = 1;
    return;
  }
  const state = loadState(file);
  const startedAt = new Date();
  const preview = applyDemoSessionReset(structuredClone(state), conversationId, startedAt);
  console.log("conversation_set", Boolean(conversationId));
  console.log("dry_run", dryRun);
  console.log("would_archive", preview.archived);
  console.log("demo_started_at", preview.startedAt);
  if (dryRun) return;
  const backup = backupStoreFile(file, startedAt);
  console.log("backup", backup ? "yes" : "none");
  const applied = applyDemoSessionReset(state, conversationId, startedAt);
  saveState(file, state);
  console.log("archived", applied.archived);
}

main();
