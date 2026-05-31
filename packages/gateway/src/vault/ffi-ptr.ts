import type { Pointer } from "bun:ffi";

export function addressAsPointer(addr: number | bigint): Pointer {
  const n = typeof addr === "bigint" ? Number(addr) : addr;
  return n as unknown as Pointer;
}
