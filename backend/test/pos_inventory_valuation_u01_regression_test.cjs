'use strict';

/**
 * OAK HIMS — Regresi U01: Valuasi Persediaan Berbasis Moving Average Cost (Tahap 1A)
 * ==================================================================================
 *
 * Memverifikasi perbaikan Temuan U01:
 *   1. CONTROL_SAME_COST: 24 BOTOL @ Rp2.000, average_cost = 2000, last_cost = 2000, price = 5000
 *      -> unit_cost = "2000.00", total_value = "48000.00".
 *   2. U01_OWNER_REPORTED_50: 50 BOTOL dari 24@2.000 + 24@2.000 + 2@30.000,
 *      average_cost = 3120.00, last_cost = 30000.00, price = 5000.00
 *      -> unit_cost = "3120.00", total_value = "156000.00" (BUKAN 30000.00 / 1500000.00).
 *   3. U01_VALID_ZERO_COST: 10 BOTOL @ Rp0, average_cost = 0.00, last_cost = 0.00, price = 5000.00
 *      -> unit_cost = "0.00", total_value = "0.00", cost_known = true, cost_status = "KNOWN"
 *         (BUKAN fallback ke harga jual Rp5.000 / Rp50.000).
 *   4. U01_BONUS_LAST_COST_ZERO: 24@2.000 lalu 24@0 = 48 BOTOL,
 *      average_cost = 1000.00, last_cost = 0.00, price = 5000.00
 *      -> unit_cost = "1000.00", total_value = "48000.00" (BUKAN 2000.00 / 96000.00).
 *   5. U01_UNKNOWN_COST_NULL: Saldo stok tanpa biaya perolehan terverifikasi
 *      (average_cost = NULL, last_cost = NULL, movement unit_cost = NULL, price = 15000.00)
 *      -> unit_cost = null, total_value = null, cost_known = false, cost_status = "UNKNOWN",
 *         summary.unknown_cost_items = 1, dan TIDAK PERNAH menggunakan harga jual (pmi.price).
 *   6. U01_SELLING_PRICE_CHANGE_NO_EFFECT: Perubahan harga jual (pos_menu_items.price) tanpa mutasi
 *      stok/biaya perolehan sama sekali tidak mengubah unit_cost maupun total_value persediaan.
 *   7. U01_LOCATION_FILTER_AND_SUMMARY_CONSISTENCY: Filter per lokasi dan laporan gabungan memiliki
 *      summary.total_valuation_value yang sama persis dengan jumlah baris item yang memiliki biaya diketahui.
 *   8. U01_OPNAME_COST_SNAPSHOT_STABILITY: Opname fisik menyimpan snapshot biaya saat kejadian opname;
 *      penerimaan stok baru yang mengubah average_cost/last_cost sesudahnya TIDAK mengubah nilai variansi
 *      historis opname yang sudah tercatat, dan opname tidak pernah memakai harga jual (pmi.price).
 *   9. U01_READ_ONLY_REPORT_INVARIANT: Pemanggilan endpoint & fungsi laporan valuasi dan variansi opname
 *      bersifat murni read-only (tidak mengubah stock_balances, stock_movements, pos_menu_items, PO, GRN).
 */

const path = require('node:path');
const assert = require('node:assert');
const { execSync } = require('node:child_process');

process.env.JWT_SECRET = 'test-u01-valuation-jwt-secret-20261101';
process.env.TZ = 'Asia/Jakarta';

const repoRoot = process.env.OAK_REPO_ROOT || path.resolve(__dirname, '../..');
const backendNodeModules = path.join(repoRoot, 'backend', 'node_modules');
module.paths.unshift(backendNodeModules);

const { Pool } = require('pg');

const schema = require(path.join(repoRoot, 'backend', 'dist', 'db', 'schema_v3'));
const { runPosPaymentSettlementMigration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_payment_settlement_v1'));
const { runPosPurchaseOrdersMigration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_purchase_orders_v1'));
const { runPosPurchaseReceiptDraftPostMigration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_purchase_receipt_draft_post_v1'));
const { runPosPurchaseReceiptDraftPostV2Migration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_purchase_receipt_draft_post_v2'));
const { runPosProcurementTahap1aV1Migration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_procurement_tahap1a_v1'));

const {
  recordOpeningBalance,
  recordStockAdjustment,
  recordStockOpname,
  getInventoryValuationReport,
  getOpnameVarianceReport,
  createInventoryValuationHandler,
  createOpnameVarianceHandler,
} = require(path.join(repoRoot, 'backend', 'dist', 'domains', 'pos', 'stockInventoryService'));

const {
  createSupplier,
} = require(path.join(repoRoot, 'backend', 'dist', 'domains', 'suppliers', 'supplierService'));

const {
  createPurchaseOrder,
  updatePurchaseOrderStatus,
} = require(path.join(repoRoot, 'backend', 'dist', 'domains', 'pos', 'posPurchaseOrderService'));

const {
  recordPosGoodsReceipt,
  postPosGoodsReceipt,
} = require(path.join(repoRoot, 'backend', 'dist', 'domains', 'pos', 'posGoodsReceiptService'));

const CONTAINER_NAME = 'oak_hims_test_u01_valuation_pg';
const PG_PORT = 55453;
const DB_NAME = 'oak_hims_test_u01_valuation';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPostgres(pool, maxAttempts = 40) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('PostgreSQL 15 test container did not become ready in time');
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

async function runTests() {
  console.log('========================================================================');
  console.log(' OAK HIMS — Regresi U01: Valuasi Persediaan & Moving Average Cost');
  console.log('========================================================================');

  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'ignore' });
  } catch {}

  console.log(`[SETUP] Starting isolated PostgreSQL 15 container (${CONTAINER_NAME} on port ${PG_PORT})...`);
  execSync(
    `docker run -d --name ${CONTAINER_NAME} -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=${DB_NAME} -p 127.0.0.1:${PG_PORT}:5432 postgres:15-alpine`,
    { stdio: 'inherit' }
  );

  const pool = new Pool({
    host: '127.0.0.1',
    port: PG_PORT,
    user: 'postgres',
    password: 'postgres',
    database: DB_NAME,
  });

  try {
    await waitForPostgres(pool);
    console.log('[SETUP] Running canonical schema initialization & Tahap 1A migrations...');
    await schema.initializeDatabase(pool);
    await runPosPaymentSettlementMigration(pool);
    await runPosPurchaseOrdersMigration(pool);
    await runPosPurchaseReceiptDraftPostMigration(pool);
    await runPosPurchaseReceiptDraftPostV2Migration(pool);
    await runPosProcurementTahap1aV1Migration(pool);

    // Seed property, role, user, category, and 2 stock locations
    await pool.query(`
      INSERT INTO properties (id, name, property_code, address)
      VALUES (1, 'OAK Hotel [Test U01 Valuation]', 'OAKU01', 'Jl. Uji Valuasi U01 No. 1')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO roles (id, name, description)
      VALUES (1, 'SUPER_ADMIN', 'Platform Super Admin')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO users (id, property_id, role_id, username, email, password_hash, full_name, is_active, account_status)
      VALUES (1, 1, 1, 'admin.u01', 'admin.u01@oakhims.local', 'hash', 'Manager Gudang U01', TRUE, 'READY')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO pos_menu_categories (id, property_id, name)
      VALUES (1, 1, 'Minuman & Bahan Baku U01')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO stock_locations (id, property_id, code, name, location_type, is_active)
      VALUES
        (1, 1, 'WH-U01-MAIN', 'Gudang Utama U01', 'WAREHOUSE', TRUE),
        (2, 1, 'OUT-U01-CAFE', 'Outlet Cafe U01', 'POS_OUTLET', TRUE)
      ON CONFLICT (id) DO NOTHING;
    `);

    const supplier = await createSupplier(pool, {
      property_id: 1,
      code: 'SUP-U01-01',
      name: 'PT Sumber Air U01',
      contact_person: 'Budi',
      phone: '081234567890',
      is_active: true,
    });

    // -------------------------------------------------------------------------
    // TEST 1: 4 Kasus Saksi Reviewer (CONTROL_SAME_COST, U01_OWNER_REPORTED_50,
    //         U01_VALID_ZERO_COST, U01_BONUS_LAST_COST_ZERO) melalui alur nyata
    // -------------------------------------------------------------------------
    console.log('\n[TEST 1] Verifikasi 4 kasus saksi reviewer (Moving Average Cost vs Last Cost vs Selling Price)...');

    // Produk 101: CONTROL_SAME_COST (24 BOTOL @ Rp2.000, harga jual Rp5.000)
    // Produk 102: U01_OWNER_REPORTED_50 (24@2.000 + 24@2.000 + 2@30.000 = 50 BOTOL, avg=3.120, last=30.000, harga jual Rp5.000)
    // Produk 103: U01_VALID_ZERO_COST (10 BOTOL @ Rp0, avg=0, last=0, harga jual Rp5.000)
    // Produk 104: U01_BONUS_LAST_COST_ZERO (24@2.000 + 24@0 = 48 BOTOL, avg=1.000, last=0, harga jual Rp5.000)
    await pool.query(`
      INSERT INTO pos_menu_items (
        id, property_id, category_id, item_code, name, price,
        base_unit, canonical_base_unit_code, track_stock, is_active, is_sellable_pos
      ) VALUES
        (101, 1, 1, 'U01-CTRL-24', 'Air Mineral Control 24', 5000.00, 'BOTOL', 'BOTOL', TRUE, TRUE, TRUE),
        (102, 1, 1, 'U01-OWNER-50', 'Air Mineral UAT 50 Botol', 5000.00, 'BOTOL', 'BOTOL', TRUE, TRUE, TRUE),
        (103, 1, 1, 'U01-ZERO-10', 'Air Mineral Valid Zero Cost', 5000.00, 'BOTOL', 'BOTOL', TRUE, TRUE, TRUE),
        (104, 1, 1, 'U01-BONUS-48', 'Air Mineral Bonus Last Cost Zero', 5000.00, 'BOTOL', 'BOTOL', TRUE, TRUE, TRUE);
    `);

    // Helper untuk membuat PO, menyetujui, dan mem-posting GRN
    const createApprovedPo = async (items) => {
      const poDraft = await createPurchaseOrder(pool, {
        property_id: 1,
        supplier_id: supplier.id,
        supplier_name: supplier.name,
        order_date: '2026-10-31',
        items,
        created_by: 1,
        actor_name_snapshot: 'Manager Pengadaan',
      });
      await updatePurchaseOrderStatus(pool, 1, poDraft.id, 'PENDING_APPROVAL', 1, {
        actorNameSnapshot: 'Manager Pengadaan',
      });
      const poApproved = await updatePurchaseOrderStatus(pool, 1, poDraft.id, 'APPROVED', 1, {
        actorNameSnapshot: 'Manager Pengadaan',
      });
      return poApproved;
    };

    const postGrnFromPo = async (poId, locationId, items) => {
      const grnDraft = await recordPosGoodsReceipt(pool, {
        property_id: 1,
        po_id: poId,
        location_id: locationId,
        receipt_date: '2026-10-31',
        status: 'DRAFT',
        created_by: 'Manager Pengadaan',
        items,
      });
      return postPosGoodsReceipt(pool, 1, grnDraft.id, 'Manager Pengadaan');
    };

    // 101: Buat PO & GRN 24 @ 2000
    const po101 = await createApprovedPo([{ product_id: 101, ordered_qty: 24, unit_cost: 2000 }]);
    await postGrnFromPo(po101.id, 1, [
      { po_item_id: po101.items[0].id, product_id: 101, received_qty: 24, unit_cost: 2000 },
    ]);

    // 102: Buat 2 PO & 3 GRN sesuai skenario UAT (24@2000, 24@2000, 2@30000)
    const po102a = await createApprovedPo([{ product_id: 102, ordered_qty: 48, unit_cost: 2000 }]);
    await postGrnFromPo(po102a.id, 1, [
      { po_item_id: po102a.items[0].id, product_id: 102, received_qty: 24, unit_cost: 2000 },
    ]);
    await postGrnFromPo(po102a.id, 1, [
      { po_item_id: po102a.items[0].id, product_id: 102, received_qty: 24, unit_cost: 2000 },
    ]);

    const po102b = await createApprovedPo([{ product_id: 102, ordered_qty: 2, unit_cost: 30000 }]);
    await postGrnFromPo(po102b.id, 1, [
      { po_item_id: po102b.items[0].id, product_id: 102, received_qty: 2, unit_cost: 30000 },
    ]);

    // 103: U01_VALID_ZERO_COST (10 BOTOL @ Rp0)
    const po103 = await createApprovedPo([{ product_id: 103, ordered_qty: 10, unit_cost: 0 }]);
    await postGrnFromPo(po103.id, 1, [
      { po_item_id: po103.items[0].id, product_id: 103, received_qty: 10, unit_cost: 0 },
    ]);

    // 104: U01_BONUS_LAST_COST_ZERO (24 @ 2000 lalu 24 @ 0 -> avg = 1000, last = 0)
    const po104 = await createApprovedPo([
      { product_id: 104, ordered_qty: 24, unit_cost: 2000 },
      { product_id: 104, ordered_qty: 24, unit_cost: 0 },
    ]);
    await postGrnFromPo(po104.id, 1, [
      { po_item_id: po104.items[0].id, product_id: 104, received_qty: 24, unit_cost: 2000 },
    ]);
    await postGrnFromPo(po104.id, 1, [
      { po_item_id: po104.items[1].id, product_id: 104, received_qty: 24, unit_cost: 0 },
    ]);

    // Verifikasi laporan untuk masing-masing dari 4 kasus saksi reviewer
    const val101 = await getInventoryValuationReport(pool, { property_id: 1, product_id: 101 });
    assert.strictEqual(val101.items.length, 1);
    assert.strictEqual(val101.items[0].quantity, '24.000');
    assert.strictEqual(val101.items[0].unit_cost, '2000.00');
    assert.strictEqual(val101.items[0].total_value, '48000.00');
    assert.strictEqual(val101.summary.total_valuation_value, '48000.00');
    console.log('  PASS: CONTROL_SAME_COST -> unit_cost=2000.00, total_value=48000.00');

    const val102 = await getInventoryValuationReport(pool, { property_id: 1, product_id: 102 });
    assert.strictEqual(val102.items.length, 1);
    assert.strictEqual(val102.items[0].quantity, '50.000');
    assert.strictEqual(val102.items[0].unit_cost, '3120.00');
    assert.strictEqual(val102.items[0].total_value, '156000.00');
    assert.strictEqual(val102.summary.total_valuation_value, '156000.00');
    console.log('  PASS: U01_OWNER_REPORTED_50 -> unit_cost=3120.00, total_value=156000.00 (bukan 30000.00 / 1500000.00)');

    const val103 = await getInventoryValuationReport(pool, { property_id: 1, product_id: 103 });
    assert.strictEqual(val103.items.length, 1);
    assert.strictEqual(val103.items[0].quantity, '10.000');
    assert.strictEqual(val103.items[0].unit_cost, '0.00');
    assert.strictEqual(val103.items[0].total_value, '0.00');
    assert.strictEqual(val103.items[0].cost_known, true);
    assert.strictEqual(val103.items[0].cost_status, 'KNOWN');
    assert.strictEqual(val103.summary.total_valuation_value, '0.00');
    console.log('  PASS: U01_VALID_ZERO_COST -> unit_cost=0.00, total_value=0.00 (bukan harga jual 5000.00 / 50000.00)');

    const val104 = await getInventoryValuationReport(pool, { property_id: 1, product_id: 104 });
    assert.strictEqual(val104.items.length, 1);
    assert.strictEqual(val104.items[0].quantity, '48.000');
    assert.strictEqual(val104.items[0].unit_cost, '1000.00');
    assert.strictEqual(val104.items[0].total_value, '48000.00');
    assert.strictEqual(val104.summary.total_valuation_value, '48000.00');
    console.log('  PASS: U01_BONUS_LAST_COST_ZERO -> unit_cost=1000.00, total_value=48000.00 (bukan 2000.00 / 96000.00)');

    // -------------------------------------------------------------------------
    // TEST 2: Biaya Belum Diketahui (NULL) vs Biaya Nol Sah (0) & Tidak Fallback ke Harga Jual
    // -------------------------------------------------------------------------
    console.log('\n[TEST 2] Verifikasi biaya belum diketahui (NULL) tidak fallback ke harga jual...');

    await pool.query(`
      INSERT INTO pos_menu_items (
        id, property_id, category_id, item_code, name, price,
        base_unit, canonical_base_unit_code, track_stock, is_active, is_sellable_pos
      ) VALUES (
        105, 1, 1, 'U01-UNKNOWN-COST', 'Item Tanpa Biaya Terverifikasi', 15000.00,
        'BOTOL', 'BOTOL', TRUE, TRUE, TRUE
      );
    `);

    // Catat opening balance tanpa unit_cost (unit_cost = null)
    await recordOpeningBalance(pool, {
      property_id: 1,
      product_id: 105,
      location_id: 1,
      quantity: '12',
      unit_cost: null,
      operation_key: 'u01-open-unknown-105',
      created_by: 1,
    });

    const val105 = await getInventoryValuationReport(pool, { property_id: 1, product_id: 105 });
    assert.strictEqual(val105.items.length, 1);
    assert.strictEqual(val105.items[0].quantity, '12.000');
    assert.strictEqual(val105.items[0].unit_cost, null);
    assert.strictEqual(val105.items[0].total_value, null);
    assert.strictEqual(val105.items[0].cost_known, false);
    assert.strictEqual(val105.items[0].cost_status, 'UNKNOWN');
    assert.strictEqual(val105.summary.total_valuation_value, '0.00');
    assert.strictEqual(val105.summary.unknown_cost_items, 1);
    console.log('  PASS: Item dengan biaya NULL mengembalikan unit_cost=null, total_value=null, cost_status=UNKNOWN, dan tidak memakai harga jual Rp15.000.');

    // -------------------------------------------------------------------------
    // TEST 3: Perubahan Harga Jual (pos_menu_items.price) Tanpa Mutasi Stok/Biaya
    // -------------------------------------------------------------------------
    console.log('\n[TEST 3] Verifikasi perubahan harga jual tidak mengubah valuasi persediaan...');

    await pool.query(`
      UPDATE pos_menu_items
         SET price = 99000.00
       WHERE property_id = 1 AND id IN (101, 102, 103, 104, 105);
    `);

    const valAfterPriceChange = await getInventoryValuationReport(pool, { property_id: 1 });
    const byPid = new Map(valAfterPriceChange.items.map((it) => [it.product_id, it]));
    assert.strictEqual(byPid.get(101).unit_cost, '2000.00');
    assert.strictEqual(byPid.get(101).total_value, '48000.00');
    assert.strictEqual(byPid.get(102).unit_cost, '3120.00');
    assert.strictEqual(byPid.get(102).total_value, '156000.00');
    assert.strictEqual(byPid.get(103).unit_cost, '0.00');
    assert.strictEqual(byPid.get(103).total_value, '0.00');
    assert.strictEqual(byPid.get(104).unit_cost, '1000.00');
    assert.strictEqual(byPid.get(104).total_value, '48000.00');
    assert.strictEqual(byPid.get(105).unit_cost, null);
    assert.strictEqual(byPid.get(105).total_value, null);
    console.log('  PASS: Perubahan harga jual ke Rp99.000 sama sekali tidak mengubah unit_cost maupun total_value pada kelima item.');

    // Kembalikan harga jual produk 101-104 ke 5000.00
    await pool.query(`
      UPDATE pos_menu_items
         SET price = 5000.00
       WHERE property_id = 1 AND id IN (101, 102, 103, 104);
    `);

    // -------------------------------------------------------------------------
    // TEST 4: Filter Lokasi & Konsistensi Total Valuasi terhadap Baris Item
    // -------------------------------------------------------------------------
    console.log('\n[TEST 4] Verifikasi filter lokasi dan kesamaan summary.total_valuation_value dengan jumlah baris item...');

    // Tambahkan stok di lokasi 2 (OUT-U01-CAFE) untuk produk 101 sebanyak 10 BOTOL (menggunakan GRN baru pada PO baru @ 2000)
    const poLoc2 = await createApprovedPo([{ product_id: 101, ordered_qty: 10, unit_cost: 2000 }]);
    await postGrnFromPo(poLoc2.id, 2, [
      { po_item_id: poLoc2.items[0].id, product_id: 101, received_qty: 10, unit_cost: 2000 },
    ]);

    const valLoc1 = await getInventoryValuationReport(pool, { property_id: 1, location_id: 1 });
    const expectedLoc1Sum = valLoc1.items.reduce(
      (acc, it) => acc + (it.total_value !== null ? parseFloat(it.total_value) : 0),
      0
    );
    assert.strictEqual(valLoc1.summary.total_valuation_value, expectedLoc1Sum.toFixed(2));
    assert.strictEqual(valLoc1.summary.total_valuation_value, '252000.00'); // 48000 + 156000 + 0 + 48000

    const valLoc2 = await getInventoryValuationReport(pool, { property_id: 1, location_id: 2 });
    assert.strictEqual(valLoc2.items.length, 1);
    assert.strictEqual(valLoc2.items[0].product_id, 101);
    assert.strictEqual(valLoc2.items[0].quantity, '10.000');
    assert.strictEqual(valLoc2.items[0].unit_cost, '2000.00');
    assert.strictEqual(valLoc2.items[0].total_value, '20000.00');
    assert.strictEqual(valLoc2.summary.total_valuation_value, '20000.00');

    const valAllLocs = await getInventoryValuationReport(pool, { property_id: 1 });
    const expectedAllSum = valAllLocs.items.reduce(
      (acc, it) => acc + (it.total_value !== null ? parseFloat(it.total_value) : 0),
      0
    );
    assert.strictEqual(valAllLocs.summary.total_valuation_value, expectedAllSum.toFixed(2));
    assert.strictEqual(valAllLocs.summary.total_valuation_value, '272000.00'); // 252000 + 20000
    console.log('  PASS: Filter lokasi (Loc 1 = Rp252.000, Loc 2 = Rp20.000, Semua = Rp272.000) konsisten penuh dengan jumlah baris item.');

    // -------------------------------------------------------------------------
    // TEST 5: Opname Variance Report — Snapshot Biaya Saat Kejadian Opname
    // -------------------------------------------------------------------------
    console.log('\n[TEST 5] Verifikasi stabilitas snapshot biaya opname saat ada penerimaan stok baru sesudahnya...');

    // Saat ini produk 101 di lokasi 1 memiliki qty=24, average_cost=2000.00.
    // Lakukan opname fisik di lokasi 1 untuk produk 101 (fisik=22 -> DEFICIT -2 @ Rp2.000 = -Rp4.000)
    // dan produk 103 (valid zero cost, fisik=11 -> SURPLUS +1 @ Rp0 = +Rp0, bukan harga jual Rp5.000)
    const opnameRes = await recordStockOpname(pool, {
      property_id: 1,
      location_id: 1,
      operation_key: 'u01-opname-snapshot-test-1',
      notes: 'Opname sebelum kenaikan harga beli produk 101',
      created_by: 1,
      items: [
        { product_id: 101, physical_quantity: '22', notes: 'Pecah 2 botol saat harga rata-rata 2000' },
        { product_id: 103, physical_quantity: '11', notes: 'Lebih 1 botol item zero cost' },
      ],
    });
    assert.strictEqual(opnameRes.items.length, 2);

    // Sekarang terima barang baru untuk produk 101 dengan harga tinggi (10 BOTOL @ Rp15.200)
    // sehingga average_cost produk 101 berubah drastis setelah opname!
    const poAfterOpname = await createApprovedPo([{ product_id: 101, ordered_qty: 10, unit_cost: 15200 }]);
    await postGrnFromPo(poAfterOpname.id, 1, [
      { po_item_id: poAfterOpname.items[0].id, product_id: 101, received_qty: 10, unit_cost: 15200 },
    ]);

    // Pastikan biaya opname historis pada getOpnameVarianceReport TETAP 2000.00 (bukan 15200.00 dan bukan average_cost baru)
    const opnameReport = await getOpnameVarianceReport(pool, { property_id: 1, location_id: 1 });
    const opItem101 = opnameReport.items.find((it) => it.product_id === 101);
    const opItem103 = opnameReport.items.find((it) => it.product_id === 103);
    assert(opItem101, 'Item opname 101 harus ditemukan');
    assert.strictEqual(opItem101.unit_cost, '2000.00');
    assert.strictEqual(opItem101.variance_quantity, '-2.000');
    assert.strictEqual(opItem101.variance_value, '-4000.00');

    assert(opItem103, 'Item opname 103 harus ditemukan');
    assert.strictEqual(opItem103.unit_cost, '0.00');
    assert.strictEqual(opItem103.variance_quantity, '+1.000');
    assert.strictEqual(opItem103.variance_value, '+0.00');
    console.log('  PASS: Snapshot biaya opname historis tetap Rp2.000 (-Rp4.000) meskipun penerimaan baru mengubah biaya produk 101 sesudahnya, dan item biaya 0 tetap Rp0.');

    // -------------------------------------------------------------------------
    // TEST 6: U01-R1 — Unformed Average Cost (NULL / Default 0 pada Riwayat Multi-Batch)
    // -------------------------------------------------------------------------
    console.log('\n[TEST 6] Verifikasi U01-R1: Riwayat multi-batch (24@2.000 + 24@2.000 + 2@30.000) dengan average_cost NULL / default 0 tidak memakai batch terakhir Rp30.000...');

    // Buat produk 106 di lokasi 2 dengan riwayat 24@2.000 + 24@2.000 + 2@30.000 = 50 BOTOL
    await pool.query(`
      INSERT INTO pos_menu_items (
        id, property_id, category_id, item_code, name, price,
        base_unit, canonical_base_unit_code, track_stock, is_active, is_sellable_pos
      ) VALUES (
        106, 1, 1, 'U01-R1-MULTIBATCH', 'Air Mineral R1 Multi-Batch 50', 5000.00,
        'BOTOL', 'BOTOL', TRUE, TRUE, TRUE
      );
    `);

    const po106a = await createApprovedPo([{ product_id: 106, ordered_qty: 48, unit_cost: 2000 }]);
    await postGrnFromPo(po106a.id, 2, [
      { po_item_id: po106a.items[0].id, product_id: 106, received_qty: 24, unit_cost: 2000 },
    ]);
    await postGrnFromPo(po106a.id, 2, [
      { po_item_id: po106a.items[0].id, product_id: 106, received_qty: 24, unit_cost: 2000 },
    ]);
    const po106b = await createApprovedPo([{ product_id: 106, ordered_qty: 2, unit_cost: 30000 }]);
    await postGrnFromPo(po106b.id, 2, [
      { po_item_id: po106b.items[0].id, product_id: 106, received_qty: 2, unit_cost: 30000 },
    ]);

    // Case A: CONTROL_VERIFIED_AVERAGE (average_cost = 3120, last_cost = 30000)
    const val106Verified = await getInventoryValuationReport(pool, { property_id: 1, product_id: 106 });
    assert.strictEqual(val106Verified.items[0].unit_cost, '3120.00');
    assert.strictEqual(val106Verified.items[0].total_value, '156000.00');
    assert.strictEqual(val106Verified.items[0].cost_known, true);
    assert.strictEqual(val106Verified.items[0].cost_status, 'KNOWN');
    assert.strictEqual(val106Verified.summary.unknown_cost_items, 0);

    // Case B: UNKNOWN_AVERAGE_NULL (simulasi data legacy sebelum constraint NOT NULL dengan average_cost = NULL, last_cost = 30000)
    await pool.query(`ALTER TABLE pos_menu_items ALTER COLUMN average_cost DROP NOT NULL`);
    await pool.query(`UPDATE pos_menu_items SET average_cost = NULL, last_cost = 30000 WHERE property_id = 1 AND id = 106`);
    const val106Null = await getInventoryValuationReport(pool, { property_id: 1, product_id: 106 });
    assert.strictEqual(val106Null.items[0].unit_cost, null);
    assert.strictEqual(val106Null.items[0].total_value, null);
    assert.strictEqual(val106Null.items[0].cost_known, false);
    assert.strictEqual(val106Null.items[0].cost_status, 'UNKNOWN');
    assert.strictEqual(val106Null.summary.total_valuation_value, '0.00');
    assert.strictEqual(val106Null.summary.unknown_cost_items, 1);

    // Case C: UNFORMED_AVERAGE_DEFAULT_ZERO (simulasi kolom average_cost NOT NULL DEFAULT 0 yang belum terbentuk pada riwayat biaya positif)
    await pool.query(`UPDATE pos_menu_items SET average_cost = 0, last_cost = 30000 WHERE property_id = 1 AND id = 106`);
    await pool.query(`ALTER TABLE pos_menu_items ALTER COLUMN average_cost SET NOT NULL`);
    const val106DefaultZero = await getInventoryValuationReport(pool, { property_id: 1, product_id: 106 });
    assert.strictEqual(val106DefaultZero.items[0].unit_cost, null);
    assert.strictEqual(val106DefaultZero.items[0].total_value, null);
    assert.strictEqual(val106DefaultZero.items[0].cost_known, false);
    assert.strictEqual(val106DefaultZero.items[0].cost_status, 'UNKNOWN');
    assert.strictEqual(val106DefaultZero.summary.total_valuation_value, '0.00');
    assert.strictEqual(val106DefaultZero.summary.unknown_cost_items, 1);

    // Case D: Ringkasan gabungan di lokasi 2 (1 item KNOWN: produk 101 + 1 item UNKNOWN: produk 106)
    const valLoc2Combined = await getInventoryValuationReport(pool, { property_id: 1, location_id: 2 });
    assert.strictEqual(valLoc2Combined.items.length, 2);
    const knownItemLoc2 = valLoc2Combined.items.find((it) => it.product_id === 101);
    const unknownItemLoc2 = valLoc2Combined.items.find((it) => it.product_id === 106);
    assert.strictEqual(knownItemLoc2.cost_status, 'KNOWN');
    assert.strictEqual(unknownItemLoc2.cost_status, 'UNKNOWN');
    assert.strictEqual(unknownItemLoc2.unit_cost, null);
    assert.strictEqual(unknownItemLoc2.total_value, null);
    assert.strictEqual(valLoc2Combined.summary.total_valuation_value, knownItemLoc2.total_value);
    assert.strictEqual(valLoc2Combined.summary.unknown_cost_items, 1);

    // Case E: recordStockOpname saat average_cost belum terbentuk (default 0 dengan riwayat positif) tidak memakai 30.000
    await recordStockOpname(pool, {
      property_id: 1,
      location_id: 2,
      operation_key: 'u01-r1-opname-unformed-avg',
      notes: 'Opname saat average_cost belum terbentuk',
      created_by: 1,
      items: [{ product_id: 106, physical_quantity: '49', notes: 'Selisih -1 botol saat average_cost belum terbentuk' }],
    });
    const opReportR1 = await getOpnameVarianceReport(pool, { property_id: 1, location_id: 2 });
    const opItem106 = opReportR1.items.find((it) => it.product_id === 106);
    assert(opItem106, 'Item opname 106 harus ditemukan');
    assert.strictEqual(opItem106.variance_quantity, '-1.000');
    assert.strictEqual(opItem106.status, 'DEFICIT');
    assert.strictEqual(opItem106.unit_cost, null);
    assert.strictEqual(opItem106.variance_value, null);
    assert.strictEqual(opItem106.cost_known, false);
    assert.strictEqual(opItem106.cost_status, 'UNKNOWN');
    console.log('  PASS: U01-R1 terverifikasi (average_cost NULL/default 0 pada riwayat multi-batch -> UNKNOWN, bukan Rp30.000 / Rp1.500.000).');

    // Kembalikan average_cost produk 106 ke nilai terverifikasi 3120.00
    await pool.query(`UPDATE pos_menu_items SET average_cost = 3120.00, last_cost = 30000.00 WHERE property_id = 1 AND id = 106`);

    // -------------------------------------------------------------------------
    // TEST 7: U01-R2 — Opname Legacy Tanpa Snapshot & Tanpa Biaya As-Of
    // -------------------------------------------------------------------------
    console.log('\n[TEST 7] Verifikasi U01-R2: Opname legacy tanpa snapshot tidak memakai biaya masa depan/saat ini (5.000 -> 10.000)...');

    await pool.query(`
      INSERT INTO pos_menu_items (
        id, property_id, category_id, item_code, name, price, average_cost, last_cost,
        base_unit, canonical_base_unit_code, track_stock, is_active, is_sellable_pos
      ) VALUES (
        107, 1, 1, 'U01-R2-LEGACY-OP', 'Item Legacy Opname Tanpa Snapshot', 12000.00, 5000.00, 5000.00,
        'BOTOL', 'BOTOL', TRUE, TRUE, TRUE
      );
    `);

    // Sisipkan sesi STOCK_OPNAME legacy pada 2026-10-29T00:00:00Z tanpa unit_cost di metadata
    // dan dengan mutasi stok berbiaya yang baru muncul sesudahnya (2026-10-31T10:00:00Z)
    await pool.query(
      `INSERT INTO stock_operations (
         property_id, operation_key, operation_type, payload_fingerprint, notes, metadata, created_by, created_at
       ) VALUES (
         1, 'u01-r2-legacy-opname-no-snapshot', 'STOCK_OPNAME', 'fp-u01-r2-legacy-opname', 'Legacy opname tanpa unit_cost snapshot',
         $1::jsonb, 1, '2026-10-29T00:00:00Z'::timestamptz
       )`,
      [
        JSON.stringify({
          location_id: 2,
          items_summary: [
            {
              product_id: 107,
              product_name: 'Item Legacy Opname Tanpa Snapshot',
              system_quantity: '10.000',
              physical_quantity: '12.000',
              variance_quantity: '+2.000',
              status: 'SURPLUS',
              movement_id: null,
              unit_cost: null,
              notes: 'Legacy opname sebelum snapshot biaya ada',
            },
          ],
        }),
      ]
    );

    // Tambahkan mutasi stok setelah tanggal opname (2026-10-31T10:00:00Z) dengan unit_cost = 2000
    const futureOpRes = await pool.query(
      `INSERT INTO stock_operations (
         property_id, operation_key, operation_type, payload_fingerprint, notes, metadata, created_by, created_at
       ) VALUES (
         1, 'u01-r2-future-receipt-107', 'PURCHASE_RECEIPT', 'fp-u01-r2-future-receipt', 'Penerimaan setelah opname legacy', '{}'::jsonb, 1, '2026-10-31T10:00:00Z'::timestamptz
       ) RETURNING id`
    );
    await pool.query(
      `INSERT INTO stock_movements (
         property_id, operation_id, product_id, location_id, quantity_delta, base_unit_code, unit_cost, created_at
       ) VALUES (
         1, $1, 107, 2, 10.000, 'BOTOL', 2000.00, '2026-10-31T10:00:00Z'::timestamptz
       )`,
      [futureOpRes.rows[0].id]
    );

    // Saat average_cost saat ini = 5000.00
    const opR2At5000 = await getOpnameVarianceReport(pool, { property_id: 1, location_id: 2 });
    const item107At5000 = opR2At5000.items.find((it) => it.product_id === 107);
    assert(item107At5000, 'Item legacy opname 107 harus ditemukan');
    assert.strictEqual(item107At5000.variance_quantity, '+2.000');
    assert.strictEqual(item107At5000.status, 'SURPLUS');
    assert.strictEqual(item107At5000.unit_cost, null);
    assert.strictEqual(item107At5000.variance_value, null);
    assert.strictEqual(item107At5000.cost_known, false);
    assert.strictEqual(item107At5000.cost_status, 'UNKNOWN');

    // Ubah average_cost & last_cost saat ini menjadi 10000.00 -> tetap null (tidak berubah mengikuti biaya masa depan)
    await pool.query(`UPDATE pos_menu_items SET average_cost = 10000.00, last_cost = 10000.00 WHERE property_id = 1 AND id = 107`);
    const opR2At10000 = await getOpnameVarianceReport(pool, { property_id: 1, location_id: 2 });
    const item107At10000 = opR2At10000.items.find((it) => it.product_id === 107);
    assert.strictEqual(item107At10000.variance_quantity, '+2.000');
    assert.strictEqual(item107At10000.status, 'SURPLUS');
    assert.strictEqual(item107At10000.unit_cost, null);
    assert.strictEqual(item107At10000.variance_value, null);
    assert.strictEqual(item107At10000.cost_known, false);
    assert.strictEqual(item107At10000.cost_status, 'UNKNOWN');
    console.log('  PASS: U01-R2 terverifikasi (opname legacy tanpa snapshot & tanpa biaya as-of tetap unit_cost=null, variance_value=null meskipun average_cost berubah 5.000 -> 10.000).');

    // -------------------------------------------------------------------------
    // TEST 8: U01-R3 — Siklus Stok Berbayar Habis Lalu Terima Barang Gratis (Nol Sah)
    //                  vs Kontrol Default 0 dengan Stok Berbayar Masih Tersisa
    // -------------------------------------------------------------------------
    console.log('\n[TEST 8] Verifikasi U01-R3: Siklus berbayar (24@2.000) -> habis (-24) -> gratis (10@0) menghasilkan KNOWN/0.00 & opname surplus +1 = 0.00...');

    await pool.query(`
      INSERT INTO pos_menu_items (
        id, property_id, category_id, item_code, name, price,
        base_unit, canonical_base_unit_code, track_stock, is_active, is_sellable_pos
      ) VALUES
        (108, 1, 1, 'U01-R3-DEPLETED-ZERO', 'Air Mineral R3 Depleted Then Free', 5000.00, 'BOTOL', 'BOTOL', TRUE, TRUE, TRUE),
        (109, 1, 1, 'U01-R3-CTRL-REMAINING', 'Air Mineral R3 Paid Remaining Control', 5000.00, 'BOTOL', 'BOTOL', TRUE, TRUE, TRUE);
    `);

    // 108 Langkah 1: Terima 24 BOTOL @ Rp2.000 melalui PO/GRN kanonik
    const po108Paid = await createApprovedPo([{ product_id: 108, ordered_qty: 24, unit_cost: 2000 }]);
    await postGrnFromPo(po108Paid.id, 1, [
      { po_item_id: po108Paid.items[0].id, product_id: 108, received_qty: 24, unit_cost: 2000 },
    ]);

    // 108 Langkah 2: Keluarkan seluruh 24 BOTOL melalui service stock-out kanonik hingga saldo 0
    const adjOut108 = await recordStockAdjustment(pool, {
      property_id: 1,
      product_id: 108,
      location_id: 1,
      adjustment_type: 'OUT',
      reason_code: 'PEMAKAIAN_INTERNAL',
      quantity: '24',
      operation_key: 'u01-r3-deplete-108-out-24',
      notes: 'Habiskan stok berbayar 24 botol',
      created_by: 1,
    });
    assert.strictEqual(adjOut108.current_balance, '0.000');

    // 108 Langkah 3: Terima 10 BOTOL gratis @ Rp0 melalui PO/GRN kanonik (tanpa UPDATE manual average_cost)
    const po108Free = await createApprovedPo([{ product_id: 108, ordered_qty: 10, unit_cost: 0 }]);
    await postGrnFromPo(po108Free.id, 1, [
      { po_item_id: po108Free.items[0].id, product_id: 108, received_qty: 10, unit_cost: 0 },
    ]);

    // Pastikan mesin penerimaan kanonik menghasilkan average_cost = 0, last_cost = 0, dan saldo = 10.000
    const pmi108Res = await pool.query(
      `SELECT average_cost, last_cost FROM pos_menu_items WHERE property_id = 1 AND id = 108`
    );
    assert.strictEqual(Number(pmi108Res.rows[0].average_cost), 0);
    assert.strictEqual(Number(pmi108Res.rows[0].last_cost), 0);

    const val108 = await getInventoryValuationReport(pool, { property_id: 1, product_id: 108 });
    assert.strictEqual(val108.items.length, 1);
    assert.strictEqual(val108.items[0].quantity, '10.000');
    assert.strictEqual(val108.items[0].unit_cost, '0.00');
    assert.strictEqual(val108.items[0].total_value, '0.00');
    assert.strictEqual(val108.items[0].cost_known, true);
    assert.strictEqual(val108.items[0].cost_status, 'KNOWN');
    assert.strictEqual(val108.summary.total_valuation_value, '0.00');
    assert.strictEqual(val108.summary.unknown_cost_items, 0);

    // 108 Langkah 4: Opname surplus +1 pada produk 108 -> snapshot unit_cost = 0.00, variance_value = +0.00 (KNOWN)
    const opname108 = await recordStockOpname(pool, {
      property_id: 1,
      location_id: 1,
      operation_key: 'u01-r3-opname-surplus-108',
      notes: 'Opname surplus +1 pada stok gratis setelah siklus berbayar habis',
      created_by: 1,
      items: [{ product_id: 108, physical_quantity: '11', notes: 'Surplus 1 botol gratis' }],
    });
    assert.strictEqual(opname108.items.length, 1);
    assert.strictEqual(opname108.items[0].unit_cost, '0.00');

    const opReport108 = await getOpnameVarianceReport(pool, { property_id: 1, location_id: 1 });
    const opItem108 = opReport108.items.find((it) => it.product_id === 108 && it.operation_key === 'u01-r3-opname-surplus-108');
    assert(opItem108, 'Item opname 108 harus ditemukan');
    assert.strictEqual(opItem108.variance_quantity, '+1.000');
    assert.strictEqual(opItem108.status, 'SURPLUS');
    assert.strictEqual(opItem108.unit_cost, '0.00');
    assert.strictEqual(opItem108.variance_value, '+0.00');
    assert.strictEqual(opItem108.cost_known, true);
    assert.strictEqual(opItem108.cost_status, 'KNOWN');

    // Baca ulang valuasi 108 setelah opname surplus +1 -> tetap KNOWN/0.00 dengan qty 11.000
    const val108AfterOpname = await getInventoryValuationReport(pool, { property_id: 1, product_id: 108 });
    assert.strictEqual(val108AfterOpname.items[0].quantity, '11.000');
    assert.strictEqual(val108AfterOpname.items[0].unit_cost, '0.00');
    assert.strictEqual(val108AfterOpname.items[0].total_value, '0.00');
    assert.strictEqual(val108AfterOpname.items[0].cost_known, true);
    assert.strictEqual(val108AfterOpname.items[0].cost_status, 'KNOWN');
    assert.strictEqual(val108AfterOpname.summary.unknown_cost_items, 0);

    // Kontrol terpisah (Produk 109): 10@2.000 masih tersisa + 10@0, tetapi kolom average_cost default 0 belum terbentuk
    const po109 = await createApprovedPo([
      { product_id: 109, ordered_qty: 10, unit_cost: 2000 },
      { product_id: 109, ordered_qty: 10, unit_cost: 0 },
    ]);
    await postGrnFromPo(po109.id, 2, [
      { po_item_id: po109.items[0].id, product_id: 109, received_qty: 10, unit_cost: 2000 },
    ]);
    await postGrnFromPo(po109.id, 2, [
      { po_item_id: po109.items[1].id, product_id: 109, received_qty: 10, unit_cost: 0 },
    ]);

    // Simulasikan kondisi kolom average_cost default 0 yang belum terbentuk padahal stok berbayar 10@2.000 masih ada
    await pool.query(`UPDATE pos_menu_items SET average_cost = 0, last_cost = 0 WHERE property_id = 1 AND id = 109`);
    const val109Unformed = await getInventoryValuationReport(pool, { property_id: 1, product_id: 109 });
    assert.strictEqual(val109Unformed.items.length, 1);
    assert.strictEqual(val109Unformed.items[0].quantity, '20.000');
    assert.strictEqual(val109Unformed.items[0].unit_cost, null);
    assert.strictEqual(val109Unformed.items[0].total_value, null);
    assert.strictEqual(val109Unformed.items[0].cost_known, false);
    assert.strictEqual(val109Unformed.items[0].cost_status, 'UNKNOWN');
    assert.strictEqual(val109Unformed.summary.unknown_cost_items, 1);
    console.log('  PASS: U01-R3 terverifikasi (siklus 24@2.000 -> habis -> 10@0 = KNOWN/0.00 & opname +1 = 0.00; kontrol stok berbayar tersisa dengan default 0 tetap UNKNOWN).');

    // -------------------------------------------------------------------------
    // TEST 9: Invarian Read-Only pada Endpoint HTTP Laporan Valuasi & Opname
    // -------------------------------------------------------------------------
    console.log('\n[TEST 9] Verifikasi invarian read-only pada HTTP handler laporan valuasi & opname...');

    const captureDbSnapshot = async () => {
      const [bal, mov, items, pos, binds, grns] = await Promise.all([
        pool.query('SELECT id, property_id, product_id, location_id, quantity FROM stock_balances ORDER BY id'),
        pool.query('SELECT id, operation_id, product_id, location_id, quantity_delta, unit_cost FROM stock_movements ORDER BY id'),
        pool.query('SELECT id, item_code, price, average_cost, last_cost FROM pos_menu_items ORDER BY id'),
        pool.query('SELECT id, po_number, status, total_amount FROM pos_purchase_orders ORDER BY id'),
        pool.query('SELECT id, ordered_quantity, received_quantity FROM stock_purchase_line_bindings ORDER BY id'),
        pool.query('SELECT id, grn_number, status, total_amount FROM pos_goods_receipts ORDER BY id'),
      ]);
      return JSON.stringify({
        bal: bal.rows,
        mov: mov.rows,
        items: items.rows,
        pos: pos.rows,
        binds: binds.rows,
        grns: grns.rows,
      });
    };

    const snapshotBefore = await captureDbSnapshot();

    const deps = {
      pool,
      assertPropertyScope: async () => {},
    };
    const valHandler = createInventoryValuationHandler(deps);
    const opnameHandler = createOpnameVarianceHandler(deps);

    const reqVal = {
      query: { property_id: '1', product_id: '102' },
      user: { id: 1, role: 'SUPERADMIN', permissions: ['inventory.view'], property_id: 1 },
    };
    const resVal = makeMockRes();
    await valHandler(reqVal, resVal);
    assert.strictEqual(resVal.statusCode, 200);
    assert.strictEqual(resVal.body.data.items[0].unit_cost, '3120.00');
    assert.strictEqual(resVal.body.data.items[0].total_value, '156000.00');
    assert.strictEqual(resVal.body.data.summary.total_valuation_value, '156000.00');

    const reqOp = {
      query: { property_id: '1', location_id: '1' },
      user: { id: 1, role: 'SUPERADMIN', permissions: ['inventory.view'], property_id: 1 },
    };
    const resOp = makeMockRes();
    await opnameHandler(reqOp, resOp);
    assert.strictEqual(resOp.statusCode, 200);

    const snapshotAfter = await captureDbSnapshot();
    assert.strictEqual(snapshotAfter, snapshotBefore, 'Laporan tidak boleh mengubah data database apa pun');
    console.log('  PASS: Endpoint HTTP laporan valuasi & opname 100% read-only (snapshot DB sebelum & sesudah identik).');

    console.log('\n========================================================================');
    console.log(' SEMUA PENGUJIAN REGRESI U01 BERHASIL (PASS)');
    console.log('========================================================================');
  } finally {
    await pool.end().catch(() => {});
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'ignore' });
    } catch {}
  }
}

runTests().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
