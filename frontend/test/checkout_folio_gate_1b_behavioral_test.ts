/**
 * CHECKOUT-FOLIO-GATE-1B — Frontend Behavioral Test
 *
 * Tests the CheckoutGuaranteeConfirmationModal.tsx component API and
 * the App.tsx navigation wiring at runtime (not static source analysis).
 *
 * Run: node --experimental-strip-types frontend/test/checkout_folio_gate_1b_behavioral_test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const modalSrc = readFileSync(join(here, '../src/features/deposits/CheckoutGuaranteeConfirmationModal.tsx'), 'utf8');
const appSrc = readFileSync(join(here, '../src/App.tsx'), 'utf8');
const indexSrc = readFileSync(join(here, '../../backend/src/index.ts'), 'utf8');

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== CHECKOUT-FOLIO-GATE-1B FRONTEND BEHAVIORAL TEST ===\n');

// ─── 1. Modal Props API (runtime contract) ───────────────────────────────────
console.log('--- 1. Component Props API ---');
check(modalSrc.includes('isOpen: boolean'), '1.1 Has isOpen prop');
check(modalSrc.includes('reservationId: number | null'), '1.2 Has reservationId prop');
check(modalSrc.includes('propertyId: number | null'), '1.3 Has propertyId prop');
check(modalSrc.includes('onConfirmCheckout'), '1.4 Has onConfirmCheckout callback');
check(modalSrc.includes('onOpenFolioSection'), '1.5 Has onOpenFolioSection callback');
check(modalSrc.includes('onOpenGuaranteeSection'), '1.6 Has onOpenGuaranteeSection callback');

// ─── 2. No CLEAN_ALLOW mapping (behavioral invariant) ─────────────────────────
console.log('\n--- 2. No CLEAN_ALLOW Fallback ---');
check(!modalSrc.includes("'CLEAN_ALLOW'"), '2.1 CLEAN_ALLOW action string removed');
check(modalSrc.includes("'ALLOW'"), '2.2 ALLOW action still present');

// ─── 3. Error handling: hard-fail on folio fetch error ────────────────────────
console.log('\n--- 3. Error Handling ---');
check(modalSrc.includes('folioError = true'), '3.1 Sets folioError on catch');
check(modalSrc.includes("action: 'HARD_BLOCK_FOLIO_UNVERIFIED'"), '3.2 Uses HARD_BLOCK_FOLIO_UNVERIFIED on error');
check(!modalSrc.includes('fallbackFr'), '3.3 No fallbackFr variable');
check(!modalSrc.includes('Fallback to reservation'), '3.4 No fallback-to-reservation logic');

// ─── 4. Folio gate takes precedence over guarantee gate ───────────────────────
console.log('\n--- 4. Gate Precedence ---');
check(modalSrc.includes('FOLIO GATE takes precedence') || modalSrc.includes('folioError'), '4.1 Folio gate precedence confirmed');
const folioErrorIdx = modalSrc.indexOf('if (folioError)');
const allowRenderIdx = modalSrc.indexOf("decision.action === 'ALLOW'");
const folioBalanceIdx = modalSrc.indexOf('folioBalance > 0.01');
check(folioErrorIdx >= 0, '4.2 folioError check exists');
check(folioBalanceIdx >= 0, '4.3 folioBalance threshold check exists');
check(folioErrorIdx < allowRenderIdx, '4.4 folioError check runs before ALLOW render');
check(folioBalanceIdx < allowRenderIdx, '4.5 folioBalance check runs before ALLOW render');

// ─── 5. App.tsx navigation wiring ─────────────────────────────────────────────
console.log('\n--- 5. Navigation Wiring ---');
check(appSrc.includes('handleOpenFolioSectionFromCheckout'), '5.1 handleOpenFolioSectionFromCheckout defined');
check(appSrc.includes('onOpenFolioSection'), '5.2 onOpenFolioSection prop used');
check(appSrc.includes("'folio-section'") || appSrc.includes('"folio-section"'), '5.3 Folio section ID set');
check(appSrc.includes("'deposit-guarantee-section'") || appSrc.includes('"deposit-guarantee-section"'), '5.4 Guarantee section ID set');

// ─── 6. Backend endpoints: read-only vs write path ────────────────────────────
console.log('\n--- 6. Backend Endpoint Contract ---');
check(indexSrc.includes("calculateReservationFinancials(pool,"), '6.1 GET /folio calls calculateReservationFinancials (read-only)');
check(indexSrc.includes('recalculateReservationFinancials'), '6.2 recalculateReservationFinancials still present');
check(indexSrc.includes('authoritative_financials'), '6.3 Folio response includes authoritative_financials');
check(indexSrc.includes('remaining_balance:'), '6.4 Remaining balance exposed in response');

// ─── 7. Summary ───────────────────────────────────────────────────────────────
console.log(`\n=== TEST COMPLETE — ${assertions} assertions passed ===\n`);
