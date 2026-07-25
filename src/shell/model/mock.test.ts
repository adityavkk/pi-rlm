import { describe, expect, test } from "bun:test";
import { MockModelClient } from "./mock.ts";

const modelIdentity = (fixture: string) => ({ id: "test/mock-model-handler", version: "1", configuration: { fixture } } as const);

describe("MockModelClient", () => {
  test("routes requests to the handler and counts calls", async () => {
    const client = new MockModelClient((req) => `echo:${req.prompt}`, modelIdentity("src/shell/model/mock.test.ts:6"));
    const r = await client.complete({ prompt: "hi" });
    expect(r.text).toBe("echo:hi");
    expect(r.usage.totalTokens).toBeGreaterThanOrEqual(1);
    expect(client.callCount).toBe(1);
  });
});
