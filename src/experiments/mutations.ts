import ts from "typescript";

export interface Mutant {
  operator: string;
  /** 1-based line of the mutated node in the original source. */
  line: number;
  /** What changed, e.g. `< -> <=`. */
  change: string;
  source: string;
}

const BINARY_SWAPS: Partial<Record<ts.SyntaxKind, { to: ts.SyntaxKind; operator: string }>> = {
  [ts.SyntaxKind.LessThanToken]: { to: ts.SyntaxKind.LessThanEqualsToken, operator: "swap-comparison" },
  [ts.SyntaxKind.LessThanEqualsToken]: { to: ts.SyntaxKind.LessThanToken, operator: "swap-comparison" },
  [ts.SyntaxKind.GreaterThanToken]: { to: ts.SyntaxKind.GreaterThanEqualsToken, operator: "swap-comparison" },
  [ts.SyntaxKind.GreaterThanEqualsToken]: { to: ts.SyntaxKind.GreaterThanToken, operator: "swap-comparison" },
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: { to: ts.SyntaxKind.ExclamationEqualsEqualsToken, operator: "swap-equality" },
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: { to: ts.SyntaxKind.EqualsEqualsEqualsToken, operator: "swap-equality" },
  [ts.SyntaxKind.AmpersandAmpersandToken]: { to: ts.SyntaxKind.BarBarToken, operator: "swap-logical" },
  [ts.SyntaxKind.BarBarToken]: { to: ts.SyntaxKind.AmpersandAmpersandToken, operator: "swap-logical" },
  [ts.SyntaxKind.PlusToken]: { to: ts.SyntaxKind.MinusToken, operator: "swap-arithmetic" },
  [ts.SyntaxKind.MinusToken]: { to: ts.SyntaxKind.PlusToken, operator: "swap-arithmetic" },
  [ts.SyntaxKind.AsteriskToken]: { to: ts.SyntaxKind.SlashToken, operator: "swap-arithmetic" },
  [ts.SyntaxKind.SlashToken]: { to: ts.SyntaxKind.AsteriskToken, operator: "swap-arithmetic" },
  [ts.SyntaxKind.PlusEqualsToken]: { to: ts.SyntaxKind.MinusEqualsToken, operator: "swap-arithmetic" },
};

/**
 * Every single-site mutant of `source` the operators produce: comparison, equality, logical and
 * arithmetic swaps, a removed negation, an integer off by one, a flipped boolean, and min/max
 * swapped. Operators follow oh-my-pi's `typescript-edit-benchmark` (MIT); each mutant is one
 * textual replacement at one node, found by the TypeScript parser rather than by pattern.
 */
export function mutantsOf(source: string, fileName = "module.mjs"): Mutant[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: Mutant[] = [];
  const replace = (start: number, end: number, text: string, operator: string, change: string) => {
    out.push({
      operator,
      line: file.getLineAndCharacterOfPosition(start).line + 1,
      change,
      source: `${source.slice(0, start)}${text}${source.slice(end)}`,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const swap = BINARY_SWAPS[node.operatorToken.kind];
      if (swap !== undefined) {
        const from = node.operatorToken.getText(file);
        const to = ts.tokenToString(swap.to) ?? from;
        replace(node.operatorToken.getStart(file), node.operatorToken.getEnd(), to, swap.operator, `${from} -> ${to}`);
      }
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      replace(node.getStart(file), node.operand.getStart(file), "", "remove-negation", "! removed");
    }
    if (ts.isNumericLiteral(node) && /^\d+$/.test(node.text)) {
      const value = Number(node.text);
      replace(node.getStart(file), node.getEnd(), String(value + 1), "off-by-one", `${node.text} -> ${String(value + 1)}`);
      if (value > 0) replace(node.getStart(file), node.getEnd(), String(value - 1), "off-by-one", `${node.text} -> ${String(value - 1)}`);
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      const to = node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true";
      replace(node.getStart(file), node.getEnd(), to, "flip-boolean", `${node.getText(file)} -> ${to}`);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Math" && (node.name.text === "min" || node.name.text === "max")) {
      const to = node.name.text === "min" ? "max" : "min";
      replace(node.name.getStart(file), node.name.getEnd(), to, "swap-min-max", `Math.${node.name.text} -> Math.${to}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}
