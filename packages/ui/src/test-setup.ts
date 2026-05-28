import "@testing-library/jest-dom";
import { vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: jest compat shim requires any
(globalThis as unknown as Record<string, unknown>).jest = vi as unknown as any;
