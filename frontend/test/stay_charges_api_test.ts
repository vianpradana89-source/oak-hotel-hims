import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseStayChargeResponse,
  toStayChargeWritePayload,
  normalizeStayChargeRule,
  toStayChargeEditForm
} from '../src/features/stayCharges/stayChargeFieldMap.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== OAK HIMS Stay-Charge Edit Client Contract Tests ===\n');

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = readFileSync(join(here, '../src/features/stayCharges/stayChargesApi.ts'), 'utf8');
check(apiSrc.includes("method: 'PATCH'"), 'updateStayChargeRule uses PATCH');
check(!/method:\s*'PUT'/.test(apiSrc), 'stayChargesApi has no PUT mutation');
check(apiSrc.includes('parseStayChargeResponse'), 'stayChargesApi uses the safe parser');
check(apiSrc.includes('toStayChargeWritePayload'), 'stayChargesApi maps UI fields to backend names');
check(apiSrc.includes('${API_BASE}/rules/${id}'), 'client update hits /api/stay-charges/rules/:id');

const writePayload = toStayChargeWritePayload({
  property_id: 4,
  charge_type: 'EXTRA_BED',
  code: 'EXTRA_BED_STD',
  name: 'Extra Bed Standard',
  calculation_type: 'FIXED',
  default_amount: 175000,
  percentage_of_rate: 0,
  is_taxable: true,
  is_service_chargeable: true,
  is_active: true,
  display_order: 3
});
check(writePayload.charge_method === 'FIXED_AMOUNT', 'calculation_type FIXED maps to charge_method FIXED_AMOUNT');
check(writePayload.percentage_rate === 0, 'percentage_of_rate maps to percentage_rate');
check(writePayload.taxable === true, 'is_taxable maps to taxable');
check(writePayload.service_chargeable === true, 'is_service_chargeable maps to service_chargeable');
check(writePayload.sort_order === 3, 'display_order maps to sort_order');
check(writePayload.default_amount === 175000, 'default_amount is preserved');

const htmlRes = new Response('<!DOCTYPE html><html><body>Cannot PUT /api/stay-charges/rules/1</body></html>', {
  status: 404,
  headers: { 'Content-Type': 'text/html; charset=utf-8' }
});
await assert.rejects(
  () => parseStayChargeResponse(htmlRes, 'Gagal memperbarui aturan stay charge'),
  (err: any) => {
    check(!String(err.message).includes('Unexpected token'), 'HTML error does not surface JSON parse text');
    check(String(err.message).includes('HTTP 404'), 'HTML error includes HTTP status');
    return true;
  }
);

const normalized = normalizeStayChargeRule({
  id: 9,
  property_id: 4,
  charge_type: 'EXTRA_BED',
  code: 'EXTRA_BED_STD',
  name: 'Extra Bed Standard',
  charge_method: 'FIXED_AMOUNT',
  default_amount: 175000,
  percentage_rate: 0,
  taxable: true,
  service_chargeable: true,
  is_active: true,
  is_archived: false,
  sort_order: 1
});
check(normalized.default_amount === 175000, 'normalized response keeps default_amount');
check(normalized.calculation_type === 'FIXED', 'GET-shaped response maps charge_method to calculation_type');
check(normalized.is_taxable === true, 'GET-shaped response maps taxable to is_taxable');
check(normalized.is_service_chargeable === true, 'GET-shaped response maps service_chargeable');
check(normalized.display_order === 1, 'GET-shaped response maps sort_order to display_order');

const editForm = toStayChargeEditForm(normalized);
check(editForm.calculation_type === 'FIXED', 'edit form loads calculation_type from normalized rule');
check(editForm.is_taxable === true, 'edit form loads is_taxable from normalized rule');
check(editForm.is_service_chargeable === true, 'edit form loads is_service_chargeable from normalized rule');
check(editForm.default_amount === 175000, 'edit form loads default_amount');

console.log(`\n=== PASSED: ${assertions} assertions ===`);
