import { describe, expect, test } from "bun:test";
import {
  acquireLeaf,
  budgetView,
  createLedger,
  type BudgetLimits,
  openFrame,
  releaseBytes,
  releaseLeaf,
  reserveAttempt,
  reserveBytes,
  reserveControllerTurn,
  reserveLogicalCall,
  settleAttempt,
} from "./budget.ts";

const limits: BudgetLimits = {
  maxDepth: 2,
  maxFrames: 3,
  maxLogicalCalls: 2,
  maxAttempts: 3,
  maxControllerTurns: 2,
  maxConcurrency: 1,
  tokenLimit: 1000,
  storedByteLimit: 500,
  deadlineMs: 10_000,
};

describe("budget ledger", () => {
  test("depth and frame limits", () => {
    const l = createLedger(limits);
    expect(openFrame(l, 3).ok).toBe(false); // exceeds maxDepth 2
    let cur = l;
    for (let i = 0; i < 3; i++) {
      const r = openFrame(cur, 1);
      expect(r.ok).toBe(true);
      if (r.ok) cur = r.value;
    }
    const over = openFrame(cur, 1);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe("BUDGET_FRAMES");
  });

  test("logical calls and attempts exhaust with correct codes", () => {
    let l = createLedger(limits);
    const c1 = reserveLogicalCall(l, 0);
    const c2 = reserveLogicalCall(c1.ok ? c1.value : l, 0);
    expect(c1.ok && c2.ok).toBe(true);
    const c3 = reserveLogicalCall(c2.ok ? c2.value : l, 0);
    expect(c3.ok).toBe(false);
    if (!c3.ok) expect(c3.error.code).toBe("BUDGET_CALLS");

    l = createLedger({ ...limits, maxAttempts: 1 });
    const a1 = reserveAttempt(l, 0, 10);
    const a2 = reserveAttempt(a1.ok ? a1.value : l, 0, 10);
    expect(a2.ok).toBe(false);
    if (!a2.ok) expect(a2.error.code).toBe("BUDGET_ATTEMPTS");
  });

  test("token reservation and settlement", () => {
    const l = createLedger({ ...limits, tokenLimit: 50 });
    const a = reserveAttempt(l, 0, 40);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const over = reserveAttempt(a.value, 0, 20); // 40+20 > 50
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe("BUDGET_TOKENS");
    const settled = settleAttempt(a.value, 40, 30);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.usage.tokensReserved).toBe(0);
    expect(settled.value.usage.tokensUsed).toBe(30);
  });

  test("settlement rejects unsafe or over-reservation usage without changing the ledger", () => {
    const reserved = reserveAttempt(createLedger(limits), 0, 40);
    if (!reserved.ok) throw new Error("reservation failed");
    const before = JSON.stringify(reserved.value);
    for (const actual of [41, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
      const settled = settleAttempt(reserved.value, 40, actual);
      expect(settled).toMatchObject({ ok: false, error: { code: "INVALID_RESULT" } });
      expect(JSON.stringify(reserved.value)).toBe(before);
    }
  });

  test("deadline blocks reservations", () => {
    const l = createLedger({ ...limits, deadlineMs: 100 });
    const r = reserveLogicalCall(l, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("BUDGET_DEADLINE");
  });

  test("byte reservation and rollback", () => {
    const l = createLedger({ ...limits, storedByteLimit: 100 });
    const r = reserveBytes(l, 60);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(reserveBytes(r.value, 60).ok).toBe(false);
      expect(releaseBytes(r.value, 60).usage.storedBytes).toBe(0);
    }
  });

  test("controller turns exhaust", () => {
    let l = createLedger({ ...limits, maxControllerTurns: 1 });
    const t1 = reserveControllerTurn(l, 0);
    expect(t1.ok).toBe(true);
    if (t1.ok) l = t1.value;
    const t2 = reserveControllerTurn(l, 0);
    expect(t2.ok).toBe(false);
    if (!t2.ok) expect(t2.error.code).toBe("CONTROLLER_TURNS_EXHAUSTED");
  });

  test("leaf concurrency saturates then releases", () => {
    const l = createLedger({ ...limits, maxConcurrency: 1 });
    const first = acquireLeaf(l);
    expect(first).not.toBe("saturated");
    if (first === "saturated") return;
    expect(acquireLeaf(first)).toBe("saturated");
    const released = releaseLeaf(first);
    expect(released.usage.activeLeafCalls).toBe(0);
  });

  test("view reports remaining", () => {
    const v = budgetView(createLedger(limits), 1);
    expect(v.logicalCallsRemaining).toBe(2);
    expect(v.reportedTokenLimit).toBe(1000);
    expect(v.depth).toBe(1);
  });
});
