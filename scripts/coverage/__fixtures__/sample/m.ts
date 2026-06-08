export function classify(n: number): string {
  if (n < 0) {
    return "negative";
  }
  const parity = n % 2 === 0 ? "even" : "odd";
  return n > 100 && parity === "even" ? "big-even" : parity;
}
