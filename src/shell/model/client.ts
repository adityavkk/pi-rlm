/** Model client boundary. The broker owns schema validation and budgeting; the
 * client only performs one completion and reports usage. */

import type { JsonObject } from "../../core/json.ts";
import type { CallUsage } from "../../core/usage.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly context?: readonly string[];
  readonly schema?: JsonObject;
  readonly maxOutputTokens?: number;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly signal?: AbortSignal;
}

export interface ModelResponse {
  readonly text: string;
  readonly usage: CallUsage;
}

export interface ModelClient {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
