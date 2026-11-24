#!/usr/bin/env node
import { main } from "../cli/index.js";

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // SDK errors can include a remote response body. Print only errors explicitly
  // intended for the operator, never raw request/response diagnostics.
  console.error(error?.operatorMessage || "Command failed. Check your configuration and run inkbox-pi doctor.");
  process.exitCode = 1;
}
