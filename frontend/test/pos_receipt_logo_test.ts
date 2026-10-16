/**
 * POS Receipt — broken-logo regression test.
 *
 * Root cause yang dibuktikan:
 *  - branding.logo_url di DB/property API adalah managed storage key
 *    ("branding/{propertyId}/logo/{uuid}.png"), BUKAN public URL.
 *  - Memakai raw storage key sebagai <img src> membuat browser meminta
 *    path statis yang tidak ada → SPA fallback → HTML, naturalWidth=0.
 *  - Fix: resolve managed key ke endpoint resmi
 *    /api/properties/{propertyId}/branding/logo/logo (getLogoServeUrl),
 *    dengan fallback ke URL legacy non-managed.
 *
 * NOTE: getLogoServeUrl di-test dengan sumber asli via transpile in-memory
 * karena import graph propertyBrandingApi.ts (extensionless relative imports)
 * tidak dapat di-strip Node 24 ESM.
 *
 * Run:
 *   cd frontend && node test/pos_receipt_logo_test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Transpile propertyBrandingApi.ts → ESM .js (no type syntax) ─────────
// Write a temporary .js module alongside fixed import specifiers so that
// Node's ESM loader can import it.  The transpiled JS keeps only the
// synchronous getLogoServeUrl function; async fns are stubbed out.
async function loadGetLogoServeUrl(): Promise<(k: string | null | undefined, p?: number) => string | null> {
  const src = readFileSync(
    resolve(__dirname, '../src/features/propertySettings/propertyBrandingApi.ts'),
    'utf8',
  );

  let js = src;

  // 1. Remove type-only import lines
  js = js.replace(/^import\s+type\s+[^\n]*\n/gm, '');

  // 2. Replace all import statements with stubs (the only value import is
  //    getFallbackPropertyBranding + authenticatedFetch — both only used in
  //    async fns that are never called in this test).
  js = js.replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"]\s*\n?/gm, '');

  // 3. Stub the two external names that the remaining async fns reference.
  js += '\n';
  js += 'function getFallbackPropertyBranding(a, b, c) { return { propertyId: a, displayName: b, shortName: c, logoUrl: null, compactLogoUrl: null, primaryColor: "#1b4332", accentColor: "#c5a880", tagline: "stub" }; }\n';
  js += 'const authenticatedFetch = () => { throw new Error("stub — not needed in this test"); };\n';

  // 4. Remove TS type annotations:
  //    - function return types: `) : Type {` → `) {`
  js = js.replace(/\)\s*:\s*[\w<>\[\]| ,&]+\s*\{/g, ') {');
  //    - parameter type annotations (simple regex per function)
  js = js.replace(
    /(function\s+\w+\(\s*)([^)]*?)(\)\s*\{)/g,
    (_m, pre, params, post) => {
      const stripped = params
        .split(',')
        .map((p: string) => p.trim().replace(/^(\w+)\??:\s*[\w<>\[\]| ,&]+$/, (_mm: string, name: string) => name.replace(/\?$/, '')))
        .filter((p: string) => p.length > 0)
        .join(', ');
      return pre + stripped + post;
    },
  );

  // 5. Write to temp dir as .js so Node loads it as raw ESM (no type-stripping)
  const dir = mkdtempSync(join(tmpdir(), 'pos-receipt-logo-test-'));
  try {
    const outFile = join(dir, 'propertyBrandingApi.js');
    writeFileSync(outFile, js, 'utf8');
    const mod = await import(pathToFileURL(outFile).href);
    return mod.getLogoServeUrl;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Mirror of the EXACT resolution rule applied in PosThermalReceiptContent.tsx:
 *   raw null/undefined/empty  -> null
 *   raw starts with "branding/" (managed key):
 *     getLogoServeUrl(raw, propertyId) returns a URL  -> that URL
 *     getLogoServeUrl returns null (malformed / scope mismatch) -> null
 *     (raw managed key is NEVER used as <img src>)
 *   raw is non-managed (legacy absolute/relative URL) -> raw
 */
async function resolveReceiptLogoUrl(
  raw: string | null | undefined,
  propertyId: number,
): Promise<string | null> {
  if (!raw) return null;
  if (raw.startsWith('branding/')) {
    const getLogoServeUrl = await loadGetLogoServeUrl();
    return getLogoServeUrl(raw, propertyId);
  }
  return raw;
}

console.log('=== POS Receipt Logo URL Resolution Tests ===\n');

// ── R1: managed key → official serve endpoint ────────────────────────────
console.log('--- R1: managed key "branding/1/logo/x.png" ---');
{
  const url = await resolveReceiptLogoUrl(
    'branding/1/logo/abcdef12-0000-4000-8000-000000000000.png',
    1,
  );
  check(
    url === '/api/properties/1/branding/logo/logo?v=abcdef12-0000-4000-8000-000000000000',
    'R1 property id 1 → /api/properties/1/branding/logo/logo?v=<uuid>',
  );
  check(
    url !== 'branding/1/logo/abcdef12-0000-4000-8000-000000000000.png',
    'R1 raw storage key TIDAK pernah menjadi img src',
  );
}

// ── R2: managed key, compact variant ────────────────────────────────────
console.log('\n--- R2: managed compact key "branding/42/compact/y.jpg" ---');
{
  const url = await resolveReceiptLogoUrl('branding/42/compact/y.jpg', 42);
  check(
    url === '/api/properties/42/branding/logo/compact?v=y',
    'R2 compact variant → /api/properties/42/branding/logo/compact?v=y',
  );
}

// ── R3: managed key with property scope mismatch → null ────────────────
console.log('\n--- R3: key scoped to property 7 but receipt says property 9 ---');
{
  const url = await resolveReceiptLogoUrl('branding/7/logo/z.webp', 9);
  check(
    url === null,
    'R3 managed key scope mismatch → null (raw storage key TIDAK dipakai sebagai img src)',
  );
  check(
    url !== 'branding/7/logo/z.webp',
    'R3 raw key "branding/7/logo/z.webp" TIDAK BOLAH muncul sebagai hasil',
  );
}

// ── R3b: malformed managed key → null ───────────────────────────────────
console.log('\n--- R3b: malformed managed key "branding/abc/logo/x.png" ---');
{
  // "abc" is not an integer property id → getLogoServeUrl returns null
  const url = await resolveReceiptLogoUrl('branding/abc/logo/x.png', 9);
  check(
    url === null,
    'R3b malformed managed key (property id non-integer) → null',
  );
}

// ── R3c: managed key with property 0 (invalid) → null ���────────────────
console.log('\n--- R3c: managed key with invalid property id 0 ---');
{
  const url = await resolveReceiptLogoUrl('branding/0/logo/x.png', 9);
  check(
    url === null,
    'R3c managed key property id 0 (non-integer match) → null',
  );
}

// ── R4: null / undefined logo → null (no broken img rendered) ─────────
console.log('\n--- R4: null / undefined logo_url ---');
{
  check((await resolveReceiptLogoUrl(null, 1)) === null, 'R4 null → null (img tidak dirender)');
  check((await resolveReceiptLogoUrl(undefined, 1)) === null, 'R4 undefined → null');
}

// ── R5: legacy absolute URL (non-managed) stays untouched ──────────────
console.log('\n--- R5: legacy absolute URL compatibility ---');
{
  const legacy = 'https://hims.oaklawang.com/uploads/logos/old-logo.png';
  const url = await resolveReceiptLogoUrl(legacy, 3);
  check(
    url === legacy,
    'R5 absolute legacy URL dipertahankan (getLogoServeUrl returns null → fallback raw)',
  );
}

// ── R6: legacy relative upload path (non-managed) stays untouched ──────
console.log('\n--- R6: legacy relative URL "/uploads/logos/x.png" ---');
{
  const legacy = '/uploads/logos/x.png';
  const url = await resolveReceiptLogoUrl(legacy, 3);
  check(
    url === legacy,
    'R6 relative legacy path dipertahankan',
  );
}

// ── R7: resolver function contract + property 5 sanity ─────────────────
console.log('\n--- R7: resolver contract ---');
{
  check(typeof resolveReceiptLogoUrl === 'function', 'R7 resolver adalah fungsi async');
  const url = await resolveReceiptLogoUrl('branding/5/logo/w.png', 5);
  check(
    url === '/api/properties/5/branding/logo/logo?v=w',
    'R7 property 5 → /api/properties/5/branding/logo/logo?v=w',
  );
}

console.log('\n[RESULT] ' + assertions + ' PASS, 0 FAIL');
console.log('[CLEANUP/RESIDUE] 0 — tidak ada fixture DB.');
