import { describe, expect, test } from "bun:test";
import { MockModelClient } from "./mock.ts";

describe("MockModelClient", () => {
  test("routes requests to the handler and counts calls", async () => {
    const client = new MockModelClient((req) => `echo:${req.prompt}`);
    const r = await client.complete({ prompt: "hi" });
    expect(r.text).toBe("echo:hi");
    expect(r.usage.totalTokens).toBeGreaterThanOrEqual(1);
    expect(client.callCount).toBe(1);
  });
});
