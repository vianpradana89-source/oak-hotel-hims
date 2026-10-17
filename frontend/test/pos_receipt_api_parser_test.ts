/**
 * POS Receipt API parser test — canonical whole-rupiah validation.
 *
 * Akar masalah yang dibuktikan test ini:
 *  - Backend membalik raw numeric(12,2) string ("45000.00") dari pg driver;
 *    kontrak receipt frontend adalah whole-rupiah string kanonik ("45000").
 *  - fetchPosReceipt (fail-closed) harus:
 *    (a) MENERIMA payload yang seluruh amount-nya whole-rupiah kanonik,
 *    (b) MENOLAK payload yang mengandung "45000.00" (non-kanonik),
 *    (c) MENOLAK payload dengan amount numerically-equal tapi string-bukan-exact
 *        (mis. order.total_amount="45000" tapi settlement.amount="45000.00").
 *
 * Run:
 *   cd frontend && node test/pos_receipt_api_parser_test.ts
 */
import assert from 'node:assert/strict';
import { fetchPosReceipt } from '../src/features/pos/posReceiptApi.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

// ── Helper: fake authFetch returning a canned JSON Response ──────────────
function fakeFetch(body: unknown, ok = true, status = 200): any {
  return async (_url: string, _init?: RequestInit): Promise<Response> => {
    return new Response(JSON.stringify(body), {
      status: ok ? status : 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ── Minimal valid receipt payload (whole-rupiah kanonik) ─────────────────
const ORDER_ID = 42;
const PROPERTY_ID = 7;

function validPayload(): Record<string, any> {
  return {
    status: 'SUCCESS',
    data: {
      property: {
        id: PROPERTY_ID,
        name: 'OAK Test Hotel',
        property_code: 'OAK001',
        address: 'Jl. Test 1',
        phone: '+622112345678',
        timezone: 'Asia/Jakarta',
        currency: 'IDR',
        branding: null,
      },
      order: {
        id: ORDER_ID,
        order_number: 'ORD-001',
        property_id: PROPERTY_ID,
        status: 'PAID',
        guest_name: 'Tamu',
        guest_phone: '+628123456789',
        table_number: 'T-1',
        notes: null,
        total_amount: '45000',
        discount_type: null,
        discount_value: null,
        discount_reason: null,
        discount_amount: '0',
        service_amount: '0',
        tax_amount: '0',
        service_charge_percent_snapshot: '0',
        tax_percent_snapshot: '0',
        service_charge_enabled_snapshot: false,
        tax_enabled_snapshot: false,
        created_at: '2026-10-16T08:00:00.000Z',
        updated_at: '2026-10-16T08:05:00.000Z',
      },
      items: [
        {
          menu_item_id: 1,
          item_name_snapshot: 'Nasi Goreng',
          item_code_snapshot: 'NG-001',
          quantity: 2,
          unit_price: '25000',
          notes: null,
          discount_type: null,
          discount_value: null,
          discount_amount: '5000',
        },
      ],
      settlement: {
        id: 1,
        amount: '45000',
        payment_method: 'CASH',
        status: 'SUCCESS',
        cash_received: '50000',
        change_due: '5000',
        payment_reference: 'REF-1',
        created_by: 'test',
        created_at: '2026-10-16T08:05:00.000Z',
        verified_by: null,
        verified_at: null,
      },
      sale: {
        id: '99',
        transaction_no: 'TX-001',
        transaction_type: 'SALE',
        source_type: 'POS_ORDER',
        source_id: String(ORDER_ID),
        payment_status: 'PAID',
        payment_method: 'CASH',
        net_amount: '45000',
        created_at: '2026-10-16T08:05:00.000Z',
      },
    },
  };
}

console.log('=== POS Receipt API Parser Tests ===\n');

// ── P1: valid whole-rupiah canonical payload is accepted ─────────────────
console.log('--- P1: valid payload (all amounts = "45000") ---');
{
  const payload = validPayload();
  const receipt = await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));

  check(
    receipt.order.total_amount === '45000',
    'P1 order.total_amount="45000"',
  );
  check(
    receipt.settlement.amount === '45000',
    'P1 settlement.amount="45000"',
  );
  check(
    receipt.sale.net_amount === '45000',
    'P1 sale.net_amount="45000"',
  );
  check(
    receipt.order.total_amount === receipt.settlement.amount,
    'P1 triple exact-equal',
  );
  check(
    receipt.settlement.cash_received === '50000',
    'P1 settlement.cash_received="50000"',
  );
  check(
    receipt.settlement.change_due === '5000',
    'P1 settlement.change_due="5000"',
  );
  check(
    receipt.items[0].unit_price === '25000',
    'P1 item.unit_price="25000"',
  );
  check(
    receipt.items[0].discount_amount === '5000',
    'P1 item.discount_amount="5000"',
  );
  check(
    receipt.order.discount_amount === '0',
    'P1 order.discount_amount="0"',
  );
}

// ── P2: non-canonical "45000.00" is REJECTED ─────────────────────────────
console.log('\n--- P2: non-canonical "45000.00" rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).total_amount = '45000.00';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch (e: any) {
    threw = true;
    check(
      /tidak valid/i.test(String(e.message)),
      'P2 pesan error "Data struk POS tidak valid"',
    );
  }
  check(threw, 'P2 order.total_amount="45000.00" ditolak');
}

// ── P3: numerically-equal but string-not-exact is REJECTED ──────────────
console.log('\n--- P3: exact-equal check (order="45000" vs settlement="45000.00") ---');
{
  const payload = validPayload();
  (payload.data.settlement as any).amount = '45000.00';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch (e: any) {
    threw = true;
  }
  check(threw, 'P3 settlement.amount="45000.00" vs order.total_amount="45000" ditolak');
}

// ── P4: secondary monetary "50000.00" is accepted (validator scope) ─────
// The fail-closed validator intentionally only enforces whole-rupiah on the
// triple authoritative amounts.  Secondary fields (cash_received,
// change_due, item prices) pass through as whatever string the backend
// emitted — this is a deliberate design boundary, not a bug.
console.log('\n--- P4: secondary "50000.00" passes (validator scope boundary) ---');
{
  const payload = validPayload();
  (payload.data.settlement as any).cash_received = '50000.00';
  const receipt = await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  check(
    receipt.settlement.cash_received === '50000.00',
    'P4 secondary field "50000.00" lolos (di luar scope validator) — backend harus normalisasi',
  );
}

// ── P5: zero amount is REJECTED ─────────────────────────────────────────
console.log('\n--- P5: total_amount="0" rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).total_amount = '0';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P5 total_amount="0" ditolak');
}

// ── P6: non-string amount is REJECTED ───────────────────────────────────
console.log('\n--- P6: total_amount=45000 (number, bukan string) rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).total_amount = 45000; // wrong type
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P6 total_amount numeric (bukan string) ditolak');
}

// ── P7: leading-zero "045000" is REJECTED ───────────────────────────────
console.log('\n--- P7: total_amount="045000" (leading zero) rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).total_amount = '045000';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P7 total_amount="045000" (leading zero) ditolak');
}

// ── P8: HTTP error propagates backend message ───────────────────────────
console.log('\n--- P8: HTTP 500 propagates backend message ---');
{
  const errBody = {
    status: 'ERROR',
    code: 'RECEIPT_INTEGRITY_ERROR',
    message: 'Receipt integrity error: Amount mismatch: order.total_amount=45000 vs settlement.amount=45000 vs transaction.net_amount=50000',
  };
  let msg = '';
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(errBody, false, 500));
  } catch (e: any) {
    msg = String(e.message);
  }
  check(
    /Amount mismatch/.test(msg),
    'P8 HTTP 500 → pesan backend diteruskan',
  );
}

// ── P9: order.property_id mismatch is REJECTED ──────────────────────────
console.log('\n--- P9: order.property_id mismatch rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).property_id = 999;
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P9 order.property_id=999 vs propertyId=7 ditolak');
}

// ── P10: B4.1 valid snapshot fields are accepted ─────────────────────────
console.log('\n--- P10: B4.1 valid service_amount/tax_amount/snapshots accepted ---');
{
  const payload = validPayload();
  (payload.data.order as any).service_amount = '5000';
  (payload.data.order as any).tax_amount = '4950';
  (payload.data.order as any).service_charge_percent_snapshot = '10';
  (payload.data.order as any).tax_percent_snapshot = '11';
  (payload.data.order as any).service_charge_enabled_snapshot = true;
  (payload.data.order as any).tax_enabled_snapshot = true;
  const receipt = await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  check(
    receipt.order.service_amount === '5000',
    'P10 order.service_amount="5000"',
  );
  check(
    receipt.order.tax_amount === '4950',
    'P10 order.tax_amount="4950"',
  );
  check(
    receipt.order.service_charge_percent_snapshot === '10',
    'P10 service_charge_percent_snapshot="10"',
  );
  check(
    receipt.order.tax_percent_snapshot === '11',
    'P10 tax_percent_snapshot="11"',
  );
  check(
    receipt.order.service_charge_enabled_snapshot === true,
    'P10 service_charge_enabled_snapshot=true',
  );
  check(
    receipt.order.tax_enabled_snapshot === true,
    'P10 tax_enabled_snapshot=true',
  );
}

// ── P11: B4.1 zero snapshots (legacy) are accepted ──────────────────────
console.log('\n--- P11: B4.1 all-zero legacy snapshots accepted ---');
{
  const payload = validPayload();
  (payload.data.order as any).service_amount = '0';
  (payload.data.order as any).tax_amount = '0';
  (payload.data.order as any).service_charge_percent_snapshot = '0';
  (payload.data.order as any).tax_percent_snapshot = '0';
  (payload.data.order as any).service_charge_enabled_snapshot = false;
  (payload.data.order as any).tax_enabled_snapshot = false;
  const receipt = await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  check(receipt.order.service_amount === '0', 'P11 legacy service_amount="0" accepted');
  check(receipt.order.tax_amount === '0', 'P11 legacy tax_amount="0" accepted');
  check(receipt.order.service_charge_enabled_snapshot === false, 'P11 legacy svc=false accepted');
  check(receipt.order.tax_enabled_snapshot === false, 'P11 legacy tax=false accepted');
}

// ── P12: missing B4.1 snapshots must be rejected ────────────────────────
console.log('\n--- P12: missing B4.1 snapshots rejected ---');
{
  const payload = validPayload();
  const keys = [
    'service_amount',
    'tax_amount',
    'service_charge_percent_snapshot',
    'tax_percent_snapshot',
    'service_charge_enabled_snapshot',
    'tax_enabled_snapshot',
  ];
  for (const key of keys) delete payload.data.order[key];

  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P12 missing all six snapshot fields rejected');
}
// ── P13: B4.1 service_amount null is REJECTED ──────────────────────────
console.log('\n--- P13: B4.1 service_amount=null rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).service_amount = null;
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P13 service_amount=null ditolak (field present tapi nilai null)');
}

// ── P14: B4.1 service_amount="5000.00" (non-canonical) is REJECTED ─────
console.log('\n--- P14: B4.1 service_amount="5000.00" rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).service_amount = '5000.00';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P14 service_amount="5000.00" ditolak (non-kanonik)');
}

// ── P15: B4.1 percent_snapshot > 100 is REJECTED ───────────────────────
console.log('\n--- P15: B4.1 service_charge_percent_snapshot="150" rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).service_charge_percent_snapshot = '150';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P15 service_charge_percent_snapshot="150" ditolak (> 100)');
}

// ── P16: B4.1 enabled_snapshot as non-boolean is REJECTED ───────────────
console.log('\n--- P16: B4.1 service_charge_enabled_snapshot="true" (string) rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).service_charge_enabled_snapshot = 'true'; // string, not boolean
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P16 service_charge_enabled_snapshot="true" (string) ditolak');
}

// ── P17: B4.1 negative service_amount is REJECTED ──────────────────────
console.log('\n--- P17: B4.1 service_amount="-100" rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).service_amount = '-100';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P17 service_amount="-100" ditolak (negatif)');
}

// ── P18: each of the six B4.1 fields missing individually is REJECTED ─
console.log('\n--- P18: each B4.1 snapshot field missing one-by-one rejected ---');
{
  const fieldKeys: Array<{ key: string; label: string }> = [
    { key: 'service_amount', label: 'P18a service_amount missing' },
    { key: 'tax_amount', label: 'P18b tax_amount missing' },
    { key: 'service_charge_percent_snapshot', label: 'P18c service_charge_percent_snapshot missing' },
    { key: 'tax_percent_snapshot', label: 'P18d tax_percent_snapshot missing' },
    { key: 'service_charge_enabled_snapshot', label: 'P18e service_charge_enabled_snapshot missing' },
    { key: 'tax_enabled_snapshot', label: 'P18f tax_enabled_snapshot missing' },
  ];
  for (const { key, label } of fieldKeys) {
    const payload = validPayload();
    delete (payload.data.order as Record<string, unknown>)[key];
    let threw = false;
    try {
      await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
    } catch {
      threw = true;
    }
    check(threw, label + ' → ditolak');
  }
}

// ── P19: percent snapshot with leading whitespace is REJECTED ─────────
console.log('\n--- P19: B4.1 percent snapshot " 10" (leading whitespace) rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).service_charge_percent_snapshot = ' 10';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P19 service_charge_percent_snapshot=" 10" (leading whitespace) ditolak');
}

// ── P20: percent snapshot with trailing whitespace is REJECTED ───────
console.log('\n--- P20: B4.1 percent snapshot "10 " (trailing whitespace) rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).tax_percent_snapshot = '10 ';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P20 tax_percent_snapshot="10 " (trailing whitespace) ditolak');
}

// ── P21: percent snapshot whitespace-only is REJECTED ────────────────
console.log('\n--- P21: B4.1 percent snapshot "   " (whitespace-only) rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).service_charge_percent_snapshot = '   ';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P21 service_charge_percent_snapshot="   " (whitespace-only) ditolak');
}

// ── P22: percent snapshot exponent form is REJECTED ──────────────────
console.log('\n--- P22: B4.1 percent snapshot "1e2" (exponent) rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).service_charge_percent_snapshot = '1e2';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P22 service_charge_percent_snapshot="1e2" (exponent) ditolak');
}

// ── P23: percent snapshot NaN string is REJECTED ─────────────────────
console.log('\n--- P23: B4.1 percent snapshot "NaN" rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).tax_percent_snapshot = 'NaN';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P23 tax_percent_snapshot="NaN" ditolak');
}

// ── P24: percent snapshot Infinity string is REJECTED ────────────────
console.log('\n--- P24: B4.1 percent snapshot "Infinity" rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).service_charge_percent_snapshot = 'Infinity';
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P24 service_charge_percent_snapshot="Infinity" ditolak');
}

// ── P25: enabled snapshot as 0/1 number is REJECTED ──────────────────
console.log('\n--- P25: B4.1 enabled snapshot=1 (number, bukan boolean) rejected ---');
{
  const payload = validPayload();
  (payload.data.order as any).service_charge_enabled_snapshot = 1; // number, not boolean
  let threw = false;
  try {
    await fetchPosReceipt(ORDER_ID, PROPERTY_ID, fakeFetch(payload));
  } catch {
    threw = true;
  }
  check(threw, 'P25 service_charge_enabled_snapshot=1 (number) ditolak');
}

console.log(
  '\n[RESULT] ' + assertions + ' PASS, ' +
    (assertions === 0 ? 0 : 0) +
    ' FAIL',
);
console.log('[CLEANUP/RESIDUE] 0 — tidak ada fixture DB.');
