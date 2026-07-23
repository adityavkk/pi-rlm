import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { normalizeProgram, type RlmProgram } from "../core/program.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import { ModelController } from "./model-controller.ts";
import { runProgram } from "./run.ts";

let backend: QuickJsBackend;
beforeAll(async () => {
  backend = await QuickJsBackend.create();
});

const singleInput = (): RlmProgram => {
  const r = normalizeProgram({
    objective: "echo the first bytes of the input",
    profile: "default",
    inputs: [{ name: "context", adapter: "text", description: "source" }],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!r.ok) throw new Error("program");
  return r.value;
};

describe("ModelController drives a real controller loop offline", () => {
  test("emits one cell that reads input and answers", async () => {
    const cells = [
      JSON.stringify({ reasoning: "read 3 bytes then answer", code: "const t = await input.read({ lengthBytes: 3 }); answer({ answer: t.text }); 'done'" }),
    ];
    let i = 0;
    const controllerModel = new MockModelClient(() => cells[i++] ?? JSON.stringify({ reasoning: "stop", code: "" }));
    const result = await runProgram({
      program: singleInput(),
      sources: { context: "ABCDE" },
      controller: new ModelController(controllerModel),
      model: new MockModelClient(() => "unused"),
      backend,
      dir: await mkdtemp(join(tmpdir(), "pi-rlm-mc-")),
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "ABC" });
  });

  test("repairs a non-JSON controller response once", async () => {
    const outputs = ["this is not json", JSON.stringify({ reasoning: "answer now", code: "answer({ answer: 'ok' }); 'x'" })];
    let i = 0;
    const controllerModel = new MockModelClient(() => outputs[i++] ?? "still not json");
    const result = await runProgram({
      program: singleInput(),
      sources: { context: "ABCDE" },
      controller: new ModelController(controllerModel),
      model: new MockModelClient(() => "unused"),
      backend,
      dir: await mkdtemp(join(tmpdir(), "pi-rlm-mc-")),
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "ok" });
    expect(controllerModel.callCount).toBe(2); // original + one repair
  });
});
