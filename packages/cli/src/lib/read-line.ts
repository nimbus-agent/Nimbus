import { createInterface } from "node:readline/promises";

export type MakeInterface = typeof createInterface;

/**
 * One question, one trimmed answer. A fresh interface per question, closed every time: the
 * answer loop interleaves with clack's consent prompt, which takes stdin over in between.
 */
export async function readLine(
  question: string,
  make: MakeInterface = createInterface,
): Promise<string> {
  const rl = make({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
