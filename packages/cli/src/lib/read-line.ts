import { createInterface } from "node:readline/promises";

export type MakeInterface = typeof createInterface;

/**
 * One question, one trimmed answer. A fresh interface per question, closed every time: the
 * answer loop interleaves with clack's consent prompt, which takes stdin over in between.
 *
 * `output` is where the question is written. It defaults to stdout; a command whose stdout is a
 * machine-readable result (a JSON envelope) passes stderr so the question never lands in it.
 */
export async function readLine(
  question: string,
  make: MakeInterface = createInterface,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  const rl = make({ input: process.stdin, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
