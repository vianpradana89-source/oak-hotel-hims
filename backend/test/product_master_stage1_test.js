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
  parseIsSellablePosInput,
  parsePriceInput,
  validateEffectiveSellablePrice,
  parseProductTypeQueryFilter,
  formatPosMenuItemRow,
  createPosMenuItemPatchHandler,
} = require('../dist/domains/pos/productMasterStage1');
const { createPosOrderCreateHandler } = require('../dist/domains/pos/posOrderCreateHandler');
const { createPosOrderUpdateHandler } = require('../dist/domains/pos/posOrderUpdateHandler');
const { runProductMasterStage1Migration } = require('../dist/db/migrations/product_master_stage1_v1');

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
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
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

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
