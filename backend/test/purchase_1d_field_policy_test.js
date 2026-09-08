'use strict';

const http = require('http');
const express = require('express');
const { createTransactionsRouter } = require('../dist/domains/transactions/transactionsRouter');
const { createPurchaseSettingsRouter } = require('../dist/domains/transactions/purchaseSettingsRouter');
const {
  createPurchaseTransaction,
  getTransactionById,
} = require('../dist/domains/transactions/transactionService');
const { getPurchaseFormOptions } = require('../dist/domains/transactions/purchaseSettingsService');
const {
  getEffectivePurchaseFieldPolicy,
  savePurchaseFieldRules,
} = require('../dist/domains/transactions/purchaseFieldRulesService');
const {
  applyPurchaseFieldPolicyToCreateDto,
  DEFAULT_PURCHASE_FIELD_MODES,
  ALLOWED_PURCHASE_FIELD_MODES,
} = require('../dist/domains/transactions/purchaseFieldPolicy');
const { matchOperationalAccessRule } = require('../dist/domains/settings/operationalAccessGuard');
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

function baseLine() {
  return { description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 };
}

async function run() {
  const hiddenSupplier = applyPurchaseFieldPolicyToCreateDto({
    dto: {
      property_id: 1,
      purchase_category_id: 5,
      supplier_id: 99,
      supplier_name: 'Sneaky',
      lines: [baseLine()],
    },
    modes: { ...DEFAULT_PURCHASE_FIELD_MODES, supplier: 'HIDDEN' },
    defaultPurchaseCategoryId: null,
  });
  expect(hiddenSupplier.supplier_id == null, 'L-pure. HIDDEN supplier ignores id');
  expect(hiddenSupplier.supplier_name == null, 'L-pure. HIDDEN supplier ignores name');

  expect(ALLOWED_PURCHASE_FIELD_MODES.line_unit.join(',') === 'REQUIRED', 'A. line_unit allowed REQUIRED only');
  expect(ALLOWED_PURCHASE_FIELD_MODES.payment_method.join(',') === 'REQUIRED,HIDDEN', 'payment_method allowed REQUIRED|HIDDEN');
  expect(ALLOWED_PURCHASE_FIELD_MODES.paid_amount.join(',') === 'REQUIRED,OPTIONAL', 'paid_amount allowed REQUIRED|OPTIONAL');

  await expectReject(
    async () => applyPurchaseFieldPolicyToCreateDto({
      dto: {
        property_id: 1,
        purchase_category_id: 5,
        supplier_name: 'Puga',
        lines: [{ ...baseLine(), unit: '' }],
      },
      modes: { ...DEFAULT_PURCHASE_FIELD_MODES },
      defaultPurchaseCategoryId: null,
    }),
    /Satuan wajib/,
    'C. missing line unit rejected'
  );
  await expectReject(
    async () => applyPurchaseFieldPolicyToCreateDto({
      dto: {
        property_id: 1,
        purchase_category_id: 5,
        supplier_name: 'Puga',
        is_immediately_paid: true,
        paid_amount: 10000,
        lines: [baseLine()],
      },
      modes: { ...DEFAULT_PURCHASE_FIELD_MODES, payment_method: 'HIDDEN' },
      defaultPurchaseCategoryId: null,
    }),
    /Metode pembayaran wajib/,
    'F/G. pay-now without method rejected; no CASH invented'
  );
  await expectReject(
    async () => applyPurchaseFieldPolicyToCreateDto({
      dto: {
        property_id: 1,
        purchase_category_id: 5,
        supplier_name: 'Puga',
        is_immediately_paid: true,
        payment_method: 'TRANSFER',
        lines: [baseLine()],
      },
      modes: { ...DEFAULT_PURCHASE_FIELD_MODES, paid_amount: 'HIDDEN' },
      defaultPurchaseCategoryId: null,
    }),
    /tidak boleh disembunyikan/,
    'I. hidden paid_amount cannot auto-settle net'
  );

  const pkg = require('../dist/index.js');
  const schemaPkg = require('../dist/db/schema_v3.js');
  const pool = pkg.pool;
  await schemaPkg.initializeDatabase(pool);

  const tableCheck = await pool.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN ('property_purchase_field_rules', 'property_purchase_settings')`
  );
  expect(Number(tableCheck.rows[0].n) === 2, 'schema. both 1D tables exist');

  const rand = Math.floor(1000 + Math.random() * 9000);
  const propA = await pool.query(
    "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('PUR-1D-A', $1, 'Asia/Jakarta', 'IDR', 'Addr', TRUE) RETURNING id",
    [`DA${rand}`]
  );
  const propB = await pool.query(
    "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('PUR-1D-B', $1, 'Asia/Jakarta', 'IDR', 'Addr', TRUE) RETURNING id",
    [`DB${rand}`]
  );
  const propertyA = Number(propA.rows[0].id);
  const propertyB = Number(propB.rows[0].id);
  const tracked = { transactions: [], suppliers: [], departments: [] };

  const deptA = await pool.query(
    `INSERT INTO hr_departments (property_id, code, name, is_active, sort_order)
     VALUES ($1, 'FB', 'F&B / Restoran', TRUE, 1) RETURNING id, name`,
    [propertyA]
  );
  const deptB = await pool.query(
    `INSERT INTO hr_departments (property_id, code, name, is_active, sort_order)
     VALUES ($1, 'FB', 'F&B B', TRUE, 1) RETURNING id`,
    [propertyB]
  );
  tracked.departments.push(Number(deptA.rows[0].id), Number(deptB.rows[0].id));

  const app = express();
  app.use(express.json());
  app.use('/api/transactions', createTransactionsRouter(pool));
  app.use('/api/settings/purchases', createPurchaseSettingsRouter(pool));
  const { server, port } = await listen(app);

  try {
    const supplierA = await createSupplier(pool, { property_id: propertyA, name: 'Puga', actor_name: 'Tester' });
    tracked.suppliers.push(Number(supplierA.id));

    const settingsGet = matchOperationalAccessRule('/api/settings/purchases/field-rules', 'GET');
    expect(settingsGet && settingsGet.resources.includes('Pengaturan') && settingsGet.action === 'view', 'G. GET field-rules is Pengaturan view');
    const settingsPut = matchOperationalAccessRule('/api/settings/purchases/field-rules', 'PUT');
    expect(settingsPut && settingsPut.resources.includes('Pengaturan') && settingsPut.action === 'edit', 'G. PUT field-rules is Pengaturan edit');
    const formRead = matchOperationalAccessRule('/api/transactions/purchases/form-options', 'GET');
    expect(formRead && formRead.resources.includes('Transaksi') && formRead.action === 'view', 'form-options remains Transaksi view');

    const defaults = await getEffectivePurchaseFieldPolicy(pool, propertyA);
    expect(defaults.modes.supplier === 'REQUIRED', 'A/I. default supplier REQUIRED');
    expect(defaults.modes.category === 'REQUIRED', 'A/I. default category REQUIRED');
    expect(defaults.modes.department === 'OPTIONAL', 'A/I. default department OPTIONAL');
    expect(defaults.modes.invoice_reference === 'OPTIONAL', 'A/I. default invoice OPTIONAL');
    expect(defaults.modes.receipt_attachment === 'OPTIONAL', 'A/I. default receipt OPTIONAL');
    expect(defaults.default_purchase_category_id == null, 'A. no default category row');
    expect(defaults.fields.some((row) => row.field_key === 'category' && row.allowed_modes.join(',') === 'REQUIRED,HIDDEN'), 'A. category restricted modes');
    expect(defaults.fields.some((row) => row.field_key === 'line_unit' && row.allowed_modes.join(',') === 'REQUIRED'), 'A. line_unit settings offer REQUIRED only');
    expect(defaults.fields.some((row) => row.field_key === 'payment_method' && row.allowed_modes.join(',') === 'REQUIRED,HIDDEN'), 'payment_method settings modes');
    expect(defaults.fields.some((row) => row.field_key === 'paid_amount' && row.allowed_modes.join(',') === 'REQUIRED,OPTIONAL'), 'paid_amount settings modes');

    const formOpts = await getPurchaseFormOptions(pool, propertyA);
    expect(Boolean(formOpts.field_policy), 'form-options includes field_policy');
    expect(formOpts.field_policy.modes.category === 'REQUIRED', 'form-options default category REQUIRED');
    const systemCat = formOpts.categories.find((row) => row.code === 'FNB_INGREDIENTS_PURCHASE');
    expect(Boolean(systemCat), 'system purchase category seeded');

    const requiredSave = await savePurchaseFieldRules(pool, propertyA, {
      rules: { supplier: 'REQUIRED', notes: 'REQUIRED' },
      actor_name: 'Purchasing',
    });
    expect(requiredSave.modes.notes === 'REQUIRED', 'B. save REQUIRED notes');

    const optionalSave = await savePurchaseFieldRules(pool, propertyA, {
      rules: { notes: 'OPTIONAL', department: 'OPTIONAL' },
      actor_name: 'Purchasing',
    });
    expect(optionalSave.modes.notes === 'OPTIONAL', 'C. save OPTIONAL notes');

    await expectReject(
      () => savePurchaseFieldRules(pool, propertyA, { rules: { category: 'OPTIONAL' } }),
      /tidak diizinkan/,
      'E. category OPTIONAL rejected'
    );
    await expectReject(
      () => savePurchaseFieldRules(pool, propertyA, { rules: { receipt_attachment: 'REQUIRED' } }),
      /Lampiran Wajib/,
      'AK. receipt REQUIRED blocked'
    );
    await expectReject(
      () => savePurchaseFieldRules(pool, propertyA, { rules: { payment_evidence: 'REQUIRED' } }),
      /Lampiran Wajib/,
      'AK. payment_evidence REQUIRED blocked'
    );
    await expectReject(
      () => savePurchaseFieldRules(pool, propertyA, { rules: { line_unit: 'HIDDEN' } }),
      /Satuan item harus Wajib/,
      'A. line_unit HIDDEN settings save rejected'
    );
    await expectReject(
      () => savePurchaseFieldRules(pool, propertyA, { rules: { line_unit: 'OPTIONAL' } }),
      /Satuan item harus Wajib/,
      'B. line_unit OPTIONAL settings save rejected'
    );
    await expectReject(
      () => savePurchaseFieldRules(pool, propertyA, {
        rules: { payment_status: 'OPTIONAL', payment_method: 'HIDDEN' },
      }),
      /Metode pembayaran tidak boleh disembunyikan/,
      'E. visible payment + hidden method rejected'
    );
    await expectReject(
      () => savePurchaseFieldRules(pool, propertyA, {
        rules: { payment_status: 'OPTIONAL', paid_amount: 'HIDDEN' },
      }),
      /tidak diizinkan/,
      'H. visible payment + hidden paid_amount rejected'
    );
    await expectReject(
      () => savePurchaseFieldRules(pool, propertyA, {
        rules: { payment_status: 'HIDDEN', payment_method: 'HIDDEN', paid_amount: 'REQUIRED' },
      }),
      /nominal dibayar tidak boleh Wajib/,
      'hidden payment + required paid_amount rejected'
    );
    await expectReject(
      () => savePurchaseFieldRules(pool, propertyA, {
        rules: { payment_status: 'HIDDEN', payment_method: 'REQUIRED' },
      }),
      /pembayaran disembunyikan/,
      'AB. hidden payment + required method rejected'
    );
    await expectReject(
      () => savePurchaseFieldRules(pool, propertyA, { rules: { category: 'HIDDEN' } }),
      /kategori pembelian default/,
      'O. HIDDEN category without default rejected'
    );

    const formOptsB = await getPurchaseFormOptions(pool, propertyB);
    const catB = formOptsB.categories.find((row) => row.code === 'SUPPLIES_PURCHASE');
    expect(Boolean(catB), 'property B seeded');
    await expectReject(
      () => savePurchaseFieldRules(pool, propertyA, {
        rules: { category: 'HIDDEN' },
        default_purchase_category_id: Number(catB.id),
      }),
      /bukan milik properti/,
      'P. cross-property default rejected'
    );

    const hiddenOk = await savePurchaseFieldRules(pool, propertyA, {
      rules: {
        supplier: 'HIDDEN',
        category: 'HIDDEN',
        department: 'HIDDEN',
        invoice_reference: 'HIDDEN',
        notes: 'HIDDEN',
        receiving_status: 'HIDDEN',
        payment_status: 'HIDDEN',
        payment_method: 'HIDDEN',
        paid_amount: 'OPTIONAL',
        receipt_attachment: 'HIDDEN',
        payment_evidence: 'HIDDEN',
        transaction_discount: 'HIDDEN',
        line_unit: 'REQUIRED',
        line_discount: 'HIDDEN',
      },
      default_purchase_category_id: systemCat.id,
      actor_name: 'Purchasing',
    });
    expect(hiddenOk.modes.category === 'HIDDEN', 'D. save HIDDEN category');
    expect(Number(hiddenOk.default_purchase_category_id) === Number(systemCat.id), 'N. default category stored');

    const sneaky = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      purchase_category_id: formOpts.categories.find((row) => row.code === 'OTHER_PURCHASE').id,
      category_code: 'ROOM_SALES',
      category_name: 'Engineering',
      department_id: Number(deptA.rows[0].id),
      supplier_id: supplierA.id,
      source_reference: 'INV-SNEAK',
      notes: 'should ignore',
      receiving_status: 'DITERIMA',
      is_immediately_paid: true,
      payment_method: 'TRANSFER',
      paid_amount: 10000,
      discount_amount: 2000,
      lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'karung', unit_price: 10000, discount_amount: 1500 }],
      actor_name: 'Purchasing',
    });
    tracked.transactions.push(sneaky.id);
    expect(sneaky.supplier_id == null, 'L. HIDDEN ignores supplier');
    expect(String(sneaky.description) === 'Pembelian Beras', 'L. summary without fake supplier');
    expect(Number(sneaky.purchase_category_id) === Number(systemCat.id), 'N/R. HIDDEN uses property default, not client');
    expect(String(sneaky.category_code) === 'FNB_INGREDIENTS_PURCHASE', 'R. default snapshot code');
    expect(sneaky.department_id == null, 'U. HIDDEN ignores department');
    expect(sneaky.source_reference == null, 'V. HIDDEN invoice ignored');
    expect(sneaky.notes == null, 'V. HIDDEN notes ignored');
    expect(String(sneaky.receiving_status) === 'BELUM_DITERIMA', 'X. HIDDEN receiving default');
    expect(String(sneaky.payment_status) === 'UNPAID', 'J. hidden payment defaults unpaid');
    expect(Number(sneaky.discount_amount || 0) === 0, 'AE. hidden transaction discount 0');
    expect(Number(sneaky.lines[0].discount_amount || 0) === 0, 'AF. hidden line discount 0');
    expect(String(sneaky.lines[0].unit) === 'karung', 'D. explicit unit persists; no automatic pcs');
    expect(String(sneaky.lines[0].unit) !== 'pcs', 'D. no automatic pcs');
    const payRows = await pool.query(`SELECT transaction_type FROM payment_transactions WHERE transaction_id = $1`, [sneaky.id]);
    expect(payRows.rows.length === 0, 'K. hidden payment creates no settlement');

    await savePurchaseFieldRules(pool, propertyA, {
      rules: { ...DEFAULT_PURCHASE_FIELD_MODES },
      default_purchase_category_id: systemCat.id,
      actor_name: 'Purchasing',
    });

    const hist = await getTransactionById(pool, propertyA, sneaky.id);
    expect(hist.supplier_id == null, 'AQ. history supplier unchanged after rule restore');
    expect(Number(hist.purchase_category_id) === Number(systemCat.id), 'AQ. history category unchanged');
    expect(String(hist.receiving_status) === 'BELUM_DITERIMA', 'AQ. history receiving unchanged');

    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        supplier_id: supplierA.id,
        lines: [baseLine()],
      }),
      /Kategori pembelian wajib dipilih/,
      'M. REQUIRED category rejects missing'
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: systemCat.id,
        lines: [baseLine()],
      }),
      /Supplier/,
      'J. REQUIRED supplier rejects missing'
    );

    await savePurchaseFieldRules(pool, propertyA, {
      rules: { supplier: 'OPTIONAL', department: 'OPTIONAL', invoice_reference: 'OPTIONAL', notes: 'OPTIONAL' },
      actor_name: 'Purchasing',
    });
    const optionalTx = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      purchase_category_id: systemCat.id,
      lines: [baseLine()],
      actor_name: 'Purchasing',
    });
    tracked.transactions.push(optionalTx.id);
    expect(optionalTx.supplier_id == null, 'K. OPTIONAL supplier blank allowed');
    expect(optionalTx.department_id == null, 'T. OPTIONAL department blank allowed');
    expect(Number(optionalTx.discount_amount || 0) === 0, 'AG. optional blank discount 0');

    await savePurchaseFieldRules(pool, propertyA, {
      rules: { department: 'REQUIRED', invoice_reference: 'REQUIRED', notes: 'REQUIRED', receiving_status: 'REQUIRED' },
      actor_name: 'Purchasing',
    });
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: systemCat.id,
        supplier_id: supplierA.id,
        lines: [baseLine()],
      }),
      /Departemen alokasi wajib/,
      'S. REQUIRED department rejects missing'
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: systemCat.id,
        supplier_id: supplierA.id,
        department_id: Number(deptA.rows[0].id),
        lines: [baseLine()],
      }),
      /faktur/,
      'V. REQUIRED invoice rejects blank'
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: systemCat.id,
        supplier_id: supplierA.id,
        department_id: Number(deptA.rows[0].id),
        source_reference: 'INV-1',
        lines: [baseLine()],
      }),
      /Catatan/,
      'V. REQUIRED notes rejects blank'
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: systemCat.id,
        supplier_id: supplierA.id,
        department_id: Number(deptA.rows[0].id),
        source_reference: 'INV-1',
        notes: 'Catatan',
        lines: [baseLine()],
      }),
      /penerimaan wajib/,
      'W. REQUIRED receiving rejects missing'
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: systemCat.id,
        supplier_id: supplierA.id,
        department_id: Number(deptA.rows[0].id),
        source_reference: 'INV-1',
        notes: 'Catatan',
        receiving_status: 'NOT_A_STATUS',
        lines: [baseLine()],
      }),
      /tidak valid/,
      'Y. invalid receiving enum rejected'
    );

    await savePurchaseFieldRules(pool, propertyA, {
      rules: {
        department: 'OPTIONAL',
        invoice_reference: 'OPTIONAL',
        notes: 'OPTIONAL',
        receiving_status: 'OPTIONAL',
        payment_status: 'OPTIONAL',
        payment_method: 'REQUIRED',
        paid_amount: 'REQUIRED',
        transaction_discount: 'OPTIONAL',
        line_discount: 'OPTIONAL',
      },
      actor_name: 'Purchasing',
    });
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: systemCat.id,
        supplier_id: supplierA.id,
        is_immediately_paid: true,
        lines: [baseLine()],
      }),
      /Metode pembayaran wajib/,
      'F. pay-now requires method'
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: systemCat.id,
        supplier_id: supplierA.id,
        lines: [{ description_snapshot: 'Beras', quantity: 1, unit: '', unit_price: 10000 }],
      }),
      /Satuan wajib/,
      'C. create rejects missing line unit'
    );
    const paid = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      purchase_category_id: systemCat.id,
      supplier_id: supplierA.id,
      is_immediately_paid: true,
      payment_method: 'TRANSFER',
      paid_amount: 10000,
      lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      actor_name: 'Purchasing',
    });
    tracked.transactions.push(paid.id);
    expect(String(paid.payment_status) === 'PAID', 'AA. pay-now settles');
    expect(String(paid.party_name || '').includes('Puga') || String(paid.supplier_id) === String(supplierA.id), 'L. Puga/Beras supplier');
    expect(String(paid.lines[0].unit) === 'kg', 'L. Beras unit kg persists');
    expect(String(paid.payment_method) === 'TRANSFER', 'M. explicit TRANSFER persists on header');
    expect(Number(paid.paid_amount) === 10000, 'N. explicit paid amount persists');
    const paidPays = await pool.query(
      `SELECT transaction_type, payment_method, amount FROM payment_transactions WHERE transaction_id = $1`,
      [paid.id]
    );
    expect(paidPays.rows.length === 1 && paidPays.rows[0].transaction_type === 'PAYMENT', 'O. settlement-only PAYMENT');
    expect(String(paidPays.rows[0].payment_method) === 'TRANSFER', 'M. explicit TRANSFER persists on PAYMENT');
    expect(Number(paidPays.rows[0].amount) === 10000, 'N. PAYMENT amount matches');
    const dupTypes = await pool.query(
      `SELECT transaction_type FROM transactions WHERE id = $1`,
      [paid.id]
    );
    expect(dupTypes.rows.length === 1 && dupTypes.rows[0].transaction_type === 'PURCHASE', 'O. no duplicate PURCHASE/EXPENSE header');
    expect(String(paid.payment_method) !== 'CASH', 'G. no automatic CASH');

    await pool.query(
      `UPDATE property_purchase_field_rules SET field_mode = 'HIDDEN' WHERE property_id = $1 AND field_key = 'paid_amount'`,
      [propertyA]
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        purchase_category_id: systemCat.id,
        supplier_id: supplierA.id,
        is_immediately_paid: true,
        payment_method: 'TRANSFER',
        lines: [baseLine()],
      }),
      /Nominal dibayar wajib/,
      'I. stale hidden paid_amount cannot auto-create full settlement'
    );
    await pool.query(
      `UPDATE property_purchase_field_rules SET field_mode = 'OPTIONAL' WHERE property_id = $1 AND field_key = 'paid_amount'`,
      [propertyA]
    );

    await pool.query(
      `UPDATE transaction_custom_categories SET is_active = FALSE WHERE id = $1`,
      [systemCat.id]
    );
    await savePurchaseFieldRules(pool, propertyA, {
      rules: { ...DEFAULT_PURCHASE_FIELD_MODES, category: 'HIDDEN' },
      default_purchase_category_id: systemCat.id,
    }).then(
      () => { throw new Error('Q. expected inactive default rejected on save'); },
      (err) => expect(/tidak aktif/.test(String(err.message || '')), `Q. inactive default rejected: ${err.message}`)
    );
    await pool.query(
      `UPDATE transaction_custom_categories SET is_active = TRUE WHERE id = $1`,
      [systemCat.id]
    );

    const saToken = await getPlatformSuperAdminToken(pool, propertyA);
    const staffB = staffToken(propertyB, 900341);
    const getA = await requestJson(port, 'GET', `/api/settings/purchases/field-rules?property_id=${propertyA}`, saToken);
    expect(getA.status === 200, `H. Super Admin GET A ${getA.status}`);
    expect(Boolean(getA.json && getA.json.data && getA.json.data.modes), 'H. SA sees modes');
    expect(getA.json.data.property_id === propertyA, 'H. SA scoped to requested property');
    const getB = await requestJson(port, 'GET', `/api/settings/purchases/field-rules?property_id=${propertyB}`, saToken);
    expect(getB.status === 200, `H. Super Admin GET B ${getB.status}`);

    const anon = await requestJson(port, 'GET', `/api/settings/purchases/field-rules?property_id=${propertyA}`, null);
    expect(anon.status === 401, 'settings require auth');

    const cross = await requestJson(port, 'PUT', `/api/settings/purchases/field-rules?property_id=${propertyA}`, staffB, {
      property_id: propertyA,
      rules: { notes: 'HIDDEN' },
    });
    expect(cross.status === 403, `F. cross-property settings 403 got ${cross.status}`);

    const formHttp = await requestJson(port, 'GET', `/api/transactions/purchases/form-options?property_id=${propertyA}`, saToken);
    expect(formHttp.status === 200, 'form-options HTTP 200');
    expect(formHttp.json && formHttp.json.data && formHttp.json.data.field_policy, 'form-options HTTP field_policy');

    console.log(`PASS | PURCHASE-1D field policy | ${assertions} assertions`);
  } finally {
    server.close();
    try {
      if (tracked.transactions.length) {
        await pool.query('DELETE FROM payment_transactions WHERE transaction_id = ANY($1::bigint[])', [tracked.transactions]);
        await pool.query('DELETE FROM transaction_lines WHERE transaction_id = ANY($1::bigint[])', [tracked.transactions]);
        await pool.query('DELETE FROM transactions WHERE id = ANY($1::bigint[])', [tracked.transactions]);
      }
      await pool.query('DELETE FROM property_purchase_field_rules WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]);
      await pool.query('DELETE FROM property_purchase_settings WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]);
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
      console.warn('PURCHASE-1D cleanup warning', cleanupErr.message);
    }
  }
}

run().catch((err) => {
  console.error('PURCHASE-1D FAILED', err);
  process.exit(1);
});
