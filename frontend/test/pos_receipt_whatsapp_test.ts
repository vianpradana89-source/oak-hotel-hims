import assert from 'node:assert/strict';
import {
  normalizeWhatsAppPhone,
  buildPosReceiptWhatsAppMessage,
  buildPosReceiptWhatsAppUrl,
  type PosWhatsAppMessageOptions,
} from '../src/features/pos/posReceiptWhatsApp';
import type { PosReceiptData } from '../src/features/pos/posReceiptTypes';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting POS Receipt WhatsApp Helper Tests ===\n');

// ============================================================================
// Test 1: normalizeWhatsAppPhone
// ============================================================================
console.log('--- Test 1: normalizeWhatsAppPhone ---');

// Nomor kosong / null / undefined → null
check(normalizeWhatsAppPhone(null) === null, '1.1 null returns null');
check(normalizeWhatsAppPhone(undefined) === null, '1.2 undefined returns null');
check(normalizeWhatsAppPhone('') === null, '1.3 empty string returns null');
check(normalizeWhatsAppPhone('   ') === null, '1.4 whitespace-only returns null');

// Format +62 (strip +, hasilnya 62...)
check(normalizeWhatsAppPhone('+6281234567890') === '6281234567890', '1.5 +62 normalized to 62');
check(normalizeWhatsAppPhone('+62-8123.456789') === '628123456789', '1.6 +62 with separators normalized');

// Format 62 langsung (tetap)
check(normalizeWhatsAppPhone('6281234567890') === '6281234567890', '1.7 62 prefix kept');

// Format 08 → konversi ke 628
check(normalizeWhatsAppPhone('081234567890') === '6281234567890', '1.8 08 converted to 628');
check(normalizeWhatsAppPhone(' 0812 3456 7890 ') === '6281234567890', '1.9 08 with spaces normalized');

// Format tidak valid → null
check(normalizeWhatsAppPhone('12345') === null, '1.10 too short returns null');
check(normalizeWhatsAppPhone('abc') === null, '1.11 non-numeric returns null');
check(normalizeWhatsAppPhone('991234567890') === null, '1.12 99 prefix invalid returns null');
check(normalizeWhatsAppPhone('81234567890') === null, '1.13 8 prefix without 0/62 returns null');

// Validasi panjang
check(normalizeWhatsAppPhone('62812') === null, '1.14 too short returns null');
check(normalizeWhatsAppPhone('62812345678901234') === null, '1.15 too long returns null');

// ============================================================================
// Test 2: buildPosReceiptWhatsAppMessage
// ============================================================================
console.log('\n--- Test 2: buildPosReceiptWhatsAppMessage ---');

// Mock receipt data
const mockReceipt: PosReceiptData = {
  property: {
    id: 1,
    name: 'OAK Hotel Jakarta',
    property_code: 'OAK-JKT',
    address: 'Jl. Sudirman No. 1',
    phone: '+62 21 1234567',
    timezone: 'Asia/Jakarta',
    currency: 'IDR',
    branding: {
      property_id: 1,
      display_name: 'OAK by Lawang',
      short_name: 'OAK',
      tagline: 'Premium Hospitality',
      primary_color: '#2d5016',
      accent_color: '#d4af37',
      logo_url: null,
      compact_logo_url: null,
    },
  },
  order: {
    id: 101,
    order_number: 'ORD-20260115-001',
    property_id: 1,
    status: 'PAID',
    guest_name: 'Budi Santoso',
    guest_phone: '081234567890',
    table_number: 'T05',
    notes: 'Tanpa bawang',
    total_amount: '150000',
    discount_type: 'NOMINAL',
    discount_value: '10000',
    discount_reason: 'Member discount',
    discount_amount: '10000',
    created_at: '2026-01-15T10:00:00Z',
    updated_at: '2026-01-15T10:00:00Z',
  },
  items: [
    {
      id: 1,
      menu_item_id: 10,
      item_name_snapshot: 'Nasi Goreng Spesial',
      item_code_snapshot: 'NGS-001',
      quantity: 2,
      unit_price: '50000',
      notes: null,
      discount_type: null,
      discount_value: null,
      discount_amount: '0',
    },
    {
      id: 2,
      menu_item_id: 20,
      item_name_snapshot: 'Es Teh Manis',
      item_code_snapshot: 'ETM-001',
      quantity: 1,
      unit_price: '15000',
      notes: null,
      discount_type: null,
      discount_value: null,
      discount_amount: '0',
    },
  ],
  settlement: {
    id: 501,
    amount: '150000',
    payment_method: 'CASH',
    status: 'SUCCESS',
    cash_received: '150000',
    change_due: '0',
    payment_reference: null,
    created_by: 'admin',
    created_at: '2026-01-15T10:05:00Z',
    verified_by: null,
    verified_at: null,
  },
  sale: {
    id: '900001',
    transaction_no: 'TRX-20260115-001',
    transaction_type: 'SALE',
    source_type: 'POS_ORDER',
    source_id: '101',
    payment_status: 'PAID',
    payment_method: 'CASH',
    net_amount: '150000',
    created_at: '2026-01-15T10:05:00Z',
  },
};

const msg = buildPosReceiptWhatsAppMessage(mockReceipt);
check(msg.includes('OAK by Lawang'), '2.1 hotel name from branding display_name');
check(msg.includes('ORD-20260115-001'), '2.2 order number present');
check(msg.includes('TRX-20260115-001'), '2.3 transaction number present');
check(msg.includes('Nasi Goreng Spesial'), '2.4 item name snapshot present');
check(msg.includes('Es Teh Manis'), '2.5 second item present');
check(msg.includes('2x'), '2.6 quantity shown');
check(msg.includes('Rp 150.000'), '2.7 total amount formatted');
check(msg.includes('CASH'), '2.8 payment method shown');
check(msg.includes('Terima kasih'), '2.9 closing thank you message');

// Test dengan non-CASH
const mockReceiptQris: PosReceiptData = {
  ...mockReceipt,
  settlement: {
    ...mockReceipt.settlement,
    payment_method: 'QRIS',
    cash_received: null,
    change_due: null,
    payment_reference: 'QRIS-REF-001',
  },
  sale: {
    ...mockReceipt.sale,
    payment_method: 'QRIS',
  },
};

const msgQris = buildPosReceiptWhatsAppMessage(mockReceiptQris);
check(msgQris.includes('QRIS'), '2.10 QRIS payment method shown');
check(msgQris.includes('QRIS-REF-001'), '2.11 QRIS reference shown');
check(!msgQris.includes('Uang Diterima'), '2.12 no cash received for QRIS');

// ============================================================================
// Test 3: buildPosReceiptWhatsAppUrl
// ============================================================================
console.log('\n--- Test 3: buildPosReceiptWhatsAppUrl ---');

// Valid phone
const validUrl = buildPosReceiptWhatsAppUrl(mockReceipt);
check(validUrl !== null, '3.1 valid phone returns URL');
check(validUrl!.startsWith('https://wa.me/6281234567890'), '3.2 URL starts with wa.me + normalized phone');
check(validUrl!.includes('?text='), '3.3 URL contains text parameter');
check(validUrl!.includes('%0A'), '3.4 newlines are encoded as %0A');

// Invalid phone → null
const mockReceiptNoPhone: PosReceiptData = {
  ...mockReceipt,
  order: {
    ...mockReceipt.order,
    guest_phone: null,
  },
};
check(buildPosReceiptWhatsAppUrl(mockReceiptNoPhone) === null, '3.5 null phone returns null');

const mockReceiptBadPhone: PosReceiptData = {
  ...mockReceipt,
  order: {
    ...mockReceipt.order,
    guest_phone: '123',
  },
};
check(buildPosReceiptWhatsAppUrl(mockReceiptBadPhone) === null, '3.6 invalid phone returns null');

// ============================================================================
// Test 4: malformed monetary strings — TIDAK BOLEH diparse sebagian
// ============================================================================
// parseRupiahStringStrict hanya menerima string murni digit penuh (^\d+$).
// "10000abc" → 0 (bukan 10000), "100.50" → 0, "1e5" → 0, "-100" → 0.
// Kita buktikan via buildPosReceiptWhatsAppMessage: nilai yang seharusnya
// > 0 tidak akan muncul di output.
console.log('\n--- Test 4: malformed monetary strings rejected ---');

function makeReceiptWithMalformedAmounts(
  totalAmount: string,
  discountAmount: string,
  cashReceived: string | null,
  unitPrice: string
): PosReceiptData {
  return {
    property: {
      id: 1,
      name: 'Test Hotel',
      property_code: 'TST',
      address: null,
      phone: null,
      timezone: 'Asia/Jakarta',
      currency: 'IDR',
      branding: null,
    },
    order: {
      id: 1,
      order_number: 'ORD-001',
      property_id: 1,
      status: 'PAID',
      guest_name: null,
      guest_phone: '081234567890',
      table_number: null,
      notes: null,
      total_amount: totalAmount,
      discount_type: 'NOMINAL',
      discount_value: null,
      discount_reason: 'test',
      discount_amount: discountAmount,
      created_at: null,
      updated_at: null,
    },
    items: [
      {
        id: 1,
        menu_item_id: 1,
        item_name_snapshot: 'Item A',
        item_code_snapshot: null,
        quantity: 1,
        unit_price: unitPrice,
        notes: null,
        discount_type: null,
        discount_value: null,
        discount_amount: '0',
      },
    ],
    settlement: {
      id: 1,
      amount: totalAmount,
      payment_method: 'CASH',
      status: 'SUCCESS',
      cash_received: cashReceived,
      change_due: null,
      payment_reference: null,
      created_by: null,
      created_at: null,
      verified_by: null,
      verified_at: null,
    },
    sale: {
      id: '1',
      transaction_no: 'TRX-001',
      transaction_type: 'SALE',
      source_type: 'POS_ORDER',
      source_id: '1',
      payment_status: 'PAID',
      payment_method: 'CASH',
      net_amount: totalAmount,
      created_at: null,
    },
  };
}

// "10000abc" — parseInt lama akan menghasilkan 10000; strict harus menghasilkan 0
const m1 = buildPosReceiptWhatsAppMessage(
  makeReceiptWithMalformedAmounts('10000abc', '10000abc', '10000abc', '10000abc')
);
check(!m1.includes('Rp 10.000'), '4.1 "10000abc" total does NOT show partial parse');
check(!m1.includes('Uang Diterima: Rp 10.000'), '4.2 "10000abc" cash_received does NOT show partial');
check(!m1.includes('Diskon: Rp 10.000'), '4.3 "10000abc" discount does NOT show partial');
check(m1.includes('Rp 0'), '4.4 malformed total shows Rp 0');

// "100.50" — parseInt lama akan menghasilkan 100; strict harus menghasilkan 0
const m2 = buildPosReceiptWhatsAppMessage(
  makeReceiptWithMalformedAmounts('100.50', '100.50', '100.50', '100.50')
);
check(!m2.includes('Rp 100'), '4.5 "100.50" does NOT show partial parse of 100');
check(m2.includes('Rp 0'), '4.6 "100.50" shows Rp 0');

// "1e5" — parseInt lama akan menghasilkan 1; strict harus menghasilkan 0
const m3 = buildPosReceiptWhatsAppMessage(
  makeReceiptWithMalformedAmounts('1e5', '1e5', '1e5', '1e5')
);
check(!m3.includes('Rp 1'), '4.7 "1e5" does NOT show partial parse of 1');
check(m3.includes('Rp 0'), '4.8 "1e5" shows Rp 0');

// "-100" — parseInt lama akan menghasilkan -100 (ditolak oleh < 0); strict menolak sign
const m4 = buildPosReceiptWhatsAppMessage(
  makeReceiptWithMalformedAmounts('-100', '-100', '-100', '-100')
);
check(!m4.includes('Rp 100'), '4.9 "-100" does NOT show parsed value');
check(m4.includes('Rp 0'), '4.10 "-100" shows Rp 0');

// Whitespace " 10000 " — parseInt lama akan menghasilkan 10000; strict harus menghasilkan 0
const m5 = buildPosReceiptWhatsAppMessage(
  makeReceiptWithMalformedAmounts(' 10000 ', ' 10000 ', ' 10000 ', ' 10000 ')
);
check(!m5.includes('Rp 10.000'), '4.11 " 10000 " (with spaces) does NOT show partial parse');
check(m5.includes('Rp 0'), '4.12 " 10000 " shows Rp 0');

// String valid harus tetap bekerja: "50000"
const m6 = buildPosReceiptWhatsAppMessage(
  makeReceiptWithMalformedAmounts('50000', '5000', '50000', '50000')
);
check(m6.includes('Rp 50.000'), '4.13 valid "50000" total shows Rp 50.000');
check(m6.includes('Rp 5.000'), '4.14 valid "5000" discount shows Rp 5.000');
check(m6.includes('Uang Diterima: Rp 50.000'), '4.15 valid "50000" cash_received shows');

// Discount "0" — isPositiveAmount harus false → baris diskon tidak muncul
const m7 = buildPosReceiptWhatsAppMessage(
  makeReceiptWithMalformedAmounts('50000', '0', '50000', '50000')
);
check(!m7.includes('Diskon:'), '4.16 discount "0" does NOT show discount line');

// ============================================================================
// Test 5: intro/closing options — focused assertions
// ============================================================================
console.log('\n--- Test 5: intro/closing options ---');

// 5.1 intro muncul SEBELUM hotel name
const msgWithIntro = buildPosReceiptWhatsAppMessage(mockReceipt, {
  intro: 'Selamat datang di OAK Hotel!',
});
const introIdx = msgWithIntro.indexOf('Selamat datang di OAK Hotel!');
const hotelIdx = msgWithIntro.indexOf('*OAK by Lawang*');
check(introIdx >= 0, '5.1a intro text present in message');
check(hotelIdx > introIdx, '5.1b intro appears before hotel name');

// 5.2 closing muncul SEBELUM hardcoded thank-you
const msgWithClosing = buildPosReceiptWhatsAppMessage(mockReceipt, {
  closing: 'Kami tunggu kunjungan Anda lagi!',
});
const closingIdx = msgWithClosing.indexOf('Kami tunggu kunjungan Anda lagi!');
const thankYouIdx = msgWithClosing.indexOf('Terima kasih telah berbelanja di');
check(closingIdx >= 0, '5.2a custom closing text present in message');
check(thankYouIdx > closingIdx, '5.2b custom closing appears before hardcoded thank-you');
// hardcoded thank-you tetap ada
check(msgWithClosing.includes('Terima kasih'), '5.2c hardcoded thank-you still present');

// 5.3 whitespace-only intro/closing → diabaikan
const msgWsIntro = buildPosReceiptWhatsAppMessage(mockReceipt, {
  intro: '   ',
});
const noWs = msgWsIntro.indexOf('   ') === -1; // baris kosong-only tidak muncul sebagai konten
// Lebih teliti: intro yang whitespace-only tidak menambah baris baru sebelum hotel name
const lines53 = msgWsIntro.split('\n');
check(lines53[0] === '*OAK by Lawang*', '5.3a whitespace-only intro: hotel name is still first line');

const msgWsClosing = buildPosReceiptWhatsAppMessage(mockReceipt, {
  closing: '\t  ',
});
const lines53b = msgWsClosing.split('\n');
// hardcoded thank-you tetap ada dan tidak ada baris "  " sebagai closing
check(lines53b[lines53b.length - 2] === 'Terima kasih telah berbelanja di OAK by Lawang!', '5.3b whitespace-only closing: hardcoded thank-you is second-to-last line');

// 5.4 existing call tanpa options tetap identik (backward-compatible)
const msgNoOpts = buildPosReceiptWhatsAppMessage(mockReceipt);
const msgEmptyOpts = buildPosReceiptWhatsAppMessage(mockReceipt, {});
check(msgNoOpts === msgEmptyOpts, '5.4 empty options object produces identical output to no options');

// 5.5 URL builder meneruskan options
const urlNoOpts = buildPosReceiptWhatsAppUrl(mockReceipt);
const urlWithIntro = buildPosReceiptWhatsAppUrl(mockReceipt, {
  intro: 'Khusus WhatsApp',
});
check(urlNoOpts !== null && urlNoOpts !== undefined, '5.5a URL without options is valid');
check(urlWithIntro !== null, '5.5b URL with intro is valid');
// decode the text param and check intro is inside
const decodedUrlWith = decodeURIComponent(urlWithIntro!);
const decodedUrlNo = decodeURIComponent(urlNoOpts!);
check(decodedUrlWith.includes('Khusus WhatsApp'), '5.5c URL with intro contains intro text in encoded message');
check(!decodedUrlNo.includes('Khusus WhatsApp'), '5.5d URL without options does NOT contain intro text');

// 5.6 intro + closing combined
const msgBoth = buildPosReceiptWhatsAppMessage(mockReceipt, {
  intro: 'Pesan pembuka',
  closing: 'Pesan penutup',
});
const iIdx = msgBoth.indexOf('Pesan pembuka');
const cIdx = msgBoth.indexOf('Pesan penutup');
const tIdx = msgBoth.indexOf('Terima kasih');
check(iIdx >= 0 && cIdx >= 0, '5.6a both intro and closing present');
check(iIdx < cIdx, '5.6b intro before closing');
check(cIdx < tIdx, '5.6c closing before hardcoded thank-you');

// 5.7 intro/closing null → tidak muncul
const msgNullOpts = buildPosReceiptWhatsAppMessage(mockReceipt, {
  intro: null,
  closing: null,
});
check(msgNullOpts === msgNoOpts, '5.7 null intro/closing produces identical output to no options');

console.log(`\n=== All ${assertions} assertions passed ===`);
