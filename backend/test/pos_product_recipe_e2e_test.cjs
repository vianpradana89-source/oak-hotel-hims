/**
 * OAK HIMS — MP-04C POS Product Recipe & Bill of Materials (BOM) E2E Test Suite
 *
 * Cakupan Pengujian:
 * 1. Inisialisasi skema database schema_v3 dan migrasi pos_product_recipe_v1.
 * 2. Verifikasi tabel pos_product_recipes, pos_product_uoms, dan is_raw_material.
 * 3. Seed Master Data (Property, Location, Raw Materials, Finished Goods, UOMs).
 * 4. Formula Resep (BOM): 1 Kopi Latte = 18 gr Biji Kopi + 150 ml Susu UHT.
 * 5. Validasi Aturan Bisnis & Integritas:
 *    - Self-reference rejection (Kopi Latte sebagai bahan baku Kopi Latte).
 *    - Circular dependency rejection (Dependensi sirkular ditolak).
 *    - Non-positive quantity rejection.
 * 6. Transaksi Kasir POS:
 *    - Penjualan 2x Kopi Latte (BOM), 1x Air Mineral (Direct retail), 1x Jasa Corkage (Non-tracked).
 *    - Penyelesaian pembayaran kasir (PAID via payPosOrderCash).
 *    - Verifikasi pemotongan stok otomatis bahan baku:
 *      * Biji Kopi Arabika: -36 gr (1000 -> 964 gr).
 *      * Susu Segar UHT: -300 ml (2000 -> 1700 ml).
 *      * Air Mineral: -1 botol (50 -> 49 botol).
 *      * Kopi Latte (Finished good): tidak dipotong langsung karena menggunakan formula BOM.
 * 7. Proteksi Insufficient Stock & Atomisitas Transaksi:
 *    - Pemesanan 100x Kopi Latte (butuh 1800 gr kopi, saldo hanya 964 gr).
 *    - Sistem menolak dengan 422 INSUFFICIENT_STOCK_BALANCE.
 *    - Transaksi DB rollback total (saldo tetap 964 gr dan 1700 ml, order tetap OPEN).
 * 8. REST API CRUD Resep Produk (getPosProductUoms, getProductRecipe, addOrUpdateRecipeIngredient, deleteRecipeIngredient).
 *
 * Keamanan:
 * - Docker PostgreSQL 15 container terisolasi.
 * - Dibersihkan tuntas di blok finally (zero residue).
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert');

const BACKEND_DIR = path.resolve(__dirname, '..');
const IMAGE = 'postgres:15';
const TEST_DB = 'oak_hims_pos_recipe_test';
const TEST_USER = 'oak_recipe_runner';
const CONTAINER_PREFIX = 'oak-hims-pos-recipe-test-';

function safeStringify(val) {
  try {
    return JSON.stringify(val, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch (e) {
    return String(val);
  }
}

function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
  console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const results = [];

async function step(name, fn) {
  const started = Date.now();
  const out = await fn();
  const durationMs = Date.now() - started;
  results.push({ name, ok: true, durationMs, detail: out === undefined ? null : out });
  log(`PASS  ${name} (${durationMs} ms)${out === undefined ? '' : ` :: ${typeof out === 'string' ? out : safeStringify(out)}`}`);
  return out;
}

function docker(args, { timeout = 120000, allowFail = false } = {}) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    throw new Error(`docker ${args.join(' ')} failed: ${stderr || (err && err.message) || String(err)}`);
  }
}

async function run() {
  log('========================================================================');
  log(' OAK HIMS — MP-04C POS Product Recipe & BOM Test Suite');
  log('========================================================================');

  // 1. Preflight module loads
  const { Pool } = require('pg');
  const schema = require('../dist/db/schema_v3');
  const posPaymentSettlement = require('../dist/db/migrations/pos_payment_settlement_v1');
  const posOrderExpansion = require('../dist/db/migrations/pos_order_expansion_v1');
  const posIdempotency = require('../dist/db/migrations/pos_idempotency_v1');
  const posServiceTax = require('../dist/db/migrations/pos_service_tax_v1');
  const posReceiptSnapshot = require('../dist/db/migrations/pos_receipt_snapshot_v1');
  const mp03c = require('../dist/db/migrations/product_master_mp03c_v1');
  const mp04bB1 = require('../dist/db/migrations/product_inventory_mp04b_b1_v1');
  const mp04bB3 = require('../dist/db/migrations/product_inventory_mp04b_b3_v1');
  const { runPosProductRecipeMigration } = require('../dist/db/migrations/pos_product_recipe_v1');
  const {
    getPosProductUoms,
    getProductRecipe,
    addOrUpdateRecipeIngredient,
    deleteRecipeIngredient,
    getRawMaterialCandidates,
  } = require('../dist/domains/pos/posProductRecipeService');
  const {
    deductStockForPosSale,
    recordOpeningBalance,
  } = require('../dist/domains/pos/stockInventoryService');
  const { payPosOrderCash } = require('../dist/domains/pos/posSettlementService');

  // 2. Start Docker Container
  const runId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const containerName = `${CONTAINER_PREFIX}${runId}`;
  const testPassword = `pass-${runId}`;

  log(`Menyiapkan database terisolasi di container Docker PostgreSQL 15 (${containerName})...`);
  docker([
    'run',
    '-d',
    '--name',
    containerName,
    '-e',
    `POSTGRES_DB=${TEST_DB}`,
    '-e',
    `POSTGRES_USER=${TEST_USER}`,
    '-e',
    `POSTGRES_PASSWORD=${testPassword}`,
    '-p',
    '127.0.0.1::5432',
    IMAGE,
  ]);

  let hostPort = null;
  for (let i = 0; i < 30; i++) {
    const portOut = docker(['port', containerName, '5432'], { allowFail: true });
    if (portOut) {
      const match = portOut.match(/:(\d+)$/m);
      if (match) {
        hostPort = parseInt(match[1], 10);
        break;
      }
    }
    await sleep(500);
  }
  assert(hostPort, 'Gagal mendapatkan host port untuk container PostgreSQL');

  const pool = new Pool({
    host: '127.0.0.1',
    port: hostPort,
    database: TEST_DB,
    user: TEST_USER,
    password: testPassword,
    max: 10,
    idleTimeoutMillis: 5000,
  });

  // Tunggu database siap menerima koneksi
  for (let i = 0; i < 30; i++) {
    try {
      const ping = await pool.query('SELECT 1 AS ready');
      if (ping.rows[0]?.ready === 1) break;
    } catch (_) {
      await sleep(500);
    }
  }

  try {
    // Skenario 1: Skema & Migrasi
    await step('DB: Inisialisasi schema_v3 dan migrasi lengkap POS & BOM Recipe', async () => {
      await schema.initializeDatabase(pool);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS property_payment_instructions (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL UNIQUE REFERENCES properties(id) ON DELETE CASCADE,
          bank_name VARCHAR(100),
          bank_account_name VARCHAR(150),
          bank_account_number VARCHAR(100),
          bank_branch VARCHAR(100),
          payment_note TEXT,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_by VARCHAR(100)
        );
      `);

      await posPaymentSettlement.runPosPaymentSettlementMigration(pool);
      await posOrderExpansion.runPosOrderExpansionMigration(pool);
      await posIdempotency.runPosIdempotencyMigration(pool);
      await posServiceTax.runPosServiceTaxMigration(pool);
      await posReceiptSnapshot.runPosReceiptSnapshotMigration(pool);
      await mp03c.runProductMasterMp03cMigration(pool);
      await mp04bB1.runProductInventoryMp04bB1Migration(pool);
      await mp04bB3.runProductInventoryMp04bB3Migration(pool);
      await runPosProductRecipeMigration(pool);

      const tableCheck = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_name IN ('pos_product_recipes', 'pos_product_uoms', 'pos_menu_items')`
      );
      assert.strictEqual(tableCheck.rows.length, 3, 'Tabel resep, UOM, dan menu items harus ada');

      const uomCheck = await pool.query(`SELECT COUNT(*)::int AS cnt FROM pos_product_uoms`);
      assert(uomCheck.rows[0].cnt >= 15, 'UOM kanonik harus ter-seed minimal 15 unit');
      return `Tabel & seed UOM terverifikasi (${uomCheck.rows[0].cnt} unit)`;
    });

    // Setup Master Data
    let propertyId, outletLocationId, coffeeProductId, milkProductId, sodaProductId, latteProductId, corkageProductId;

    await step('Master Data: Setup Properti, Lokasi Outlet, Bahan Baku, dan Menu Jadi', async () => {
      const propRes = await pool.query(
        `INSERT INTO properties (name, property_code) VALUES ('OAK Prime Sunset', 'OAK01') RETURNING id`
      );
      propertyId = propRes.rows[0].id;

      // Buat lokasi stok POS_OUTLET
      const locRes = await pool.query(
        `INSERT INTO stock_locations (property_id, name, code, location_type, is_active)
         VALUES ($1, 'Main Bar & Coffee Station', 'BAR-01', 'POS_OUTLET', TRUE)
         RETURNING id`,
        [propertyId]
      );
      outletLocationId = locRes.rows[0].id;

      // Buat kategori
      const catRes = await pool.query(
        `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, 'Beverage') RETURNING id`,
        [propertyId]
      );
      const categoryId = catRes.rows[0].id;

      // 1. Raw Material 1: Biji Kopi Arabika (GRAM, track_stock=true)
      const cofRes = await pool.query(
        `INSERT INTO pos_menu_items (
           property_id, category_id, name, item_code, base_unit, canonical_base_unit_code,
           product_type, is_raw_material, track_stock, is_sellable_pos, price
         ) VALUES ($1, $2, 'Biji Kopi Arabika', 'RAW-COF-01', 'GRAM', 'GRAM', 'RAW_MATERIAL', TRUE, TRUE, FALSE, NULL)
         RETURNING id`,
        [propertyId, categoryId]
      );
      coffeeProductId = cofRes.rows[0].id;

      // 2. Raw Material 2: Susu Segar UHT (ML, track_stock=true)
      const milkRes = await pool.query(
        `INSERT INTO pos_menu_items (
           property_id, category_id, name, item_code, base_unit, canonical_base_unit_code,
           product_type, is_raw_material, track_stock, is_sellable_pos, price
         ) VALUES ($1, $2, 'Susu Segar UHT', 'RAW-MILK-01', 'ML', 'ML', 'RAW_MATERIAL', TRUE, TRUE, FALSE, NULL)
         RETURNING id`,
        [propertyId, categoryId]
      );
      milkProductId = milkRes.rows[0].id;

      // 3. Retail Finished Good: Air Mineral Botol (BOTOL, direct tracked)
      const sodaRes = await pool.query(
        `INSERT INTO pos_menu_items (
           property_id, category_id, name, item_code, base_unit, canonical_base_unit_code,
           product_type, is_raw_material, track_stock, is_sellable_pos, price
         ) VALUES ($1, $2, 'Air Mineral 600ml', 'RET-WATER-01', 'BOTOL', 'BOTOL', 'FINISHED_GOOD', FALSE, TRUE, TRUE, 10000)
         RETURNING id`,
        [propertyId, categoryId]
      );
      sodaProductId = sodaRes.rows[0].id;

      // 4. Menu Finished Good (Has Recipe / BOM): Kopi Latte (track_stock=false)
      const latteRes = await pool.query(
        `INSERT INTO pos_menu_items (
           property_id, category_id, name, item_code, base_unit, canonical_base_unit_code,
           product_type, is_raw_material, track_stock, is_sellable_pos, price
         ) VALUES ($1, $2, 'Kopi Latte', 'BEV-LATTE-01', 'CUP', 'CUP', 'FINISHED_GOOD', FALSE, FALSE, TRUE, 35000)
         RETURNING id`,
        [propertyId, categoryId]
      );
      latteProductId = latteRes.rows[0].id;

      // 5. Service / Non-Tracked: Corkage Fee (track_stock=false)
      const feeRes = await pool.query(
        `INSERT INTO pos_menu_items (
           property_id, category_id, name, item_code, base_unit, canonical_base_unit_code,
           product_type, is_raw_material, track_stock, is_sellable_pos, price
         ) VALUES ($1, $2, 'Corkage Fee', 'SRV-CORKAGE', 'PORSI', 'PORSI', 'FINISHED_GOOD', FALSE, FALSE, TRUE, 50000)
         RETURNING id`,
        [propertyId, categoryId]
      );
      corkageProductId = feeRes.rows[0].id;

      // Rekam saldo awal untuk bahan baku & retail item
      // Biji Kopi: 1000.000 GRAM
      await recordOpeningBalance(pool, {
        property_id: propertyId,
        product_id: coffeeProductId,
        location_id: outletLocationId,
        quantity: '1000.000',
        unit_cost: '200.00',
        operation_key: `OP-BAL-${propertyId}-${coffeeProductId}`,
      });

      // Susu UHT: 2000.000 ML
      await recordOpeningBalance(pool, {
        property_id: propertyId,
        product_id: milkProductId,
        location_id: outletLocationId,
        quantity: '2000.000',
        unit_cost: '25.00',
        operation_key: `OP-BAL-${propertyId}-${milkProductId}`,
      });

      // Air Mineral: 50.000 BOTOL
      await recordOpeningBalance(pool, {
        property_id: propertyId,
        product_id: sodaProductId,
        location_id: outletLocationId,
        quantity: '50.000',
        unit_cost: '4000.00',
        operation_key: `OP-BAL-${propertyId}-${sodaProductId}`,
      });

      return `Properti #${propertyId}, Bahan Baku: Kopi (1000g), Susu (2000ml), Retail: Air Mineral (50 botol)`;
    });

    // Skenario 2: Validasi Aturan Bisnis Formulasi Resep (BOM)
    await step('Validasi: Penolakan referensi diri sendiri (self-reference)', async () => {
      let rejected = false;
      try {
        await addOrUpdateRecipeIngredient(pool, {
          propertyId,
          productId: latteProductId,
          ingredientProductId: latteProductId, // Sama dengan diri sendiri
          quantity: 1,
        });
      } catch (err) {
        rejected = true;
        assert.strictEqual(err.code, 'CIRCULAR_RECIPE_SELF_REFERENCE');
      }
      assert(rejected, 'Self-reference harus ditolak dengan CIRCULAR_RECIPE_SELF_REFERENCE');
      return 'Self-reference berhasil ditolak';
    });

    await step('Validasi: Penolakan kuantitas non-positif (<= 0)', async () => {
      let rejected = false;
      try {
        await addOrUpdateRecipeIngredient(pool, {
          propertyId,
          productId: latteProductId,
          ingredientProductId: coffeeProductId,
          quantity: -5,
        });
      } catch (err) {
        rejected = true;
        assert.strictEqual(err.code, 'INVALID_RECIPE_QUANTITY');
      }
      assert(rejected, 'Kuantitas negatif harus ditolak');
      return 'Kuantitas negatif berhasil ditolak';
    });

    // Skenario 3: Konfigurasi Formula Resep (BOM) Menu Kopi Latte
    await step('BOM: Konfigurasi 1 Kopi Latte = 18 gr Kopi + 150 ml Susu', async () => {
      // Dapatkan UOM id untuk GRAM & ML
      const uoms = await getPosProductUoms(pool, propertyId);
      const gramUom = uoms.find((u) => u.code === 'GRAM');
      const mlUom = uoms.find((u) => u.code === 'ML');

      // Tambah Biji Kopi: 18 gr
      const rec1 = await addOrUpdateRecipeIngredient(pool, {
        propertyId,
        productId: latteProductId,
        ingredientProductId: coffeeProductId,
        quantity: 18.0,
        uomId: gramUom?.id,
        notes: 'Espresso double shot standard 18g',
      });
      assert.strictEqual(rec1.ingredient_product_id, coffeeProductId);
      assert.strictEqual(parseFloat(rec1.quantity), 18.0);

      // Tambah Susu UHT: 150 ml
      const rec2 = await addOrUpdateRecipeIngredient(pool, {
        propertyId,
        productId: latteProductId,
        ingredientProductId: milkProductId,
        quantity: 150.0,
        uomId: mlUom?.id,
        notes: 'Steamed milk 150ml',
      });
      assert.strictEqual(rec2.ingredient_product_id, milkProductId);
      assert.strictEqual(parseFloat(rec2.quantity), 150.0);

      const fullRecipe = await getProductRecipe(pool, propertyId, latteProductId);
      assert.strictEqual(fullRecipe.ingredients.length, 2);
      return `Formula tersimpan: ${fullRecipe.ingredients.map((i) => `${i.quantity} ${i.uom_code} ${i.ingredient_name}`).join(', ')}`;
    });

    // Skenario 4: Validasi Deteksi Dependensi Sirkular (Circular Dependency)
    await step('Validasi: Penolakan circular dependency (Biji Kopi mencoba memasukkan Kopi Latte sebagai resep)', async () => {
      let rejected = false;
      try {
        await addOrUpdateRecipeIngredient(pool, {
          propertyId,
          productId: coffeeProductId,
          ingredientProductId: latteProductId, // Akan membentuk siklus A -> B -> A
          quantity: 1,
        });
      } catch (err) {
        rejected = true;
        assert.strictEqual(err.code, 'CIRCULAR_RECIPE_DEPENDENCY');
      }
      assert(rejected, 'Circular dependency harus ditolak dengan CIRCULAR_RECIPE_DEPENDENCY');
      return 'Circular dependency berhasil dicegah';
    });

    // Skenario 5: Transaksi Kasir POS (Pemesanan & Pemotongan Stok Otomatis)
    let order1Id;
    await step('Operasional: Buat Pesanan POS: 2x Kopi Latte, 1x Air Mineral, 1x Corkage Fee', async () => {
      const orderRes = await pool.query(
        `INSERT INTO pos_orders (property_id, order_number, table_number, guest_name, status, total_amount, location_id)
         VALUES ($1, 'ORD-BOM-001', 'Table 05', 'Budi Santoso', 'OPEN', 130000, $2)
         RETURNING id`,
        [propertyId, outletLocationId]
      );
      order1Id = orderRes.rows[0].id;

      // Item 1: 2x Kopi Latte (Harga @ 35.000 = 70.000) -> punya BOM
      await pool.query(
        `INSERT INTO pos_order_items (order_id, menu_item_id, item_name_snapshot, quantity, unit_price, discount_amount)
         VALUES ($1, $2, 'Kopi Latte', 2, 35000, 0)`,
        [order1Id, latteProductId]
      );

      // Item 2: 1x Air Mineral (Harga @ 10.000 = 10.000) -> retail direct
      await pool.query(
        `INSERT INTO pos_order_items (order_id, menu_item_id, item_name_snapshot, quantity, unit_price, discount_amount)
         VALUES ($1, $2, 'Air Mineral 600ml', 1, 10000, 0)`,
        [order1Id, sodaProductId]
      );

      // Item 3: 1x Corkage Fee (Harga @ 50.000 = 50.000) -> service non-tracked
      await pool.query(
        `INSERT INTO pos_order_items (order_id, menu_item_id, item_name_snapshot, quantity, unit_price, discount_amount)
         VALUES ($1, $2, 'Corkage Fee Wine', 1, 50000, 0)`,
        [order1Id, corkageProductId]
      );

      return `Order #${order1Id} berstatus OPEN dengan 3 baris item`;
    });

    await step('Operasional: Selesaikan Pembayaran Kasir & Potong Stok BOM Otomatis', async () => {
      // Eksekusi penyelesaian pembayaran kasir
      const payClient = await pool.connect();
      let payResult;
      try {
        payResult = await payPosOrderCash(payClient, {
          propertyId,
          orderId: order1Id,
          cashierId: '1',
          cashierName: 'Kasir Utama',
          actorName: 'Kasir Utama',
          idempotencyKey: `idemp-bom-test-order1-${Date.now()}`,
          shiftId: null,
          methodInput: {
            cashReceived: 150000,
          },
        });
      } finally {
        payClient.release();
      }

      assert.strictEqual(payResult.settlement.status, 'SUCCESS');
      const orderCheck = await pool.query('SELECT status FROM pos_orders WHERE id = $1', [order1Id]);
      assert.strictEqual(orderCheck.rows[0].status, 'PAID');

      // Verifikasi saldo stok terkini setelah pemotongan otomatis:
      // 1. Biji Kopi: 1000 - (2 * 18) = 964.000 GRAM
      const cofBal = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [propertyId, coffeeProductId, outletLocationId]
      );
      assert.strictEqual(parseFloat(cofBal.rows[0].quantity), 964.0, 'Saldo Biji Kopi harus berkurang 36 gr menjadi 964 gr');

      // 2. Susu Segar UHT: 2000 - (2 * 150) = 1700.000 ML
      const milkBal = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [propertyId, milkProductId, outletLocationId]
      );
      assert.strictEqual(parseFloat(milkBal.rows[0].quantity), 1700.0, 'Saldo Susu UHT harus berkurang 300 ml menjadi 1700 ml');

      // 3. Air Mineral Botol: 50 - 1 = 49.000 BOTOL
      const sodaBal = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [propertyId, sodaProductId, outletLocationId]
      );
      assert.strictEqual(parseFloat(sodaBal.rows[0].quantity), 49.0, 'Saldo Air Mineral harus berkurang 1 botol menjadi 49 botol');

      // 4. Kopi Latte (Finished Good) tidak memiliki saldo fisik di stock_balances
      const latteBal = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [propertyId, latteProductId, outletLocationId]
      );
      assert.strictEqual(latteBal.rows.length, 0, 'Kopi Latte dengan resep tidak memotong saldo produk jadi secara langsung');

      // 5. Cek mutasi ledger (stock_movements)
      const movs = await pool.query(
        `SELECT sm.product_id, sm.quantity_delta, sm.base_unit_code, pmi.name
           FROM stock_movements sm
           JOIN pos_menu_items pmi ON pmi.id = sm.product_id
          WHERE sm.property_id = $1 AND sm.quantity_delta < 0
          ORDER BY sm.id ASC`,
        [propertyId]
      );
      assert.strictEqual(movs.rows.length, 3, 'Harus ada tepat 3 mutasi keluar: 2 bahan baku + 1 produk ritel');

      return `Saldo akurat: Kopi: ${cofBal.rows[0].quantity}g, Susu: ${milkBal.rows[0].quantity}ml, Air: ${sodaBal.rows[0].quantity}btl`;
    });

    // Skenario 6: Penolakan Insufficient Stock & Atomisitas Transaksi (Rollback)
    await step('Proteksi: Pesanan 100x Kopi Latte ditolak karena stok bahan baku tidak cukup', async () => {
      // 100x Latte butuh 1800 gr Kopi, tapi saldo saat ini 964 gr
      const order2Res = await pool.query(
        `INSERT INTO pos_orders (property_id, order_number, table_number, guest_name, status, total_amount, location_id)
         VALUES ($1, 'ORD-BOM-LARGE', 'Table 10', 'Rombongan Besar', 'OPEN', 3500000, $2)
         RETURNING id`,
        [propertyId, outletLocationId]
      );
      const order2Id = order2Res.rows[0].id;

      await pool.query(
        `INSERT INTO pos_order_items (order_id, menu_item_id, item_name_snapshot, quantity, unit_price, discount_amount)
         VALUES ($1, $2, 'Kopi Latte', 100, 35000, 0)`,
        [order2Id, latteProductId]
      );

      let rejected = false;
      const rejectClient = await pool.connect();
      try {
        await payPosOrderCash(rejectClient, {
          propertyId,
          orderId: order2Id,
          cashierId: '1',
          cashierName: 'Kasir Utama',
          actorName: 'Kasir Utama',
          idempotencyKey: `idemp-bom-test-order2-${Date.now()}`,
          methodInput: { cashReceived: 3500000 },
        });
      } catch (err) {
        rejected = true;
        assert.strictEqual(err.code, 'INSUFFICIENT_STOCK_BALANCE');
        assert(err.message.includes('Biji Kopi Arabika'));
      } finally {
        rejectClient.release();
      }
      assert(rejected, 'Pembayaran harus ditolak karena bahan baku tidak cukup');

      // Verifikasi atomisitas: saldo Biji Kopi dan Susu tidak berubah seperser pun
      const cofBalAfter = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [propertyId, coffeeProductId, outletLocationId]
      );
      assert.strictEqual(parseFloat(cofBalAfter.rows[0].quantity), 964.0, 'Saldo kopi harus tetap 964 gr (rollback atomik)');

      const milkBalAfter = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [propertyId, milkProductId, outletLocationId]
      );
      assert.strictEqual(parseFloat(milkBalAfter.rows[0].quantity), 1700.0, 'Saldo susu harus tetap 1700 ml (rollback atomik)');

      // Order tetap OPEN
      const ord2Check = await pool.query(`SELECT status FROM pos_orders WHERE id = $1`, [order2Id]);
      assert.strictEqual(ord2Check.rows[0].status, 'OPEN');

      return '422 INSUFFICIENT_STOCK_BALANCE terverifikasi, transaksi DB di-rollback atomik';
    });

    // Skenario 7: REST API Query Candidates & Recipe Deletion
    await step('Query & CRUD: Raw Material Candidates dan Penghapusan Komponen Resep', async () => {
      // Ambil kandidat bahan baku
      const candidates = await getRawMaterialCandidates(pool, propertyId, latteProductId);
      assert(candidates.length >= 2, 'Harus ada kandidat bahan baku');
      assert(candidates.some((c) => c.id === coffeeProductId));

      // Hapus satu komponen resep (Susu)
      const recipeBefore = await getProductRecipe(pool, propertyId, latteProductId);
      const milkRecipeItem = recipeBefore.ingredients.find((i) => i.ingredient_product_id === milkProductId);
      assert(milkRecipeItem, 'Komponen susu harus ada');

      const delRes = await deleteRecipeIngredient(pool, propertyId, milkRecipeItem.id);
      assert.strictEqual(delRes.deleted, true);

      const recipeAfter = await getProductRecipe(pool, propertyId, latteProductId);
      assert.strictEqual(recipeAfter.ingredients.length, 1);
      assert.strictEqual(recipeAfter.ingredients[0].ingredient_product_id, coffeeProductId);

      return `Komponen resep #${milkRecipeItem.id} berhasil dihapus, sisa 1 komponen`;
    });

    log('========================================================================');
    log(' SEMUA SKENARIO PENGUJIAN MP-04C LULUS 100% (PASS)');
    log('========================================================================');
  } finally {
    await pool.end().catch(() => {});
    log(`Menghentikan dan menghapus container docker uji: ${containerName}`);
    docker(['rm', '-f', containerName], { allowFail: true });
    log('Container docker dibersihkan (zero residue).');
  }
}

run().catch((err) => {
  console.error('\nTEST SUITE GAGAL:');
  console.error(err);
  process.exit(1);
});
