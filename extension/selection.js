/**
 * @param {import("./tools/types.ts").RegisteredTool} tool
 * @param {Set<string>} enable
 * @param {Set<string>} disable
 */
export function isToolEnabled(tool, enable, disable) {
  if (disable.has(tool.name)) return false;
  if (enable.has(tool.name)) return true;
  if (tool.sensitive) return false;
  if (disable.has(tool.group)) return false;
  if (enable.has(tool.group)) return true;
  if (disable.has("all")) return false;
  if (enable.has("all")) return true;
  return tool.defaultEnabled;
}
