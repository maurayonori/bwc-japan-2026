import { readFileSync } from "node:fs";

export function readApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY?.trim())
    return process.env.ANTHROPIC_API_KEY.trim();
  if (process.env.ANTHROPIC_API_KEY_FILE) {
    try {
      return (
        readFileSync(process.env.ANTHROPIC_API_KEY_FILE, "utf8").trim() ||
        undefined
      );
    } catch {
      return undefined;
    }
  }
  return undefined;
}
