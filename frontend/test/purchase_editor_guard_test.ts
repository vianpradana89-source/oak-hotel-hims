import assert from 'node:assert/strict';
import {
  canSubmitPurchaseCreate,
  PURCHASE_FORM_OPTIONS_ERROR,
} from '../src/features/transactions/purchaseEditorGuard.ts';

let assertions = 0;
function check(condition: unknown, message: string) {
  assert.ok(condition, message);
  assertions += 1;
}

const categories = [{ id: 11 }, { id: 22 }];

check(
  PURCHASE_FORM_OPTIONS_ERROR.includes('Gagal memuat kategori/departemen pembelian'),
  'L. visible options-load error copy'
);
check(
  PURCHASE_FORM_OPTIONS_ERROR.includes('Muat ulang sebelum menyimpan'),
  'L. retry instruction present'
);

check(
  canSubmitPurchaseCreate({
    optionsFailed: true,
    optionsLoaded: false,
    categories,
    categoryId: 11,
  }) === false,
  'M. save disabled when options failed'
);

check(
  canSubmitPurchaseCreate({
    optionsFailed: false,
    optionsLoaded: false,
    categories,
    categoryId: 11,
  }) === false,
  'M. save disabled while options not loaded'
);

check(
  canSubmitPurchaseCreate({
    optionsFailed: false,
    optionsLoaded: true,
    categories: [],
    categoryId: '',
  }) === false,
  'N. save disabled when no categories'
);

check(
  canSubmitPurchaseCreate({
    optionsFailed: false,
    optionsLoaded: true,
    categories,
    categoryId: '',
  }) === false,
  'N. save disabled when no category selected'
);

check(
  canSubmitPurchaseCreate({
    optionsFailed: false,
    optionsLoaded: true,
    categories,
    categoryId: 99,
  }) === false,
  'N. save disabled when selected id is not in options'
);

check(
  canSubmitPurchaseCreate({
    optionsFailed: false,
    optionsLoaded: true,
    categories,
    categoryId: 11,
  }) === true,
  'N. save enabled with valid canonical category'
);

console.log(`PASS | PURCHASE-1C1 editor guard | ${assertions} assertions`);
