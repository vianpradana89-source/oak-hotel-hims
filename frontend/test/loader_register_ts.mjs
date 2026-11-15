// test/loader_register_ts.mjs — register a synchronous ESM resolve hook so
// that Node's --experimental-strip-types mode can import the project's
// extensionless relative TS modules (e.g. "./calendarApi" -> "./calendarApi.ts").
//
// This is LOAD infrastructure only: it does not duplicate or alter any
// application logic. Dynamically import it BEFORE dynamically importing any
// src module that uses extensionless relative imports (static imports are
// resolved before this module's code can run).
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function pathToFileUrl(p) {
  const resolved = p.replace(/\\/g, '/');
  return `file://${resolved.startsWith('/') ? '' : '/'}${resolved}`;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Only intercept relative specifiers with no file extension.
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !/\.[a-z]+$/i.test(specifier)
    ) {
      const parent = context.parentURL ?? pathToFileUrl(process.cwd() + '/');
      const base = new URL(specifier, parent);
      for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs']) {
        const candidate = new URL(base.href + ext);
        let candidatePath;
        try {
          candidatePath = fileURLToPath(candidate);
        } catch {
          continue;
        }
        if (existsSync(candidatePath)) {
          return nextResolve(candidate.href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
