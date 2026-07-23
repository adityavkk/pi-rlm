/** Concrete sha256 Hasher for the pure core, plus a byte-length helper. */

import { createHash } from "node:crypto";
import type { Hasher } from "../core/ids.ts";

export const sha256: Hasher = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

export const sha256Bytes = (input: Uint8Array): string => createHash("sha256").update(input).digest("hex");
