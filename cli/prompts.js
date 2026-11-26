import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export function prompts() {
  let hidden = false;
  const output = new Writable({
    write(bytes, _encoding, done) {
      if (!hidden) process.stdout.write(bytes);
      done();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: true,
    historySize: 0,
  });
  return {
    print: console.log,
    ask: async (message) => (await rl.question(message + ": ")).trim(),
    confirm: async (message, fallback = false) => {
      const answer = (
        await rl.question(message + (fallback ? " [Y/n]: " : " [y/N]: "))
      ).trim();
      return answer ? /^(y|yes)$/i.test(answer) : fallback;
    },
    async secret(message) {
      process.stdout.write(message + ": ");
      hidden = true;
      try {
        return (await rl.question("")).trim();
      } finally {
        hidden = false;
        process.stdout.write("\n");
      }
    },
    close: () => rl.close(),
  };
}
