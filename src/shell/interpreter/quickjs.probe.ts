import { transformCell } from "../../core/cell.ts";
import type { JsonValue } from "../../core/json.ts";
import type { HostDispatch } from "./backend.ts";
import { QuickJsBackend } from "./quickjs.ts";

const mode = process.argv[2];
const backend = await QuickJsBackend.create();

const run = async (code: string, dispatch: HostDispatch, wallMs = 80) => {
  const transformed = transformCell(code);
  if (!transformed.ok) throw new Error(transformed.error.message);
  const started = Date.now();
  const outcome = await backend.evalCell({
    source: transformed.value.source,
    deadlineMs: started + wallMs,
    memoryBytes: 64 * 1024 * 1024,
    globals: {
      objective: "probe",
      inputs: {},
      variables: {},
      budget: {},
      workspace: {},
    },
    dispatch,
    effect: () => {},
  });
  return { outcome, elapsedMs: Date.now() - started };
};

try {
  switch (mode) {
    case "awaited-never": {
      let aborted = false;
      const result = await run("await llm({ key: 'k', prompt: 'p' });\n1", async (_name, _args, signal) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        return new Promise<never>(() => {});
      });
      console.log(JSON.stringify({ ...result, aborted }));
      break;
    }
    case "unawaited-never": {
      let aborted = false;
      const result = await run("llm({ key: 'k', prompt: 'p' });\n1", async (_name, _args, signal) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        return new Promise<never>(() => {});
      });
      console.log(JSON.stringify({ ...result, aborted }));
      break;
    }
    case "workspace-proxy": {
      const result = await run("workspace = new Proxy({}, { ownKeys() { while (true) {} } });\n1", async () => null);
      console.log(JSON.stringify(result));
      break;
    }
    case "workspace-getter": {
      const result = await run("Object.defineProperty(workspace, 'x', { enumerable: true, get() { while (true) {} } });\n1", async () => null);
      console.log(JSON.stringify(result));
      break;
    }
    case "late-callback": {
      let aborted = false;
      let callbackRan = false;
      const result = await run("await llm({ key: 'k', prompt: 'p' });\n1", async (_name, _args, signal) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        return new Promise<JsonValue>((resolve) => {
          setTimeout(() => {
            callbackRan = true;
            resolve("late");
          }, 100);
        });
      }, 30);
      await new Promise((resolve) => setTimeout(resolve, 130));
      console.log(JSON.stringify({ ...result, aborted, callbackRan }));
      break;
    }
    case "cleanup": {
      let aborted = false;
      const first = await run("llm({ key: 'k', prompt: 'p' });\n1", async (_name, _args, signal) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        return new Promise<never>(() => {});
      });
      const second = await run("40 + 2", async () => null);
      console.log(JSON.stringify({ first, second, aborted }));
      break;
    }
    case "host-rejection": {
      const result = await run("await llm({ key: 'k', prompt: 'p' })", async () => {
        throw new Error("host boom");
      });
      console.log(JSON.stringify(result));
      break;
    }
    case "normal-async": {
      let sawAbortedSignal = false;
      const result = await run("await llm({ key: 'k', prompt: 'p' })", async (_name, _args, signal) => {
        sawAbortedSignal = signal.aborted;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true };
      });
      console.log(JSON.stringify({ ...result, sawAbortedSignal }));
      break;
    }
    default:
      throw new Error(`unknown probe mode: ${String(mode)}`);
  }
} finally {
  await backend.dispose();
}
