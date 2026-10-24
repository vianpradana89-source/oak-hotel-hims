/**
 * OAK HIMS — MP-04D POS Purchase Order (PO) & Goods Receipt Note (GRN) E2E Test Suite
 *
 * Cakupan Pengujian:
 * 1. Inisialisasi skema database schema_v3 dan migrasi pos_purchase_orders_v1.
 * 2. CRUD Supplier & Validasi Integritas Kode Unik per Properti.
 * 3. Pembuatan Purchase Order (PO) & Siklus Transisi Status (DRAFT -> ORDERED).
 * 4. Penerimaan Barang Parsial (Partial Goods Receipt):
 *    - PO status bergeser otomatis menjadi PARTIALLY_RECEIVED.
 *    - Validasi kuantitas yang diterima (received_qty) pada PO item.
 *    - Mutasi persediaan tercatat di stock_movements (PURCHASE_RECEIPT) dan stock_balances.
 * 5. Kalkulasi Weighted Moving Average Unit Cost & Full Receipt:
 *    - Formula Moving Average: ((saldo_lama * avg_lama) + (qty_baru * cost_baru)) / (saldo_lama + qty_baru).
 *    - PO status otomatis menjadi COMPLETED saat seluruh item diterima penuh.
 * 6. Proteksi Over-Receipt & Penerimaan Langsung (Standalone GRN tanpa PO).
 * 7. Idempotensi GRN via idempotency_key (zero duplicate mutation).
 * 8. Audit Ledger Invariants:
 *    - stock_movements vs stock_balances drift = 0.
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
const TEST_DB = 'oak_hims_pos_po_test';
const TEST_USER = 'oak_po_runner';
const CONTAINER_PREFIX = 'oak-hims-pos-po-test-';

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
  log(' OAK HIMS — MP-04D POS Purchase Order & Goods Receipt Note Test Suite');
  log('========================================================================');

  // 1. Preflight module loads
  const { Pool } = require('pg');
  const schema = require('../dist/db/schema_v3');
  const { runPosPurchaseOrdersMigration } = require('../dist/db/migrations/pos_purchase_orders_v1');
  const {
    getPosSuppliers,
    getPosSupplierById,
    createPosSupplier,
    updatePosSupplier,
    getPosPurchaseOrders,
    getPosPurchaseOrderById,
    createPosPurchaseOrder,
    updatePosPurchaseOrderStatus,
  } = require('../dist/domains/pos/posPurchaseOrderService');
  const {
    recordPosGoodsReceipt,
    getPosGoodsReceipts,
    getPosGoodsReceiptById,
  } = require('../dist/domains/pos/posGoodsReceiptService');

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
  if (!hostPort) {
    throw new Error('Gagal mendapatkan host port dari Docker container');
  }
  log(`Container aktif pada 127.0.0.1:${hostPort}`);

  // 3. Connect to database
  const pool = new Pool({
    host: '127.0.0.1',
    port: hostPort,
    database: TEST_DB,
    user: TEST_USER,
    password: testPassword,
    max: 10,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });

  // Wait for postgres ready
  let dbReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      const ping = await pool.query('SELECT 1 AS ok');
      if (ping.rows[0].ok === 1) {
        dbReady = true;
        break;
      }
    } catch (e) {
      await sleep(500);
    }
  }
  if (!dbReady) throw new Error('PostgreSQL tidak siap dalam batas waktu');

  let propertyId = null;
  let locationId = null;
  let supplierAId = null;
  let supplierBId = null;
  let prodKopiId = null;
  let prodSusuId = null;
  let uomKgId = null;
  let uomLiterId = null;
  let poId = null;

  try {
    // -------------------------------------------------------------------------
    // STEP 1: Skema Database & Migrasi
    // -------------------------------------------------------------------------
    await step('1. Inisialisasi schema_v3 dan migrasi pos_purchase_orders_v1', async () => {
      await schema.initializeDatabase(pool);
      const mig = await runPosPurchaseOrdersMigration(pool);
      assert.ok(mig.applied.length >= 0, 'Migrasi berhasil dieksekusi');

      // Verifikasi tabel ada
      const tblCheck = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('pos_suppliers', 'pos_purchase_orders', 'pos_purchase_order_items', 'pos_goods_receipts', 'pos_goods_receipt_items')
      `);
      assert.strictEqual(tblCheck.rows.length, 5, 'Kelima tabel MP-04D harus terbentuk');
      return { tables: tblCheck.rows.map((r) => r.table_name) };
    });

    // -------------------------------------------------------------------------
    // STEP 2: Seeding Data Dasar
    // -------------------------------------------------------------------------
    await step('2. Seed Properti, Gudang, Satuan UOM, dan Master Produk', async () => {
      // 2a. Properti (property_code max 6 karakter)
      const propRes = await pool.query(
        `INSERT INTO properties (name, property_code, address, phone, email)
         VALUES ('OAK Grand Resort', 'OAK01', 'Jl. Merdeka No. 1', '021123456', 'info@oak.com')
         RETURNING id`
      );
      propertyId = propRes.rows[0].id;

      // 2b. Lokasi Gudang
      const locRes = await pool.query(
        `INSERT INTO stock_locations (property_id, code, name, location_type, is_active)
         VALUES ($1, 'WH-MAIN', 'Gudang Utama F&B', 'WAREHOUSE', TRUE)
         RETURNING id`,
        [propertyId]
      );
      locationId = locRes.rows[0].id;

      // 2c. UOMs
      const uomKgRes = await pool.query(
        `INSERT INTO pos_product_uoms (property_id, code, name, category)
         VALUES ($1, 'KG', 'Kilogram', 'WEIGHT')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [propertyId]
      );
      if (uomKgRes.rows.length > 0) {
        uomKgId = uomKgRes.rows[0].id;
      } else {
        const f = await pool.query(`SELECT id FROM pos_product_uoms WHERE UPPER(code) = 'KG' LIMIT 1`);
        uomKgId = f.rows[0].id;
      }

      const uomLtRes = await pool.query(
        `INSERT INTO pos_product_uoms (property_id, code, name, category)
         VALUES ($1, 'LITER', 'Liter', 'VOLUME')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [propertyId]
      );
      if (uomLtRes.rows.length > 0) {
        uomLiterId = uomLtRes.rows[0].id;
      } else {
        const f = await pool.query(`SELECT id FROM pos_product_uoms WHERE UPPER(code) = 'LITER' LIMIT 1`);
        uomLiterId = f.rows[0].id;
      }

      // 2d. Produk Bahan Baku
      const prodKopi = await pool.query(
        `INSERT INTO pos_menu_items (
           property_id, name, item_code, product_type, price, is_sellable_pos, base_unit,
           canonical_base_unit_code, track_stock, track_inventory, average_cost, last_cost
         ) VALUES ($1, 'Biji Kopi Arabika', 'RAW-KOPI', 'RAW_MATERIAL', 0, FALSE, 'KG', 'KG', TRUE, TRUE, 0, 0)
         RETURNING id`,
        [propertyId]
      );
      prodKopiId = prodKopi.rows[0].id;

      const prodSusu = await pool.query(
        `INSERT INTO pos_menu_items (
           property_id, name, item_code, product_type, price, is_sellable_pos, base_unit,
           canonical_base_unit_code, track_stock, track_inventory, average_cost, last_cost
         ) VALUES ($1, 'Susu Segar UHT', 'RAW-SUSU', 'RAW_MATERIAL', 0, FALSE, 'LITER', 'LITER', TRUE, TRUE, 0, 0)
         RETURNING id`,
        [propertyId]
      );
      prodSusuId = prodSusu.rows[0].id;

      return { propertyId, locationId, prodKopiId, prodSusuId, uomKgId, uomLiterId };
    });

    // -------------------------------------------------------------------------
    // STEP 3: Supplier CRUD & Constraint Validation
    // -------------------------------------------------------------------------
    await step('3. Supplier CRUD & Validasi Keunikan Kode', async () => {
      // Create Supplier A
      const supA = await createPosSupplier(pool, {
        property_id: propertyId,
        code: 'SUP-KOPI',
        name: 'CV Berkah Kopi Nusantara',
        contact_person: 'Pak Handoko',
        phone: '081234567890',
        email: 'handoko@berkahkopi.com',
        address: 'Jl. Kopi No. 10, Bandung',
      });
      assert.strictEqual(supA.code, 'SUP-KOPI');
      supplierAId = supA.id;

      // Create Supplier B
      const supB = await createPosSupplier(pool, {
        property_id: propertyId,
        code: 'SUP-SUSU',
        name: 'PT Greenfields Dairy Jaya',
        contact_person: 'Ibu Sarah',
        phone: '081987654321',
      });
      supplierBId = supB.id;

      // Duplikasi kode supplier di properti yang sama harus ditolak
      let dupFailed = false;
      try {
        await createPosSupplier(pool, {
          property_id: propertyId,
          code: 'SUP-KOPI',
          name: 'Duplikat Supplier',
        });
      } catch (e) {
        dupFailed = true;
      }
      assert.ok(dupFailed, 'Duplikasi kode supplier SUP-KOPI harus ditolak');

      // Update Supplier A
      const updatedSupA = await updatePosSupplier(pool, propertyId, supplierAId, {
        contact_person: 'Pak Handoko Senior',
      });
      assert.strictEqual(updatedSupA.contact_person, 'Pak Handoko Senior');

      // List suppliers
      const allSups = await getPosSuppliers(pool, propertyId);
      assert.strictEqual(allSups.length, 2, 'Total supplier harus 2');

      return { supplierAId, supplierBId, totalSuppliers: allSups.length };
    });

    // -------------------------------------------------------------------------
    // STEP 4: Purchase Order Creation & Status Transitions
    // -------------------------------------------------------------------------
    await step('4. Buat Purchase Order (DRAFT) & Setujui (ORDERED)', async () => {
      // 100 kg Kopi @ 80,000 + 200 liter Susu @ 15,000 = 8,000,000 + 3,000,000 = 11,000,000
      const po = await createPosPurchaseOrder(pool, {
        property_id: propertyId,
        po_number: 'PO-202610-001',
        supplier_id: supplierAId,
        order_date: '2026-10-24',
        expected_date: '2026-10-26',
        notes: 'Pemesanan bahan baku mingguan',
        created_by: 'Supervisor F&B',
        items: [
          {
            product_id: prodKopiId,
            ordered_qty: 100,
            unit_cost: 80000,
            uom_id: uomKgId,
            notes: 'Biji kopi grade 1',
          },
          {
            product_id: prodSusuId,
            ordered_qty: 200,
            unit_cost: 15000,
            uom_id: uomLiterId,
            notes: 'Susu UHT Plain',
          },
        ],
      });

      assert.strictEqual(po.status, 'DRAFT', 'Status awal PO harus DRAFT');
      assert.strictEqual(parseFloat(po.total_estimated_amount), 11000000, 'Total estimasi PO harus 11,000,000');
      assert.strictEqual(po.items.length, 2, 'PO harus memiliki 2 item baris');
      poId = po.id;

      // Status transition: DRAFT -> ORDERED
      const orderedPo = await updatePosPurchaseOrderStatus(pool, propertyId, poId, 'ORDERED', 'Manager F&B');
      assert.strictEqual(orderedPo.status, 'ORDERED', 'Status PO harus berhasil diubah menjadi ORDERED');

      return { poId, poNumber: po.po_number, totalEstimated: po.total_estimated_amount, status: orderedPo.status };
    });

    // -------------------------------------------------------------------------
    // STEP 5: Penerimaan Barang Parsial (Partial Goods Receipt)
    // -------------------------------------------------------------------------
    await step('5. Penerimaan Parsial (GRN #1: 40 kg Kopi & 100 lt Susu)', async () => {
      const grn1 = await recordPosGoodsReceipt(pool, {
        property_id: propertyId,
        po_id: poId,
        location_id: locationId,
        receipt_date: '2026-10-24',
        invoice_no: 'INV-SUP-001',
        received_by: 'Staf Gudang Doni',
        notes: 'Penerimaan tahap 1',
        items: [
          {
            product_id: prodKopiId,
            received_qty: 40,
            unit_cost: 80000,
            uom_id: uomKgId,
          },
          {
            product_id: prodSusuId,
            received_qty: 100,
            unit_cost: 15000,
            uom_id: uomLiterId,
          },
        ],
      });

      assert.strictEqual(grn1.status, 'COMPLETED');
      assert.strictEqual(grn1.po_status, 'PARTIALLY_RECEIVED', 'Status PO harus berubah jadi PARTIALLY_RECEIVED');

      // Verifikasi status PO di database
      const curPo = await getPosPurchaseOrderById(pool, propertyId, poId);
      assert.strictEqual(curPo.status, 'PARTIALLY_RECEIVED');
      const kopiItem = curPo.items.find((i) => i.product_id === prodKopiId);
      const susuItem = curPo.items.find((i) => i.product_id === prodSusuId);
      assert.strictEqual(parseFloat(kopiItem.received_qty), 40, 'Kopi received_qty harus 40');
      assert.strictEqual(parseFloat(susuItem.received_qty), 100, 'Susu received_qty harus 100');

      // Verifikasi saldo stok di stock_balances
      const balKopi = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [propertyId, prodKopiId, locationId]
      );
      assert.strictEqual(parseFloat(balKopi.rows[0].quantity), 40, 'Saldo fisik Kopi harus 40');

      // Verifikasi pos_menu_items average_cost & last_cost (inbound pertama: avg_cost = unit_cost)
      const costKopi = await pool.query(
        `SELECT average_cost, last_cost FROM pos_menu_items WHERE id = $1`,
        [prodKopiId]
      );
      assert.strictEqual(parseFloat(costKopi.rows[0].average_cost), 80000, 'Avg cost awal kopi harus 80,000');
      assert.strictEqual(parseFloat(costKopi.rows[0].last_cost), 80000, 'Last cost awal kopi harus 80,000');

      return { grnNumber: grn1.grn_number, poStatus: curPo.status, saldoKopi: balKopi.rows[0].quantity };
    });

    // -------------------------------------------------------------------------
    // STEP 6: Kalkulasi Moving Average Cost (MAC) & Full Receipt Completion
    // -------------------------------------------------------------------------
    await step('6. Penerimaan Sisa & Kalkulasi Weighted Moving Average Cost', async () => {
      // Saldo lama kopi: 40 kg @ 80,000 (total val: 3,200,000)
      // Terima baru kopi: 60 kg @ 90,000 (total val: 5,400,000)
      // New total: 100 kg, total val: 8,600,000 => New Avg Cost: 86,000 / kg!
      // Terima baru susu: sisa 100 liter @ 15,000 => Total 200 liter diterima penuh.

      const grn2 = await recordPosGoodsReceipt(pool, {
        property_id: propertyId,
        po_id: poId,
        location_id: locationId,
        receipt_date: '2026-10-25',
        invoice_no: 'INV-SUP-002',
        received_by: 'Staf Gudang Doni',
        notes: 'Penerimaan tahap 2 (pelunasan sisa PO)',
        items: [
          {
            product_id: prodKopiId,
            received_qty: 60,
            unit_cost: 90000, // Harga naik menjadi 90,000
            uom_id: uomKgId,
          },
          {
            product_id: prodSusuId,
            received_qty: 100,
            unit_cost: 15000,
            uom_id: uomLiterId,
          },
        ],
      });

      assert.strictEqual(grn2.status, 'COMPLETED');
      assert.strictEqual(grn2.po_status, 'COMPLETED', 'Status PO harus otomatis COMPLETED karena semua item lunas');

      // Verifikasi status PO di database
      const finalPo = await getPosPurchaseOrderById(pool, propertyId, poId);
      assert.strictEqual(finalPo.status, 'COMPLETED');

      // Verifikasi Saldo Fisik Kopi (40 + 60 = 100 kg)
      const balKopi = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [propertyId, prodKopiId, locationId]
      );
      assert.strictEqual(parseFloat(balKopi.rows[0].quantity), 100, 'Saldo fisik Kopi harus 100 kg');

      // Verifikasi Moving Average Cost Kopi: HARUS 86,000.00 dan last_cost 90,000.00
      const costKopi = await pool.query(
        `SELECT average_cost, last_cost FROM pos_menu_items WHERE id = $1`,
        [prodKopiId]
      );
      assert.strictEqual(parseFloat(costKopi.rows[0].average_cost), 86000, 'Moving average cost Kopi harus tepat 86,000');
      assert.strictEqual(parseFloat(costKopi.rows[0].last_cost), 90000, 'Last cost Kopi harus 90,000');

      return {
        poStatus: finalPo.status,
        finalKopiQty: balKopi.rows[0].quantity,
        movingAvgCost: costKopi.rows[0].average_cost,
        lastCost: costKopi.rows[0].last_cost,
      };
    });

    // -------------------------------------------------------------------------
    // STEP 7: Proteksi Over-Receipt & Standalone GRN
    // -------------------------------------------------------------------------
    await step('7. Proteksi Over-Receipt & Standalone GRN tanpa PO', async () => {
      // 7a. Coba terima barang lagi di PO yang sudah COMPLETED
      let overPoFailed = false;
      try {
        await recordPosGoodsReceipt(pool, {
          property_id: propertyId,
          po_id: poId,
          location_id: locationId,
          items: [{ product_id: prodKopiId, received_qty: 10, unit_cost: 80000 }],
        });
      } catch (e) {
        overPoFailed = true;
      }
      assert.ok(overPoFailed, 'Penerimaan pada PO yang sudah COMPLETED harus ditolak');

      // 7b. Standalone GRN (penerimaan langsung tanpa PO, e.g. pembelian tunai pasar/darurat)
      const directGrn = await recordPosGoodsReceipt(pool, {
        property_id: propertyId,
        po_id: null,
        supplier_id: supplierBId,
        location_id: locationId,
        invoice_no: 'CASH-MARKET-99',
        notes: 'Pembelian darurat pasar',
        items: [
          {
            product_id: prodSusuId,
            received_qty: 50,
            unit_cost: 16000,
          },
        ],
      });
      assert.strictEqual(directGrn.status, 'COMPLETED');

      // Verifikasi saldo Susu bertambah 50 (sebelumnya 200 -> jadi 250)
      const balSusu = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [propertyId, prodSusuId, locationId]
      );
      assert.strictEqual(parseFloat(balSusu.rows[0].quantity), 250, 'Saldo Susu harus 250 liter');

      return { standaloneGrnNumber: directGrn.grn_number, finalSusuQty: balSusu.rows[0].quantity };
    });

    // -------------------------------------------------------------------------
    // STEP 8: Idempotensi & Invarian Drift Ledger = 0
    // -------------------------------------------------------------------------
    await step('8. Idempotensi GRN & Invarian Ledger (Drift = 0)', async () => {
      const idempKey = 'IDEMP-GRN-UNIQUE-KEY-001';

      // Kirim pertama
      const grnA = await recordPosGoodsReceipt(pool, {
        property_id: propertyId,
        location_id: locationId,
        idempotency_key: idempKey,
        notes: 'Penerimaan dengan Idempotency Key',
        items: [{ product_id: prodKopiId, received_qty: 5, unit_cost: 86000 }],
      });

      // Saldo kopi setelah kirim pertama: 100 + 5 = 105
      const balA = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [propertyId, prodKopiId, locationId]
      );
      assert.strictEqual(parseFloat(balA.rows[0].quantity), 105);

      // Replay permintaan kedua dengan key yang sama
      const grnB = await recordPosGoodsReceipt(pool, {
        property_id: propertyId,
        location_id: locationId,
        idempotency_key: idempKey,
        notes: 'Penerimaan duplikat tidak boleh menambah stok',
        items: [{ product_id: prodKopiId, received_qty: 5, unit_cost: 86000 }],
      });

      assert.strictEqual(grnA.id, grnB.id, 'Idempotent request harus mengembalikan id GRN yang sama');

      // Saldo kopi harus TETAP 105 (tidak terduplikasi menjadi 110)
      const balB = await pool.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
        [propertyId, prodKopiId, locationId]
      );
      assert.strictEqual(parseFloat(balB.rows[0].quantity), 105, 'Saldo stok tidak boleh bertambah pada idempotent replay');

      // Verifikasi Invarian Ledger: Drift = 0
      // SUM(stock_movements.quantity_delta) per produk & lokasi HARUS sama persis dengan stock_balances.quantity
      const driftCheck = await pool.query(`
        SELECT
          sb.product_id,
          sb.location_id,
          sb.quantity AS balance_qty,
          COALESCE(SUM(sm.quantity_delta), 0) AS movement_sum,
          (sb.quantity - COALESCE(SUM(sm.quantity_delta), 0)) AS drift
        FROM stock_balances sb
        LEFT JOIN stock_movements sm
          ON sb.property_id = sm.property_id
         AND sb.product_id = sm.product_id
         AND sb.location_id = sm.location_id
        WHERE sb.property_id = $1
        GROUP BY sb.product_id, sb.location_id, sb.quantity
      `, [propertyId]);

      for (const row of driftCheck.rows) {
        const drift = Math.abs(parseFloat(row.drift));
        assert.ok(drift < 0.0001, `Ledger drift harus 0 untuk produk ${row.product_id} (drift: ${drift})`);
      }

      return {
        idempotentGrnId: grnA.id,
        ledgerRowsChecked: driftCheck.rows.length,
        driftInvariantOk: true,
      };
    });

    log('\n========================================================================');
    log(' SEMUA SKENARIO PENGUJIAN E2E MP-04D LULUS (PASS 100%)');
    log('========================================================================\n');
  } finally {
    await pool.end().catch(() => {});
    log(`Membersihkan Docker container ${containerName}...`);
    docker(['rm', '-f', containerName], { allowFail: true });
    log('Pembersihan selesai (zero residue).');
  }
}

run().catch((err) => {
  console.error('\nFAIL E2E TEST FAILED:', err);
  process.exit(1);
});
