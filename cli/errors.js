export function problem(message) {
  return Object.assign(new Error(message), { operatorMessage: message });
}

export function operatorError(error) {
  if (error?.operatorMessage) return error.operatorMessage;
  if (error?.statusCode === 401)
    return "Inkbox did not accept the API key. Run inkbox-pi setup --replace-key or bootstrap --api-key-stdin.";
  if (error?.statusCode === 403)
    return "Inkbox denied this operation. Check the selected identity and its permissions.";
  if (error?.name === "InkboxConnectionError")
    return "Could not reach Inkbox. Check the configured API origin and network connection.";
  return "Command failed. Check your configuration and run inkbox-pi doctor.";
}
