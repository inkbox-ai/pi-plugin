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
    confirm: async (message) =>
      /^(y|yes)$/i.test((await rl.question(message + " [y/N]: ")).trim()),
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
