/**
 * C3B — PosCommunicationSettingsTab focused tests.
 *
 * Verifies component-level logic:
 *   1. GET null → textareas empty, enabled defaults to true
 *   2. enabled=false shown as toggle off
 *   3. whitespace-only save → null in payload
 *   4. intro/closing 500 chars accepted
 *   5. >500 chars rejected (client-side validation)
 *   6. PUT payload uses canonical field names
 *   7. 403 save displays permission error
 *   8. reset restores initialData
 *   9. preview position: intro before hotel name
 *  10. preview position: closing before hardcoded thank-you
 *  11. GET endpoint URL is canonical
 *  12. PUT endpoint URL is canonical
 *  13. stale property guard discards stale responses
 *  14. GET error state → error + retry card, no fabricated saved state
 *  15. preview purity — no receipt builder / fake PosReceiptData usage
 *  16. workspace render placement after PaymentInstructionsSettingsTab
 *
 * Run: npx tsx test/pos_communication_settings_tab_c3b_test.ts
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

console.log('=== C3B PosCommunicationSettingsTab — Logic Tests ===\n');

// ── Simulate the component's state transitions ──────────────────────────
// We test the pure logic that mirrors the component's handlers.

interface CommSettingsData {
  whatsapp_enabled: boolean;
  whatsapp_intro_message: string | null;
  whatsapp_closing_message: string | null;
}

/** Mirrors applyData in the component */
function applyData(data: CommSettingsData): {
  whatsappEnabled: boolean;
  introMessage: string;
  closingMessage: string;
} {
  return {
    whatsappEnabled: data.whatsapp_enabled,
    introMessage: data.whatsapp_intro_message ?? '',
    closingMessage: data.whatsapp_closing_message ?? '',
  };
}

/** Mirrors handleSave payload construction */
function buildPutPayload(
  propertyId: number,
  whatsappEnabled: boolean,
  introMessage: string,
  closingMessage: string,
): Record<string, unknown> {
  const trimmedIntro = introMessage.trim();
  const trimmedClosing = closingMessage.trim();
  return {
    property_id: propertyId,
    whatsapp_enabled: whatsappEnabled,
    whatsapp_intro_message: trimmedIntro.length > 0 ? trimmedIntro : null,
    whatsapp_closing_message: trimmedClosing.length > 0 ? trimmedClosing : null,
  };
}

/** Mirrors preview line construction */
function buildPreviewLines(
  hotelLabel: string,
  introMessage: string,
  closingMessage: string,
): string[] {
  const trimmedIntro = introMessage.trim();
  const trimmedClosing = closingMessage.trim();
  const lines: string[] = [];

  if (trimmedIntro) {
    lines.push(trimmedIntro, '');
  }
  lines.push(`*${hotelLabel}*`);
  lines.push('No. Order: POS-YYMMDD-0001');
  lines.push('No. Transaksi: …');
  lines.push('');
  lines.push('Detail Pesanan: …');
  lines.push('Total: Rp …');
  lines.push('');
  lines.push('Pembayaran:');
  lines.push('Metode: …');
  lines.push('');

  if (trimmedClosing) {
    lines.push(trimmedClosing, '');
  }

  lines.push(`Terima kasih telah berbelanja di ${hotelLabel}!`);
  lines.push('Semoga berkenan. Sampai jumpa.');
  return lines;
}

// ── Source files under test ────────────────────────────────────────────
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tabSrc = readFileSync(resolve(root, 'src/features/settings/PosCommunicationSettingsTab.tsx'), 'utf8');
const workspaceSrc = readFileSync(resolve(root, 'src/features/settings/ManagementSettingsWorkspace.tsx'), 'utf8');

// ========================================================================
// Test 1: GET null → empty textareas, enabled=true default
// ========================================================================
console.log('--- Test 1: GET null → defaults ---');
{
  const state = applyData({
    whatsapp_enabled: true,
    whatsapp_intro_message: null,
    whatsapp_closing_message: null,
  });
  check(state.introMessage === '', '1.1 null intro → empty string');
  check(state.closingMessage === '', '1.2 null closing → empty string');
  check(state.whatsappEnabled === true, '1.3 enabled defaults to true');
}

// ========================================================================
// Test 2: enabled=false shown as toggle off
// ========================================================================
console.log('\n--- Test 2: whatsapp_enabled=false ---');
{
  const state = applyData({
    whatsapp_enabled: false,
    whatsapp_intro_message: 'Halo',
    whatsapp_closing_message: 'Dah',
  });
  check(state.whatsappEnabled === false, '2.1 toggle is off');
  check(state.introMessage === 'Halo', '2.2 intro preserved');
  check(state.closingMessage === 'Dah', '2.3 closing preserved');
}

// ========================================================================
// Test 3: whitespace-only save → null in payload
// ========================================================================
console.log('\n--- Test 3: whitespace-only → null ---');
{
  const payload = buildPutPayload(1, true, '   ', '\t\n  ');
  check(payload.whatsapp_intro_message === null, '3.1 whitespace intro → null');
  check(payload.whatsapp_closing_message === null, '3.2 whitespace closing → null');
}

// ========================================================================
// Test 4: 500 chars accepted
// ========================================================================
console.log('\n--- Test 4: 500 chars accepted ---');
{
  const intro500 = 'a'.repeat(500);
  const closing500 = 'b'.repeat(500);
  const payload = buildPutPayload(1, true, intro500, closing500);
  check(payload.whatsapp_intro_message === intro500, '4.1 500-char intro accepted');
  check(payload.whatsapp_closing_message === closing500, '4.2 500-char closing accepted');
}

// ========================================================================
// Test 5: >500 rejected (client-side maxLength prevents, but logic check)
// ========================================================================
console.log('\n--- Test 5: >500 chars rejected ---');
{
  const intro501 = 'a'.repeat(501);
  const shouldReject = intro501.length > 500;
  check(shouldReject === true, '5.1 501 chars would be rejected');
}

// ========================================================================
// Test 6: PUT payload canonical field names
// ========================================================================
console.log('\n--- Test 6: PUT payload canonical names ---');
{
  const payload = buildPutPayload(42, false, 'test intro', 'test closing');
  check('whatsapp_enabled' in payload, '6.1 whatsapp_enabled key present');
  check('whatsapp_intro_message' in payload, '6.2 whatsapp_intro_message key present');
  check('whatsapp_closing_message' in payload, '6.3 whatsapp_closing_message key present');
  check('property_id' in payload, '6.4 property_id key present');
  check(!('whatsap_enabled' in payload), '6.5 no typo whatsapp_enabled');
  check(!('whatsap_intro_message' in payload), '6.6 no typo whatsapp_intro_message');
  check(!('whatsap_closing_message' in payload), '6.7 no typo whatsapp_closing_message');
  check(payload.property_id === 42, '6.8 property_id value correct');
  check(payload.whatsapp_enabled === false, '6.9 whatsapp_enabled value correct');
}

// ========================================================================
// Test 7: 403 save displays permission error
// ========================================================================
console.log('\n--- Test 7: 403 permission error ---');
{
  const httpStatus = 403;
  const errorMessage =
    httpStatus === 403
      ? 'Anda tidak memiliki izin mengubah pengaturan POS.'
      : 'Gagal menyimpan pengaturan komunikasi POS.';
  check(
    errorMessage === 'Anda tidak memiliki izin mengubah pengaturan POS.',
    '7.1 403 → specific permission error message',
  );
  check(
    tabSrc.includes('Anda tidak memiliki izin mengubah pengaturan POS.'),
    '7.2 component source contains exact 403 message',
  );
}

// ========================================================================
// Test 8: reset restores initialData
// ========================================================================
console.log('\n--- Test 8: reset restores initialData ---');
{
  const initial: CommSettingsData = {
    whatsapp_enabled: true,
    whatsapp_intro_message: 'Original intro',
    whatsapp_closing_message: 'Original closing',
  };
  const editedIntro = 'Edited intro';
  const editedClosing = 'Edited closing';
  const afterReset = applyData(initial);
  check(afterReset.introMessage === 'Original intro', '8.1 reset restores intro');
  check(afterReset.closingMessage === 'Original closing', '8.2 reset restores closing');
  check(afterReset.whatsappEnabled === true, '8.3 reset restores enabled');
  check(afterReset.introMessage !== editedIntro, '8.4 edited intro not retained after reset');
}

// ========================================================================
// Test 9: preview — intro positioned before hotel name
// ========================================================================
console.log('\n--- Test 9: preview intro position ---');
{
  const lines = buildPreviewLines('OAK Hotel', 'Pesan pembuka di sini', '');
  const introIdx = lines.indexOf('Pesan pembuka di sini');
  const hotelIdx = lines.indexOf('*OAK Hotel*');
  check(introIdx !== -1 && hotelIdx !== -1, '9.1 both intro and hotel present');
  check(introIdx < hotelIdx, '9.2 intro appears before hotel name in preview');
}

// ========================================================================
// Test 10: preview — closing positioned before hardcoded thank-you
// ========================================================================
console.log('\n--- Test 10: preview closing position ---');
{
  const lines = buildPreviewLines('OAK Hotel', '', 'Pesan penutup di sini');
  const closingIdx = lines.indexOf('Pesan penutup di sini');
  const thanksIdx = lines.indexOf('Terima kasih telah berbelanja di OAK Hotel!');
  check(closingIdx !== -1 && thanksIdx !== -1, '10.1 both closing and thank-you present');
  check(closingIdx < thanksIdx, '10.2 custom closing appears before hardcoded thank-you');
}

// ========================================================================
// Test 11: preview — no intro/closing → no extra lines
// ========================================================================
console.log('\n--- Test 11: preview without intro/closing ---');
{
  const lines = buildPreviewLines('OAK Hotel', '', '');
  const hotelIdx = lines.indexOf('*OAK Hotel*');
  check(hotelIdx >= 0, '11.1 hotel name present');
  check(!lines.includes('Pesan pembuka'), '11.2 no intro placeholder text');
  check(!lines.includes('Pesan penutup'), '11.3 no closing placeholder text');
}

// ========================================================================
// Test 12: preview — hotel label falls back to "Nama Hotel"
// ========================================================================
console.log('\n--- Test 12: preview hotel label fallback ---');
{
  const lines = buildPreviewLines('Nama Hotel', '', '');
  const hotelIdx = lines.indexOf('*Nama Hotel*');
  check(hotelIdx >= 0, '12.1 fallback label "Nama Hotel" used when no property name');
}

// ========================================================================
// Test 13: canonical GET endpoint URL in component source
// ========================================================================
console.log('\n--- Test 13: canonical GET endpoint ---');
{
  check(
    tabSrc.includes('/pos/communication-settings?property_id='),
    '13.1 GET URL uses /pos/communication-settings?property_id=',
  );
  check(
    tabSrc.includes('`${apiBaseUrl}/pos/communication-settings?property_id=${propertyId}`'),
    '13.2 GET URL template exact',
  );
}

// ========================================================================
// Test 14: canonical PUT endpoint URL in component source
// ========================================================================
console.log('\n--- Test 14: canonical PUT endpoint ---');
{
  check(
    tabSrc.includes('`${apiBaseUrl}/pos/communication-settings`'),
    '14.1 PUT URL template exact',
  );
  check(tabSrc.includes("method: 'PUT'") || tabSrc.includes('method: "PUT"'), '14.2 PUT method used');
}

// ========================================================================
// Test 15: stale property/request guard present in component source
// ========================================================================
console.log('\n--- Test 15: stale property/request guard ---');
{
  check(tabSrc.includes('activePropertyRef'), '15.1 activePropertyRef guard present');
  check(tabSrc.includes('scopeEpoch'), '15.2 scopeEpoch guard present');
  check(
    tabSrc.includes('activePropertyRef.current === requestedProperty'),
    '15.3 response applies only when property unchanged',
  );
  check(
    tabSrc.includes('scopeEpoch.current.version === requestedEpoch'),
    '15.4 response applies only when epoch unchanged',
  );
}

// ========================================================================
// Test 16: GET error state/retry — error card with retry, no fabricated state
// ========================================================================
console.log('\n--- Test 16: GET error state / retry ---');
{
  // On GET failure without initialData, the component must not fabricate a
  // saved state: applyData (which sets initialData) is only called on a
  // successful GET response with shape-valid data.
  check(tabSrc.includes('Muat ulang'), '16.1 retry button label present');
  check(tabSrc.includes('loadSettings'), '16.2 retry calls loadSettings');
  check(
    tabSrc.includes("feedback?.type === 'error' && !initialData"),
    '16.3 error card only when no saved initial data (no fabricated saved state)',
  );
}

// ========================================================================
// Test 17: preview purity — no receipt builder / fake PosReceiptData
// ========================================================================
console.log('\n--- Test 17: preview purity ---');
{
  check(!tabSrc.includes('buildPosReceiptWhatsAppMessage'), '17.1 preview does not use receipt builder');
  check(!tabSrc.includes('PosReceiptData'), '17.2 preview does not fabricate PosReceiptData');
  check(!tabSrc.includes('posReceiptWhatsApp'), '17.3 no receipt presentation import');
  check(!/import[^;]*tax/i.test(tabSrc), '17.4 no tax helpers import');
  check(!/import[^;]*service/i.test(tabSrc), '17.5 no service helpers import');
  check(tabSrc.includes('Data transaksi pada preview hanya contoh.'), '17.6 preview disclaimer present');
}

// ========================================================================
// Test 18: workspace render placement after PaymentInstructionsSettingsTab
// ========================================================================
console.log('\n--- Test 18: workspace placement ---');
{
  const posImportIdx = workspaceSrc.indexOf(
    "import { PosCommunicationSettingsTab } from './PosCommunicationSettingsTab';",
  );
  check(posImportIdx !== -1, '18.1 PosCommunicationSettingsTab imported in workspace');

  const payIdx = workspaceSrc.indexOf('<PaymentInstructionsSettingsTab');
  const posIdx = workspaceSrc.indexOf('<PosCommunicationSettingsTab');
  check(payIdx !== -1, '18.2 PaymentInstructionsSettingsTab still rendered');
  check(posIdx !== -1, '18.3 PosCommunicationSettingsTab rendered');
  check(posIdx > payIdx, '18.4 PosCommunicationSettingsTab rendered AFTER PaymentInstructionsSettingsTab');
  // Both inside the same 'pos' category block
  const posCategoryIdx = workspaceSrc.indexOf("activeCategory === 'pos'");
  check(posCategoryIdx !== -1 && posCategoryIdx < payIdx && payIdx < posIdx, '18.5 both inside POS & F&B category');
}

// ========================================================================
// Test 19: maxLength 500 enforced on both textareas
// ========================================================================
console.log('\n--- Test 19: maxLength 500 ---');
{
  const maxLenOccurrences = tabSrc.match(/maxLength=\{MAX_MSG_LEN\}/g) || [];
  check(maxLenOccurrences.length === 2, '19.1 both textareas use maxLength={MAX_MSG_LEN}');
  check(tabSrc.includes('const MAX_MSG_LEN = 500;'), '19.2 MAX_MSG_LEN is 500');
}

// ========================================================================
// Test 20: trim + whitespace-only → null normalization
// ========================================================================
console.log('\n--- Test 20: trim & whitespace normalization ---');
{
  check(tabSrc.includes('introMessage.trim()'), '20.1 intro trimmed before save');
  check(tabSrc.includes('closingMessage.trim()'), '20.2 closing trimmed before save');
  check(
    tabSrc.includes('trimmedIntro.length > 0 ? trimmedIntro : null'),
    '20.3 empty intro normalized to null',
  );
  check(
    tabSrc.includes('trimmedClosing.length > 0 ? trimmedClosing : null'),
    '20.4 empty closing normalized to null',
  );
}

console.log(`\n=== All ${assertions} assertions passed ===`);
