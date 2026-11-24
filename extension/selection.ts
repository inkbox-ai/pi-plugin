import type { RegisteredTool } from "./tools/types.ts";

export function isToolEnabled(
  tool: RegisteredTool,
  enable: Set<string>,
  disable: Set<string>,
): boolean {
  if (disable.has(tool.name)) return false;
  if (enable.has(tool.name)) return true;
  if (tool.sensitive) return false;
  if (disable.has(tool.group)) return false;
  if (enable.has(tool.group)) return true;
  if (disable.has("all")) return false;
  if (enable.has("all")) return true;
  return tool.defaultEnabled;
}
