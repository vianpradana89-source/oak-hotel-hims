/**
 * C2B — PosThermalReceiptModal communication settings integration tests.
 *
 * Verifies (baseline 8d16750 + S3 runtime settings):
 *   1. Default settings (fetch failure / no settings) → backward compat
 *   2. whatsapp_enabled=false + valid phone → disabled + setting tooltip
 *   3. whatsapp_enabled=true + invalid phone → disabled + phone tooltip
 *   4. whatsapp_enabled=false + invalid phone → setting tooltip wins
 *   5. intro/closing are forwarded to buildPosReceiptWhatsAppUrl
 *   6. Receipt fetch independence (settings failure does not block receipt)
 *   7. backward compatibility (no options param)
 *   8. raw order.order_number remains the No. Order source
 *
 * Run: npx tsx test/pos_thermal_receipt_modal_c2b_test.ts
 */
import assert from 'node:assert/strict';
import {
  buildPosReceiptWhatsAppUrl,
  buildPosReceiptWhatsAppMessage,
  type PosWhatsAppMessageOptions,
} from '../src/features/pos/posReceiptWhatsApp';
import type { PosReceiptData } from '../src/features/pos/posReceiptTypes';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

// ── Mock receipt fixtures (baseline 8d16750 — no tax/service fields) ────────

const receiptValidPhone: PosReceiptData = {
  property: {
    id: 1, name: 'Hotel A', property_code: 'A',
    address: null, phone: null, timezone: 'Asia/Jakarta', currency: 'IDR',
    branding: null,
  },
  order: {
    id: 1, order_number: 'ORD-001', property_id: 1, status: 'PAID',
    guest_name: null, guest_phone: '081234567890',
    table_number: null, notes: null,
    total_amount: '50000',
    discount_type: null, discount_value: null, discount_reason: null,
    discount_amount: '0',
    // B4.1 — legacy zero snapshots
    service_amount: '0',
    tax_amount: '0',
    service_charge_percent_snapshot: '0',
    tax_percent_snapshot: '0',
    service_charge_enabled_snapshot: false,
    tax_enabled_snapshot: false,
    created_at: '2026-10-16T10:00:00Z', updated_at: '2026-10-16T10:00:00Z',
  },
  items: [
    {
      id: 1, menu_item_id: 1, item_name_snapshot: 'Item',
      item_code_snapshot: null, quantity: 1, unit_price: '50000',
      notes: null, discount_type: null, discount_value: null,
      discount_amount: '0',
    },
  ],
  settlement: {
    id: 1, amount: '50000', payment_method: 'CASH', status: 'SUCCESS',
    cash_received: '50000', change_due: '0', payment_reference: null,
    created_by: null, created_at: '2026-10-16T10:05:00Z',
    verified_by: null, verified_at: null,
  },
  sale: {
    id: '1', transaction_no: 'TRX-001', transaction_type: 'SALE',
    source_type: 'POS_ORDER', source_id: '1',
    payment_status: 'PAID', payment_method: 'CASH',
    net_amount: '50000', created_at: '2026-10-16T10:05:00Z',
  },
};

const receiptNoPhone: PosReceiptData = {
  ...receiptValidPhone,
  order: { ...receiptValidPhone.order, guest_phone: null },
};

// ── Simulate the modal's WhatsApp state logic ───────────────────────────────
// Mirrors the exact logic in PosThermalReceiptModal.tsx for canWhatsApp
// and tooltip selection (S3 always-visible disabled button semantics).

interface CommSettings {
  whatsapp_enabled: boolean;
  whatsapp_intro_message: string | null;
  whatsapp_closing_message: string | null;
}

const DEFAULT_SETTINGS: CommSettings = {
  whatsapp_enabled: true,
  whatsapp_intro_message: null,
  whatsapp_closing_message: null,
};

function computeWhatsAppState(
  receipt: PosReceiptData | null,
  settings: CommSettings,
) {
  const options: PosWhatsAppMessageOptions = {
    intro: settings.whatsapp_intro_message,
    closing: settings.whatsapp_closing_message,
  };
  const whatsappUrl =
    receipt !== null
      ? buildPosReceiptWhatsAppUrl(receipt, options)
      : null;
  const canWhatsApp = whatsappUrl !== null && settings.whatsapp_enabled;

  const whatsappTooltip = !canWhatsApp
    ? !settings.whatsapp_enabled
      ? 'Pengiriman WhatsApp dinonaktifkan dari Pengaturan POS'
      : 'Nomor WhatsApp pelanggan tidak tersedia atau tidak valid'
    : 'Kirim struk ke WhatsApp tamu';

  return { whatsappUrl, canWhatsApp, whatsappTooltip };
}

console.log('=== C2B PosThermalReceiptModal — Communication Settings Integration ===\n');

// ============================================================================
// Test 1: Default settings (fetch failure / no settings) → backward compat
// ============================================================================
console.log('--- Test 1: default settings (fetch failure fallback) ---');

{
  const { whatsappUrl, canWhatsApp, whatsappTooltip } = computeWhatsAppState(
    receiptValidPhone, DEFAULT_SETTINGS,
  );
  check(whatsappUrl !== null, '1.1 valid phone + default settings → URL present');
  check(canWhatsApp === true, '1.2 valid phone + default settings → button enabled');
  check(
    whatsappTooltip === 'Kirim struk ke WhatsApp tamu',
    '1.3 tooltip = enabled state',
  );
}

{
  const { whatsappUrl, canWhatsApp, whatsappTooltip } = computeWhatsAppState(
    receiptNoPhone, DEFAULT_SETTINGS,
  );
  check(whatsappUrl === null, '1.4 no phone + default settings → URL is null');
  check(canWhatsApp === false, '1.5 no phone + default settings → button disabled');
  check(
    whatsappTooltip === 'Nomor WhatsApp pelanggan tidak tersedia atau tidak valid',
    '1.6 tooltip = phone reason',
  );
}

// ============================================================================
// Test 2: whatsapp_enabled=false + valid phone → disabled + setting tooltip
// ============================================================================
console.log('\n--- Test 2: whatsapp_enabled=false + valid phone ---');

{
  const settings: CommSettings = {
    whatsapp_enabled: false,
    whatsapp_intro_message: 'Halo!',
    whatsapp_closing_message: 'Sampai jumpa.',
  };
  const { canWhatsApp, whatsappTooltip } = computeWhatsAppState(
    receiptValidPhone, settings,
  );
  check(canWhatsApp === false, '2.1 button disabled when whatsapp_enabled=false');
  check(
    whatsappTooltip === 'Pengiriman WhatsApp dinonaktifkan dari Pengaturan POS',
    '2.2 tooltip = setting reason (wins over phone)',
  );
}

// ============================================================================
// Test 3: whatsapp_enabled=true + invalid phone → disabled + phone tooltip
// ============================================================================
console.log('\n--- Test 3: whatsapp_enabled=true + invalid phone ---');

{
  const settings: CommSettings = {
    whatsapp_enabled: true,
    whatsapp_intro_message: null,
    whatsapp_closing_message: null,
  };
  const { canWhatsApp, whatsappTooltip } = computeWhatsAppState(
    receiptNoPhone, settings,
  );
  check(canWhatsApp === false, '3.1 button disabled when phone invalid');
  check(
    whatsappTooltip === 'Nomor WhatsApp pelanggan tidak tersedia atau tidak valid',
    '3.2 tooltip = phone reason',
  );
}

// ============================================================================
// Test 4: whatsapp_enabled=false + invalid phone → setting tooltip wins
// ============================================================================
console.log('\n--- Test 4: whatsapp_enabled=false + invalid phone (priority) ---');

{
  const settings: CommSettings = {
    whatsapp_enabled: false,
    whatsapp_intro_message: null,
    whatsapp_closing_message: null,
  };
  const { canWhatsApp, whatsappTooltip } = computeWhatsAppState(
    receiptNoPhone, settings,
  );
  check(canWhatsApp === false, '4.1 button disabled');
  check(
    whatsappTooltip === 'Pengiriman WhatsApp dinonaktifkan dari Pengaturan POS',
    '4.2 setting tooltip takes priority over phone tooltip',
  );
}

// ============================================================================
// Test 5: intro/closing forwarded to builder
// ============================================================================
console.log('\n--- Test 5: intro/closing forwarded to builder ---');

{
  const settings: CommSettings = {
    whatsapp_enabled: true,
    whatsapp_intro_message: 'Pesan khusus: silakan cek struk ini',
    whatsapp_closing_message: 'Terima kasih! Jangan lupa like & follow.',
  };
  const { whatsappUrl } = computeWhatsAppState(receiptValidPhone, settings);
  check(whatsappUrl !== null, '5.1 URL present with intro/closing');

  const textParam = whatsappUrl!.split('?text=')[1];
  check(
    decodeURIComponent(textParam!).includes('Pesan khusus: silakan cek struk ini'),
    '5.2 intro text present in URL payload',
  );
  check(
    decodeURIComponent(textParam!).includes('Terima kasih! Jangan lupa like & follow.'),
    '5.3 closing text present in URL payload',
  );

  // Verify intro appears before hotel name
  const decoded = decodeURIComponent(textParam!);
  const hotelIdx = decoded.indexOf('Hotel A');
  const introIdx = decoded.indexOf('Pesan khusus');
  check(introIdx < hotelIdx, '5.4 intro positioned before hotel name');

  // Verify closing appears before hardcoded thank-you
  const hardcodedIdx = decoded.indexOf('Terima kasih telah berbelanja di');
  const closingIdx = decoded.indexOf('Terima kasih! Jangan lupa');
  check(closingIdx < hardcodedIdx, '5.5 custom closing before hardcoded thank-you');

  // Receipt financial data unchanged
  check(
    decoded.includes('Rp 50.000'),
    '5.6 total amount intact in payload',
  );
}

// ============================================================================
// Test 6: receipt independence — settings failure does not block receipt
// ============================================================================
console.log('\n--- Test 6: receipt independence from settings fetch ---');

{
  // Simulate: receipt is valid, settings fetch failed (using defaults)
  const { whatsappUrl, canWhatsApp } = computeWhatsAppState(
    receiptValidPhone, DEFAULT_SETTINGS,
  );
  check(whatsappUrl !== null, '6.1 valid receipt + settings failure → URL still built');
  check(canWhatsApp === true, '6.2 button still enabled with default settings');

  // Simulate: receipt not yet loaded, settings fetch in flight
  const { canWhatsApp: noReceipt } = computeWhatsAppState(null, DEFAULT_SETTINGS);
  check(noReceipt === false, '6.3 no receipt → button disabled regardless of settings');
}

// ============================================================================
// Test 7: buildPosReceiptWhatsAppUrl backward compatibility (no options)
// ============================================================================
console.log('\n--- Test 7: backward compatibility (no options param) ---');

{
  const urlNoOpts = buildPosReceiptWhatsAppUrl(receiptValidPhone);
  check(urlNoOpts !== null, '7.1 URL without options param still works');

  const urlWithDefaultOpts = buildPosReceiptWhatsAppUrl(receiptValidPhone, {
    intro: null, closing: null,
  });
  check(urlNoOpts === urlWithDefaultOpts, '7.2 null options ≡ no options');
}

// ============================================================================
// Test 8: raw order_number remains the No. Order source
// ============================================================================
console.log('\n--- Test 8: No. Order uses raw order.order_number ---');

{
  const msg = buildPosReceiptWhatsAppMessage(receiptValidPhone);
  check(
    msg.includes('No. Order: ORD-001'),
    '8.1 message contains raw order.order_number',
  );
  check(
    !msg.includes('POS-'),
    '8.2 no formatted POS-YYMMDD-xxxx reference in message',
  );
}

console.log(`\n=== All ${assertions} assertions passed ===`);
