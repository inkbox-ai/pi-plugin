#!/usr/bin/env node
import { operatorError } from "../cli/errors.js";
import { main } from "../cli/index.js";

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // SDK errors can include a remote response body. Print only errors explicitly
  // intended for the operator, never raw request/response diagnostics.
  console.error(operatorError(error));
  process.exitCode = 1;
}
