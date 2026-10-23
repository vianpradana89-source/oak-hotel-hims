'use strict';

/**
 * Backend Regression & Contract Test — Master Produk Tahap 1
 *
 * Menguji kontrak Tahap 1 Master Produk tanpa menyentuh database live atau .env:
 *  1. Klasifikasi (product_type, product_kind aktif vs roadmap, base_unit)
 *  2. Kompatibilitas data lama (NULL -> "Belum diatur", default is_sellable_pos = true)
 *  3. Aturan Harga & Dijual di POS (is_sellable_pos = true wajib harga Rupiah utuh >= 0;
 *     is_sellable_pos = false boleh price = null; harga 0 harus eksplisit)
 *  4. Guard POST /api/pos/orders terhadap produk internal (MENU_ITEM_NOT_SELLABLE)
 *     dan harga tidak valid (MENU_ITEM_PRICE_INVALID)
 *  5. Guard PUT /api/pos/orders/:id pada baris baru vs preservasi snapshot baris existing
 *  6. Kontrak DDL migration product_master_stage1_v1 (mock client)
 */

const assert = require('assert');
const {
  PRODUCT_TYPE_LABELS,
  PRODUCT_KIND_LABELS,
  ROADMAP_PRODUCT_KINDS,
  parseProductTypeInput,
  parseProductKindInput,
  parseBaseUnitInput,
  parseBarcodeInput,
  parseIsSellablePosInput,
  parsePriceInput,
  validateEffectiveSellablePrice,
  parseProductTypeQueryFilter,
  formatPosMenuItemRow,
  createPosMenuItemPatchHandler,
  createPosMenuItemCreateHandler,
  createPosMenuItemDeactivateHandler,
} = require('../dist/domains/pos/productMasterStage1');
const {
  MAX_PRODUCT_PHOTO_BYTES,
  isProductPhotoStorageKey,
  hasValidImageSignature,
  validateProductPhotoBuffer,
  createProductPhotoUploadHandler,
  createProductPhotoDeleteHandler,
  createProductPhotoGetHandler,
} = require('../dist/domains/pos/productPhotoStorage');
const { createPosOrderCreateHandler } = require('../dist/domains/pos/posOrderCreateHandler');
const { createPosOrderUpdateHandler } = require('../dist/domains/pos/posOrderUpdateHandler');
const { runProductMasterStage1Migration } = require('../dist/db/migrations/product_master_stage1_v1');
const {
  runProductMasterMp02bMigration,
  runProductMasterMp02bMigrationCli,
} = require('../dist/db/migrations/product_master_mp02b_v1');
const {
  runProductMasterMp03cMigration,
  runProductMasterMp03cMigrationCli,
} = require('../dist/db/migrations/product_master_mp03c_v1');
const {
  SYSTEM_CANONICAL_UNITS,
  CANONICAL_UNIT_CODES,
  STOCK_LOCATION_TYPES,
  getCanonicalUnitByCode,
  matchCanonicalUnitByText,
  isTextEquivalentToCanonicalUnit,
  milliToDecimalString,
  parseStrictDecimalString,
  parsePackagingFactorInput,
  parseCanonicalQuantityInput,
  convertPackagingToBaseQuantity,
  convertIntraDimensionQuantity,
  resolveCreateProductUnitInput,
  resolvePatchProductUnitMutation,
  checkProductBaseUnitLockStatus,
  fetchPropertyPackagingsByItem,
  createProductPackagingListHandler,
  createProductPackagingCreateHandler,
  createProductPackagingPatchHandler,
  createStockLocationListHandler,
  createStockLocationRoomCandidatesHandler,
  createStockLocationCreateHandler,
  createStockLocationPatchHandler,
} = require('../dist/domains/pos/productUnitsAndLocations');
const {
  OPERATIONAL_ACCESS_RULES,
  matchOperationalAccessRule,
} = require('../dist/domains/settings/operationalAccessGuard');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.stack ? err.stack : err}`);
  }
}

function makeMockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    sentBuffer: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.sentBuffer = payload;
      return this;
    },
  };
}

async function main() {
  console.log('=== Master Produk Tahap 1 — Backend Contract & Handler Tests ===\n');

  // ── 1. Klasifikasi & Satuan Dasar ──────────────────────────────────────────
  await test('T1.1 parseProductTypeInput menerima tipe valid, null/kosong -> null, undefined -> undefined, dan menolak nilai asing', () => {
    assert.strictEqual(parseProductTypeInput(undefined).value, undefined);
    assert.strictEqual(parseProductTypeInput(null).value, null);
    assert.strictEqual(parseProductTypeInput('').value, null);
    assert.strictEqual(parseProductTypeInput('  ').value, null);
    assert.strictEqual(parseProductTypeInput('RAW_MATERIAL').value, 'RAW_MATERIAL');
    assert.strictEqual(parseProductTypeInput('semi_finished').value, 'SEMI_FINISHED');
    assert.strictEqual(parseProductTypeInput('FINISHED_GOOD').value, 'FINISHED_GOOD');

    const bad = parseProductTypeInput('BEVERAGE');
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.message.includes('product_type'));
  });

  await test('T1.2 parseProductKindInput hanya mengizinkan STANDARD (Biasa) atau null, serta menolak jenis roadmap', () => {
    assert.strictEqual(parseProductKindInput(undefined).value, undefined);
    assert.strictEqual(parseProductKindInput(null).value, null);
    assert.strictEqual(parseProductKindInput('').value, null);
    assert.strictEqual(parseProductKindInput('STANDARD').value, 'STANDARD');
    assert.strictEqual(parseProductKindInput('standard').value, 'STANDARD');

    for (const rk of ROADMAP_PRODUCT_KINDS) {
      const res = parseProductKindInput(rk);
      assert.strictEqual(res.ok, false, `Roadmap kind ${rk} harus ditolak pada Tahap 1`);
      assert.ok(res.message.includes('roadmap'), `Pesan error ${rk} harus menyebut roadmap`);
    }

    const unknown = parseProductKindInput('CUSTOM_KIND');
    assert.strictEqual(unknown.ok, false);
  });

  await test('T1.3 parseBaseUnitInput memvalidasi satuan dasar 1..50 karakter dan tidak menebak nilai kosong', () => {
    assert.strictEqual(parseBaseUnitInput(undefined).value, undefined);
    assert.strictEqual(parseBaseUnitInput(null).value, null);
    assert.strictEqual(parseBaseUnitInput('   ').value, null);
    assert.strictEqual(parseBaseUnitInput(' porsi ').value, 'porsi');
    assert.strictEqual(parseBaseUnitInput('gram').value, 'gram');

    const tooLong = parseBaseUnitInput('x'.repeat(51));
    assert.strictEqual(tooLong.ok, false);
    const nonStr = parseBaseUnitInput(123);
    assert.strictEqual(nonStr.ok, false);
  });

  await test('T1.4 parseIsSellablePosInput mewajibkan boolean strict bila dikirim', () => {
    assert.strictEqual(parseIsSellablePosInput(undefined).value, undefined);
    assert.strictEqual(parseIsSellablePosInput(true).value, true);
    assert.strictEqual(parseIsSellablePosInput(false).value, false);
    assert.strictEqual(parseIsSellablePosInput('true').ok, false);
    assert.strictEqual(parseIsSellablePosInput(1).ok, false);
    assert.strictEqual(parseIsSellablePosInput(null).ok, false);
  });

  // ── 2. Harga Jual vs Internal ──────────────────────────────────────────────
  await test('T2.1 parsePriceInput & validateEffectiveSellablePrice: produk jual wajib Rupiah utuh >= 0, produk internal boleh null', () => {
    assert.strictEqual(parsePriceInput(undefined).value, undefined);
    assert.strictEqual(parsePriceInput(null).value, null);
    assert.strictEqual(parsePriceInput(0).value, 0);
    assert.strictEqual(parsePriceInput('0').value, 0);
    assert.strictEqual(parsePriceInput(25000).value, 25000);
    assert.strictEqual(parsePriceInput('25000.00').value, 25000);

    // String kosong, pecahan, negatif, atau NaN ditolak
    assert.strictEqual(parsePriceInput('').ok, false);
    assert.strictEqual(parsePriceInput(12500.5).ok, false);
    assert.strictEqual(parsePriceInput(-1).ok, false);
    assert.strictEqual(parsePriceInput('gratis').ok, false);
    assert.strictEqual(parsePriceInput(true).ok, false);

    // Kombinasi dengan is_sellable_pos
    assert.strictEqual(validateEffectiveSellablePrice(true, 25000).ok, true);
    assert.strictEqual(validateEffectiveSellablePrice(true, 0).ok, true);
    assert.strictEqual(validateEffectiveSellablePrice(true, null).ok, false);
    assert.strictEqual(validateEffectiveSellablePrice(false, null).ok, true);
    assert.strictEqual(validateEffectiveSellablePrice(false, 15000).ok, true);
  });

  await test('T2.2 formatPosMenuItemRow menampilkan "Belum diatur" untuk atribut NULL dan mempertahankan price: null tanpa mengubah jadi 0', () => {
    const legacyRow = formatPosMenuItemRow({
      id: 10,
      property_id: 1,
      category_id: 2,
      category_name: 'Food',
      item_code: 'FD-01',
      name: 'Nasi Goreng Legacy',
      price: '35000.00',
      is_active: true,
      is_sellable_pos: true,
      product_type: null,
      product_kind: null,
      base_unit: null,
    });
    assert.strictEqual(legacyRow.price, 35000);
    assert.strictEqual(legacyRow.is_sellable_pos, true);
    assert.strictEqual(legacyRow.product_type, null);
    assert.strictEqual(legacyRow.product_type_label, 'Belum diatur');
    assert.strictEqual(legacyRow.product_kind, null);
    assert.strictEqual(legacyRow.product_kind_label, 'Belum diatur');
    assert.strictEqual(legacyRow.base_unit, null);

    const internalRow = formatPosMenuItemRow({
      id: 11,
      property_id: 1,
      category_id: null,
      category_name: null,
      item_code: 'RM-01',
      name: 'Beras Premium',
      price: null,
      is_active: true,
      is_sellable_pos: false,
      product_type: 'RAW_MATERIAL',
      product_kind: 'STANDARD',
      base_unit: 'kg',
    });
    assert.strictEqual(internalRow.price, null);
    assert.strictEqual(internalRow.is_sellable_pos, false);
    assert.strictEqual(internalRow.product_type, 'RAW_MATERIAL');
    assert.strictEqual(internalRow.product_type_label, PRODUCT_TYPE_LABELS.RAW_MATERIAL);
    assert.strictEqual(internalRow.product_kind, 'STANDARD');
    assert.strictEqual(internalRow.product_kind_label, PRODUCT_KIND_LABELS.STANDARD);
    assert.strictEqual(internalRow.base_unit, 'kg');
  });

  await test('T2.3 parseProductTypeQueryFilter memvalidasi filter query GET /api/pos/menu', () => {
    assert.strictEqual(parseProductTypeQueryFilter(undefined).filter, 'ALL');
    assert.strictEqual(parseProductTypeQueryFilter('all').filter, 'ALL');
    assert.strictEqual(parseProductTypeQueryFilter('UNSET').filter, 'UNSET');
    assert.strictEqual(parseProductTypeQueryFilter('NULL').filter, 'UNSET');
    assert.strictEqual(parseProductTypeQueryFilter('RAW_MATERIAL').filter, 'RAW_MATERIAL');
    assert.strictEqual(parseProductTypeQueryFilter('SEMI_FINISHED').filter, 'SEMI_FINISHED');
    assert.strictEqual(parseProductTypeQueryFilter('FINISHED_GOOD').filter, 'FINISHED_GOOD');
    assert.strictEqual(parseProductTypeQueryFilter('INVALID').ok, false);
  });

  // ── 3. Guard POST /api/pos/orders ──────────────────────────────────────────
  await test('T3.1 POST /api/pos/orders menolak produk internal (is_sellable_pos = false) dengan 400 MENU_ITEM_NOT_SELLABLE', async () => {
    const queries = [];
    const mockClient = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql.includes('SELECT id FROM properties')) {
          return { rowCount: 1, rows: [{ id: 1 }] };
        }
        if (sql.includes('FROM pos_menu_items WHERE id = $1 AND is_active = TRUE')) {
          return {
            rowCount: 1,
            rows: [{
              id: 501,
              property_id: 1,
              name: 'Kaldu Dasar Internal',
              item_code: 'SF-501',
              price: 15000,
              is_active: true,
              is_sellable_pos: false,
            }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
      release() {},
    };

    const handler = createPosOrderCreateHandler({
      pool: {},
      connect: async () => mockClient,
      release: () => {},
      assertPropertyScope: async () => {},
      broadcastEvent: () => {},
      checkDiscountPermission: async () => true,
    });

    const req = {
      headers: {},
      body: {
        property_id: 1,
        table_number: 'T1',
        guest_name: 'Tamu Uji',
        items: [{ menu_item_id: 501, quantity: 1 }],
      },
      user: { id: 1 },
    };
    const res = makeMockRes();
    await handler(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'MENU_ITEM_NOT_SELLABLE');
    assert.ok(queries.some((q) => q.sql === 'ROLLBACK'), 'Transaksi wajib ROLLBACK');
  });

  await test('T3.2 POST /api/pos/orders menolak produk tanpa harga jual valid (price = null) dengan 400 MENU_ITEM_PRICE_INVALID', async () => {
    const queries = [];
    const mockClient = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql.includes('SELECT id FROM properties')) {
          return { rowCount: 1, rows: [{ id: 1 }] };
        }
        if (sql.includes('FROM pos_menu_items WHERE id = $1 AND is_active = TRUE')) {
          return {
            rowCount: 1,
            rows: [{
              id: 502,
              property_id: 1,
              name: 'Item Tanpa Harga',
              item_code: 'IT-502',
              price: null,
              is_active: true,
              is_sellable_pos: true,
            }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
      release() {},
    };

    const handler = createPosOrderCreateHandler({
      pool: {},
      connect: async () => mockClient,
      release: () => {},
      assertPropertyScope: async () => {},
      broadcastEvent: () => {},
      checkDiscountPermission: async () => true,
    });

    const req = {
      headers: {},
      body: {
        property_id: 1,
        items: [{ menu_item_id: 502, quantity: 1 }],
      },
      user: { id: 1 },
    };
    const res = makeMockRes();
    await handler(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'MENU_ITEM_PRICE_INVALID');
    assert.ok(queries.some((q) => q.sql === 'ROLLBACK'), 'Transaksi wajib ROLLBACK');
  });

  // ── 4. Guard PUT /api/pos/orders/:id ───────────────────────────────────────
  function createUpdateHarness({ menuItemsById, existingOrderItems }) {
    const queries = [];
    const currentItems = existingOrderItems.map((it) => ({ ...it }));
    let nextItemId = 900;

    const mockClient = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('FROM pos_orders') && sql.includes('FOR UPDATE')) {
          return {
            rowCount: 1,
            rows: [{
              id: 77,
              property_id: 1,
              status: 'OPEN',
              version: 1,
              total_amount: 30000,
              discount_type: null,
              discount_value: null,
              discount_reason: null,
              discount_amount: 0,
              service_charge_percent_snapshot: 0,
              tax_percent_snapshot: 0,
              service_charge_enabled_snapshot: false,
              tax_enabled_snapshot: false,
              service_amount: 0,
              tax_amount: 0,
            }],
          };
        }
        if (sql.includes('FROM pos_order_edit_requests') && sql.includes('SELECT')) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('FROM transactions')) {
          return { rowCount: 1, rows: [{ n: 0 }] };
        }
        if (sql.includes('FROM pos_settlements')) {
          return { rowCount: 1, rows: [{ n: 0 }] };
        }
        if (sql.includes('FROM pos_order_items') && sql.includes('SELECT id, menu_item_id, quantity, unit_price')) {
          return {
            rowCount: currentItems.length,
            rows: currentItems.map((r) => ({ ...r })),
          };
        }
        if (sql.includes('FROM pos_menu_items') && sql.includes('WHERE id = $1 AND property_id = $2')) {
          const item = menuItemsById.get(Number(params[0]));
          if (!item || Number(item.property_id) !== Number(params[1])) {
            return { rowCount: 0, rows: [] };
          }
          return { rowCount: 1, rows: [{ ...item }] };
        }
        if (sql.startsWith('UPDATE pos_order_items') && sql.includes('SET quantity = $1')) {
          const target = currentItems.find((r) => r.id === Number(params[4]));
          if (target) {
            target.quantity = Number(params[0]);
            target.discount_type = params[1];
            target.discount_value = params[2];
            target.notes = params[3];
          }
          return { rowCount: 1, rows: [] };
        }
        if (sql.startsWith('INSERT INTO pos_order_items')) {
          const newId = ++nextItemId;
          currentItems.push({
            id: newId,
            menu_item_id: Number(params[1]),
            quantity: Number(params[2]),
            unit_price: Number(params[3]),
            discount_type: params[4],
            discount_value: params[5],
            discount_amount: 0,
            notes: params[6],
          });
          return { rowCount: 1, rows: [{ id: newId }] };
        }
        if (sql.includes('SELECT id, quantity, unit_price, discount_type, discount_value') && sql.includes('FROM pos_order_items')) {
          return {
            rowCount: currentItems.length,
            rows: currentItems.map((r) => ({ ...r })),
          };
        }
        return { rowCount: 1, rows: [] };
      },
      release() {},
    };

    const handler = createPosOrderUpdateHandler({
      pool: {},
      connect: async () => mockClient,
      release: () => {},
      assertPropertyScope: async () => {},
      broadcastEvent: () => {},
      checkDiscountPermission: async () => true,
    });

    return { handler, queries, currentItems };
  }

  await test('T4.1 PUT /api/pos/orders/:id menolak penambahan baris baru jika produk is_sellable_pos = false', async () => {
    const menuItemsById = new Map([
      [601, { id: 601, property_id: 1, name: 'Saus Rahasia Internal', item_code: 'SF-601', price: 10000, is_active: true, is_sellable_pos: false }],
    ]);
    const { handler, queries } = createUpdateHarness({
      menuItemsById,
      existingOrderItems: [
        { id: 101, menu_item_id: 200, quantity: 1, unit_price: 30000, discount_type: null, discount_value: null, discount_amount: 0, notes: null },
      ],
    });

    const req = {
      params: { id: '77' },
      headers: { 'idempotency-key': 'idem-stage1-not-sellable' },
      body: {
        property_id: 1,
        expected_version: 1,
        idempotency_key: 'idem-stage1-not-sellable',
        items: [
          { id: 101, menu_item_id: 200, quantity: 1 },
          { menu_item_id: 601, quantity: 1 },
        ],
      },
      user: { id: 1 },
    };
    const res = makeMockRes();
    await handler(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'MENU_ITEM_NOT_SELLABLE');
    assert.ok(queries.some((q) => q.sql === 'ROLLBACK'));
  });

  await test('T4.2 PUT /api/pos/orders/:id tetap mengizinkan edit baris existing meskipun produk masternya telah berubah menjadi internal (snapshot harga dipertahankan)', async () => {
    const menuItemsById = new Map([
      // Produk 200 sekarang diubah jadi internal dan tanpa harga jual
      [200, { id: 200, property_id: 1, name: 'Menu Lama Jadi Internal', item_code: 'MN-200', price: null, is_active: true, is_sellable_pos: false }],
    ]);
    const { handler } = createUpdateHarness({
      menuItemsById,
      existingOrderItems: [
        { id: 101, menu_item_id: 200, quantity: 1, unit_price: 30000, discount_type: null, discount_value: null, discount_amount: 0, notes: null },
      ],
    });

    const req = {
      params: { id: '77' },
      headers: { 'idempotency-key': 'idem-stage1-preserve-existing' },
      body: {
        property_id: 1,
        expected_version: 1,
        idempotency_key: 'idem-stage1-preserve-existing',
        items: [
          { id: 101, menu_item_id: 200, quantity: 2, notes: 'Tambah porsi baris existing' },
        ],
      },
      user: { id: 1 },
    };
    const res = makeMockRes();
    await handler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, 'OK');
    assert.strictEqual(res.body.data.order.total_amount, 60000);
    assert.strictEqual(res.body.data.order.version, 2);
  });

  // ── 5. Migration Contract ──────────────────────────────────────────────────
  await test('T5.1 runProductMasterStage1Migration mengeksekusi DDL additive tanpa mengubah atau membulatkan nilai price existing', async () => {
    const executedSql = [];
    const mockPool = {
      async connect() {
        return {
          async query(sql) {
            const text = typeof sql === 'string' ? sql.trim() : '';
            executedSql.push(text);
            if (text.includes('FROM information_schema.tables')) {
              return { rowCount: 1, rows: [{ '?column?': 1 }] };
            }
            if (text.includes('FROM information_schema.columns')) {
              return {
                rowCount: 5,
                rows: [
                  { column_name: 'is_sellable_pos', is_nullable: 'NO' },
                  { column_name: 'product_type', is_nullable: 'YES' },
                  { column_name: 'product_kind', is_nullable: 'YES' },
                  { column_name: 'base_unit', is_nullable: 'YES' },
                  { column_name: 'price', is_nullable: 'YES' },
                ],
              };
            }
            return { rows: [], rowCount: 1 };
          },
          release() {},
        };
      },
    };

    await runProductMasterStage1Migration(mockPool);
    const joined = executedSql.join('\n');
    assert.ok(joined.includes('ADD COLUMN IF NOT EXISTS is_sellable_pos BOOLEAN NOT NULL DEFAULT TRUE'));
    assert.ok(joined.includes('ADD COLUMN IF NOT EXISTS product_type VARCHAR(30)'));
    assert.ok(joined.includes('ADD COLUMN IF NOT EXISTS product_kind VARCHAR(30)'));
    assert.ok(joined.includes('ADD COLUMN IF NOT EXISTS base_unit VARCHAR(50)'));
    assert.ok(joined.includes('ALTER COLUMN price DROP NOT NULL'));
    assert.ok(joined.includes('chk_pos_menu_items_price_sellable'));
    assert.ok(!joined.includes('ROUND('), 'Migration tidak boleh membulatkan harga existing secara otomatis');
  });

  // ── 6. Handler Produksi PATCH /api/pos/menu/items/:id ──────────────────────
  function createPatchItemHarness(initialRows) {
    const rowsById = new Map(initialRows.map((r) => [Number(r.id), { ...r }]));
    const executedQueries = [];

    function validateSqlPlaceholders(sql, params) {
      const boundParams = Array.isArray(params) ? params : [];
      const matches = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      if (boundParams.length === 0) {
        assert.strictEqual(matches.length, 0, `SQL tidak boleh memiliki placeholder bila params kosong: ${sql}`);
        return;
      }
      assert.ok(matches.length > 0, `SQL wajib memakai placeholder parameter terikat ($1..$N): ${sql}`);
      const maxIndex = Math.max(...matches);
      assert.strictEqual(
        maxIndex,
        boundParams.length,
        `Jumlah parameter (${boundParams.length}) harus sama dengan placeholder tertinggi ($${maxIndex}) pada SQL: ${sql}`
      );
      for (let i = 1; i <= boundParams.length; i++) {
        assert.ok(matches.includes(i), `Placeholder $${i} wajib digunakan dalam SQL: ${sql}`);
      }
    }

    const mockPool = {
      async query(sql, params = []) {
        const normalizedSql = String(sql).replace(/\s+/g, ' ').trim();
        executedQueries.push({ sql: normalizedSql, params: [...params] });
        validateSqlPlaceholders(normalizedSql, params);

        if (normalizedSql === 'SELECT is_sellable_pos FROM pos_menu_items WHERE id = $1 AND property_id = $2') {
          const row = rowsById.get(Number(params[0]));
          if (!row || Number(row.property_id) !== Number(params[1])) {
            return { rowCount: 0, rows: [] };
          }
          return { rowCount: 1, rows: [{ is_sellable_pos: row.is_sellable_pos }] };
        }

        if (normalizedSql === 'SELECT price FROM pos_menu_items WHERE id = $1 AND property_id = $2') {
          const row = rowsById.get(Number(params[0]));
          if (!row || Number(row.property_id) !== Number(params[1])) {
            return { rowCount: 0, rows: [] };
          }
          return { rowCount: 1, rows: [{ price: row.price }] };
        }

        if (normalizedSql === 'SELECT id FROM pos_menu_ items WHERE property_id = $1 AND item_code = $2 AND id != $3' ||
            normalizedSql === 'SELECT id FROM pos_menu_items WHERE property_id = $1 AND item_code = $2 AND id != $3') {
          for (const candidate of rowsById.values()) {
            if (
              Number(candidate.property_id) === Number(params[0]) &&
              candidate.item_code === params[1] &&
              Number(candidate.id) !== Number(params[2])
            ) {
              return { rowCount: 1, rows: [{ id: candidate.id }] };
            }
          }
          return { rowCount: 0, rows: [] };
        }

        if (normalizedSql === 'SELECT id FROM pos_menu_items WHERE property_id = $1 AND barcode = $2 AND id != $3') {
          for (const candidate of rowsById.values()) {
            if (
              Number(candidate.property_id) === Number(params[0]) &&
              candidate.barcode !== null &&
              candidate.barcode !== undefined &&
              candidate.barcode === params[1] &&
              Number(candidate.id) !== Number(params[2])
            ) {
              return { rowCount: 1, rows: [{ id: candidate.id }] };
            }
          }
          return { rowCount: 0, rows: [] };
        }

        const updateMatch = normalizedSql.match(
          /^UPDATE pos_menu_items SET (.+) WHERE id = \$(\d+) AND property_id = \$(\d+) RETURNING \*$/
        );
        if (updateMatch) {
          const setClauseStr = updateMatch[1];
          const idParamIdx = Number(updateMatch[2]);
          const propParamIdx = Number(updateMatch[3]);

          const assignments = setClauseStr.split(',').map((part) => part.trim());
          assert.ok(assignments.length > 0, 'SET clause tidak boleh kosong');

          const updatesToApply = {};
          assignments.forEach((assignStr, idx) => {
            const m = assignStr.match(/^([a-z_]+)\s*=\s*(.+)$/);
            assert.ok(m, `Format assignment SET tidak valid: ${assignStr}`);
            const colName = m[1];
            const rhs = m[2].trim();
            const phMatch = rhs.match(/^\$(\d+)$/);
            assert.ok(
              phMatch,
              `Assignment kolom "${colName}" wajib memakai placeholder parameter terikat ($N), ditemukan: "${assignStr}"`
            );
            const paramIndex = Number(phMatch[1]);
            assert.strictEqual(
              paramIndex,
              idx + 1,
              `Placeholder kolom "${colName}" harus berurutan ($${idx + 1}), ditemukan: $${paramIndex}`
            );
            updatesToApply[colName] = params[paramIndex - 1];
          });

          assert.strictEqual(idParamIdx, assignments.length + 1, 'Placeholder WHERE id harus tepat setelah SET');
          assert.strictEqual(propParamIdx, assignments.length + 2, 'Placeholder WHERE property_id harus tepat setelah id');

          const targetId = Number(params[idParamIdx - 1]);
          const targetPropId = Number(params[propParamIdx - 1]);
          const existing = rowsById.get(targetId);
          if (!existing || Number(existing.property_id) !== targetPropId) {
            return { rowCount: 0, rows: [] };
          }

          const updatedRow = { ...existing, ...updatesToApply };
          rowsById.set(targetId, updatedRow);
          return { rowCount: 1, rows: [{ ...updatedRow }] };
        }

        throw new Error(`Query SQL tidak dikenali oleh mock SQL ketat: ${normalizedSql}`);
      },
    };

    const handler = createPosMenuItemPatchHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
    });

    return { handler, rowsById, executedQueries };
  }

  await test('T6.1 PATCH /api/pos/menu/items/:id memperbarui kelima field Tahap 1 dengan placeholder $1..$5 dan parameter terikat yang benar', async () => {
    const { handler, rowsById, executedQueries } = createPatchItemHarness([
      {
        id: 101,
        property_id: 1,
        category_id: 2,
        item_code: 'MN-101',
        name: 'Nasi Goreng Spesial',
        description: null,
        price: 30000,
        is_active: true,
        is_sellable_pos: false,
        product_type: null,
        product_kind: null,
        base_unit: null,
      },
    ]);

    const req = {
      params: { id: '101' },
      query: { property_id: '1' },
      body: {
        price: 45000,
        is_sellable_pos: true,
        product_type: 'FINISHED_GOOD',
        product_kind: 'STANDARD',
        base_unit: 'porsi',
      },
    };
    const res = makeMockRes();
    await handler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, 'OK');
    assert.strictEqual(executedQueries.length, 1);
    assert.strictEqual(
      executedQueries[0].sql,
      'UPDATE pos_menu_items SET price = $1, is_sellable_pos = $2, product_type = $3, product_kind = $4, base_unit = $5 WHERE id = $6 AND property_id = $7 RETURNING *'
    );
    assert.deepStrictEqual(executedQueries[0].params, [
      45000,
      true,
      'FINISHED_GOOD',
      'STANDARD',
      'porsi',
      101,
      1,
    ]);
    assert.strictEqual(res.body.data.price, 45000);
    assert.strictEqual(res.body.data.is_sellable_pos, true);
    assert.strictEqual(res.body.data.product_type, 'FINISHED_GOOD');
    assert.strictEqual(res.body.data.product_kind, 'STANDARD');
    assert.strictEqual(res.body.data.base_unit, 'porsi');
    assert.strictEqual(rowsById.get(101).price, 45000);
  });

  await test('T6.2 PATCH /api/pos/menu/items/:id menolak harga existing pecahan atau null saat mengaktifkan is_sellable_pos tanpa price baru dan tidak mengubah harga otomatis', async () => {
    const { handler, rowsById, executedQueries } = createPatchItemHarness([
      {
        id: 102,
        property_id: 1,
        item_code: 'RM-102',
        name: 'Bahan Pecahan Number',
        price: 12500.5,
        is_active: true,
        is_sellable_pos: false,
        product_type: 'RAW_MATERIAL',
        product_kind: 'STANDARD',
        base_unit: 'kg',
      },
      {
        id: 103,
        property_id: 1,
        item_code: 'RM-103',
        name: 'Bahan Pecahan String PG',
        price: '12500.50',
        is_active: true,
        is_sellable_pos: false,
        product_type: 'RAW_MATERIAL',
        product_kind: 'STANDARD',
        base_unit: 'kg',
      },
      {
        id: 104,
        property_id: 1,
        item_code: 'RM-104',
        name: 'Bahan Tanpa Harga',
        price: null,
        is_active: true,
        is_sellable_pos: false,
        product_type: 'RAW_MATERIAL',
        product_kind: 'STANDARD',
        base_unit: 'kg',
      },
    ]);

    for (const targetId of [102, 103, 104]) {
      const beforePrice = rowsById.get(targetId).price;
      const res = makeMockRes();
      await handler(
        {
          params: { id: String(targetId) },
          query: { property_id: '1' },
          body: { is_sellable_pos: true },
        },
        res
      );
      assert.strictEqual(res.statusCode, 400, `Item ${targetId} dengan price=${beforePrice} wajib ditolak 400`);
      assert.strictEqual(res.body.code, 'VALIDATION_ERROR');
      assert.strictEqual(rowsById.get(targetId).price, beforePrice, 'Harga existing tidak boleh dibulatkan/diubah otomatis');
      assert.strictEqual(rowsById.get(targetId).is_sellable_pos, false);
    }

    assert.ok(
      executedQueries.every((q) => !q.sql.startsWith('UPDATE ')),
      'Tidak boleh ada query UPDATE ketika validasi harga existing gagal'
    );
  });

  await test('T6.3 PATCH /api/pos/menu/items/:id menerima harga integer dan 0 eksplisit (baik via body PATCH maupun saat mengaktifkan POS dengan harga existing valid)', async () => {
    const { handler, rowsById, executedQueries } = createPatchItemHarness([
      {
        id: 105,
        property_id: 1,
        item_code: 'CP-105',
        name: 'Air Mineral Complimentary',
        price: '0.00',
        is_active: true,
        is_sellable_pos: false,
        product_type: 'FINISHED_GOOD',
        product_kind: 'STANDARD',
        base_unit: 'botol',
      },
      {
        id: 106,
        property_id: 1,
        item_code: 'FD-106',
        name: 'Kentang Goreng',
        price: '25000.00',
        is_active: true,
        is_sellable_pos: false,
        product_type: 'FINISHED_GOOD',
        product_kind: 'STANDARD',
        base_unit: 'porsi',
      },
    ]);

    // 1) Mengaktifkan POS pada item dengan harga existing 0 ('0.00') tanpa mengirim price baru
    const resZeroExisting = makeMockRes();
    await handler(
      {
        params: { id: '105' },
        query: { property_id: '1' },
        body: { is_sellable_pos: true },
      },
      resZeroExisting
    );
    assert.strictEqual(resZeroExisting.statusCode, 200);
    assert.strictEqual(resZeroExisting.body.data.price, 0);
    assert.strictEqual(resZeroExisting.body.data.is_sellable_pos, true);
    // Pastikan kolom price di DB tidak disentuh oleh UPDATE ketika price tidak dikirim di body
    assert.strictEqual(rowsById.get(105).price, '0.00');

    // 2) Mengaktifkan POS pada item dengan harga existing integer ('25000.00') tanpa mengirim price baru
    const resIntExisting = makeMockRes();
    await handler(
      {
        params: { id: '106' },
        query: { property_id: '1' },
        body: { is_sellable_pos: true },
      },
      resIntExisting
    );
    assert.strictEqual(resIntExisting.statusCode, 200);
    assert.strictEqual(resIntExisting.body.data.price, 25000);
    assert.strictEqual(resIntExisting.body.data.is_sellable_pos, true);

    // 3) Mengirim price: 0 eksplisit dan price integer eksplisit pada body PATCH
    executedQueries.length = 0;
    const resExplicitZero = makeMockRes();
    await handler(
      {
        params: { id: '106' },
        query: { property_id: '1' },
        body: { price: 0 },
      },
      resExplicitZero
    );
    assert.strictEqual(resExplicitZero.statusCode, 200);
    assert.strictEqual(resExplicitZero.body.data.price, 0);
    assert.strictEqual(
      executedQueries[0].sql,
      'UPDATE pos_menu_items SET price = $1 WHERE id = $2 AND property_id = $3 RETURNING *'
    );
    assert.deepStrictEqual(executedQueries[0].params, [0, 106, 1]);
  });

  await test('T6.4 PATCH /api/pos/menu/items/:id mengizinkan produk internal memiliki price=null dan menolak price=null pada produk jual POS', async () => {
    const { handler, rowsById, executedQueries } = createPatchItemHarness([
      {
        id: 107,
        property_id: 1,
        item_code: 'FD-107',
        name: 'Saus Tomat',
        price: 15000,
        is_active: true,
        is_sellable_pos: true,
        product_type: 'SEMI_FINISHED',
        product_kind: 'STANDARD',
        base_unit: 'liter',
      },
    ]);

    // Menolak price=null selama masih is_sellable_pos=true
    const resRejectNull = makeMockRes();
    await handler(
      {
        params: { id: '107' },
        query: { property_id: '1' },
        body: { price: null },
      },
      resRejectNull
    );
    assert.strictEqual(resRejectNull.statusCode, 400);
    assert.strictEqual(rowsById.get(107).price, 15000);

    // Mengubah ke produk internal sekaligus mengosongkan harga (is_sellable_pos: false, price: null)
    executedQueries.length = 0;
    const resInternalNull = makeMockRes();
    await handler(
      {
        params: { id: '107' },
        query: { property_id: '1' },
        body: { is_sellable_pos: false, price: null },
      },
      resInternalNull
    );
    assert.strictEqual(resInternalNull.statusCode, 200);
    assert.strictEqual(resInternalNull.body.data.is_sellable_pos, false);
    assert.strictEqual(resInternalNull.body.data.price, null);
    assert.strictEqual(
      executedQueries[0].sql,
      'UPDATE pos_menu_items SET price = $1, is_sellable_pos = $2 WHERE id = $3 AND property_id = $4 RETURNING *'
    );
    assert.deepStrictEqual(executedQueries[0].params, [null, false, 107, 1]);

    // Setelah berstatus internal (is_sellable_pos: false), PATCH { price: null } tanpa mengirim is_sellable_pos tetap diterima
    rowsById.get(107).price = 12000;
    executedQueries.length = 0;
    const resNullOnExistingInternal = makeMockRes();
    await handler(
      {
        params: { id: '107' },
        query: { property_id: '1' },
        body: { price: null },
      },
      resNullOnExistingInternal
    );
    assert.strictEqual(resNullOnExistingInternal.statusCode, 200);
    assert.strictEqual(resNullOnExistingInternal.body.data.price, null);
    assert.strictEqual(resNullOnExistingInternal.body.data.is_sellable_pos, false);
  });

  await test('T6.5 PATCH /api/pos/menu/items/:id yang menghilangkan field tetap mempertahankan nilai field existing lainnya', async () => {
    const { handler, rowsById, executedQueries } = createPatchItemHarness([
      {
        id: 108,
        property_id: 1,
        category_id: 4,
        item_code: 'BV-108',
        name: 'Es Kopi Gula Aren',
        description: 'Kopi susu dingin',
        price: 28000,
        is_active: true,
        is_sellable_pos: true,
        product_type: 'FINISHED_GOOD',
        product_kind: 'STANDARD',
        base_unit: 'cup',
      },
    ]);

    const res = makeMockRes();
    await handler(
      {
        params: { id: '108' },
        query: { property_id: '1' },
        body: { base_unit: 'gelas' },
      },
      res
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(executedQueries.length, 1);
    assert.strictEqual(
      executedQueries[0].sql,
      'UPDATE pos_menu_items SET base_unit = $1 WHERE id = $2 AND property_id = $3 RETURNING *'
    );
    assert.deepStrictEqual(executedQueries[0].params, ['gelas', 108, 1]);

    const updated = rowsById.get(108);
    assert.strictEqual(updated.name, 'Es Kopi Gula Aren');
    assert.strictEqual(updated.item_code, 'BV-108');
    assert.strictEqual(updated.price, 28000);
    assert.strictEqual(updated.is_sellable_pos, true);
    assert.strictEqual(updated.product_type, 'FINISHED_GOOD');
    assert.strictEqual(updated.product_kind, 'STANDARD');
    assert.strictEqual(updated.base_unit, 'gelas');
    assert.strictEqual(res.body.data.price, 28000);
    assert.strictEqual(res.body.data.product_type, 'FINISHED_GOOD');
    assert.strictEqual(res.body.data.product_kind, 'STANDARD');
    assert.strictEqual(res.body.data.base_unit, 'gelas');
  });

  // ── 7. MP-02B: Barcode & Foto Produk ───────────────────────────────────────
  await test('T7.1 parseBarcodeInput memvalidasi string <= 100 karakter setelah trim dan mempertahankan nol awal', () => {
    assert.strictEqual(parseBarcodeInput(undefined).provided, false);
    assert.strictEqual(parseBarcodeInput(undefined).value, undefined);
    assert.strictEqual(parseBarcodeInput(null).value, null);
    assert.strictEqual(parseBarcodeInput('').value, null);
    assert.strictEqual(parseBarcodeInput('   ').value, null);
    assert.strictEqual(parseBarcodeInput('  0012345678905  ').value, '0012345678905');
    assert.strictEqual(parseBarcodeInput('0000').value, '0000');

    // Jangan menerima number agar nol awal tidak hilang diam-diam
    assert.strictEqual(parseBarcodeInput(12345).ok, false);
    assert.strictEqual(parseBarcodeInput('x'.repeat(101)).ok, false);
    assert.strictEqual(parseBarcodeInput('x'.repeat(100)).value, 'x'.repeat(100));
  });

  await test('T7.2 formatPosMenuItemRow menyertakan barcode, has_photo, photo_url dan menyembunyikan photo_storage_key', () => {
    const withPhoto = formatPosMenuItemRow({
      id: 42,
      property_id: 2,
      name: 'Kopi Susu Botol',
      price: 25000,
      is_active: true,
      is_sellable_pos: true,
      barcode: '0089912345678',
      photo_storage_key: 'branding/2/product-photos/42/11111111-2222-3333-4444-555555555555.png',
      updated_at: '2026-10-22T08:00:00.000Z',
    });
    assert.strictEqual(withPhoto.barcode, '0089912345678');
    assert.strictEqual(withPhoto.has_photo, true);
    assert.ok(
      withPhoto.photo_url.startsWith('/api/pos/menu/items/42/photo?property_id=2&v='),
      `photo_url tidak sesuai: ${withPhoto.photo_url}`
    );
    assert.strictEqual('photo_storage_key' in withPhoto, false, 'photo_storage_key tidak boleh bocor ke respons API');

    const withoutPhoto = formatPosMenuItemRow({
      id: 43,
      property_id: 2,
      name: 'Teh Tawar',
      price: 8000,
      is_active: true,
      is_sellable_pos: true,
      barcode: null,
      photo_storage_key: null,
    });
    assert.strictEqual(withoutPhoto.barcode, null);
    assert.strictEqual(withoutPhoto.has_photo, false);
    assert.strictEqual(withoutPhoto.photo_url, null);
    assert.strictEqual('photo_storage_key' in withoutPhoto, false);
  });

  await test('T7.3 POST /api/pos/menu/items mendukung barcode (nol awal terjaga, tidak diisi dari SKU), kompatibel tanpa barcode, menolak duplikat per properti (termasuk nonaktif), & menolak photo_storage_key', async () => {
    const existingRows = [
      { id: 1, property_id: 1, item_code: 'INACT-01', name: 'Produk Lama Nonaktif', barcode: '0099887766', is_active: false },
    ];
    let nextId = 200;

    const mockPool = {
      async connect() {
        return {
          async query(sql, params = []) {
            const norm = String(sql).replace(/\s+/g, ' ').trim();
            if (norm === 'BEGIN' || norm === 'COMMIT' || norm === 'ROLLBACK') {
              return { rowCount: 0, rows: [] };
            }
            if (norm.startsWith('SELECT id FROM properties')) {
              return { rowCount: 1, rows: [{ id: params[0] }] };
            }
            if (norm === 'SELECT id FROM pos_menu_items WHERE property_id = $1 AND barcode = $2') {
              const dup = existingRows.find(
                (r) => Number(r.property_id) === Number(params[0]) && r.barcode === params[1]
              );
              return dup ? { rowCount: 1, rows: [{ id: dup.id }] } : { rowCount: 0, rows: [] };
            }
            if (norm.startsWith('INSERT INTO pos_menu_items')) {
              const created = {
                id: ++nextId,
                property_id: params[0],
                category_id: params[1],
                item_code: params[2],
                name: params[3],
                description: params[4],
                price: params[5],
                is_active: params[6],
                is_sellable_pos: params[7],
                product_type: params[8],
                product_kind: params[9],
                base_unit: params[10],
                barcode: params[11],
                photo_storage_key: null,
              };
              existingRows.push(created);
              return { rowCount: 1, rows: [created] };
            }
            throw new Error(`Unexpected SQL in POST test: ${norm}`);
          },
          release() {},
        };
      },
    };

    const createHandler = createPosMenuItemCreateHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
    });

    // 1) POST tanpa barcode -> kompatibel, barcode = null (tidak diisi dari SKU)
    const resNoBarcode = makeMockRes();
    await createHandler(
      {
        body: {
          property_id: 1,
          item_code: 'SKU-NO-BC',
          name: 'Menu Tanpa Barcode',
          price: 20000,
        },
      },
      resNoBarcode
    );
    assert.strictEqual(resNoBarcode.statusCode, 201);
    assert.strictEqual(resNoBarcode.body.data.item_code, 'SKU-NO-BC');
    assert.strictEqual(resNoBarcode.body.data.barcode, null, 'Barcode tidak boleh diisi otomatis dari SKU');

    // 2) POST dengan barcode berawalan nol -> nol awal dipertahankan
    const resLeadingZero = makeMockRes();
    await createHandler(
      {
        body: {
          property_id: 1,
          item_code: 'SKU-LZ',
          name: 'Air Mineral Botol',
          price: 10000,
          barcode: '  0012345678905 ',
        },
      },
      resLeadingZero
    );
    assert.strictEqual(resLeadingZero.statusCode, 201);
    assert.strictEqual(resLeadingZero.body.data.barcode, '0012345678905');

    // 3) POST dengan barcode yang sama milik produk nonaktif di properti yang sama -> 409 BARCODE_DUPLICATE
    const resDupInactive = makeMockRes();
    await createHandler(
      {
        body: {
          property_id: 1,
          name: 'Produk Bentrok Nonaktif',
          price: 15000,
          barcode: '0099887766',
        },
      },
      resDupInactive
    );
    assert.strictEqual(resDupInactive.statusCode, 409);
    assert.strictEqual(resDupInactive.body.code, 'BARCODE_DUPLICATE');

    // 4) POST di properti berbeda dengan barcode yang sama -> diizinkan (unik per properti)
    const resOtherProperty = makeMockRes();
    await createHandler(
      {
        body: {
          property_id: 2,
          name: 'Produk Properti Kedua',
          price: 15000,
          barcode: '0099887766',
        },
      },
      resOtherProperty
    );
    assert.strictEqual(resOtherProperty.statusCode, 201);
    assert.strictEqual(resOtherProperty.body.data.barcode, '0099887766');

    // 5) POST yang mencoba menyuntikkan photo_storage_key -> ditolak 400
    const resInjectPhotoKey = makeMockRes();
    await createHandler(
      {
        body: {
          property_id: 1,
          name: 'Produk Injeksi Key',
          price: 15000,
          photo_storage_key: 'branding/1/product-photos/1/hack.png',
        },
      },
      resInjectPhotoKey
    );
    assert.strictEqual(resInjectPhotoKey.statusCode, 400);
    assert.strictEqual(resInjectPhotoKey.body.code, 'VALIDATION_ERROR');
  });

  await test('T7.4 PATCH /api/pos/menu/items/:id mempertahankan barcode saat field dihilangkan, mengubah/menghapus barcode saat dikirim, menolak duplikat, & menolak photo_storage_key', async () => {
    const { handler, rowsById } = createPatchItemHarness([
      {
        id: 301,
        property_id: 1,
        item_code: 'MN-301',
        name: 'Kopi Tubruk',
        price: 18000,
        is_active: true,
        is_sellable_pos: true,
        barcode: '0011223344',
        photo_storage_key: 'branding/1/product-photos/301/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png',
      },
      {
        id: 302,
        property_id: 1,
        item_code: 'MN-302',
        name: 'Produk Nonaktif Dengan Barcode',
        price: 20000,
        is_active: false,
        is_sellable_pos: true,
        barcode: '0055667788',
        photo_storage_key: null,
      },
    ]);

    // 1) Field barcode dihilangkan -> nilai barcode & foto tetap utuh
    const resOmitted = makeMockRes();
    await handler(
      {
        params: { id: '301' },
        query: { property_id: '1' },
        body: { name: 'Kopi Tubruk Spesial' },
      },
      resOmitted
    );
    assert.strictEqual(resOmitted.statusCode, 200);
    assert.strictEqual(resOmitted.body.data.barcode, '0011223344');
    assert.strictEqual(resOmitted.body.data.has_photo, true);

    // 2) Update barcode baru dengan nol awal
    const resUpdateBarcode = makeMockRes();
    await handler(
      {
        params: { id: '301' },
        query: { property_id: '1' },
        body: { barcode: ' 0077889900 ' },
      },
      resUpdateBarcode
    );
    assert.strictEqual(resUpdateBarcode.statusCode, 200);
    assert.strictEqual(resUpdateBarcode.body.data.barcode, '0077889900');
    assert.strictEqual(rowsById.get(301).barcode, '0077889900');

    // 3) Bentrok dengan barcode produk nonaktif (#302) -> 409 BARCODE_DUPLICATE
    const resDup = makeMockRes();
    await handler(
      {
        params: { id: '301' },
        query: { property_id: '1' },
        body: { barcode: '0055667788' },
      },
      resDup
    );
    assert.strictEqual(resDup.statusCode, 409);
    assert.strictEqual(resDup.body.code, 'BARCODE_DUPLICATE');
    assert.strictEqual(rowsById.get(301).barcode, '0077889900');

    // 4) Kosongkan barcode dengan string kosong "" -> menjadi null
    const resClearEmpty = makeMockRes();
    await handler(
      {
        params: { id: '301' },
        query: { property_id: '1' },
        body: { barcode: '   ' },
      },
      resClearEmpty
    );
    assert.strictEqual(resClearEmpty.statusCode, 200);
    assert.strictEqual(resClearEmpty.body.data.barcode, null);
    assert.strictEqual(rowsById.get(301).barcode, null);

    // 5) Tolak injeksi photo_storage_key pada PATCH
    const resRejectPhotoKey = makeMockRes();
    await handler(
      {
        params: { id: '301' },
        query: { property_id: '1' },
        body: { photo_storage_key: null },
      },
      resRejectPhotoKey
    );
    assert.strictEqual(resRejectPhotoKey.statusCode, 400);
    assert.strictEqual(resRejectPhotoKey.body.code, 'VALIDATION_ERROR');
  });

  await test('T7.5 Menonaktifkan produk (PATCH is_active=false maupun DELETE /api/pos/menu/items/:id) mempertahankan foto dan barcode', async () => {
    const initialRow = {
      id: 350,
      property_id: 1,
      item_code: 'MN-350',
      name: 'Matcha Latte',
      price: 32000,
      is_active: true,
      is_sellable_pos: true,
      barcode: '00350350',
      photo_storage_key: 'branding/1/product-photos/350/12345678-1234-1234-1234-1234567890ab.webp',
    };
    const { handler: patchHandler, rowsById } = createPatchItemHarness([initialRow]);

    // 1) Via PATCH { is_active: false }
    const resPatchDeactivate = makeMockRes();
    await patchHandler(
      {
        params: { id: '350' },
        query: { property_id: '1' },
        body: { is_active: false },
      },
      resPatchDeactivate
    );
    assert.strictEqual(resPatchDeactivate.statusCode, 200);
    assert.strictEqual(resPatchDeactivate.body.data.is_active, false);
    assert.strictEqual(resPatchDeactivate.body.data.barcode, '00350350');
    assert.strictEqual(resPatchDeactivate.body.data.has_photo, true);
    assert.strictEqual(rowsById.get(350).photo_storage_key, initialRow.photo_storage_key);

    // 2) Via DELETE /api/pos/menu/items/:id
    rowsById.get(350).is_active = true;
    const deactivateQueries = [];
    const deactivateHandler = createPosMenuItemDeactivateHandler({
      pool: {
        async query(sql, params) {
          const norm = String(sql).replace(/\s+/g, ' ').trim();
          deactivateQueries.push({ sql: norm, params });
          const row = rowsById.get(Number(params[0]));
          if (!row || Number(row.property_id) !== Number(params[1])) {
            return { rowCount: 0, rows: [] };
          }
          row.is_active = false;
          return { rowCount: 1, rows: [{ id: row.id }] };
        },
      },
      assertPropertyScope: async () => {},
    });

    const resDeleteDeactivate = makeMockRes();
    await deactivateHandler(
      { params: { id: '350' }, query: { property_id: '1' } },
      resDeleteDeactivate
    );
    assert.strictEqual(resDeleteDeactivate.statusCode, 200);
    assert.strictEqual(
      deactivateQueries[0].sql,
      'UPDATE pos_menu_items SET is_active = FALSE WHERE id = $1 AND property_id = $2 RETURNING id'
    );
    assert.strictEqual(rowsById.get(350).is_active, false);
    assert.strictEqual(rowsById.get(350).barcode, '00350350');
    assert.strictEqual(rowsById.get(350).photo_storage_key, initialRow.photo_storage_key);
  });

  await test('T7.6 Validasi & Upload Foto (POST /api/pos/menu/items/:id/photo): magic bytes PNG/JPEG/WebP, batas 2 MB, hapus foto lama pasca-COMMIT, & cleanup aman saat gagal COMMIT', async () => {
    const validPng = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(32, 1),
    ]);
    const validJpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]);
    const validWebp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([32, 0, 0, 0]),
      Buffer.from('WEBP', 'ascii'),
      Buffer.alloc(16, 0),
    ]);

    assert.strictEqual(hasValidImageSignature(validPng, 'image/png'), true);
    assert.strictEqual(hasValidImageSignature(validJpeg, 'image/jpeg'), true);
    assert.strictEqual(hasValidImageSignature(validWebp, 'image/webp'), true);
    assert.strictEqual(hasValidImageSignature(Buffer.from('not-an-image'), 'image/png'), false);

    // Tolak ukuran > 2 MB
    const oversized = validateProductPhotoBuffer({
      buffer: validPng,
      mimetype: 'image/png',
      size: MAX_PRODUCT_PHOTO_BYTES + 1,
    });
    assert.strictEqual(oversized.ok, false);
    assert.strictEqual(oversized.code, 'PRODUCT_PHOTO_TOO_LARGE');

    // Simulasi adapter storage in-memory
    const storedFiles = new Map();
    const deletedKeys = [];
    const mockAdapter = {
      async save(key, buffer, contentType) {
        storedFiles.set(key, { buffer, contentType });
      },
      async read(key) {
        return storedFiles.has(key) ? storedFiles.get(key).buffer : null;
      },
      async exists(key) {
        return storedFiles.has(key);
      },
      async delete(key) {
        deletedKeys.push(key);
        storedFiles.delete(key);
      },
    };

    const oldKey = 'branding/1/product-photos/401/11111111-1111-1111-1111-111111111111.png';
    storedFiles.set(oldKey, { buffer: validPng, contentType: 'image/png' });

    const dbRow = {
      id: 401,
      property_id: 1,
      name: 'Nasi Ayam Geprek',
      price: 28000,
      is_active: true,
      is_sellable_pos: true,
      barcode: '00401',
      photo_storage_key: oldKey,
    };

    let failCommitMode = null; // null | 'rollback_clean' | 'uncertain_persisted'

    const mockPool = {
      async query(sql) {
        const norm = String(sql).replace(/\s+/g, ' ').trim();
        if (norm.startsWith('SELECT id FROM pos_menu_items')) {
          return { rowCount: 1, rows: [{ id: dbRow.id }] };
        }
        if (norm.startsWith('SELECT photo_storage_key FROM pos_menu_items')) {
          return { rowCount: 1, rows: [{ photo_storage_key: dbRow.photo_storage_key }] };
        }
        throw new Error(`Unexpected pool.query: ${norm}`);
      },
      async connect() {
        let stagedKey = dbRow.photo_storage_key;
        return {
          async query(sql, params = []) {
            const norm = String(sql).replace(/\s+/g, ' ').trim();
            if (norm === 'BEGIN' || norm === 'ROLLBACK') return { rowCount: 0, rows: [] };
            if (norm.startsWith('SELECT id, photo_storage_key FROM pos_menu_items')) {
              return { rowCount: 1, rows: [{ id: dbRow.id, photo_storage_key: dbRow.photo_storage_key }] };
            }
            if (norm.startsWith('UPDATE pos_menu_items SET photo_storage_key = $1')) {
              stagedKey = params[0];
              return { rowCount: 1, rows: [{ ...dbRow, photo_storage_key: stagedKey }] };
            }
            if (norm === 'COMMIT') {
              if (failCommitMode === 'rollback_clean') {
                throw new Error('Simulated DB connection drop before commit');
              }
              if (failCommitMode === 'uncertain_persisted') {
                dbRow.photo_storage_key = stagedKey;
                throw new Error('Simulated network timeout after DB commit persisted');
              }
              dbRow.photo_storage_key = stagedKey;
              return { rowCount: 0, rows: [] };
            }
            throw new Error(`Unexpected client.query: ${norm}`);
          },
          release() {},
        };
      },
    };

    const uploadHandler = createProductPhotoUploadHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
      storageAdapter: mockAdapter,
    });

    // 1) Upload sukses menggantikan foto lama: foto lama dihapus setelah COMMIT
    const resUploadOk = makeMockRes();
    await uploadHandler(
      {
        params: { id: '401' },
        query: { property_id: '1' },
        file: { buffer: validWebp, mimetype: 'image/webp', size: validWebp.length },
      },
      resUploadOk
    );
    assert.strictEqual(resUploadOk.statusCode, 200);
    assert.strictEqual(resUploadOk.body.data.has_photo, true);
    assert.ok(isProductPhotoStorageKey(dbRow.photo_storage_key, 1, 401));
    assert.notStrictEqual(dbRow.photo_storage_key, oldKey);
    assert.strictEqual(storedFiles.has(oldKey), false, 'Foto lama harus dihapus setelah COMMIT berhasil');
    assert.strictEqual(storedFiles.has(dbRow.photo_storage_key), true, 'Foto baru harus tersimpan');

    // 2) Upload gagal sebelum COMMIT (DB tidak mereferensikan key baru):
    //    Foto aktif saat ini tetap aman, dan file baru yang yatim dihapus.
    const activeKeyBeforeFail = dbRow.photo_storage_key;
    failCommitMode = 'rollback_clean';
    const resUploadRollback = makeMockRes();
    await uploadHandler(
      {
        params: { id: '401' },
        query: { property_id: '1' },
        file: { buffer: validPng, mimetype: 'image/png', size: validPng.length },
      },
      resUploadRollback
    );
    assert.strictEqual(resUploadRollback.statusCode, 500);
    assert.strictEqual(dbRow.photo_storage_key, activeKeyBeforeFail, 'Key DB tidak berubah saat transaksi gagal');
    assert.strictEqual(storedFiles.has(activeKeyBeforeFail), true, 'Foto lama/aktif tidak boleh terhapus saat transaksi gagal');
    assert.strictEqual(storedFiles.size, 1, 'File baru yang gagal ditautkan harus dibersihkan setelah verifikasi DB');

    // 3) Upload error jaringan pasca-COMMIT (DB sudah mereferensikan key baru):
    //    Pembacaan ulang DB mendeteksi currentKey === newKey sehingga file baru TIDAK dihapus!
    failCommitMode = 'uncertain_persisted';
    const resUploadUncertain = makeMockRes();
    await uploadHandler(
      {
        params: { id: '401' },
        query: { property_id: '1' },
        file: { buffer: validJpeg, mimetype: 'image/jpeg', size: validJpeg.length },
      },
      resUploadUncertain
    );
    assert.strictEqual(resUploadUncertain.statusCode, 500);
    assert.notStrictEqual(dbRow.photo_storage_key, activeKeyBeforeFail);
    assert.strictEqual(
      storedFiles.has(dbRow.photo_storage_key),
      true,
      'File baru yang sudah terlanjur tereferensi di DB tidak boleh dihapus oleh error handler'
    );
  });

  await test('T7.7 Hapus Foto (DELETE) & Baca Foto (GET) beserta pembatasan akses POS vs Master Produk', async () => {
    const validPng = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(24, 7),
    ]);
    const keySellable = 'branding/1/product-photos/501/aaaaaaaa-1111-2222-3333-444444444444.png';
    const keyNonPos = 'branding/1/product-photos/502/bbbbbbbb-1111-2222-3333-444444444444.png';

    const storedFiles = new Map([
      [keySellable, validPng],
      [keyNonPos, validPng],
    ]);
    const mockAdapter = {
      async save(k, b) { storedFiles.set(k, b); },
      async read(k) { return storedFiles.get(k) || null; },
      async exists(k) { return storedFiles.has(k); },
      async delete(k) { storedFiles.delete(k); },
    };

    const items = new Map([
      [501, { id: 501, property_id: 1, name: 'Menu POS Aktif', price: 25000, is_active: true, is_sellable_pos: true, photo_storage_key: keySellable }],
      [502, { id: 502, property_id: 1, name: 'Bahan Baku Non-POS', price: null, is_active: true, is_sellable_pos: false, photo_storage_key: keyNonPos }],
    ]);

    const mockPool = {
      async query(sql, params = []) {
        const item = items.get(Number(params[0]));
        if (!item || Number(item.property_id) !== Number(params[1])) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ ...item }] };
      },
      async connect() {
        return {
          async query(sql, params = []) {
            const norm = String(sql).replace(/\s+/g, ' ').trim();
            if (norm === 'BEGIN' || norm === 'COMMIT' || norm === 'ROLLBACK') return { rowCount: 0, rows: [] };
            if (norm.startsWith('SELECT id, photo_storage_key FROM pos_menu_items')) {
              const item = items.get(Number(params[0]));
              if (!item || Number(item.property_id) !== Number(params[1])) return { rowCount: 0, rows: [] };
              return { rowCount: 1, rows: [{ id: item.id, photo_storage_key: item.photo_storage_key }] };
            }
            if (norm.startsWith('UPDATE pos_menu_items SET photo_storage_key = NULL')) {
              const item = items.get(Number(params[0]));
              item.photo_storage_key = null;
              return { rowCount: 1, rows: [{ ...item }] };
            }
            throw new Error(`Unexpected SQL: ${norm}`);
          },
          release() {},
        };
      },
    };

    let hasMasterView = false;
    const getHandler = createProductPhotoGetHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
      canViewMasterProduct: async () => hasMasterView,
      storageAdapter: mockAdapter,
    });

    // 1) Kasir POS (tanpa izin Master Produk) membaca foto produk POS aktif -> 200 OK
    const resPosReadSellable = makeMockRes();
    await getHandler({ params: { id: '501' }, query: { property_id: '1' } }, resPosReadSellable);
    assert.strictEqual(resPosReadSellable.statusCode, 200);
    assert.strictEqual(resPosReadSellable.headers['content-type'], 'image/png');
    assert.strictEqual(resPosReadSellable.headers['cache-control'], 'private, no-store');
    assert.deepStrictEqual(resPosReadSellable.sentBuffer, validPng);

    // 2) Kasir POS (tanpa izin Master Produk) membaca foto produk non-POS -> 403 FORBIDDEN
    const resPosReadNonPos = makeMockRes();
    await getHandler({ params: { id: '502' }, query: { property_id: '1' } }, resPosReadNonPos);
    assert.strictEqual(resPosReadNonPos.statusCode, 403);
    assert.strictEqual(resPosReadNonPos.body.code, 'FORBIDDEN');

    // 3) User dengan izin Master Produk membaca foto produk non-POS -> 200 OK
    hasMasterView = true;
    const resMasterReadNonPos = makeMockRes();
    await getHandler({ params: { id: '502' }, query: { property_id: '1' } }, resMasterReadNonPos);
    assert.strictEqual(resMasterReadNonPos.statusCode, 200);
    assert.deepStrictEqual(resMasterReadNonPos.sentBuffer, validPng);

    // 4) DELETE /api/pos/menu/items/:id/photo menghapus tautan DB dan file di storage
    const deleteHandler = createProductPhotoDeleteHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
      storageAdapter: mockAdapter,
    });
    const resDelete = makeMockRes();
    await deleteHandler({ params: { id: '501' }, query: { property_id: '1' } }, resDelete);
    assert.strictEqual(resDelete.statusCode, 200);
    assert.strictEqual(resDelete.body.data.has_photo, false);
    assert.strictEqual(resDelete.body.data.photo_url, null);
    assert.strictEqual(storedFiles.has(keySellable), false);
  });

  await test('T7.8 Kontrak Migration MP-02B & Operational Access Rules untuk endpoint foto produk', async () => {
    const executedSql = [];
    const mockPool = {
      async connect() {
        return {
          async query(sql) {
            const text = typeof sql === 'string' ? sql.trim() : '';
            executedSql.push(text);
            if (text.includes('FROM information_schema.tables')) {
              return { rowCount: 1, rows: [{ '?column?': 1 }] };
            }
            if (text.includes('FROM information_schema.columns')) {
              return {
                rowCount: 2,
                rows: [
                  { column_name: 'barcode', is_nullable: 'YES', character_maximum_length: 100 },
                  { column_name: 'photo_storage_key', is_nullable: 'YES', character_maximum_length: null },
                ],
              };
            }
            return { rowCount: 1, rows: [] };
          },
          release() {},
        };
      },
    };

    await runProductMasterMp02bMigration(mockPool);
    const joined = executedSql.join('\n');
    assert.ok(joined.includes('ADD COLUMN IF NOT EXISTS barcode VARCHAR(100)'));
    assert.ok(joined.includes('ADD COLUMN IF NOT EXISTS photo_storage_key TEXT'));
    assert.ok(joined.includes('chk_pos_menu_items_barcode_non_empty'));
    assert.ok(joined.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_pmi_property_barcode'));
    assert.ok(joined.includes('ON pos_menu_items(property_id, barcode)'));
    assert.ok(joined.includes('WHERE barcode IS NOT NULL'));

    // Verifikasi OPERATIONAL_ACCESS_RULES memiliki rule khusus endpoint foto produk
    const photoGetRule = OPERATIONAL_ACCESS_RULES.find(
      (r) => r.pattern.test('/api/pos/menu/items/123/photo') && r.methods && r.methods.includes('GET')
    );
    const photoMutateRule = OPERATIONAL_ACCESS_RULES.find(
      (r) => r.pattern.test('/api/pos/menu/items/123/photo') && r.methods && r.methods.includes('POST')
    );
    assert.ok(photoGetRule, 'Rule GET foto produk wajib terdaftar di OPERATIONAL_ACCESS_RULES');
    assert.deepStrictEqual(photoGetRule.resources, ['POS', 'Master Produk']);
    assert.strictEqual(photoGetRule.action, 'view');

    assert.ok(photoMutateRule, 'Rule POST/DELETE foto produk wajib terdaftar di OPERATIONAL_ACCESS_RULES');
    assert.deepStrictEqual(photoMutateRule.resources, ['Master Produk']);
    assert.strictEqual(photoMutateRule.action, 'edit');
  });

  await test('T7.9 Runner CLI Migration MP-02B memanggil runProductMasterMp02bMigration(pool), menutup pool di semua jalur, & exit nonzero bila gagal (mock, tanpa DB live)', async () => {
    const fs = require('fs');
    const path = require('path');

    // 1) Jalur sukses: menjalankan runProductMasterMp02bMigration(pool), menutup pool.end(), return 0
    let okPoolEnded = false;
    let okClientReleased = false;
    const okExecutedSql = [];
    const mockPoolSuccess = {
      async connect() {
        return {
          async query(sql) {
            const text = typeof sql === 'string' ? sql.trim() : '';
            okExecutedSql.push(text);
            if (text.includes('FROM information_schema.tables')) {
              return { rowCount: 1, rows: [{ '?column?': 1 }] };
            }
            if (text.includes('FROM information_schema.columns')) {
              return {
                rowCount: 2,
                rows: [
                  { column_name: 'barcode', is_nullable: 'YES' },
                  { column_name: 'photo_storage_key', is_nullable: 'YES' },
                ],
              };
            }
            return { rowCount: 1, rows: [] };
          },
          release() {
            okClientReleased = true;
          },
        };
      },
      async end() {
        okPoolEnded = true;
      },
    };

    let okExitCode = null;
    let okLoggedErr = null;
    const okResult = await runProductMasterMp02bMigrationCli({
      createPool: () => mockPoolSuccess,
      onError: (err) => {
        okLoggedErr = err;
      },
      setExitCode: (code) => {
        okExitCode = code;
      },
    });
    assert.strictEqual(okResult, 0);
    assert.strictEqual(okExitCode, null);
    assert.strictEqual(okLoggedErr, null);
    assert.strictEqual(okClientReleased, true, 'Client harus di-release pada jalur sukses');
    assert.strictEqual(okPoolEnded, true, 'pool.end() wajib dipanggil pada jalur sukses');
    assert.ok(
      okExecutedSql.some((s) => s.includes('ADD COLUMN IF NOT EXISTS photo_storage_key TEXT')),
      'Runner wajib benar-benar memanggil runProductMasterMp02bMigration(pool)'
    );

    // 2) Jalur gagal: menutup pool.end() di finally, mencatat error, dan mengeset exit code nonzero (1)
    let failPoolEnded = false;
    let failClientReleased = false;
    const mockPoolFail = {
      async connect() {
        return {
          async query(sql) {
            const text = typeof sql === 'string' ? sql.trim() : '';
            if (text.includes('FROM information_schema.tables')) {
              return { rowCount: 0, rows: [] }; // gagal prasyarat pos_menu_items
            }
            return { rowCount: 0, rows: [] };
          },
          release() {
            failClientReleased = true;
          },
        };
      },
      async end() {
        failPoolEnded = true;
      },
    };

    let failExitCode = null;
    let failLoggedErr = null;
    const failResult = await runProductMasterMp02bMigrationCli({
      createPool: () => mockPoolFail,
      onError: (err) => {
        failLoggedErr = err;
      },
      setExitCode: (code) => {
        failExitCode = code;
      },
    });
    assert.strictEqual(failResult, 1, 'Runner wajib mengembalikan kode nonzero (1) saat gagal');
    assert.strictEqual(failExitCode, 1, 'Runner wajib mengeset exitCode nonzero (1) saat gagal');
    assert.ok(failLoggedErr instanceof Error, 'Error kegagalan migrasi harus diteruskan ke handler error');
    assert.match(failLoggedErr.message, /Prerequisite failed: table pos_menu_items does not exist/);
    assert.strictEqual(failClientReleased, true, 'Client harus tetap di-release pada jalur gagal');
    assert.strictEqual(failPoolEnded, true, 'pool.end() wajib tetap dipanggil pada jalur gagal');

    // 3) Verifikasi entrypoint CLI require.main === module di dist/db/migrations/product_master_mp02b_v1.js
    const compiledMigrationSrc = fs.readFileSync(
      path.resolve(__dirname, '../dist/db/migrations/product_master_mp02b_v1.js'),
      'utf8'
    );
    assert.ok(
      compiledMigrationSrc.includes('require.main === module'),
      'Modul migrasi terkompilasi wajib memiliki blok runner CLI require.main === module'
    );
    assert.ok(
      compiledMigrationSrc.includes('runProductMasterMp02bMigrationCli()'),
      'Blok require.main === module wajib memanggil runProductMasterMp02bMigrationCli()'
    );
  });

  // ── MP-03C: Satuan Kanonik, Kemasan Produk, & Lokasi Stok ─────────────────
  await test('T8.1 MP-03C: Katalog 15 satuan kanonik & 5 tipe lokasi kontrak, batas numerik NUMERIC(12,3) & 100000.000, kemasan bulat positif, & larangan lintas dimensi / sub-mili', async () => {
    assert.strictEqual(SYSTEM_CANONICAL_UNITS.length, 15);
    const codes = SYSTEM_CANONICAL_UNITS.map((u) => u.code);
    assert.deepStrictEqual(codes, [
      'PCS', 'PORSI', 'GELAS', 'CUP', 'BOTOL', 'KALENG', 'PACK', 'BOX', 'ROLL', 'SET', 'LEMBAR', 'KG', 'GRAM', 'LITER', 'ML',
    ]);

    assert.deepStrictEqual(STOCK_LOCATION_TYPES, [
      'WAREHOUSE', 'KITCHEN', 'POS_OUTLET', 'HK_PANTRY', 'ROOM_MINIBAR',
    ]);

    // Pencocokan alias konservatif (case-insensitive)
    assert.strictEqual(matchCanonicalUnitByText('  Kilogram ').code, 'KG');
    assert.strictEqual(matchCanonicalUnitByText('gr').code, 'GRAM');
    assert.strictEqual(matchCanonicalUnitByText('ml').code, 'ML');
    assert.strictEqual(matchCanonicalUnitByText('btl').code, 'BOTOL');
    assert.strictEqual(matchCanonicalUnitByText('pcs').code, 'PCS');
    assert.strictEqual(matchCanonicalUnitByText('bungkus').code, 'PACK');
    assert.strictEqual(matchCanonicalUnitByText('Ikat Daun Pisang'), null, 'Teks bebas tidak dikenal wajib tetap null');
    assert.strictEqual(matchCanonicalUnitByText(null), null);

    // Aritmetika mili-unit BigInt & representasi string desimal
    const q025 = parseStrictDecimalString('0.250');
    assert.strictEqual(q025.ok, true);
    assert.strictEqual(q025.milli, 250n);
    assert.strictEqual(q025.formatted3, '0.250');

    const q24 = parseStrictDecimalString('24');
    assert.strictEqual(q24.ok, true);
    assert.strictEqual(q24.milli, 24000n);
    assert.strictEqual(q24.formatted3, '24.000');

    const qTooManyDecimals = parseStrictDecimalString('0.0005');
    assert.strictEqual(qTooManyDecimals.ok, false);
    assert.strictEqual(qTooManyDecimals.code, 'DECIMAL_STRING_REQUIRED');

    // Batas faktor kemasan: maksimal 100000.000, > 100000.000 ditolak
    const factorMaxOk = parsePackagingFactorInput('100000.000', 'KG');
    assert.strictEqual(factorMaxOk.ok, true);
    assert.strictEqual(factorMaxOk.formatted3, '100000.000');

    const factorOverMax = parsePackagingFactorInput('100000.001', 'KG');
    assert.strictEqual(factorOverMax.ok, false);
    assert.strictEqual(factorOverMax.status, 400);
    assert.strictEqual(factorOverMax.code, 'VALIDATION_ERROR');

    // Batas kapasitas kuantitas NUMERIC(12,3): maksimal 999999999.999
    const qtyMaxOk = parseCanonicalQuantityInput('999999999.999', 'KG');
    assert.strictEqual(qtyMaxOk.ok, true);
    assert.strictEqual(qtyMaxOk.formatted3, '999999999.999');

    const qtyOverMax = parseCanonicalQuantityInput('1000000000.000', 'KG');
    assert.strictEqual(qtyOverMax.ok, false);
    assert.strictEqual(qtyOverMax.status, 422);
    assert.strictEqual(qtyOverMax.code, 'CONVERSION_RESULT_OVERFLOW');

    // Konversi dimensi standar (WEIGHT: KG <-> GRAM; VOLUME: LITER <-> ML)
    const convKgToGram = convertIntraDimensionQuantity({
      quantity: '0.250',
      fromUnitCode: 'KG',
      toUnitCode: 'GRAM',
    });
    assert.strictEqual(convKgToGram.ok, true);
    assert.strictEqual(convKgToGram.formatted3, '250.000');
    assert.strictEqual(convKgToGram.milli, 250000n);

    const convGramToKg = convertIntraDimensionQuantity({
      quantity: '250',
      fromUnitCode: 'GRAM',
      toUnitCode: 'KG',
    });
    assert.strictEqual(convGramToKg.ok, true);
    assert.strictEqual(convGramToKg.formatted3, '0.250');
    assert.strictEqual(convGramToKg.milli, 250n);

    const convLiterToMl = convertIntraDimensionQuantity({
      quantity: '1.5',
      fromUnitCode: 'LITER',
      toUnitCode: 'ML',
    });
    assert.strictEqual(convLiterToMl.ok, true);
    assert.strictEqual(convLiterToMl.formatted3, '1500.000');

    // Regresi konversi KG -> GRAM yang overflow (> 999999999.999 GRAM)
    const convKgToGramOverflow = convertIntraDimensionQuantity({
      quantity: '1000000.000',
      fromUnitCode: 'KG',
      toUnitCode: 'GRAM',
    });
    assert.strictEqual(convKgToGramOverflow.ok, false);
    assert.strictEqual(convKgToGramOverflow.status, 422);
    assert.strictEqual(convKgToGramOverflow.code, 'CONVERSION_RESULT_OVERFLOW');

    // Larangan kehilangan presisi sub-mili (0.5 GRAM -> KG = 0.0005 KG)
    const convSubMilli = convertIntraDimensionQuantity({
      quantity: '0.5',
      fromUnitCode: 'GRAM',
      toUnitCode: 'KG',
    });
    assert.strictEqual(convSubMilli.ok, false);
    assert.strictEqual(convSubMilli.status, 422);
    assert.strictEqual(convSubMilli.code, 'SUB_MILLI_UNIT_PRECISION_LOSS');

    // Larangan konversi lintas dimensi (KG <-> LITER, COUNT <-> WEIGHT, COUNT berbeda)
    const convCrossDim = convertIntraDimensionQuantity({
      quantity: '1',
      fromUnitCode: 'KG',
      toUnitCode: 'LITER',
    });
    assert.strictEqual(convCrossDim.ok, false);
    assert.strictEqual(convCrossDim.status, 422);
    assert.strictEqual(convCrossDim.code, 'CROSS_DIMENSION_CONVERSION_FORBIDDEN');

    const convCountDifferent = convertIntraDimensionQuantity({
      quantity: '1',
      fromUnitCode: 'PACK',
      toUnitCode: 'BOTOL',
    });
    assert.strictEqual(convCountDifferent.ok, false);
    assert.strictEqual(convCountDifferent.status, 422);
    assert.strictEqual(convCountDifferent.code, 'CROSS_DIMENSION_CONVERSION_FORBIDDEN');

    // Konversi kemasan produk (packagingQty wajib bulat positif)
    const pkgConvDiscrete = convertPackagingToBaseQuantity({
      packagingQty: '2',
      toBaseFactor: '24.000',
      baseUnitCode: 'BOTOL',
    });
    assert.strictEqual(pkgConvDiscrete.ok, true);
    assert.strictEqual(pkgConvDiscrete.formatted3, '48.000');
    assert.strictEqual(pkgConvDiscrete.milli, 48000n);

    const pkgConvContinuous = convertPackagingToBaseQuantity({
      packagingQty: '3',
      toBaseFactor: '0.250',
      baseUnitCode: 'KG',
    });
    assert.strictEqual(pkgConvContinuous.ok, true);
    assert.strictEqual(pkgConvContinuous.formatted3, '0.750');
    assert.strictEqual(pkgConvContinuous.milli, 750n);

    // Regresi setengah kemasan wajib ditolak baik pada satuan diskrit (BOTOL) maupun kontinu (KG)
    const pkgConvFractionDiscrete = convertPackagingToBaseQuantity({
      packagingQty: '0.5',
      toBaseFactor: '24.000',
      baseUnitCode: 'BOTOL',
    });
    assert.strictEqual(pkgConvFractionDiscrete.ok, false);
    assert.strictEqual(pkgConvFractionDiscrete.status, 400);
    assert.strictEqual(pkgConvFractionDiscrete.code, 'VALIDATION_ERROR');

    const pkgConvFractionContinuous = convertPackagingToBaseQuantity({
      packagingQty: '0.5',
      toBaseFactor: '10.000',
      baseUnitCode: 'KG',
    });
    assert.strictEqual(pkgConvFractionContinuous.ok, false);
    assert.strictEqual(pkgConvFractionContinuous.status, 400);
    assert.strictEqual(pkgConvFractionContinuous.code, 'VALIDATION_ERROR');

    // Regresi hasil satu miliar botol (10000 kemasan x 100000 botol = 1.000.000.000 > 999.999.999) wajib ditolak overflow
    const pkgConvOneBillionBottles = convertPackagingToBaseQuantity({
      packagingQty: '10000',
      toBaseFactor: '100000.000',
      baseUnitCode: 'BOTOL',
    });
    assert.strictEqual(pkgConvOneBillionBottles.ok, false);
    assert.strictEqual(pkgConvOneBillionBottles.status, 422);
    assert.strictEqual(pkgConvOneBillionBottles.code, 'CONVERSION_RESULT_OVERFLOW');
  });

  await test('T8.2 MP-03C: POST & PATCH produk — dukungan base_unit 50 karakter & matriks kompatibilitas caller lama (L1–L4 & C1–C4)', async () => {
    // 1) POST caller lama & baru
    const createdRows = [];
    let nextId = 800;
    const mockCreateQuery = async (sql, params = []) => {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      if (norm === 'BEGIN' || norm === 'COMMIT' || norm === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (norm === 'SELECT id FROM properties WHERE id = $1 FOR UPDATE') {
        return { rowCount: 1, rows: [{ id: Number(params[0]) }] };
      }
      if (norm.startsWith('INSERT INTO pos_menu_items')) {
        const row = {
          id: ++nextId,
          property_id: params[0],
          category_id: params[1],
          item_code: params[2],
          name: params[3],
          description: params[4],
          price: params[5],
          is_active: params[6],
          is_sellable_pos: params[7],
          product_type: params[8],
          product_kind: params[9],
          base_unit: params[10],
          barcode: params[11],
          canonical_base_unit_code: params.length > 12 ? params[12] : null,
          photo_storage_key: null,
        };
        createdRows.push(row);
        return { rowCount: 1, rows: [row] };
      }
      throw new Error(`Unexpected SQL in POST test: ${norm}`);
    };
    const createHandler = createPosMenuItemCreateHandler({
      pool: {
        query: mockCreateQuery,
        async connect() {
          return {
            query: mockCreateQuery,
            release() {},
          };
        },
      },
      assertPropertyScope: async () => {},
    });

    // POST hanya base_unit "Ikat Daun" (caller lama tanpa canonical_base_unit_code) -> base_unit disimpan, canonical_base_unit_code = null
    const resPostCustomText = makeMockRes();
    await createHandler(
      { body: { property_id: 1, name: 'Daun Pisang', price: 5000, base_unit: 'Ikat Daun' } },
      resPostCustomText
    );
    assert.strictEqual(resPostCustomText.statusCode, 201);
    assert.strictEqual(resPostCustomText.body.data.base_unit, 'Ikat Daun');
    assert.strictEqual(resPostCustomText.body.data.canonical_base_unit_code, null);

    // POST base_unit tepat 50 karakter diterima, 51 karakter ditolak 400 INVALID_BASE_UNIT
    const text50 = 'Satuan Legacy Kustom Panjang Lima Puluh Karakter50';
    assert.strictEqual(text50.length, 50);
    const resPost50Chars = makeMockRes();
    await createHandler(
      { body: { property_id: 1, name: 'Produk 50 Karakter', price: 10000, base_unit: text50 } },
      resPost50Chars
    );
    assert.strictEqual(resPost50Chars.statusCode, 201);
    assert.strictEqual(resPost50Chars.body.data.base_unit, text50);

    const resPost51Chars = makeMockRes();
    await createHandler(
      { body: { property_id: 1, name: 'Produk 51 Karakter', price: 10000, base_unit: `${text50}X` } },
      resPost51Chars
    );
    assert.strictEqual(resPost51Chars.statusCode, 400);
    assert.strictEqual(resPost51Chars.body.code, 'VALIDATION_ERROR');

    // POST dengan canonical_base_unit_code: 'LITER' -> menyelaraskan base_unit = 'Liter' & canonical_base_unit_code = 'LITER'
    const resPostCanonicalOnly = makeMockRes();
    await createHandler(
      { body: { property_id: 1, name: 'Susu Segar', price: 25000, canonical_base_unit_code: 'LITER' } },
      resPostCanonicalOnly
    );
    assert.strictEqual(resPostCanonicalOnly.statusCode, 201);
    assert.strictEqual(resPostCanonicalOnly.body.data.canonical_base_unit_code, 'LITER');
    assert.strictEqual(resPostCanonicalOnly.body.data.base_unit, 'Liter');

    // POST kode kanonik tidak valid -> 400 INVALID_CANONICAL_BASE_UNIT
    const resPostInvalidCode = makeMockRes();
    await createHandler(
      { body: { property_id: 1, name: 'Susu', price: 25000, canonical_base_unit_code: 'GALON_ASING' } },
      resPostInvalidCode
    );
    assert.strictEqual(resPostInvalidCode.statusCode, 400);
    assert.strictEqual(resPostInvalidCode.body.code, 'INVALID_CANONICAL_BASE_UNIT');

    // POST dengan konflik canonical_base_unit_code vs base_unit -> 400 CONFLICTING_BASE_UNIT_FIELDS
    const resPostConflict = makeMockRes();
    await createHandler(
      { body: { property_id: 1, name: 'Susu', price: 25000, canonical_base_unit_code: 'LITER', base_unit: 'Botol' } },
      resPostConflict
    );
    assert.strictEqual(resPostConflict.statusCode, 400);
    assert.strictEqual(resPostConflict.body.code, 'CONFLICTING_BASE_UNIT_FIELDS');

    // 2) Unit test matriks L1–L4 (produk belum terpetakan: canonical_base_unit_code = NULL)
    const legacyRow = { base_unit: 'Kilogram', canonical_base_unit_code: null };

    // L1: keduanya dihilangkan -> tetap, isUnitChanging = false
    const l1 = resolvePatchProductUnitMutation({
      existingBaseUnit: legacyRow.base_unit,
      existingCanonicalCode: legacyRow.canonical_base_unit_code,
      body: {},
    });
    assert.strictEqual(l1.ok, true);
    assert.strictEqual(l1.isUnitChanging, false);

    // L2: hanya base_unit dikirim dengan alias setara ("Kg") -> tetap null canonical, isUnitChanging = false
    const l2 = resolvePatchProductUnitMutation({
      existingBaseUnit: legacyRow.base_unit,
      existingCanonicalCode: legacyRow.canonical_base_unit_code,
      body: { base_unit: 'Kg' },
    });
    assert.strictEqual(l2.ok, true);
    assert.strictEqual(l2.base_unit, 'Kg');
    assert.strictEqual(l2.canonical_base_unit_code, null);
    assert.strictEqual(l2.isUnitChanging, false);

    // L3: hanya base_unit dikirim dengan teks berbeda "Loyang" -> canonical tetap null, isUnitChanging = true
    const l3 = resolvePatchProductUnitMutation({
      existingBaseUnit: legacyRow.base_unit,
      existingCanonicalCode: legacyRow.canonical_base_unit_code,
      body: { base_unit: 'Loyang' },
    });
    assert.strictEqual(l3.ok, true);
    assert.strictEqual(l3.base_unit, 'Loyang');
    assert.strictEqual(l3.canonical_base_unit_code, null);
    assert.strictEqual(l3.isUnitChanging, true);

    // L4: base_unit = null -> keduanya null, isUnitChanging = true
    const l4 = resolvePatchProductUnitMutation({
      existingBaseUnit: legacyRow.base_unit,
      existingCanonicalCode: legacyRow.canonical_base_unit_code,
      body: { base_unit: null },
    });
    assert.strictEqual(l4.ok, true);
    assert.strictEqual(l4.base_unit, null);
    assert.strictEqual(l4.canonical_base_unit_code, null);
    assert.strictEqual(l4.isUnitChanging, true);

    // 3) Unit test matriks C1–C4 (produk sudah terpetakan: canonical_base_unit_code = 'KG')
    const canonicalRow = { base_unit: 'Kg', canonical_base_unit_code: 'KG' };

    // C1: keduanya dihilangkan -> tetap KG, isUnitChanging = false
    const c1 = resolvePatchProductUnitMutation({
      existingBaseUnit: canonicalRow.base_unit,
      existingCanonicalCode: canonicalRow.canonical_base_unit_code,
      body: {},
    });
    assert.strictEqual(c1.ok, true);
    assert.strictEqual(c1.isUnitChanging, false);
    assert.strictEqual(c1.canonical_base_unit_code, 'KG');

    // C2: caller lama mengirim ulang label setara ("Kilogram") -> mempertahankan KG, isUnitChanging = false
    const c2 = resolvePatchProductUnitMutation({
      existingBaseUnit: canonicalRow.base_unit,
      existingCanonicalCode: canonicalRow.canonical_base_unit_code,
      body: { base_unit: 'Kilogram' },
    });
    assert.strictEqual(c2.ok, true);
    assert.strictEqual(c2.canonical_base_unit_code, 'KG');
    assert.strictEqual(c2.base_unit, 'Kg');
    assert.strictEqual(c2.isUnitChanging, false);

    // C3a: caller lama mengirim teks berbeda ("Liter") tanpa canonical_base_unit_code ->
    // sesuai kontrak C3, tidak boleh auto-map ke kode kanonik baru: canonical_base_unit_code di-reset null, isUnitChanging = true
    const c3a = resolvePatchProductUnitMutation({
      existingBaseUnit: canonicalRow.base_unit,
      existingCanonicalCode: canonicalRow.canonical_base_unit_code,
      body: { base_unit: 'Liter' },
    });
    assert.strictEqual(c3a.ok, true);
    assert.strictEqual(c3a.base_unit, 'Liter');
    assert.strictEqual(c3a.canonical_base_unit_code, null);
    assert.strictEqual(c3a.isUnitChanging, true);

    // C3b: caller lama mengirim teks tidak dikenal ("Ikat") pada produk yang sudah kanonik -> canonical_base_unit_code = null, isUnitChanging = true
    const c3b = resolvePatchProductUnitMutation({
      existingBaseUnit: canonicalRow.base_unit,
      existingCanonicalCode: canonicalRow.canonical_base_unit_code,
      body: { base_unit: 'Ikat' },
    });
    assert.strictEqual(c3b.ok, true);
    assert.strictEqual(c3b.base_unit, 'Ikat');
    assert.strictEqual(c3b.canonical_base_unit_code, null);
    assert.strictEqual(c3b.isUnitChanging, true);

    // C4: caller mengirim base_unit: null -> isUnitChanging = true (dicek lock!)
    const c4 = resolvePatchProductUnitMutation({
      existingBaseUnit: canonicalRow.base_unit,
      existingCanonicalCode: canonicalRow.canonical_base_unit_code,
      body: { base_unit: null },
    });
    assert.strictEqual(c4.ok, true);
    assert.strictEqual(c4.base_unit, null);
    assert.strictEqual(c4.canonical_base_unit_code, null);
    assert.strictEqual(c4.isUnitChanging, true);
  });

  await test('T8.3 MP-03C: Penguncian satuan dasar (409 BASE_UNIT_LOCKED_BY_USAGE) via kemasan & 4 tabel minibar kontrak, keselarasan GET katalog, serta fail-closed 503 USAGE_CHECK_FAILED', async () => {
    const lockedItem = {
      id: 601,
      property_id: 1,
      item_code: 'MN-601',
      name: 'Tepung Terigu Protein Tinggi',
      price: 18000,
      is_active: true,
      is_sellable_pos: false,
      product_type: 'RAW_MATERIAL',
      product_kind: 'STANDARD',
      base_unit: 'Kg',
      canonical_base_unit_code: 'KG',
    };

    let hasPackagingRows = true;
    let minibarTableRegs = {
      rtms_reg: 'room_type_minibar_standard',
      mbv_reg: 'minibar_baseline_verification',
      mse_reg: 'minibar_stay_event',
      mirl_reg: 'minibar_inspection_report_line',
    };
    let minibarCounts = {
      room_type_minibar_standard: 0,
      minibar_baseline_verification: 0,
      minibar_stay_event: 0,
      minibar_inspection_report_line: 0,
    };
    let simulateDbErrorOnCheck = null;
    let simulateMinibarDbError = null;
    let simulateSchemaMissing = false;

    const handleMockQuery = async (sql, params = []) => {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      if (norm === 'BEGIN' || norm === 'COMMIT' || norm === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (norm.startsWith('SELECT * FROM pos_menu_items WHERE id = $1 AND property_id = $2 FOR UPDATE')) {
        if (Number(params[0]) === lockedItem.id && Number(params[1]) === lockedItem.property_id) {
          return { rowCount: 1, rows: [{ ...lockedItem }] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (norm.includes("to_regclass('public.product_packaging_conversions')")) {
        if (simulateSchemaMissing) {
          return { rowCount: 1, rows: [{ pkg_reg: null }] };
        }
        return { rowCount: 1, rows: [{ pkg_reg: 'product_packaging_conversions' }] };
      }
      if (norm.includes('FROM product_packaging_conversions') && norm.includes('COUNT(*)')) {
        if (simulateDbErrorOnCheck) {
          throw simulateDbErrorOnCheck;
        }
        return { rowCount: 1, rows: [{ cnt: hasPackagingRows ? 1 : 0 }] };
      }
      if (norm.includes('FROM product_packaging_conversions') && norm.includes('ORDER BY is_active DESC')) {
        return {
          rowCount: hasPackagingRows ? 1 : 0,
          rows: hasPackagingRows
            ? [
                {
                  id: 11,
                  property_id: 1,
                  menu_item_id: 601,
                  packaging_code: 'SAK',
                  packaging_label: 'Sak 25 Kg',
                  base_unit_code: 'KG',
                  to_base_factor: '25.000',
                  is_default_purchase: true,
                  is_active: true,
                  idempotency_key: 'sak-25',
                },
              ]
            : [],
        };
      }
      if (norm.includes("to_regclass('public.room_type_minibar_standard')")) {
        return { rowCount: 1, rows: [{ ...minibarTableRegs }] };
      }
      for (const tbl of [
        'room_type_minibar_standard',
        'minibar_baseline_verification',
        'minibar_stay_event',
        'minibar_inspection_report_line',
      ]) {
        if (norm.includes(`FROM ${tbl}`)) {
          if (simulateMinibarDbError) {
            throw simulateMinibarDbError;
          }
          if (norm.includes('SELECT DISTINCT menu_item_id')) {
            return minibarCounts[tbl] > 0
              ? { rowCount: 1, rows: [{ menu_item_id: 601 }] }
              : { rowCount: 0, rows: [] };
          }
          if (norm.includes('SELECT EXISTS')) {
            return { rowCount: 1, rows: [{ used: (minibarCounts[tbl] || 0) > 0 }] };
          }
          return { rowCount: 1, rows: [{ cnt: minibarCounts[tbl] || 0 }] };
        }
      }
      if (norm.includes("to_regclass('public.stock_movements')")) {
        return { rowCount: 1, rows: [{ sm_reg: null, sb_reg: null }] };
      }
      if (norm.startsWith('UPDATE pos_menu_items SET')) {
        lockedItem.base_unit = params[params.length - 4];
        lockedItem.canonical_base_unit_code = params[params.length - 3];
        return { rowCount: 1, rows: [{ ...lockedItem }] };
      }
      throw new Error(`Unexpected SQL in T8.3: ${norm}`);
    };

    const mockPool = {
      query: handleMockQuery,
      async connect() {
        return {
          query: handleMockQuery,
          release() {},
        };
      },
    };

    const patchHandler = createPosMenuItemPatchHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
    });

    // 1) Saat terkunci oleh kemasan aktif, mengubah canonical_base_unit_code KG -> GRAM ditolak 409 BASE_UNIT_LOCKED_BY_USAGE
    const resChangeCanonical = makeMockRes();
    await patchHandler(
      {
        params: { id: '601' },
        query: { property_id: '1' },
        body: { canonical_base_unit_code: 'GRAM', base_unit: 'Gram' },
      },
      resChangeCanonical
    );
    assert.strictEqual(resChangeCanonical.statusCode, 409);
    assert.strictEqual(resChangeCanonical.body.code, 'BASE_UNIT_LOCKED_BY_USAGE');
    assert.strictEqual(lockedItem.canonical_base_unit_code, 'KG');

    // 2) Saat terkunci, caller lama mengirim base_unit berbeda ("Botol") ditolak 409 BASE_UNIT_LOCKED_BY_USAGE
    const resLegacyChange = makeMockRes();
    await patchHandler(
      {
        params: { id: '601' },
        query: { property_id: '1' },
        body: { base_unit: 'Botol' },
      },
      resLegacyChange
    );
    assert.strictEqual(resLegacyChange.statusCode, 409);
    assert.strictEqual(resLegacyChange.body.code, 'BASE_UNIT_LOCKED_BY_USAGE');

    // 3) Saat terkunci, caller lama mengirim ulang label yang setara ("Kilogram") DIIZINKAN (C2) dan mempertahankan kode KG
    const resSameAlias = makeMockRes();
    await patchHandler(
      {
        params: { id: '601' },
        query: { property_id: '1' },
        body: { base_unit: 'Kilogram' },
      },
      resSameAlias
    );
    assert.strictEqual(resSameAlias.statusCode, 200);
    assert.strictEqual(resSameAlias.body.data.canonical_base_unit_code, 'KG');
    assert.strictEqual(resSameAlias.body.data.base_unit, 'Kg');

    // 4) Tanpa kemasan aktif, tetapi direferensikan di tabel minibar kontrak (mis. minibar_stay_event) ->
    //    tetap terkunci pada PATCH dan selaras dengan fetchPropertyPackagingsByItem (GET katalog)
    hasPackagingRows = false;
    minibarCounts.minibar_stay_event = 2;

    const resLockedByMinibar = makeMockRes();
    await patchHandler(
      {
        params: { id: '601' },
        query: { property_id: '1' },
        body: { canonical_base_unit_code: 'GRAM' },
      },
      resLockedByMinibar
    );
    assert.strictEqual(resLockedByMinibar.statusCode, 409);
    assert.strictEqual(resLockedByMinibar.body.code, 'BASE_UNIT_LOCKED_BY_USAGE');

    const catalogLockCheck = await fetchPropertyPackagingsByItem(mockPool, 1);
    assert.strictEqual(
      catalogLockCheck.lockedByMinibarItemIds.has(601),
      true,
      'GET katalog wajib menandai produk yang direferensikan tabel minibar sebagai terkunci'
    );

    // 5) Kegagalan query pada tabel minibar yang ada TIDAK boleh dianggap "belum digunakan" -> 503 USAGE_CHECK_FAILED
    simulateMinibarDbError = new Error('Simulated DB error on minibar_stay_event');
    const resMinibarQueryFail = makeMockRes();
    await patchHandler(
      {
        params: { id: '601' },
        query: { property_id: '1' },
        body: { canonical_base_unit_code: 'GRAM' },
      },
      resMinibarQueryFail
    );
    assert.strictEqual(resMinibarQueryFail.statusCode, 503);
    assert.strictEqual(resMinibarQueryFail.body.code, 'USAGE_CHECK_FAILED');
    simulateMinibarDbError = null;
    minibarCounts.minibar_stay_event = 0;

    // 6) Kegagalan kueri pemeriksaan kemasan juga menghasilkan 503 USAGE_CHECK_FAILED
    simulateDbErrorOnCheck = new Error('Simulated DB timeout while checking packaging table');
    const resCheckFailed = makeMockRes();
    await patchHandler(
      {
        params: { id: '601' },
        query: { property_id: '1' },
        body: { canonical_base_unit_code: 'GRAM' },
      },
      resCheckFailed
    );
    assert.strictEqual(resCheckFailed.statusCode, 503);
    assert.strictEqual(resCheckFailed.body.code, 'USAGE_CHECK_FAILED');

    // 7) Jika tabel wajib product_packaging_conversions belum dimigrasikan (to_regclass === null) -> 503 SCHEMA_NOT_READY
    simulateDbErrorOnCheck = null;
    simulateSchemaMissing = true;
    const resSchemaNotReady = makeMockRes();
    await patchHandler(
      {
        params: { id: '601' },
        query: { property_id: '1' },
        body: { canonical_base_unit_code: 'GRAM' },
      },
      resSchemaNotReady
    );
    assert.strictEqual(resSchemaNotReady.statusCode, 503);
    assert.strictEqual(resSchemaNotReady.body.code, 'SCHEMA_NOT_READY');
  });

  await test('T8.4 & T8.5 MP-03C: Endpoint Kemasan Produk — snapshot idempotency immutable pasca-edit (faktor 24 -> 12), lock FOR UPDATE, 409 PACKAGING_BASE_UNIT_MISMATCH, & larangan reaktivasi beda satuan', async () => {
    const productState = {
      id: 701,
      property_id: 1,
      name: 'Air Mineral 600ml',
      base_unit: 'Botol',
      canonical_base_unit_code: 'BOTOL',
    };
    const packagings = [];
    let nextPkgId = 1;
    const lockedSelectQueries = [];

    const mockPool = {
      async query(sql, params = []) {
        const norm = String(sql).replace(/\s+/g, ' ').trim();
        if (norm.startsWith('SELECT id, property_id, name, base_unit, canonical_base_unit_code FROM pos_menu_items')) {
          if (Number(params[0]) === productState.id && Number(params[1]) === productState.property_id) {
            return { rowCount: 1, rows: [{ ...productState }] };
          }
          return { rowCount: 0, rows: [] };
        }
        if (norm.includes("to_regclass('public.product_packaging_conversions')")) {
          return { rowCount: 1, rows: [{ pkg_reg: 'product_packaging_conversions' }] };
        }
        if (norm.includes('FROM product_packaging_conversions') && norm.includes('COUNT(*)')) {
          const activeCnt = packagings.filter(
            (p) => p.property_id === Number(params[0]) && p.menu_item_id === Number(params[1]) && p.is_active
          ).length;
          return { rowCount: 1, rows: [{ cnt: activeCnt }] };
        }
        if (norm.includes("to_regclass('public.room_type_minibar_standard')")) {
          return {
            rowCount: 1,
            rows: [{ rtms_reg: null, mbv_reg: null, mse_reg: null, mirl_reg: null }],
          };
        }
        if (norm.includes("to_regclass('public.stock_movements')")) {
          return { rowCount: 1, rows: [{ sm_reg: null, sb_reg: null }] };
        }
        if (norm.includes('FROM product_packaging_conversions') && norm.includes('ORDER BY is_active DESC')) {
          return { rowCount: packagings.length, rows: packagings.map((p) => ({ ...p })) };
        }
        throw new Error(`Unexpected pool.query in T8.4: ${norm}`);
      },
      async connect() {
        return {
          async query(sql, params = []) {
            const norm = String(sql).replace(/\s+/g, ' ').trim();
            if (norm === 'BEGIN' || norm === 'COMMIT' || norm === 'ROLLBACK') {
              return { rowCount: 0, rows: [] };
            }
            if (norm.startsWith('SELECT id, property_id, base_unit, canonical_base_unit_code FROM pos_menu_items')) {
              if (norm.includes('FOR UPDATE')) {
                lockedSelectQueries.push(norm);
              }
              if (Number(params[0]) === productState.id && Number(params[1]) === productState.property_id) {
                return { rowCount: 1, rows: [{ ...productState }] };
              }
              return { rowCount: 0, rows: [] };
            }
            if (norm.includes('FROM product_packaging_conversions') && norm.includes('AND BTRIM(idempotency_key) = $3')) {
              const found = packagings.find(
                (p) =>
                  p.property_id === Number(params[0]) &&
                  p.menu_item_id === Number(params[1]) &&
                  p.idempotency_key === String(params[2]).trim()
              );
              return found ? { rowCount: 1, rows: [{ ...found }] } : { rowCount: 0, rows: [] };
            }
            if (norm.includes('FROM product_packaging_conversions') && norm.includes('AND UPPER(BTRIM(packaging_code)) = $3')) {
              const excludeId = params.length >= 4 ? Number(params[3]) : null;
              const found = packagings.find(
                (p) =>
                  p.property_id === Number(params[0]) &&
                  p.menu_item_id === Number(params[1]) &&
                  p.packaging_code.toUpperCase() === String(params[2]).toUpperCase() &&
                  (excludeId === null || p.id !== excludeId)
              );
              return found ? { rowCount: 1, rows: [{ id: found.id }] } : { rowCount: 0, rows: [] };
            }
            if (norm.includes('FROM product_packaging_conversions') && norm.includes('AND LOWER(BTRIM(packaging_label)) = LOWER($3)')) {
              const excludeId = params.length >= 4 ? Number(params[3]) : null;
              const found = packagings.find(
                (p) =>
                  p.property_id === Number(params[0]) &&
                  p.menu_item_id === Number(params[1]) &&
                  p.packaging_label.toLowerCase() === String(params[2]).toLowerCase() &&
                  (excludeId === null || p.id !== excludeId)
              );
              return found ? { rowCount: 1, rows: [{ id: found.id }] } : { rowCount: 0, rows: [] };
            }
            if (norm.includes('FROM product_packaging_conversions') && norm.includes('WHERE id = $1 AND menu_item_id = $2 AND property_id = $3 FOR UPDATE')) {
              const found = packagings.find(
                (p) =>
                  p.id === Number(params[0]) &&
                  p.menu_item_id === Number(params[1]) &&
                  p.property_id === Number(params[2])
              );
              return found ? { rowCount: 1, rows: [{ ...found }] } : { rowCount: 0, rows: [] };
            }
            if (norm.startsWith('UPDATE product_packaging_conversions SET is_default_purchase = FALSE')) {
              for (const p of packagings) {
                if (p.property_id === Number(params[0]) && p.menu_item_id === Number(params[1])) {
                  if (params.length < 3 || p.id !== Number(params[2])) {
                    p.is_default_purchase = false;
                  }
                }
              }
              return { rowCount: 1, rows: [] };
            }
            if (norm.startsWith('INSERT INTO product_packaging_conversions')) {
              const row = {
                id: nextPkgId++,
                property_id: Number(params[0]),
                menu_item_id: Number(params[1]),
                packaging_code: params[2],
                packaging_label: params[3],
                base_unit_code: params[4],
                to_base_factor: params[5],
                is_default_purchase: Boolean(params[6]),
                is_active: true,
                idempotency_key: params[7],
                create_payload_hash: params[8],
                create_payload_snapshot:
                  typeof params[9] === 'string' ? JSON.parse(params[9]) : params[9],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };
              packagings.push(row);
              return { rowCount: 1, rows: [{ ...row }] };
            }
            if (norm.startsWith('UPDATE product_packaging_conversions SET packaging_code = $1')) {
              const target = packagings.find((p) => p.id === Number(params[5]));
              target.packaging_code = params[0];
              target.packaging_label = params[1];
              target.to_base_factor = params[2];
              target.is_default_purchase = Boolean(params[3]);
              target.is_active = Boolean(params[4]);
              return { rowCount: 1, rows: [{ ...target }] };
            }
            throw new Error(`Unexpected SQL in T8.4: ${norm}`);
          },
          release() {},
        };
      },
    };

    const createPkgHandler = createProductPackagingCreateHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
    });
    const patchPkgHandler = createProductPackagingPatchHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
    });
    const listPkgHandler = createProductPackagingListHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
    });

    // 1) POST tanpa base_unit_code -> 400 BASE_UNIT_CODE_REQUIRED
    const resMissingBaseUnit = makeMockRes();
    await createPkgHandler(
      {
        params: { id: '701' },
        query: { property_id: '1' },
        body: {
          idempotency_key: 'idem-001',
          packaging_code: 'KARTON',
          packaging_label: 'Karton 24 Botol',
          to_base_factor: '24',
        },
      },
      resMissingBaseUnit
    );
    assert.strictEqual(resMissingBaseUnit.statusCode, 400);
    assert.strictEqual(resMissingBaseUnit.body.code, 'BASE_UNIT_CODE_REQUIRED');

    // 2) POST tanpa idempotency_key -> 400 IDEMPOTENCY_KEY_REQUIRED
    const resMissingIdem = makeMockRes();
    await createPkgHandler(
      {
        params: { id: '701' },
        query: { property_id: '1' },
        body: {
          base_unit_code: 'BOTOL',
          packaging_code: 'KARTON',
          packaging_label: 'Karton 24 Botol',
          to_base_factor: '24',
        },
      },
      resMissingIdem
    );
    assert.strictEqual(resMissingIdem.statusCode, 400);
    assert.strictEqual(resMissingIdem.body.code, 'IDEMPOTENCY_KEY_REQUIRED');

    // 3) POST dengan base_unit_code snapshot yang berbeda dari satuan produk saat ini di DB -> 409 PACKAGING_BASE_UNIT_MISMATCH
    const resMismatchUnit = makeMockRes();
    await createPkgHandler(
      {
        params: { id: '701' },
        query: { property_id: '1' },
        body: {
          idempotency_key: 'idem-mismatch',
          base_unit_code: 'PCS', // produk saat ini adalah BOTOL
          packaging_code: 'KARTON',
          packaging_label: 'Karton 24',
          to_base_factor: '24',
        },
      },
      resMismatchUnit
    );
    assert.strictEqual(resMismatchUnit.statusCode, 409);
    assert.strictEqual(resMismatchUnit.body.code, 'PACKAGING_BASE_UNIT_MISMATCH');
    assert.ok(lockedSelectQueries.length >= 1, 'Pemeriksaan satuan produk wajib dilakukan setelah SELECT ... FOR UPDATE');

    // 4) POST dengan faktor pecahan pada satuan dasar diskrit (BOTOL) -> 400 INTEGER_UNIT_REQUIRES_WHOLE_NUMBER
    const resDiscreteFraction = makeMockRes();
    await createPkgHandler(
      {
        params: { id: '701' },
        query: { property_id: '1' },
        body: {
          idempotency_key: 'idem-frac',
          base_unit_code: 'BOTOL',
          packaging_code: 'KARTON',
          packaging_label: 'Karton Pecahan',
          to_base_factor: '24.5',
        },
      },
      resDiscreteFraction
    );
    assert.strictEqual(resDiscreteFraction.statusCode, 400);
    assert.strictEqual(resDiscreteFraction.body.code, 'INTEGER_UNIT_REQUIRES_WHOLE_NUMBER');

    // 5) POST sukses faktor 24 -> 201 Created, menyimpan base_unit_code, idempotency_key, & snapshot penciptaan immutable
    const resCreateOk = makeMockRes();
    await createPkgHandler(
      {
        params: { id: '701' },
        query: { property_id: '1' },
        body: {
          idempotency_key: 'pkg-701-op-1',
          base_unit_code: 'BOTOL',
          packaging_code: 'KARTON',
          packaging_label: 'Karton 24 Botol',
          to_base_factor: '24',
          is_default_purchase: true,
        },
      },
      resCreateOk
    );
    assert.strictEqual(resCreateOk.statusCode, 201);
    assert.strictEqual(resCreateOk.body.replayed, false);
    assert.strictEqual(resCreateOk.body.data.id, 1);
    assert.strictEqual(resCreateOk.body.data.base_unit_code, 'BOTOL');
    assert.strictEqual(resCreateOk.body.data.to_base_factor, '24.000');
    assert.strictEqual(resCreateOk.body.data.idempotency_key, 'pkg-701-op-1');
    assert.ok(packagings[0].create_payload_hash, 'create_payload_hash wajib tersimpan');
    assert.strictEqual(packagings[0].create_payload_snapshot.to_base_factor, '24.000');

    // 6) Regresi Temuan #2: Edit faktor kemasan dari 24 menjadi 12 melalui PATCH
    const resEditTo12 = makeMockRes();
    await patchPkgHandler(
      {
        params: { id: '701', packagingId: '1' },
        query: { property_id: '1' },
        body: {
          to_base_factor: '12',
        },
      },
      resEditTo12
    );
    assert.strictEqual(resEditTo12.statusCode, 200);
    assert.strictEqual(resEditTo12.body.data.to_base_factor, '12.000');
    assert.strictEqual(packagings[0].to_base_factor, '12.000');

    // 7) Retry POST dengan payload penciptaan asli (faktor 24) dan key lama 'pkg-701-op-1' ->
    //    wajib 200 OK (replayed: true), mengembalikan ID yang sama (#1), dan TIDAK menimpa faktor 12 kembali ke 24!
    const resReplayOriginalAfterEdit = makeMockRes();
    await createPkgHandler(
      {
        params: { id: '701' },
        query: { property_id: '1' },
        body: {
          idempotency_key: 'pkg-701-op-1',
          base_unit_code: 'BOTOL',
          packaging_code: 'KARTON',
          packaging_label: 'Karton 24 Botol',
          to_base_factor: '24.000',
          is_default_purchase: true,
        },
      },
      resReplayOriginalAfterEdit
    );
    assert.strictEqual(resReplayOriginalAfterEdit.statusCode, 200);
    assert.strictEqual(resReplayOriginalAfterEdit.body.replayed, true);
    assert.strictEqual(resReplayOriginalAfterEdit.body.data.id, 1);
    assert.strictEqual(
      resReplayOriginalAfterEdit.body.data.to_base_factor,
      '12.000',
      'Replay idempotency_key tidak boleh menerapkan ulang/menimpa hasil edit menjadi 24.000'
    );
    assert.strictEqual(packagings[0].to_base_factor, '12.000');
    assert.strictEqual(packagings.length, 1, 'Replay idempotency_key tidak boleh menambah baris kedua');

    // 8) POST dengan payload hasil edit (faktor 12) menggunakan key penciptaan lama 'pkg-701-op-1' ->
    //    wajib ditolak 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH!
    const resReplayEditedPayloadMismatch = makeMockRes();
    await createPkgHandler(
      {
        params: { id: '701' },
        query: { property_id: '1' },
        body: {
          idempotency_key: 'pkg-701-op-1',
          base_unit_code: 'BOTOL',
          packaging_code: 'KARTON',
          packaging_label: 'Karton 24 Botol',
          to_base_factor: '12',
          is_default_purchase: true,
        },
      },
      resReplayEditedPayloadMismatch
    );
    assert.strictEqual(resReplayEditedPayloadMismatch.statusCode, 409);
    assert.strictEqual(resReplayEditedPayloadMismatch.body.code, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');

    // 9) Skenario celah §3.2 & §4.1: Kemasan nonaktif memiliki base_unit_code 'KG', sedangkan produk saat ini 'GRAM'.
    //    Reaktivasi kemasan lama wajib ditolak 409 PACKAGING_BASE_UNIT_MISMATCH!
    packagings.push({
      id: 2,
      property_id: 1,
      menu_item_id: 701,
      packaging_code: 'BOX',
      packaging_label: 'Box 25 Kg Lama',
      base_unit_code: 'KG',
      to_base_factor: '25.000',
      is_default_purchase: false,
      is_active: false,
      idempotency_key: 'legacy-kg-box',
    });
    productState.canonical_base_unit_code = 'GRAM';

    const resReactivateMismatch = makeMockRes();
    await patchPkgHandler(
      {
        params: { id: '701', packagingId: '2' },
        query: { property_id: '1' },
        body: { is_active: true },
      },
      resReactivateMismatch
    );
    assert.strictEqual(resReactivateMismatch.statusCode, 409);
    assert.strictEqual(resReactivateMismatch.body.code, 'PACKAGING_BASE_UNIT_MISMATCH');
    assert.strictEqual(packagings[1].is_active, false, 'Kemasan beda satuan dasar tidak boleh aktif kembali');

    // 10) GET daftar kemasan mengembalikan daftar beserta idempotency_key dan is_base_unit_locked
    const resList = makeMockRes();
    await listPkgHandler({ params: { id: '701' }, query: { property_id: '1' } }, resList);
    assert.strictEqual(resList.statusCode, 200);
    assert.strictEqual(resList.body.data.is_base_unit_locked, true);
    assert.strictEqual(resList.body.data.packagings.length, 2);
    assert.strictEqual(resList.body.data.packagings[0].idempotency_key, 'pkg-701-op-1');
  });

  await test('T8.6 MP-03C: Endpoint Lokasi Stok & Minibar Kamar — 5 tipe lokasi kontrak, JOIN room_types tanpa status operasional, & kunci kamar lokasi nonaktif', async () => {
    const roomTypes = [
      { id: 10, name: 'Deluxe King Canonical' },
      { id: 20, name: 'Executive Suite Canonical' },
    ];
    const rooms = [
      { id: 101, property_id: 1, room_number: '101', room_type_id: 10, type: 'Deluxe King Legacy', status: 'VACANT_CLEAN' },
      { id: 102, property_id: 1, room_number: '102', room_type_id: null, type: 'Standard Twin Fallback', status: 'OCCUPIED_CLEAN' },
      { id: 201, property_id: 2, room_number: '201', room_type_id: 20, type: 'Suite', status: 'VACANT_CLEAN' },
    ];
    const locations = [];
    let nextLocId = 1;

    const mockPool = {
      async query(sql, params = []) {
        const norm = String(sql).replace(/\s+/g, ' ').trim();
        if (norm.includes('FROM stock_locations sl') && norm.includes('LEFT JOIN rooms r')) {
          const pid = Number(params[0]);
          const rows = locations
            .filter((l) => l.property_id === pid)
            .map((l) => {
              const rm = rooms.find((r) => r.id === l.room_id && r.property_id === l.property_id);
              return {
                ...l,
                room_number: rm ? rm.room_number : null,
              };
            });
          return { rowCount: rows.length, rows };
        }
        if (
          norm.includes('FROM rooms r') &&
          norm.includes('LEFT JOIN room_types rt ON rt.id = r.room_type_id') &&
          norm.includes('LEFT JOIN stock_locations sl')
        ) {
          const pid = Number(params[0]);
          const rows = rooms
            .filter((r) => r.property_id === pid)
            .map((r) => {
              const rt = roomTypes.find((t) => t.id === r.room_type_id);
              const loc = locations.find(
                (l) => l.property_id === pid && l.room_id === r.id && l.location_type === 'ROOM_MINIBAR'
              );
              return {
                room_id: r.id,
                room_number: r.room_number,
                room_type_id: r.room_type_id,
                room_type_name: rt ? rt.name : r.type,
                existing_stock_location_id: loc ? loc.id : null,
                existing_stock_location_code: loc ? loc.code : null,
                existing_stock_location_is_active: loc ? Boolean(loc.is_active) : null,
              };
            });
          return { rowCount: rows.length, rows };
        }
        throw new Error(`Unexpected pool.query in T8.6: ${norm}`);
      },
      async connect() {
        return {
          async query(sql, params = []) {
            const norm = String(sql).replace(/\s+/g, ' ').trim();
            if (norm === 'BEGIN' || norm === 'COMMIT' || norm === 'ROLLBACK') return { rowCount: 0, rows: [] };
            if (norm.startsWith('SELECT id, property_id, room_number FROM rooms WHERE id = $1')) {
              const rm = rooms.find((r) => r.id === Number(params[0]));
              return rm ? { rowCount: 1, rows: [rm] } : { rowCount: 0, rows: [] };
            }
            if (norm.includes('FROM stock_locations WHERE property_id = $1 AND room_id = $2 AND location_type =')) {
              const dup = locations.find(
                (l) =>
                  l.property_id === Number(params[0]) &&
                  l.room_id === Number(params[1]) &&
                  l.location_type === 'ROOM_MINIBAR'
              );
              return dup ? { rowCount: 1, rows: [dup] } : { rowCount: 0, rows: [] };
            }
            if (norm.includes('FROM stock_locations WHERE property_id = $1 AND UPPER(BTRIM(code)) = $2')) {
              const excludeId = params.length >= 3 ? Number(params[2]) : null;
              const dup = locations.find(
                (l) =>
                  l.property_id === Number(params[0]) &&
                  l.code.toUpperCase() === String(params[1]).toUpperCase() &&
                  (excludeId === null || l.id !== excludeId)
              );
              return dup ? { rowCount: 1, rows: [{ id: dup.id }] } : { rowCount: 0, rows: [] };
            }
            if (norm.includes('FROM stock_locations WHERE property_id = $1 AND LOWER(BTRIM(name)) = LOWER($2)')) {
              const excludeId = params.length >= 3 ? Number(params[2]) : null;
              const dup = locations.find(
                (l) =>
                  l.property_id === Number(params[0]) &&
                  l.name.toLowerCase() === String(params[1]).toLowerCase() &&
                  (excludeId === null || l.id !== excludeId)
              );
              return dup ? { rowCount: 1, rows: [{ id: dup.id }] } : { rowCount: 0, rows: [] };
            }
            if (norm.startsWith('INSERT INTO stock_locations')) {
              const row = {
                id: nextLocId++,
                property_id: Number(params[0]),
                code: params[1],
                name: params[2],
                location_type: params[3],
                room_id: params[4],
                is_active: Boolean(params[5]),
                notes: params[6],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };
              locations.push(row);
              return { rowCount: 1, rows: [{ ...row }] };
            }
            if (norm.includes('FROM stock_locations sl') && norm.includes('FOR UPDATE OF sl')) {
              const found = locations.find(
                (l) => l.id === Number(params[0]) && l.property_id === Number(params[1])
              );
              if (!found) return { rowCount: 0, rows: [] };
              const rm = rooms.find((r) => r.id === found.room_id && r.property_id === found.property_id);
              return {
                rowCount: 1,
                rows: [{ ...found, room_number: rm ? rm.room_number : null }],
              };
            }
            if (norm.startsWith('UPDATE stock_locations SET code = $1')) {
              const target = locations.find((l) => l.id === Number(params[4]));
              target.code = params[0];
              target.name = params[1];
              target.is_active = Boolean(params[2]);
              target.notes = params[3];
              return { rowCount: 1, rows: [{ ...target }] };
            }
            throw new Error(`Unexpected client.query in T8.6: ${norm}`);
          },
          release() {},
        };
      },
    };

    const createLocHandler = createStockLocationCreateHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
    });
    const patchLocHandler = createStockLocationPatchHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
    });
    const listLocHandler = createStockLocationListHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
    });
    const roomCandHandler = createStockLocationRoomCandidatesHandler({
      pool: mockPool,
      assertPropertyScope: async () => {},
    });

    // 1) Buat WAREHOUSE sukses
    const resCreateWh = makeMockRes();
    await createLocHandler(
      {
        query: { property_id: '1' },
        body: { code: 'wh-main', name: 'Gudang Utama Hotel', location_type: 'WAREHOUSE' },
      },
      resCreateWh
    );
    assert.strictEqual(resCreateWh.statusCode, 201);
    assert.strictEqual(resCreateWh.body.data.code, 'WH-MAIN');
    assert.strictEqual(resCreateWh.body.data.location_type, 'WAREHOUSE');
    assert.strictEqual(resCreateWh.body.data.room_id, null);

    // 2) Buat WAREHOUSE dengan room_id -> 400 ROOM_ID_FORBIDDEN_FOR_NON_MINIBAR
    const resWhWithRoom = makeMockRes();
    await createLocHandler(
      {
        query: { property_id: '1' },
        body: { code: 'WH-2', name: 'Gudang Salah', location_type: 'WAREHOUSE', room_id: 101 },
      },
      resWhWithRoom
    );
    assert.strictEqual(resWhWithRoom.statusCode, 400);
    assert.strictEqual(resWhWithRoom.body.code, 'ROOM_ID_FORBIDDEN_FOR_NON_MINIBAR');

    // 3) Buat ROOM_MINIBAR tanpa room_id -> 400 ROOM_ID_REQUIRED_FOR_MINIBAR
    const resMbNoRoom = makeMockRes();
    await createLocHandler(
      {
        query: { property_id: '1' },
        body: { code: 'MB-NO', name: 'Minibar Tanpa Kamar', location_type: 'ROOM_MINIBAR' },
      },
      resMbNoRoom
    );
    assert.strictEqual(resMbNoRoom.statusCode, 400);
    assert.strictEqual(resMbNoRoom.body.code, 'ROOM_ID_REQUIRED_FOR_MINIBAR');

    // 4) Buat ROOM_MINIBAR dengan room_id milik properti lain (#201 milik properti 2) -> 422 ROOM_PROPERTY_MISMATCH
    const resMbOtherPropRoom = makeMockRes();
    await createLocHandler(
      {
        query: { property_id: '1' },
        body: { code: 'MB-201', name: 'Minibar Kamar 201', location_type: 'ROOM_MINIBAR', room_id: 201 },
      },
      resMbOtherPropRoom
    );
    assert.strictEqual(resMbOtherPropRoom.statusCode, 422);
    assert.strictEqual(resMbOtherPropRoom.body.code, 'ROOM_PROPERTY_MISMATCH');

    // 5) Buat ROOM_MINIBAR valid untuk kamar 101 di properti 1 -> 201 Created
    const resMbOk = makeMockRes();
    await createLocHandler(
      {
        query: { property_id: '1' },
        body: { code: 'mb-101', name: 'Minibar Kamar 101', location_type: 'ROOM_MINIBAR', room_id: 101 },
      },
      resMbOk
    );
    assert.strictEqual(resMbOk.statusCode, 201);
    assert.strictEqual(resMbOk.body.data.code, 'MB-101');
    assert.strictEqual(resMbOk.body.data.room_id, 101);
    assert.strictEqual(resMbOk.body.data.room_number, '101');

    // 6) Buat ROOM_MINIBAR kedua untuk kamar 101 yang sama -> 409 ROOM_MINIBAR_LOCATION_EXISTS
    const resMbDupRoom = makeMockRes();
    await createLocHandler(
      {
        query: { property_id: '1' },
        body: { code: 'MB-101-B', name: 'Minibar Duplikat 101', location_type: 'ROOM_MINIBAR', room_id: 101 },
      },
      resMbDupRoom
    );
    assert.strictEqual(resMbDupRoom.statusCode, 409);
    assert.strictEqual(resMbDupRoom.body.code, 'ROOM_MINIBAR_LOCATION_EXISTS');

    // 7) PATCH yang mencoba mengubah location_type atau room_id -> 400 IMMUTABLE_LOCATION_IDENTITY
    const resPatchType = makeMockRes();
    await patchLocHandler(
      {
        params: { id: '2' },
        query: { property_id: '1' },
        body: { location_type: 'KITCHEN' },
      },
      resPatchType
    );
    assert.strictEqual(resPatchType.statusCode, 400);
    assert.strictEqual(resPatchType.body.code, 'IMMUTABLE_LOCATION_IDENTITY');

    const resPatchRoom = makeMockRes();
    await patchLocHandler(
      {
        params: { id: '2' },
        query: { property_id: '1' },
        body: { room_id: 102 },
      },
      resPatchRoom
    );
    assert.strictEqual(resPatchRoom.statusCode, 400);
    assert.strictEqual(resPatchRoom.body.code, 'IMMUTABLE_LOCATION_IDENTITY');

    // 8) PATCH nama/catatan/is_active -> 200 OK (menonaktifkan lokasi minibar kamar 101)
    const resPatchOk = makeMockRes();
    await patchLocHandler(
      {
        params: { id: '2' },
        query: { property_id: '1' },
        body: { name: 'Minibar Kamar 101 (VIP)', notes: 'Kulkas baru', is_active: false },
      },
      resPatchOk
    );
    assert.strictEqual(resPatchOk.statusCode, 200);
    assert.strictEqual(resPatchOk.body.data.name, 'Minibar Kamar 101 (VIP)');
    assert.strictEqual(resPatchOk.body.data.is_active, false);

    // 9) GET daftar lokasi & kandidat kamar minibar:
    //    - Tidak boleh mengembalikan field operasional `status`
    //    - Mengambil room_type_name dari room_types (Kamar 101 -> Deluxe King Canonical) dengan fallback r.type (Kamar 102 -> Standard Twin Fallback)
    //    - Kamar 101 yang terikat ke lokasi minibar nonaktif tetap tidak tersedia (is_available_for_minibar = false)
    const resList = makeMockRes();
    await listLocHandler({ query: { property_id: '1', include_inactive: 'true' } }, resList);
    assert.strictEqual(resList.statusCode, 200);
    assert.strictEqual(resList.body.data.locations.length, 2);

    const resCand = makeMockRes();
    await roomCandHandler({ query: { property_id: '1' } }, resCand);
    assert.strictEqual(resCand.statusCode, 200);
    assert.strictEqual(resCand.body.data.rooms.length, 2);
    const cand101 = resCand.body.data.rooms[0];
    const cand102 = resCand.body.data.rooms[1];
    assert.strictEqual('status' in cand101, false, 'Kandidat kamar tidak boleh membocorkan status operasional kamar');
    assert.strictEqual(cand101.room_type_name, 'Deluxe King Canonical');
    assert.strictEqual(cand101.existing_stock_location_id, 2);
    assert.strictEqual(cand101.existing_stock_location_code, 'MB-101');
    assert.strictEqual(cand101.existing_stock_location_is_active, false);
    assert.strictEqual(cand101.is_available_for_minibar, false);
    assert.strictEqual(cand102.room_type_name, 'Standard Twin Fallback');
    assert.strictEqual(cand102.is_available_for_minibar, true);
  });

  await test('T8.7 MP-03C: Kontrak Migration MP-03C, Kesetaraan schema_v3.ts & Migration Runner, serta Operational Access Rules', async () => {
    const fs = require('fs');
    const path = require('path');

    let okPoolEnded = false;
    let okClientReleased = false;
    const executedSql = [];
    const mockPoolSuccess = {
      async connect() {
        return {
          async query(sql) {
            const text = typeof sql === 'string' ? sql.trim() : '';
            executedSql.push(text);
            if (text.includes('FROM information_schema.tables') && text.includes('table_name IN')) {
              return {
                rowCount: 2,
                rows: [{ table_name: 'product_packaging_conversions' }, { table_name: 'stock_locations' }],
              };
            }
            if (text.includes('FROM information_schema.tables')) {
              return { rowCount: 1, rows: [{ '?column?': 1 }] };
            }
            if (text.includes('FROM information_schema.columns')) {
              return { rowCount: 1, rows: [{ column_name: 'canonical_base_unit_code' }] };
            }
            return { rowCount: 1, rows: [] };
          },
          release() {
            okClientReleased = true;
          },
        };
      },
      async end() {
        okPoolEnded = true;
      },
    };

    let okExitCode = null;
    const okResult = await runProductMasterMp03cMigrationCli({
      createPool: () => mockPoolSuccess,
      onError: () => {},
      setExitCode: (c) => { okExitCode = c; },
    });
    assert.strictEqual(okResult, 0);
    assert.strictEqual(okExitCode, null);
    assert.strictEqual(okClientReleased, true);
    assert.strictEqual(okPoolEnded, true);

    const joinedSql = executedSql.join('\n');
    assert.ok(joinedSql.includes('ADD COLUMN IF NOT EXISTS canonical_base_unit_code VARCHAR(20)'));
    assert.ok(joinedSql.includes('CREATE TABLE IF NOT EXISTS product_packaging_conversions'));
    assert.ok(joinedSql.includes('create_payload_hash VARCHAR(64)'));
    assert.ok(joinedSql.includes('create_payload_snapshot JSONB'));
    assert.ok(joinedSql.includes('to_base_factor <= 100000.000'));
    assert.ok(joinedSql.includes('uq_ppc_item_idempotency_key'));
    assert.ok(joinedSql.includes('CREATE TABLE IF NOT EXISTS stock_locations'));
    assert.ok(joinedSql.includes('fk_stock_locations_property_room'));
    assert.ok(joinedSql.includes('uq_stock_locations_property_room_minibar'));
    assert.ok(joinedSql.includes('trg_guard_pos_menu_item_base_unit'));
    assert.ok(joinedSql.includes('trg_guard_product_packaging_conversion'));
    assert.ok(joinedSql.includes('trg_guard_stock_location_identity'));

    // Verifikasi kesetaraan bootstrap schema_v3.ts dan migration product_master_mp03c_v1.ts
    const schemaV3Src = fs.readFileSync(
      path.resolve(__dirname, '../src/db/schema_v3.ts'),
      'utf8'
    );
    for (const unitCode of [
      'PCS', 'PORSI', 'GELAS', 'CUP', 'BOTOL', 'KALENG', 'PACK', 'BOX', 'ROLL', 'SET', 'LEMBAR', 'KG', 'GRAM', 'LITER', 'ML',
    ]) {
      assert.ok(joinedSql.includes(`'${unitCode}'`), `Migration wajib memuat satuan '${unitCode}'`);
      assert.ok(schemaV3Src.includes(`'${unitCode}'`), `schema_v3.ts wajib memuat satuan '${unitCode}'`);
    }
    for (const locType of ['WAREHOUSE', 'KITCHEN', 'POS_OUTLET', 'HK_PANTRY', 'ROOM_MINIBAR']) {
      assert.ok(joinedSql.includes(`'${locType}'`), `Migration wajib memuat tipe lokasi '${locType}'`);
      assert.ok(schemaV3Src.includes(`'${locType}'`), `schema_v3.ts wajib memuat tipe lokasi '${locType}'`);
    }
    for (const requiredFragment of [
      'to_base_factor <= 100000.000',
      'create_payload_hash VARCHAR(64)',
      'create_payload_snapshot JSONB',
      'trg_fn_guard_pos_menu_item_base_unit',
      'trg_guard_pos_menu_item_base_unit',
      'trg_fn_guard_product_packaging_conversion',
      'trg_guard_product_packaging_conversion',
      'trg_fn_guard_stock_location_identity',
      'trg_guard_stock_location_identity',
      'room_type_minibar_standard',
      'minibar_baseline_verification',
      'minibar_stay_event',
      'minibar_inspection_report_line',
    ]) {
      assert.ok(
        schemaV3Src.includes(requiredFragment),
        `schema_v3.ts wajib menyertakan fragmen MP-03C yang setara dengan migration: ${requiredFragment}`
      );
    }

    // Jalur gagal CLI runner menutup pool dan mengembalikan kode 1
    let failPoolEnded = false;
    let failExitCode = null;
    const mockPoolFail = {
      async connect() {
        return {
          async query(sql) {
            const text = typeof sql === 'string' ? sql.trim() : '';
            if (text.includes('FROM information_schema.tables')) {
              return { rowCount: 0, rows: [] };
            }
            return { rowCount: 0, rows: [] };
          },
          release() {},
        };
      },
      async end() {
        failPoolEnded = true;
      },
    };
    const failResult = await runProductMasterMp03cMigrationCli({
      createPool: () => mockPoolFail,
      onError: () => {},
      setExitCode: (c) => { failExitCode = c; },
    });
    assert.strictEqual(failResult, 1);
    assert.strictEqual(failExitCode, 1);
    assert.strictEqual(failPoolEnded, true);

    // Verifikasi entrypoint CLI require.main === module di dist/db/migrations/product_master_mp03c_v1.js
    const compiledMp03cSrc = fs.readFileSync(
      path.resolve(__dirname, '../dist/db/migrations/product_master_mp03c_v1.js'),
      'utf8'
    );
    assert.ok(compiledMp03cSrc.includes('require.main === module'));
    assert.ok(compiledMp03cSrc.includes('runProductMasterMp03cMigrationCli()'));

    // Verifikasi OPERATIONAL_ACCESS_RULES & matchOperationalAccessRule untuk stock-locations & packagings
    const stockLocGetMatch = matchOperationalAccessRule('/api/pos/stock-locations', 'GET');
    const stockLocCandMatch = matchOperationalAccessRule('/api/pos/stock-locations/room-candidates', 'GET');
    const stockLocPostMatch = matchOperationalAccessRule('/api/pos/stock-locations', 'POST');
    const stockLocPatchMatch = matchOperationalAccessRule('/api/pos/stock-locations/5', 'PATCH');
    const pkgGetMatch = matchOperationalAccessRule('/api/pos/menu/items/12/packagings', 'GET');
    const pkgPostMatch = matchOperationalAccessRule('/api/pos/menu/items/12/packagings', 'POST');
    assert.ok(
      stockLocGetMatch && stockLocCandMatch && stockLocPostMatch && stockLocPatchMatch && pkgGetMatch && pkgPostMatch,
      'Rules /api/pos/stock-locations dan packagings wajib terdaftar'
    );
    assert.deepStrictEqual(stockLocGetMatch.resources, ['Master Produk']);
    assert.strictEqual(stockLocGetMatch.action, 'view');
    assert.deepStrictEqual(stockLocCandMatch.resources, ['Master Produk']);
    assert.strictEqual(stockLocCandMatch.action, 'view');
    assert.deepStrictEqual(stockLocPostMatch.resources, ['Master Produk']);
    assert.strictEqual(stockLocPostMatch.action, 'edit');
    assert.deepStrictEqual(stockLocPatchMatch.resources, ['Master Produk']);
    assert.strictEqual(stockLocPatchMatch.action, 'edit');
    assert.deepStrictEqual(pkgGetMatch.resources, ['Master Produk']);
    assert.strictEqual(pkgGetMatch.action, 'view');
    assert.deepStrictEqual(pkgPostMatch.resources, ['Master Produk']);
    assert.strictEqual(pkgPostMatch.action, 'edit');
  });

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
