'use strict';

const http = require('http');
const express = require('express');
const { createTransactionsRouter } = require('../dist/domains/transactions/transactionsRouter');
const { createPurchaseSettingsRouter } = require('../dist/domains/transactions/purchaseSettingsRouter');
const {
  createPurchaseTransaction,
  getTransactionById,
  getTransactions,
} = require('../dist/domains/transactions/transactionService');
const {
  createPurchaseCategory,
  updatePurchaseCategory,
  setPurchaseCategoryActive,
  deletePurchaseCategory,
  listPurchaseCategories,
  getPurchaseFormOptions,
  replacePurchaseAllowedDepartments,
} = require('../dist/domains/transactions/purchaseSettingsService');
const { createSupplier } = require('../dist/domains/suppliers/supplierService');
const { getPlatformSuperAdminToken, staffToken } = require('./helpers/transactionReadAuth');

let assertions = 0;
function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function requestJson(port, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let json = null;
        const text = Buffer.concat(chunks).toString('utf8');
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function expectReject(fn, pattern, message) {
  try {
    await fn();
    throw new Error(`${message}: expected rejection`);
  } catch (err) {
    if (String(err.message || '').includes('expected rejection')) throw err;
    expect(pattern.test(String(err.message || '')), `${message}: ${err.message}`);
  }
}

async function run() {
  const pkg = require('../dist/index.js');
  const schemaPkg = require('../dist/db/schema_v3.js');
  const pool = pkg.pool;
  await schemaPkg.initializeDatabase(pool);

  const rand = Math.floor(1000 + Math.random() * 9000);
  const propA = await pool.query(
    "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('PUR-1C-A', $1, 'Asia/Jakarta', 'IDR', 'Addr', TRUE) RETURNING id",
    [`CA${rand}`]
  );
  const propB = await pool.query(
    "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('PUR-1C-B', $1, 'Asia/Jakarta', 'IDR', 'Addr', TRUE) RETURNING id",
    [`CB${rand}`]
  );
  const propertyA = Number(propA.rows[0].id);
  const propertyB = Number(propB.rows[0].id);
  const tracked = { transactions: [], suppliers: [], departments: [] };

  const deptAFb = await pool.query(
    `INSERT INTO hr_departments (property_id, code, name, is_active, sort_order)
     VALUES ($1, 'FB', 'F&B / Restoran', TRUE, 1) RETURNING id, name`,
    [propertyA]
  );
  const deptAHk = await pool.query(
    `INSERT INTO hr_departments (property_id, code, name, is_active, sort_order)
     VALUES ($1, 'HK', 'Housekeeping', TRUE, 2) RETURNING id, name`,
    [propertyA]
  );
  const deptAFo = await pool.query(
    `INSERT INTO hr_departments (property_id, code, name, is_active, sort_order)
     VALUES ($1, 'FO', 'Front Office', TRUE, 3) RETURNING id, name`,
    [propertyA]
  );
  const deptAInactive = await pool.query(
    `INSERT INTO hr_departments (property_id, code, name, is_active, sort_order)
     VALUES ($1, 'MG', 'Management', FALSE, 4) RETURNING id, name`,
    [propertyA]
  );
  const deptBFb = await pool.query(
    `INSERT INTO hr_departments (property_id, code, name, is_active, sort_order)
     VALUES ($1, 'FB', 'F&B B', TRUE, 1) RETURNING id`,
    [propertyB]
  );
  tracked.departments.push(
    Number(deptAFb.rows[0].id),
    Number(deptAHk.rows[0].id),
    Number(deptAFo.rows[0].id),
    Number(deptAInactive.rows[0].id),
    Number(deptBFb.rows[0].id)
  );

  const app = express();
  app.use(express.json());
  app.use('/api/transactions', createTransactionsRouter(pool));
  app.use('/api/settings/purchases', createPurchaseSettingsRouter(pool));
  const { server, port } = await listen(app);

  try {
    const supplierA = await createSupplier(pool, { property_id: propertyA, name: 'Puga', actor_name: 'Tester' });
    tracked.suppliers.push(Number(supplierA.id));

    const createdCat = await createPurchaseCategory(pool, {
      property_id: propertyA,
      name: 'Bahan Dapur Custom',
      actor_name: 'Purchasing',
    });
    expect(createdCat.transaction_type === 'PURCHASE', 'A. custom category is PURCHASE');
    expect(Boolean(createdCat.code), 'A. generated code');
    expect(createdCat.is_active === true, 'A. active');

    const renamed = await updatePurchaseCategory(pool, propertyA, createdCat.id, {
      name: 'Bahan Dapur Custom Revisi',
      actor_name: 'Purchasing',
    });
    expect(renamed.name === 'Bahan Dapur Custom Revisi', 'B. name edited');
    expect(renamed.code === createdCat.code, 'B. code stable');

    const unused = await createPurchaseCategory(pool, {
      property_id: propertyA,
      name: 'Kategori Unused',
      actor_name: 'Purchasing',
    });
    await deletePurchaseCategory(pool, propertyA, unused.id, 'Purchasing');
    const afterDelete = await listPurchaseCategories(pool, propertyA);
    expect(!afterDelete.some((row) => row.id === unused.id), 'F. unused category deleted');

    await setPurchaseCategoryActive(pool, propertyA, createdCat.id, false, 'Purchasing');
    const formAfterOff = await getPurchaseFormOptions(pool, propertyA);
    expect(!formAfterOff.categories.some((row) => row.id === createdCat.id), 'C/D. inactive not offered');
    await setPurchaseCategoryActive(pool, propertyA, createdCat.id, true, 'Purchasing');
    const formAfterOn = await getPurchaseFormOptions(pool, propertyA);
    expect(formAfterOn.categories.some((row) => row.id === createdCat.id), 'E. reactivated category offered');

    const emptyAllow = await getPurchaseFormOptions(pool, propertyA);
    expect(emptyAllow.empty_allow_list_means === 'ALL_ACTIVE', 'X. empty allow-list documented');
    expect(emptyAllow.departments.some((row) => row.id === Number(deptAFb.rows[0].id)), 'K/X. F&B offered when unconfigured');
    expect(emptyAllow.departments.some((row) => row.id === Number(deptAHk.rows[0].id)), 'K. HK offered when unconfigured');
    expect(!emptyAllow.departments.some((row) => row.id === Number(deptAInactive.rows[0].id)), 'N. inactive department not offered');

    await replacePurchaseAllowedDepartments(pool, propertyA, [Number(deptAFb.rows[0].id), Number(deptAHk.rows[0].id)], 'Purchasing');
    const allowedForm = await getPurchaseFormOptions(pool, propertyA);
    expect(allowedForm.departments.some((row) => row.id === Number(deptAFb.rows[0].id)), 'L. allowed F&B appears');
    expect(!allowedForm.departments.some((row) => row.id === Number(deptAFo.rows[0].id)), 'M. Front Office not offered');

    const systemCat = formAfterOn.categories.find((row) => row.code === 'FNB_INGREDIENTS_PURCHASE');
    expect(Boolean(systemCat), 'system default seeded');

    const staging = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      purchase_category_id: systemCat.id,
      department_id: Number(deptAFb.rows[0].id),
      supplier_id: supplierA.id,
      source_reference: 'INV-1C-PUGA',
      receiving_status: 'DITERIMA',
      lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      is_immediately_paid: true,
      payment_method: 'TRANSFER',
      paid_amount: 10000,
      actor_name: 'Purchasing',
    });
    tracked.transactions.push(staging.id);
    expect(String(staging.description) === 'Pembelian Beras — Puga', 'Z/AA. generated description');
    expect(/^TRX-\d{6}-\d{5}$/.test(String(staging.transaction_no)), 'AB. transaction_no');
    expect(Number(staging.purchase_category_id) === Number(systemCat.id), 'purchase_category_id persisted');
    expect(String(staging.category_code) === 'FNB_INGREDIENTS_PURCHASE', 'category_code snapshot');
    expect(String(staging.category_name) === systemCat.name, 'category_name snapshot');
    expect(Number(staging.department_id) === Number(deptAFb.rows[0].id), 'P. department_id persisted');
    expect(String(staging.department_name_snapshot) === 'F&B / Restoran', 'Q. department_name_snapshot');
    expect(Number(staging.net_amount) === 10000, 'Z. net 10000');
    expect(String(staging.payment_status) === 'PAID', 'AD. paid');

    const payments = await pool.query(
      `SELECT transaction_type FROM payment_transactions WHERE transaction_id = $1`,
      [staging.id]
    );
    expect(payments.rows.length === 1 && payments.rows[0].transaction_type === 'PAYMENT', 'AD. settlement only');

    const listPurchase = await getTransactions(pool, { property_id: propertyA, transaction_type: 'PURCHASE' });
    expect(listPurchase.transactions.filter((row) => Number(row.id) === Number(staging.id)).length === 1, 'AF. once in Pembelian');
    const listAll = await getTransactions(pool, { property_id: propertyA });
    expect(listAll.transactions.filter((row) => Number(row.id) === Number(staging.id)).length === 1, 'AG. once in ALL');

    const referenced = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      purchase_category_id: createdCat.id,
      department_id: Number(deptAHk.rows[0].id),
      supplier_id: supplierA.id,
      lines: [{ description_snapshot: 'Minyak', quantity: 1, unit: 'L', unit_price: 15000 }],
      actor_name: 'Purchasing',
    });
    tracked.transactions.push(referenced.id);
    await expectReject(
      () => deletePurchaseCategory(pool, propertyA, createdCat.id, 'Purchasing'),
      /sudah dipakai/,
      'G. referenced category cannot delete'
    );

    await updatePurchaseCategory(pool, propertyA, createdCat.id, { name: 'Nama Baru Setelah Transaksi' });
    await setPurchaseCategoryActive(pool, propertyA, createdCat.id, false, 'Purchasing');
    const hist = await getTransactionById(pool, propertyA, referenced.id);
    expect(String(hist.category_name) === 'Bahan Dapur Custom Revisi', 'H. snapshot survives rename');
    expect(Number(hist.purchase_category_id) === Number(createdCat.id), 'H. id remains');

    await pool.query(`UPDATE hr_departments SET name = 'Housekeeping Renamed' WHERE id = $1`, [deptAHk.rows[0].id]);
    const histDept = await getTransactionById(pool, propertyA, referenced.id);
    expect(String(histDept.department_name_snapshot) === 'Housekeeping', 'S. department snapshot survives rename');

    const legacy = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      category_code: 'FNB_INGREDIENTS_PURCHASE',
      department_code: 'FNB',
      supplier_id: supplierA.id,
      description: 'Pembelian Daging Sapi & Bumbu Dapur',
      lines: [{ description_snapshot: 'Daging', quantity: 1, unit: 'kg', unit_price: 20000 }],
      discount_amount: 2000,
      rounding_amount: 37,
      receiving_status: 'DITERIMA_SEBAGIAN',
      actor_name: 'Purchasing',
    });
    tracked.transactions.push(legacy.id);
    expect(String(legacy.description) === 'Pembelian Daging Sapi & Bumbu Dapur', 'AH. explicit description kept');
    expect(String(legacy.department_code) === 'FNB', 'R. legacy department_code kept');
    expect(legacy.department_id == null, 'R. legacy department_id null');
    expect(Number(legacy.net_amount) === 18037, 'AC. 20000-2000+37 once');
    expect(String(legacy.receiving_status) === 'DITERIMA_SEBAGIAN', 'AE. receiving preserved');

    await setPurchaseCategoryActive(pool, propertyA, createdCat.id, true, 'Purchasing');
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: createdCat.id,
        department_id: Number(deptBFb.rows[0].id),
        supplier_id: supplierA.id,
        lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      }),
      /bukan milik properti/,
      'O. cross-property department rejected'
    );

    const catB = await createPurchaseCategory(pool, { property_id: propertyB, name: 'Cat B', actor_name: 'B' });
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: catB.id,
        supplier_id: supplierA.id,
        lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      }),
      /bukan milik properti/,
      'I. cross-property category rejected'
    );

    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        category_code: 'ROOM_SALES',
        supplier_id: supplierA.id,
        lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      }),
      /bukan kategori pembelian|tidak valid/,
      'J. SALE category rejected'
    );

    const spoofed = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      purchase_category_id: systemCat.id,
      category_code: 'ROOM_SALES',
      category_name: 'Engineering',
      department_id: Number(deptAFb.rows[0].id),
      supplier_id: supplierA.id,
      lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
    });
    tracked.transactions.push(spoofed.id);
    expect(Number(spoofed.purchase_category_id) === Number(systemCat.id), '1C1-A/B/F. id remains master');
    expect(String(spoofed.category_code) === 'FNB_INGREDIENTS_PURCHASE', '1C1-B/F. master code persists');
    expect(String(spoofed.category_name) === systemCat.name, '1C1-A/F. master name persists, not Engineering');

    const spoofedByCode = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      category_code: 'FNB_INGREDIENTS_PURCHASE',
      category_name: 'Engineering',
      department_code: 'FNB',
      supplier_id: supplierA.id,
      lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
    });
    tracked.transactions.push(spoofedByCode.id);
    expect(String(spoofedByCode.category_code) === 'FNB_INGREDIENTS_PURCHASE', '1C1-C/H. legacy code succeeds');
    expect(String(spoofedByCode.category_name) === systemCat.name, '1C1-C. code path uses master name');

    const expenseCat = await pool.query(
      `INSERT INTO transaction_custom_categories (property_id, code, name, transaction_type, department_code, is_active, created_at)
       VALUES ($1, $2, 'Kas Kecil 1C1', 'EXPENSE', 'GENERAL', TRUE, NOW()) RETURNING id`,
      [propertyA, `EXP_1C1_${rand}`]
    );
    const incomeCat = await pool.query(
      `INSERT INTO transaction_custom_categories (property_id, code, name, transaction_type, department_code, is_active, created_at)
       VALUES ($1, $2, 'Pemasukan 1C1', 'INCOME', 'GENERAL', TRUE, NOW()) RETURNING id`,
      [propertyA, `INC_1C1_${rand}`]
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: Number(expenseCat.rows[0].id),
        supplier_id: supplierA.id,
        lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      }),
      /bukan kategori pembelian/,
      '1C1-D. EXPENSE id rejected'
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: Number(incomeCat.rows[0].id),
        supplier_id: supplierA.id,
        lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      }),
      /bukan kategori pembelian/,
      '1C1-E. INCOME id rejected'
    );

    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        supplier_id: supplierA.id,
        lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      }),
      /Kategori pembelian wajib dipilih/,
      '1C1-G. missing category rejected'
    );

    await setPurchaseCategoryActive(pool, propertyA, createdCat.id, false, 'Purchasing');
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: createdCat.id,
        supplier_id: supplierA.id,
        lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      }),
      /tidak aktif/,
      '1C1-I. inactive category rejected'
    );
    await setPurchaseCategoryActive(pool, propertyA, createdCat.id, true, 'Purchasing');

    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        department_id: Number(deptAFo.rows[0].id),
        category_code: 'FNB_INGREDIENTS_PURCHASE',
        supplier_id: supplierA.id,
        lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      }),
      /tidak diizinkan/,
      'M. disallowed department rejected on create'
    );

    const saToken = await getPlatformSuperAdminToken(pool, propertyA);
    const staffB = staffToken(propertyB, 900241);
    const settingsList = await requestJson(port, 'GET', `/api/settings/purchases/categories?property_id=${propertyA}`, saToken);
    expect(settingsList.status === 200, `U. settings load ${settingsList.status}`);
    expect(Array.isArray(settingsList.json && settingsList.json.data), 'U. settings categories array');

    const anon = await requestJson(port, 'GET', `/api/settings/purchases/categories?property_id=${propertyA}`, null);
    expect(anon.status === 401, 'V. settings require auth');

    const crossSettings = await requestJson(port, 'POST', `/api/settings/purchases/categories?property_id=${propertyA}`, staffB, {
      property_id: propertyA,
      name: 'Should Fail',
    });
    expect(crossSettings.status === 403, `W. cross-property settings 403 got ${crossSettings.status}`);

    const otherPropCats = await listPurchaseCategories(pool, propertyB);
    expect(!otherPropCats.some((row) => row.id === createdCat.id), 'Y. settings isolated');

    const noSecondDept = await pool.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name IN ('purchase_departments', 'purchase_department_master')`
    );
    expect(Number(noSecondDept.rows[0].n) === 0, 'T. no duplicate department master');

    console.log(`PASS | PURCHASE-1C category/department | ${assertions} assertions`);
  } finally {
    server.close();
    try {
      if (tracked.transactions.length) {
        await pool.query('DELETE FROM payment_transactions WHERE transaction_id = ANY($1::bigint[])', [tracked.transactions]);
        await pool.query('DELETE FROM transaction_lines WHERE transaction_id = ANY($1::bigint[])', [tracked.transactions]);
        await pool.query('DELETE FROM transactions WHERE id = ANY($1::bigint[])', [tracked.transactions]);
      }
      await pool.query('DELETE FROM property_purchase_allowed_departments WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]);
      await pool.query('DELETE FROM transaction_custom_categories WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]);
      if (tracked.suppliers.length) {
        await pool.query('DELETE FROM suppliers WHERE id = ANY($1::bigint[])', [tracked.suppliers]);
      }
      if (tracked.departments.length) {
        await pool.query('DELETE FROM hr_departments WHERE id = ANY($1::int[])', [tracked.departments]);
      }
      await pool.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]);
      await pool.query('DELETE FROM transaction_daily_sequences WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]);
      await pool.query('DELETE FROM properties WHERE id = ANY($1::int[])', [[propertyA, propertyB]]);
    } catch (cleanupErr) {
      console.warn('PURCHASE-1C cleanup warning', cleanupErr.message);
    }
  }
}

run().catch((err) => {
  console.error('PURCHASE-1C FAILED', err);
  process.exit(1);
});
