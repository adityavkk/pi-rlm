/** Deterministic in-process model client for tests and offline runs. */

import type { RuntimeComponentIdentity } from "../../core/identity.ts";
import type { CallUsage } from "../../core/usage.ts";
import type { ModelClient, ModelRequest, ModelResponse } from "./client.ts";

export type MockHandler = (request: ModelRequest) => string | ModelResponse;

const defaultUsage = (text: string): CallUsage => ({
  attempts: 1,
  inputTokens: 0,
  outputTokens: Math.ceil(text.length / 4),
  totalTokens: Math.ceil(text.length / 4),
  durationMs: 0,
});

export class MockModelClient implements ModelClient {
  readonly id = "mock-model";
  private calls = 0;
  constructor(
    private readonly handler: MockHandler,
    readonly identity: RuntimeComponentIdentity,
  ) {}

  get callCount(): number {
    return this.calls;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    const result = this.handler(request);
    if (typeof result === "string") return { text: result, usage: defaultUsage(result) };
    return result;
  }
}
