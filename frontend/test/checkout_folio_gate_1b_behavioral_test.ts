/**
 * CHECKOUT-FOLIO-GATE-1B — Static Source Assertion Test
 *
 * This test reads .ts/.tsx source files as plain text and asserts that
 * specific patterns exist (or do not exist) in the checkout modal code.
 *
 * What this test does NOT do:
 * - It does NOT mount or execute React components.
 * - It does NOT simulate browser events or user interaction.
 * - It does NOT prove runtime checkout behavior or branch coverage.
 * - It is NOT an integration or end-to-end test.
 *
 * Limitations:
 * - Passing assertions confirm the source code contains the expected patterns,
 *   but do not guarantee those code paths execute correctly at runtime.
 * - Coverage gaps (runtime execution, error branching) require live staging
 *   smoke testing for verification.
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
const policySrc = readFileSync(join(here, '../src/features/deposits/guaranteeScopePolicy.ts'), 'utf8');

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== CHECKOUT-FOLIO-GATE-1B FRONTEND BEHAVIORAL TEST (COMPREHENSIVE) ===\n');

// ─── A. Outstanding balance > 0 blocks BEFORE confirmation ────────────────────
console.log('--- A. Outstanding Balance Blocks Before Confirmation ---');
check(modalSrc.includes('authoritative_financials'), 'A.1 Uses authoritative_financials from backend');
check(modalSrc.includes('fin.remaining_balance') || modalSrc.includes('fin?.remaining_balance'), 'A.2 Reads remaining_balance from authoritative object');
check(modalSrc.includes("action: 'HARD_BLOCK_FOLIO_OUTSTANDING'"), 'A.3 Sets HARD_BLOCK_FOLIO_OUTSTANDING when balance > 0');
check(modalSrc.includes('folioBalance > 0.01') || modalSrc.includes('Number(fin.remaining_balance)'), 'A.4 Checks balance threshold');
check(!modalSrc.includes('fallbackFr'), 'A.5 No stale local balance fallback');
check(modalSrc.includes("action === 'HARD_BLOCK_FOLIO_OUTSTANDING'"), 'A.6 Renders hard block UI for outstanding balance');

// ─── B. remaining_balance = 0 proceeds to guarantee gate ───────────────────────
console.log('\n--- B. Zero Balance Proceeds to Guarantee Gate ---');
check(modalSrc.includes('FOLIO GATE takes precedence'), 'B.1 Folio gate documented as taking precedence');
check(modalSrc.includes("action === 'ALLOW'") || modalSrc.includes("decision.action === 'ALLOW'"), 'B.2 ALLOW action allows proceeding to guarantee');
check(modalSrc.includes("action === 'WARN_ROOM_DEPOSIT'") || modalSrc.includes("'WARN_ROOM_DEPOSIT'"), 'B.3 Room deposit warning preserved');
check(modalSrc.includes("action === 'WARN_FINAL_GROUP_GUARANTEE'") || modalSrc.includes("'WARN_FINAL_GROUP_GUARANTEE'"), 'B.4 Final group guarantee warning preserved');

// ─── C. Malformed/missing authoritative financials fails closed ───────────────
console.log('\n--- C. Malformed Authoritative Financials Fails Closed ---');
check(modalSrc.includes('folioError = true'), 'C.1 Sets folioError on malformed data');
check(modalSrc.includes('fin === null') || modalSrc.includes('fin == null') || modalSrc.includes('!fin'), 'C.2 Checks for null authoritative_financials');
check(modalSrc.includes("action: 'HARD_BLOCK_FOLIO_UNVERIFIED'"), 'C.3 Fails closed with HARD_BLOCK_FOLIO_UNVERIFIED');
check(modalSrc.includes('folioError &&') || modalSrc.indexOf('if (folioError)') < modalSrc.indexOf("action === 'ALLOW'"), 'C.4 Folio error checked before ALLOW decision');
check(modalSrc.includes('Number.isFinite(remainingBalance)') && modalSrc.includes('Number.isFinite(totalPrice)'), 'C.5 Number.isFinite guard on all authoritative financial fields');
check(!modalSrc.includes('totalCharges = Number.isFinite(tp)'), 'C.6 No silent zero-fallback for non-finite totalPrice');
check(!modalSrc.includes('appliedDeposit = Number.isFinite(ad)'), 'C.7 No silent zero-fallback for non-finite appliedDeposit');

// ─── D. Folio request/network error fails closed ──────────────────────────────
console.log('\n--- D. Network Error Fails Closed ---');
check(modalSrc.includes('catch (e)'), 'D.1 Has catch block for folio fetch');
check(modalSrc.includes('folioError = true'), 'D.2 Sets folioError on network failure');
check(modalSrc.includes('console.warn'), 'D.3 Logs warning on error');
check(!modalSrc.includes('fallbackFr') && !modalSrc.includes('Fallback to reservation'), 'D.4 No silent fallback on error');

// ─── E. "Buka Folio" targets #folio-section ───────────────────────────────────
console.log('\n--- E. Buka Folio Navigation ---');
check(appSrc.includes('handleOpenFolioSectionFromCheckout'), 'E.1 handleOpenFolioSectionFromCheckout defined');
check(appSrc.includes("'folio-section'") || appSrc.includes('"folio-section"'), 'E.2 Scrolls to folio-section');
check(modalSrc.includes('onOpenFolioSection'), 'E.3 Modal accepts onOpenFolioSection callback');
check(modalSrc.includes('Buka Folio'), 'E.4 Button labeled "Buka Folio"');

// ─── F. Guarantee behavior remains unchanged ───────────────────────────────────
console.log('\n--- F. Guarantee Behavior Preserved ---');
check(policySrc.includes("| 'HARD_BLOCK_ROOM_IDENTITY'"), 'F.1 HARD_BLOCK_ROOM_IDENTITY in policy');
check(policySrc.includes("| 'WARN_ROOM_DEPOSIT'"), 'F.2 WARN_ROOM_DEPOSIT in policy');
check(policySrc.includes("| 'WARN_FINAL_GROUP_GUARANTEE'"), 'F.3 WARN_FINAL_GROUP_GUARANTEE in policy');
check(policySrc.includes("| 'WARN_ROOM_AND_FINAL_GROUP'"), 'F.4 WARN_ROOM_AND_FINAL_GROUP in policy');
check(modalSrc.includes('deriveCheckoutGateDecision'), 'F.5 Calls deriveCheckoutGateDecision');
check(modalSrc.includes('guaranteeDecision'), 'F.6 Uses guaranteeDecision variable');

// ─── G. No stale local reservation balance fallback ───────────────────────────
console.log('\n--- G. No Stale Local Fallback ---');
check(!modalSrc.includes('reservationData?.remaining_balance'), 'G.1 Does not read remaining_balance from reservationData');
check(!modalSrc.includes('fallbackFr'), 'G.2 No fallbackFr variable');
check(!modalSrc.includes('Fallback to reservation'), 'G.3 No fallback-to-reservation logic');
check(modalSrc.includes('authoritative_financials'), 'G.4 Only reads from authoritative_financials');

// ─── H. Correct reservation child in multi-room booking ───────────────────────
console.log('\n--- H. Multi-room Child Isolation ---');
check(modalSrc.includes('targetId'), 'H.1 Uses targetId for folio fetch');
check(modalSrc.includes('reservationId') && modalSrc.includes('effectivePropId'), 'H.2 Passes reservationId and propertyId to evaluateData');
check(indexSrc.includes('sibling_reservations') || indexSrc.includes('siblingReservations'), 'H.3 Backend returns sibling_reservations');

// ─── I. Backend endpoint contract ─────────────────────────────────────────────
console.log('\n--- I. Backend Endpoint Contract ---');
check(indexSrc.includes("calculateReservationFinancials(pool,"), 'I.1 GET /folio calls calculateReservationFinancials');
check(indexSrc.includes('authoritative_financials: {'), 'I.2 Response includes authoritative_financials object');
check(indexSrc.includes('remaining_balance:'), 'I.3 remaining_balance in response');
check(indexSrc.includes('recalculateReservationFinancials'), 'I.4 recalculate preserved for POST /checkout');

// ─── K. No CLEAN_ALLOW mapping ────────────────────────────────────────────────
console.log('\n--- K. No CLEAN_ALLOW (Security Invariant) ---');
check(!modalSrc.includes("'CLEAN_ALLOW'"), 'K.1 CLEAN_ALLOW action string removed');
check(!modalSrc.includes("action === 'ALLOW' ? 'CLEAN_ALLOW'"), 'K.2 No ALLOW→CLEAN_ALLOW mapping');
check(!modalSrc.includes('guaranteeDecision.action ==='), 'K.3 No decision.action reassignment');

// ─── L. Processing-State UX — Modal Immutability During Checkout Mutation ──────
console.log('\n--- L. Processing-State Immutability ---');
check(modalSrc.includes('handleModalClose'), 'L.1 Guarded onClose refactored to handleModalClose');
check(modalSrc.includes('if (submitting) return;'), 'L.2 handleModalClose guards against close while submitting');
check(modalSrc.includes('closeOnOverlayClick={submitting ? false : undefined}'), 'L.3 Overlay click disabled during submitting on ALLOW modal');
check(modalSrc.includes('closeOnEscape={submitting ? false : undefined}'), 'L.4 Escape key disabled during submitting on ALLOW modal');
check(modalSrc.includes('closeOnCloseClick={submitting ? false : undefined}'), 'L.5 X close button disabled during submitting on ALLOW modal');
check(modalSrc.includes('onClick={handleModalClose}') || modalSrc.includes('onClick={handleModalClose}'), 'L.6 Batal button uses guarded handleModalClose in ALLOW modal');
check(modalSrc.includes("onClose={handleModalClose}") || modalSrc.includes('onClose={handleModalClose}'), 'L.7 ALLOW modal passes handleModalClose as onClose to Modal component');
check(modalSrc.includes("'WARN_ROOM_DEPOSIT'") && modalSrc.split("'WARN_ROOM_DEPOSIT'")[1]?.includes('onClose={handleModalClose}') || modalSrc.includes("onClose={handleModalClose}"), 'L.8 WARN_ROOM_DEPOSIT uses handleModalClose');
check(modalSrc.includes("'WARN_FINAL_GROUP_GUARANTEE'") && modalSrc.split("'WARN_FINAL_GROUP_GUARANTEE'")[1]?.includes('onClose={handleModalClose}') || modalSrc.includes("onClose={handleModalClose}"), 'L.9 WARN_FINAL_GROUP_GUARANTEE uses handleModalClose');
check(modalSrc.includes("'WARN_ROOM_AND_FINAL_GROUP'") && modalSrc.split("'WARN_ROOM_AND_FINAL_GROUP'")[1]?.includes('onClose={handleModalClose}') || modalSrc.includes("onClose={handleModalClose}"), 'L.10 WARN_ROOM_AND_FINAL_GROUP uses handleModalClose');
check(modalSrc.includes("'Memproses…'") || modalSrc.includes('Memproses'), 'L.11 Submit-capable modals show Memproses… while submitting');

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n=== TEST COMPLETE — ${assertions} assertions passed ===\n`);
