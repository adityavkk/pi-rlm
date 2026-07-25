import { writeFile } from "node:fs/promises";
import type { AgentSessionEvent, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createPublicRuntimeFixture, PUBLIC_FIXTURE_COMMAND } from "./public-runtime.ts";

const mode = process.argv[2] as "tui" | "rpc" | "json" | "print" | undefined;
const root = process.argv[3];
const statePath = process.argv[4];
if (!mode || !root || !statePath || !["tui", "rpc", "json", "print"].includes(mode))
  throw new Error("usage: public-binding-fixture <tui|rpc|json|print> <root> <state-path>");

const ui = {
  setStatus() {},
  notify() {},
  confirm: async () => true,
} as unknown as ExtensionUIContext;
const fixture = await createPublicRuntimeFixture(root);
const events: AgentSessionEvent[] = [];
let resolveEnd!: () => void;
const ended = new Promise<void>((resolve) => { resolveEnd = resolve; });
const unsubscribe = fixture.runtime.session.subscribe((event) => {
  events.push(event);
  if (event.type === "message_end"
    && (event.message as { customType?: string }).customType === "pi-rlm-result") resolveEnd();
});
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  await fixture.runtime.session.bindExtensions({ mode, uiContext: ui });
  await fixture.runtime.session.prompt(PUBLIC_FIXTURE_COMMAND, {
    source: mode === "rpc" ? "rpc" : "interactive",
  });
  await Promise.race([
    ended,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("custom message_end timeout")), 1_000);
    }),
  ]);
  const messages = events.flatMap((event) => {
    if (event.type !== "message_start" && event.type !== "message_end") return [];
    const message = event.message as { role?: string; customType?: string; content?: unknown };
    return message.role === "custom" && message.customType === "pi-rlm-result"
      ? [{ type: event.type, content: message.content }]
      : [];
  });
  const entries = fixture.sessionManager.getEntries().filter((entry) =>
    entry.type === "custom_message" && entry.customType === "pi-rlm-result");
  await writeFile(statePath, JSON.stringify({ captured: fixture.captured, messages, entries }), "utf8");
} finally {
  if (timeout) clearTimeout(timeout);
  unsubscribe();
  fixture.runtime.session.dispose();
}
