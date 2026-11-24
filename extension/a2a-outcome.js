// Only the gateway selects the task and performs its transition. The model
// supplies a disposition and user-facing text, never an identity or task ID.
export const A2A_RESPONSE_INSTRUCTIONS = [
  "This is an inbound A2A task. Return a single JSON object with exactly two fields: intent and text.",
  'Use {"intent":"complete","text":"..."} for a final answer, "ask_caller" for a question that must be answered before continuing, or "fail" when the task cannot be fulfilled.',
  "Always give the caller meaningful text. Do not return [SILENT] for an A2A task.",
].join(" ");

export function parseA2AOutcome(answer) {
  const text = answer.trim();
  if (!text || text === "[SILENT]") throw new Error("An A2A task requires an outcome.");
  const fenced = /^\x60\x60\x60(?:json)?\s*\n([\s\S]+?)\n\x60\x60\x60$/i.exec(text);
  let value;
  try { value = JSON.parse(fenced?.[1] ?? text); } catch { /* A plain final answer is supported. */ }
  if (value !== null && typeof value === "object" && Object.hasOwn(value, "intent")) {
    if (!["complete", "ask_caller", "fail"].includes(value.intent) || typeof value.text !== "string" ||
        !value.text.trim() || Object.keys(value).length !== 2) {
      throw new Error("Invalid A2A task outcome.");
    }
    return { intent: value.intent, text: value.text.trim() };
  }
  return { intent: "complete", text };
}
