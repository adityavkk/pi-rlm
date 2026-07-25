import { describe, expect, test } from "bun:test";

const PROBE_TIMEOUT_MS = 1_500;
const probePath = `${import.meta.dir}/quickjs.probe.ts`;

interface ProbePayload {
  readonly outcome?: { readonly kind: string; readonly error?: { readonly code: string }; readonly message?: string; readonly result?: unknown };
  readonly elapsedMs?: number;
  readonly aborted?: boolean;
  readonly callbackRan?: boolean;
  readonly sawAbortedSignal?: boolean;
  readonly first?: ProbePayload;
  readonly second?: ProbePayload;
}

const probe = async (mode: string): Promise<ProbePayload> => {
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, probePath, mode], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, PROBE_TIMEOUT_MS);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timeout);
  expect(timedOut, `${mode} exceeded ${PROBE_TIMEOUT_MS}ms`).toBe(false);
  expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS);
  expect(exitCode, `${mode} stderr:\n${stderr}`).toBe(0);
  return JSON.parse(stdout.trim()) as ProbePayload;
};

const expectBounded = (payload: ProbePayload): void => {
  expect(payload.elapsedMs).toBeNumber();
  expect(payload.elapsedMs!).toBeLessThan(500);
};

describe("QuickJsBackend subprocess lifecycle probes", () => {
  test("bounds an awaited never-settling host dispatch", async () => {
    const result = await probe("awaited-never");
    expectBounded(result);
    expect(result.outcome?.kind).toBe("terminal");
    expect(result.outcome?.error?.code).toBe("CPU_LIMIT");
    expect(result.aborted).toBe(true);
  }, 3_000);

  test("bounds and cleans up an unawaited never-settling host dispatch", async () => {
    const result = await probe("unawaited-never");
    expectBounded(result);
    expect(result.outcome?.kind).toBe("guest_error");
    expect(result.outcome?.message).toContain("UNAWAITED_WORK");
    expect(result.aborted).toBe(true);
  }, 3_000);

  test("interrupts malicious workspace Proxy readback", async () => {
    const result = await probe("workspace-proxy");
    expectBounded(result);
    expect(result.outcome?.kind).toBe("terminal");
    expect(result.outcome?.error?.code).toBe("CPU_LIMIT");
  }, 3_000);

  test("interrupts malicious workspace getter readback", async () => {
    const result = await probe("workspace-getter");
    expectBounded(result);
    expect(result.outcome?.kind).toBe("terminal");
    expect(result.outcome?.error?.code).toBe("CPU_LIMIT");
  }, 3_000);

  test("drops a callback that settles after disposal", async () => {
    const result = await probe("late-callback");
    expectBounded(result);
    expect(result.outcome?.kind).toBe("terminal");
    expect(result.outcome?.error?.code).toBe("CPU_LIMIT");
    expect(result.aborted).toBe(true);
    expect(result.callbackRan).toBe(true);
  }, 3_000);

  test("disposes a timed-out cell without poisoning the next runtime", async () => {
    const result = await probe("cleanup");
    expectBounded(result.first!);
    expect(result.first?.outcome?.kind).toBe("guest_error");
    expect(result.second?.outcome?.kind).toBe("value");
    expect(result.second?.outcome?.result).toBe(42);
    expect(result.aborted).toBe(true);
  }, 3_000);

  test("propagates host rejection into the guest", async () => {
    const result = await probe("host-rejection");
    expectBounded(result);
    expect(result.outcome?.kind).toBe("guest_error");
    expect(result.outcome?.message).toContain("host boom");
  }, 3_000);

  test("preserves normal async dispatch success", async () => {
    const result = await probe("normal-async");
    expectBounded(result);
    expect(result.outcome?.kind).toBe("value");
    expect(result.outcome?.result).toEqual({ ok: true });
    expect(result.sawAbortedSignal).toBe(false);
  }, 3_000);
});
