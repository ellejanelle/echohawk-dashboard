// Minimal .env loader — no third-party dependency. Never logs key values; never prints .env contents.
import { readFileSync, existsSync } from "node:fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    // Match KEY=value lines; skip comments and blank lines; strip inline comments.
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) {
      // Strip surrounding quotes from value (single or double)
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
