/**
 * Guest cell validation and transform (pure).
 *
 * Each cell is ES2023 JavaScript. We parse with acorn, reject module syntax,
 * dynamic import, `import.meta`, `with`, and direct `eval`, then rewrite a
 * trailing expression statement into an implicit return so the controller sees
 * a REPL-style value. The result is an async IIFE expression string the
 * interpreter backend evaluates; lexical declarations stay cell-local.
 */

import { parse } from "acorn";
import { type InterpreterError, interpreterError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

const asNode = (value: unknown): AstNode | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? (value as AstNode) : undefined;
};

/** Visit every AST node depth-first. The visitor may return a rejection reason. */
const walk = (root: AstNode, visit: (node: AstNode) => string | undefined): string | undefined => {
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as AstNode;
    const reason = visit(node);
    if (reason) return reason;
    for (const value of Object.values(node as unknown as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const child = asNode(item);
          if (child) stack.push(child);
        }
      } else {
        const child = asNode(value);
        if (child) stack.push(child);
      }
    }
  }
  return undefined;
};

const FORBIDDEN: Record<string, string> = {
  ImportDeclaration: "import statements are not allowed",
  ImportExpression: "dynamic import() is not allowed",
  ExportNamedDeclaration: "export statements are not allowed",
  ExportDefaultDeclaration: "export statements are not allowed",
  ExportAllDeclaration: "export statements are not allowed",
  WithStatement: "with statements are not allowed",
  MetaProperty: "import.meta is not allowed",
};

const rejectionFor = (node: AstNode): string | undefined => {
  const forbidden = FORBIDDEN[node.type];
  if (forbidden) return forbidden;
  if (node.type === "CallExpression") {
    const callee = (node as unknown as { callee?: unknown }).callee;
    const calleeNode = asNode(callee);
    if (calleeNode?.type === "Identifier" && (callee as { name?: unknown }).name === "eval")
      return "direct eval() is not allowed";
  }
  return undefined;
};

export interface CellTransform {
  readonly source: string;
  readonly hasResultExpression: boolean;
}

/**
 * Validate and transform a cell into an async IIFE expression string.
 * On failure returns a terminal PARSE_ERROR (guest cannot catch it).
 */
export const transformCell = (code: string): Result<CellTransform, InterpreterError> => {
  let program: AstNode;
  try {
    program = parse(code, {
      ecmaVersion: 2023,
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: false,
    }) as unknown as AstNode;
  } catch (error) {
    return err(interpreterError("PARSE_ERROR", (error as Error).message));
  }

  const rejection = walk(program, rejectionFor);
  if (rejection) return err(interpreterError("PARSE_ERROR", rejection));

  const body = (program as unknown as { body?: unknown[] }).body ?? [];
  const last = body.length > 0 ? asNode(body[body.length - 1]) : undefined;

  if (last && last.type === "ExpressionStatement") {
    const expression = asNode((last as unknown as { expression?: unknown }).expression);
    if (expression) {
      const prefix = code.slice(0, expression.start);
      const exprSource = code.slice(expression.start, expression.end);
      const source = `(async () => {\n"use strict";\n${prefix}\n;return (\n${exprSource}\n);\n})()`;
      return ok({ source, hasResultExpression: true });
    }
  }

  const source = `(async () => {\n"use strict";\n${code}\n})()`;
  return ok({ source, hasResultExpression: false });
};
