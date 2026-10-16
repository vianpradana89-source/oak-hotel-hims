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

console.log(
  '\n[RESULT] ' + assertions + ' PASS, ' +
    (assertions === 0 ? 0 : 0) +
    ' FAIL',
);
console.log('[CLEANUP/RESIDUE] 0 — tidak ada fixture DB.');
