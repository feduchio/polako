import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** True when this module is the process entry, including via `bin` shims and symlinks. */
export function isMainModule(metaUrl: string, argv1 = process.argv[1]): boolean {
  if (argv1 === undefined || argv1 === "") return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return metaUrl === pathToFileURL(argv1).href;
  }
}
