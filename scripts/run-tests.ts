#!/usr/bin/env bun
import { runCiTestSuite } from "./lib/ci-tests.ts";

await runCiTestSuite();
