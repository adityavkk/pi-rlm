import { describe, expect, test } from "bun:test";
import { collectResults, err, flatMapResult, isErr, isOk, mapErr, mapResult, ok, unwrapOr } from "./result.ts";

describe("result", () => {
  test("ok/err construction and guards", () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(err("e"))).toBe(true);
    expect(isOk(err("e"))).toBe(false);
  });

  test("map only transforms ok", () => {
    expect(mapResult(ok(2), (n) => n * 3)).toEqual(ok(6));
    expect(mapResult(err<string>("e"), (n: number) => n * 3)).toEqual(err("e"));
  });

  test("mapErr only transforms err", () => {
    expect(mapErr(err("e"), (s) => `${s}!`)).toEqual(err("e!"));
    expect(mapErr(ok(2), (s: string) => `${s}!`)).toEqual(ok(2));
  });

  test("flatMap chains", () => {
    const half = (n: number) => (n % 2 === 0 ? ok(n / 2) : err("odd"));
    expect(flatMapResult(ok(8), half)).toEqual(ok(4));
    expect(flatMapResult(ok(7), half)).toEqual(err("odd"));
  });

  test("unwrapOr and collect", () => {
    expect(unwrapOr(err("e"), 9)).toBe(9);
    expect(collectResults([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
    expect(collectResults([ok(1), err("bad"), ok(3)])).toEqual(err("bad"));
  });
});
