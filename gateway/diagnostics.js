import { problem } from "../cli/errors.js";

const descriptions = {
  "pi-binary":
    "Pi could not start. Check INKBOX_PI_BIN, PATH, and the configured project directory.",
  "pi-model":
    "No usable Pi model was selected. Select a model in Pi before starting the gateway.",
  "pi-auth":
    "Pi model credentials are unavailable. Log in with Pi or configure the model credential for this service.",
  "pi-timeout": "Pi timed out. Check the model connection and configuration.",
  "pi-incomplete": "Pi returned an incomplete or interrupted answer.",
  "pi-protocol":
    "Pi returned an unexpected response. Check the installed Pi version.",
  "pi-turn":
    "Pi could not complete its turn. Check model access with inkbox-pi doctor.",
};

export function hostProblem(category) {
  return Object.assign(problem(descriptions[category]), { category });
}

export function failureCategory(error, fallback = "gateway") {
  if (Object.hasOwn(descriptions, error?.category)) return error.category;
  const code = error?.statusCode;
  if (Number.isInteger(code) && code >= 400 && code <= 599)
    return "inkbox-http-" + code;
  if (error?.name === "InkboxConnectionError") return "inkbox-connection";
  if (error?.code === "ENOSPC") return "storage-full";
  if (error?.code === "EACCES" || error?.code === "EPERM")
    return "permission-denied";
  return fallback;
}

export function startupProblem(stage, error) {
  if (error?.operatorMessage) return error;
  if (error?.code === "EADDRINUSE")
    return problem(
      "The local gateway port is already in use. Stop the other listener or choose another port.",
    );
  return problem(
    "Gateway " +
      stage +
      " failed (" +
      failureCategory(error) +
      "). Check the selected identity and configuration with inkbox-pi doctor.",
  );
}
