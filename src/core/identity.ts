/** Stable, non-secret identity supplied by effectful runtime components. */

import type { JsonValue } from "./json.ts";

/** Implementation id/version plus canonical instance configuration. */
export interface RuntimeComponentIdentity {
  readonly id: string;
  readonly version: string;
  readonly configuration: JsonValue;
}
