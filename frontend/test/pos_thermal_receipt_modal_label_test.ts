/**
 * POS Thermal Receipt Modal — label regression test.
 *
 * Akar masalah yang dibuktikan test ini:
 *  - Button label "Cetak" dan "Coba Lagi" pada PosThermalReceiptModal.tsx
 *    pernah mengandung literal backslash-u escape sequence (mis.
 *    `\ud83d\ud` atau `\ud83d\udd04`) yang render sebagai teks mojibake
 *    di UI, bukan emoji yang benar.
 *  - Test ini scan sumber modal dan memastikan:
 *    (a) tidak ada literal `\uXXXX` escape sequence tersisa di file,
 *    (b) button label "Cetak" dan "Coba Lagi" hadir sebagai teks polos.
 *
 * Run:
 *   cd frontend && node test/pos_thermal_receipt_modal_label_test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const modalPath = resolve(
  __dirname,
  '../src/features/thermalReceipt/PosThermalReceiptModal.tsx',
);
const src = readFileSync(modalPath, 'utf8');

console.log('=== POS Thermal Receipt Modal Label Tests ===\n');

// ── L1: no literal backslash-u escape sequences anywhere in modal ───────
console.log('--- L1: no \\uXXXX literal escapes in modal source ---');
{
  // Match literal backslash followed by "u" and 4 hex digits.
  // In the source file the bytes are: \ u d 8 3 d  (6 chars, not an
  // actual JS escape — they are plain text in a JSX text node).
  const re = /\\u[0-9a-fA-F]{4}/g;
  const matches = src.match(re);
  check(
    matches === null,
    'L1 tidak ada literal \\uXXXX escape di PosThermalReceiptModal.tsx',
  );
  if (matches) {
    console.error('[L1] matches:', matches);
  }
}

// ── L2: "Cetak" button label present as clean text ──────────────────────
console.log('\n--- L2: "Cetak" button label present as clean text ---');
{
  // Find the print button block and confirm the label is exactly "Cetak"
  // (not prefixed with any escape-garbage).
  const cetakOk = />\s*Cetak\s*</.test(src);
  check(cetakOk, 'L2 button label "Cetak" hadir sebagai teks polos');
}

// ── L3: "Coba Lagi" retry button label present as clean text ────────────
console.log('\n--- L3: "Coba Lagi" button label present as clean text ---');
{
  const retryOk = />\s*Coba Lagi\s*</.test(src);
  check(retryOk, 'L3 button label "Coba Lagi" hadir sebagai teks polos');
}

// ── L4: no emoji surrogate pairs that would indicate broken escaping ───
console.log('\n--- L4: no stray surrogate characters in modal source ---');
{
  // A broken escape like `\ud83d\ud` leaves the LONE high surrogate
  // U+D83D as a lone (unpaired) char in the source.  Legitimate emoji in
  // source would be a *paired* surrogate.  We assert there are no
  // characters in the high-surrogate range at all.
  const hasLoneHigh = /[\uD800-\uDBFF]/.test(src);
  check(
    !hasLoneHigh,
    'L4 tidak ada karakter high-surrogate (U+D800-U+DBFF) di sumber modal',
  );
}

console.log(
  '\n[RESULT] ' + assertions + ' PASS, 0 FAIL',
);
console.log('[CLEANUP/RESIDUE] 0 — tidak ada fixture DB.');
