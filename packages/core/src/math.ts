/** Arithmetic only. Anything other than numbers and + - * / ( ) is rejected. */
export function evaluateMath(expression: string): number | null {
  const source = expression.replace(/,/g, "").replace(/\s+/g, "");
  if (!source || source.length > 200 || !/^[\d+\-*/().]+$/.test(source)) return null;
  let index = 0;

  const peek = () => source[index] ?? "";

  const parseExpression = (): number | null => {
    let left = parseTerm();
    if (left == null) return null;
    while (peek() === "+" || peek() === "-") {
      const op = peek();
      index += 1;
      const right = parseTerm();
      if (right == null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  };

  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left == null) return null;
    while (peek() === "*" || peek() === "/") {
      const op = peek();
      index += 1;
      const right = parseFactor();
      if (right == null || (op === "/" && right === 0)) return null;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  };

  const parseFactor = (): number | null => {
    if (peek() === "+" || peek() === "-") {
      const sign = peek() === "-" ? -1 : 1;
      index += 1;
      const value = parseFactor();
      return value == null ? null : sign * value;
    }
    if (peek() === "(") {
      index += 1;
      const value = parseExpression();
      if (value == null || peek() !== ")") return null;
      index += 1;
      return value;
    }
    const start = index;
    while (/[\d.]/.test(peek())) index += 1;
    if (index === start) return null;
    const text = source.slice(start, index);
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  };

  const value = parseExpression();
  if (value == null || index !== source.length || !Number.isFinite(value)) return null;
  return value;
}

/** Spoken result of a calculate tool call. */
export function speakMath(expression: string): string {
  const value = evaluateMath(expression);
  if (value == null) return "I couldn't calculate that. Use numbers with plus, minus, times, and divide.";
  const rounded = Math.round((value + Number.EPSILON) * 1000) / 1000;
  const text = Object.is(rounded, -0) ? "0" : String(rounded);
  return `That's ${text}.`;
}
