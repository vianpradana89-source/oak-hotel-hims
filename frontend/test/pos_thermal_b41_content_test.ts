/**
 * B4.1 — POS Thermal Receipt Content: service charge & PPN rendering tests.
 *
 * Uses react-dom/server renderToString to verify:
 *  T1: receipt with service + PPN → both lines shown with correct amounts
 *  T2: service-only → PPN line absent
 *  T3: tax-only → service line absent
 *  T4: legacy zero / no B4.1 fields → no service/PPN lines
 *  T5: percent snapshots shown alongside amount when present
 *
 * Run: cd frontend && npx tsx test/pos_thermal_b41_content_test.ts
 */
import assert from 'node:assert/strict';
import { renderToString } from 'react-dom/server';
import React from 'react';
import PosThermalReceiptContent from '../src/features/thermalReceipt/PosThermalReceiptContent.tsx';
import type { PosReceiptData } from '../src/features/pos/posReceiptTypes';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

// ── Base receipt fixture ─────────────────────────────────────────────
const baseReceipt: PosReceiptData = {
  property: {
    id: 1,
    name: 'OAK Hotel Test',
    property_code: 'OAK-T',
    address: 'Jl. Test 1',
    phone: '+62211234567',
    timezone: 'Asia/Jakarta',
    currency: 'IDR',
    branding: null,
  },
  order: {
    id: 100,
    order_number: 'ORD-B41',
    property_id: 1,
    status: 'PAID',
    guest_name: 'Tamu',
    guest_phone: '08123456789',
    table_number: 'T01',
    notes: null,
    total_amount: '150000',
    discount_type: null,
    discount_value: null,
    discount_reason: null,
    discount_amount: '0',
    // B4.1 legacy zero
    service_amount: '0',
    tax_amount: '0',
    service_charge_percent_snapshot: '0',
    tax_percent_snapshot: '0',
    service_charge_enabled_snapshot: false,
    tax_enabled_snapshot: false,
    created_at: '2026-01-15T10:00:00Z',
    updated_at: '2026-01-15T10:00:00Z',
  },
  items: [
    {
      id: 1,
      menu_item_id: 10,
      item_name_snapshot: 'Nasi Goreng',
      item_code_snapshot: 'NG-01',
      quantity: 1,
      unit_price: '100000',
      notes: null,
      discount_type: null,
      discount_value: null,
      discount_amount: '0',
    },
  ],
  settlement: {
    id: 200,
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
    id: '999',
    transaction_no: 'TRX-B41',
    transaction_type: 'SALE',
    source_type: 'POS_ORDER',
    source_id: '100',
    payment_status: 'PAID',
    payment_method: 'CASH',
    net_amount: '150000',
    created_at: '2026-01-15T10:05:00Z',
  },
};

function render(receipt: PosReceiptData): string {
  return renderToString(
    React.createElement(PosThermalReceiptContent, {
      receipt,
      width: '58',
      printedBy: 'Receptionist',
      printedAt: '2026-01-15T10:10:00Z',
    }),
  );
}

// ── T1: service + PPN both active ────────────────────────────────────
console.log('--- T1: service + PPN both active ---');
{
  const receipt: PosReceiptData = {
    ...baseReceipt,
    order: {
      ...baseReceipt.order,
      service_amount: '15000',
      tax_amount: '14850',
      service_charge_percent_snapshot: '10',
      tax_percent_snapshot: '11',
      service_charge_enabled_snapshot: true,
      tax_enabled_snapshot: true,
    },
  };
  const html = render(receipt);
  check(html.includes('Service Charge'), 'T1a "Service Charge" label present');
  check(html.includes('15.000'), 'T1b service amount 15.000 formatted');
  check(html.includes('(10%)'), 'T1c service percent "(10%)" shown');
  check(html.includes('PPN'), 'T1d "PPN" label present');
  check(html.includes('14.850'), 'T1e tax amount 14.850 formatted');
  check(html.includes('(11%)'), 'T1f tax percent "(11%)" shown');
}

// ── T2: service-only (tax = 0) → PPN line absent ────────────────────
console.log('\n--- T2: service-only (tax=0) ---');
{
  const receipt: PosReceiptData = {
    ...baseReceipt,
    order: {
      ...baseReceipt.order,
      service_amount: '15000',
      tax_amount: '0',
      service_charge_percent_snapshot: '10',
      tax_percent_snapshot: '0',
      service_charge_enabled_snapshot: true,
      tax_enabled_snapshot: false,
    },
  };
  const html = render(receipt);
  check(html.includes('Service Charge'), 'T2a service line shown');
  check(!html.includes('PPN'), 'T2b PPN line absent when tax_amount="0"');
}

// ── T3: tax-only (service = 0) → service line absent ────────────────
console.log('\n--- T3: tax-only (service=0) ---');
{
  const receipt: PosReceiptData = {
    ...baseReceipt,
    order: {
      ...baseReceipt.order,
      service_amount: '0',
      tax_amount: '14850',
      service_charge_percent_snapshot: '0',
      tax_percent_snapshot: '11',
      service_charge_enabled_snapshot: false,
      tax_enabled_snapshot: true,
    },
  };
  const html = render(receipt);
  check(!html.includes('Service Charge'), 'T3a service line absent when service_amount="0"');
  check(html.includes('PPN'), 'T3b PPN line shown when tax_amount>0');
}

// ── T4: legacy receipt (all zero / no B4.1 fields) ──────────────────
// NOTE: T4c/T4d are DEFENSIVE RENDERING tests only. They simulate a
// scenario where B4.1 fields are absent at runtime to prove the UI does
// not crash. The API contract (PosReceiptOrder) requires all six fields;
// a real receipt response will never omit them. These tests verify
// graceful degradation, NOT a valid payload.
console.log('\n--- T4: legacy receipt (all-zero / absent B4.1 fields) ---');
{
  // baseReceipt has service_amount="0", tax_amount="0" → no lines
  const html = render(baseReceipt);
  check(!html.includes('Service Charge'), 'T4a no service line for legacy zero');
  check(!html.includes('PPN'), 'T4b no PPN line for legacy zero');

  // Defensive variant: B4.1 fields stripped at runtime to simulate crash safety.
  // This is NOT a valid API payload — PosReceiptOrder requires all six fields.
  const receiptLegacyNoFields = baseReceipt as unknown as PosReceiptData & {
    order: { service_amount?: undefined; tax_amount?: undefined; service_charge_percent_snapshot?: undefined; tax_percent_snapshot?: undefined; service_charge_enabled_snapshot?: undefined; tax_enabled_snapshot?: undefined };
  };
  (receiptLegacyNoFields.order as any).service_amount = undefined;
  (receiptLegacyNoFields.order as any).tax_amount = undefined;
  (receiptLegacyNoFields.order as any).service_charge_percent_snapshot = undefined;
  (receiptLegacyNoFields.order as any).tax_percent_snapshot = undefined;
  (receiptLegacyNoFields.order as any).service_charge_enabled_snapshot = undefined;
  (receiptLegacyNoFields.order as any).tax_enabled_snapshot = undefined;
  const htmlNoFields = render(receiptLegacyNoFields);
  check(!htmlNoFields.includes('Service Charge'), 'T4c no service line when field absent (defensive)');
  check(!htmlNoFields.includes('PPN'), 'T4d no PPN line when field absent (defensive)');
}

// ── T5: percent not shown when percent field is undefined ───────────
// NOTE: T5 is a DEFENSIVE RENDERING test. It verifies the thermal UI
// omits the percent suffix gracefully when the percent snapshot field
// is missing at runtime, even though the API contract requires it.
console.log('\n--- T5: percent snapshot absent → amount only, no percent suffix (defensive) ---');
{
  const receipt = baseReceipt as unknown as PosReceiptData;
  (receipt.order as any).service_amount = '15000';
  (receipt.order as any).tax_amount = '0';
  // percent snapshots stripped at runtime — defensive rendering test only
  (receipt.order as any).service_charge_percent_snapshot = undefined;
  (receipt.order as any).tax_percent_snapshot = undefined;
  (receipt.order as any).service_charge_enabled_snapshot = true;
  (receipt.order as any).tax_enabled_snapshot = false;
  const html = render(receipt);
  check(html.includes('Service Charge'), 'T5a service line still shown (defensive)');
  // The amount "15.000" is there but no "(…%)" suffix for service
  const svcIdx = html.indexOf('Service Charge');
  const svcLine = html.slice(svcIdx, svcIdx + 200);
  check(!svcLine.includes('(10%)'), 'T5b no percent suffix when percent field absent (defensive)');
}

console.log(`\n=== ${assertions} assertions passed ===`);
