import { readFileSync } from "node:fs";
import { join } from "node:path";

// npm always includes package.json in the tarball, so this reads the running
// installation's version both in a checkout and in node_modules.
export const { version: VERSION }: { version: string } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
);
