export function problem(message) {
  return Object.assign(new Error(message), { operatorMessage: message });
}
