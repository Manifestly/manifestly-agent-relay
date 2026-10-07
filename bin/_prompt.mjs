import readline from "node:readline";
import { Writable } from "node:stream";

// Hidden prompt. The label goes straight to stdout rather than through
// readline, so the mute cannot swallow it on the way out.
export function hidden(label) {
  return new Promise((resolve) => {
    const muted = new Writable({
      write(chunk, encoding, done) {
        if (!muted.hide) process.stdout.write(chunk, encoding);
        done();
      },
    });
    process.stdout.write(`${label}: `);
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    muted.hide = true;
    rl.question("", (answer) => {
      process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function apiKey() {
  return process.env.OPENAI_API_KEY?.trim() || (await hidden("OpenAI API key (hidden)"));
}
