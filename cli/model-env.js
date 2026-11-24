import { problem } from "./errors.js";

// A user may have credentials for several unrelated projects in their shell.
// Persist only the Pi model variables explicitly selected for this service.
const supported = new Set([
  "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "COPILOT_GITHUB_TOKEN", "MISTRAL_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY",
  "XAI_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY",
  "OPENCODE_API_KEY", "HF_TOKEN", "FIREWORKS_API_KEY", "TOGETHER_API_KEY",
  "BASETEN_API_KEY", "KIMI_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY",
  "MOONSHOT_API_KEY", "NVIDIA_API_KEY", "RADIUS_API_KEY", "META_API_KEY",
]);

export function modelEnvironment(env, previous = {}) {
  if (env.INKBOX_PI_MODEL_ENV === undefined) return previous;
  const selected = {};
  for (const name of env.INKBOX_PI_MODEL_ENV.split(",").map(s => s.trim()).filter(Boolean)) {
    if (!supported.has(name)) throw problem("INKBOX_PI_MODEL_ENV must name supported Pi model credential variables.");
    if (!env[name]) throw problem("A selected Pi model variable is not set in this shell: " + name);
    selected[name] = env[name];
  }
  return selected;
}
