/** The launcher that runs `hunch task verify` from THIS installation, not a
 * potentially stale global binary. Core, not mcp: the prompt hook prints the
 * command inline (so the model needs no hunch_task start call just to learn it)
 * and a hook must never pull in the MCP SDK. */
import { fileURLToPath, pathToFileURL } from "node:url";

/** Structured argv is authoritative; the shell hint uses literal quoting. */
export function verificationLauncher(): { argv: string[]; shell: string } {
  return verificationLauncherFor(import.meta.url, (specifier) => import.meta.resolve(specifier));
}

/** `metaUrl` is the module running (a `.ts` source checkout needs the tsx
 * loader; a published `.js` build needs nothing) and `resolve` is that
 * module's `import.meta.resolve`. Callers in sibling directories (src/core,
 * src/mcp) resolve the same `../cli/index.{ts|js}`, but each must pass ITS OWN
 * import.meta so the dev/published discrimination stays honest. The loader is
 * resolved ONLY on the source path: `import.meta.resolve` throws for a package
 * that is not installed, and `tsx` is a devDependency absent from every
 * published install (#261). */
export function verificationLauncherFor(metaUrl: string, resolve: (specifier: string) => string): { argv: string[]; shell: string } {
  const dev = metaUrl.endsWith(".ts");
  const entry = fileURLToPath(new URL(`../cli/index.${dev ? "ts" : "js"}`, metaUrl));
  // `--import` takes a URL. Converting the resolved loader to a path made Node on
  // Windows reject it ("Received protocol 'c:'"), so every verification launched
  // from a source checkout there failed before running and cards showed no check.
  const loader = dev ? resolve("tsx") : null;
  const argv = [process.execPath, ...(loader ? ["--import", loader.startsWith("file:") ? loader : pathToFileURL(loader).href] : []), entry];
  const quote = (s: string) => process.platform === "win32" ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`;
  return { argv, shell: `${process.platform === "win32" ? "& " : ""}${argv.map(quote).join(" ")}` };
}
