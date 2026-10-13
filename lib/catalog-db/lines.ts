import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import readline from "node:readline";

/**
 * Reads a feed file (.gz or plain text) line by line.
 * LAZY on purpose: nothing is opened until the first line is requested. A readline interface that is created early
 * starts emitting lines at once, and any line emitted before a `for await` begins is silently LOST. The loader
 * connects to the database and creates tables before it starts reading, so an eager reader dropped the header and
 * the first thousands of cars (it then saw a car row where the header should be).
 */
export async function* readLines(file: string): AsyncGenerator<string> {
  const raw = createReadStream(file);
  const input = file.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    raw.destroy();
  }
}
