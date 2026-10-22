'use strict';

/**
 * Frontend Contract & UI Helper Tests — Master Produk Tahap 1
 *
 * Mengompilasi dan menguji langsung modul produksi:
 *  - frontend/src/features/products/ProductMasterPage.tsx
 *  - frontend/src/features/pos/PosWorkspace.tsx
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

function compileAndLoad(relPath, mocks = {}) {
  const fullPath = path.resolve(__dirname, '..', relPath);
  const src = fs.readFileSync(fullPath, 'utf8');
  const transpiled = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: path.basename(fullPath),
  }).outputText;

  const mod = { exports: {} };
  vm.runInNewContext(
    transpiled,
    {
      module: mod,
      exports: mod.exports,
      require: (name) => {
        if (name in mocks) return mocks[name];
        if (name === 'react' || name === 'react/jsx-runtime') {
          return {
            useState: (v) => [v, () => {}],
            useMemo: (fn) => fn(),
            useEffect: () => {},
            useRef: (v) => ({ current: v }),
            useCallback: (fn) => fn,
            jsx: () => null,
            jsxs: () => null,
            Fragment: 'Fragment',
          };
        }
        return {};
      },
      console,
      Intl,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Math,
      Set,
      Map,
    },
    { timeout: 3000 }
  );
  return mod.exports;
}

const PM = compileAndLoad('src/features/products/ProductMasterPage.tsx');
const PW = compileAndLoad('src/features/pos/PosWorkspace.tsx');

console.log('=== Master Produk Tahap 1 — Frontend UI & POS Catalog Guard Tests ===\n');

// 1. Label Klasifikasi & Satuan Dasar ("Belum diatur" untuk data existing yang belum diatur)
assert.equal(PM.formatProductTypeLabel('FINISHED_GOOD'), 'Produk Jadi');
assert.equal(PM.formatProductTypeLabel('SEMI_FINISHED'), 'Setengah Jadi');
assert.equal(PM.formatProductTypeLabel('RAW_MATERIAL'), 'Bahan Baku');
assert.equal(PM.formatProductTypeLabel(null), 'Belum diatur');
assert.equal(PM.formatProductTypeLabel(undefined), 'Belum diatur');

assert.equal(PM.formatProductKindLabel('STANDARD'), 'Biasa');
assert.equal(PM.formatProductKindLabel('WEIGHED'), 'Timbangan');
assert.equal(PM.formatProductKindLabel('UNLIMITED'), 'Unlimited');
assert.equal(PM.formatProductKindLabel('SERVICE'), 'Jasa');
assert.equal(PM.formatProductKindLabel('BUNDLE'), 'Bundle');
assert.equal(PM.formatProductKindLabel('FORMULA'), 'Formula');
assert.equal(PM.formatProductKindLabel(null), 'Belum diatur');
assert.equal(PM.formatProductKindLabel(undefined), 'Belum diatur');

assert.equal(PM.formatBaseUnitLabel('porsi'), 'porsi');
assert.equal(PM.formatBaseUnitLabel('  kg  '), 'kg');
assert.equal(PM.formatBaseUnitLabel(null), 'Belum diatur');
assert.equal(PM.formatBaseUnitLabel(''), 'Belum diatur');
console.log('  PASS  U1: Label klasifikasi, jenis operasional, dan satuan dasar ("Belum diatur" untuk NULL)');

// 2. Tampilan Harga Jual vs Harga Kosong (null tidak boleh ditampilkan "gratis" atau Rp 0)
const nullPrice = PM.formatSellingPriceDisplay(null);
assert.equal(nullPrice.text, 'Belum diatur');
assert.equal(nullPrice.isUnset, true);

const undefPrice = PM.formatSellingPriceDisplay(undefined);
assert.equal(undefPrice.text, 'Belum diatur');
assert.equal(undefPrice.isUnset, true);

const emptyPrice = PM.formatSellingPriceDisplay('');
assert.equal(emptyPrice.text, 'Belum diatur');
assert.equal(emptyPrice.isUnset, true);

assert.ok(!nullPrice.text.toLowerCase().includes('gratis'));
assert.notEqual(nullPrice.text, 'Rp 0');

// Harga 0 eksplisit ditampilkan sebagai Rp 0
const zeroPrice = PM.formatSellingPriceDisplay(0);
assert.equal(zeroPrice.isUnset, false);
assert.match(zeroPrice.text, /^Rp\s*0$/);

const zeroStrPrice = PM.formatSellingPriceDisplay('0');
assert.equal(zeroStrPrice.isUnset, false);
assert.match(zeroStrPrice.text, /^Rp\s*0$/);

const normalPrice = PM.formatSellingPriceDisplay(25000);
assert.equal(normalPrice.isUnset, false);
assert.match(normalPrice.text, /^Rp\s*25\.000$/);
console.log('  PASS  U2: Tampilan harga membedakan null ("Belum diatur") vs 0 eksplisit ("Rp 0")');

// 3. Guard Katalog Kasir POS (isSellablePosMenuItem)
assert.equal(
  PW.isSellablePosMenuItem({ id: 1, name: 'Nasi Goreng', price: 35000 }),
  true,
  'Produk legacy tanpa field is_sellable_pos tetap kompatibel (sellable)'
);
assert.equal(
  PW.isSellablePosMenuItem({ id: 2, name: 'Air Mineral Complimentary', price: 0, is_sellable_pos: true, is_active: true }),
  true,
  'Produk jual dengan harga 0 eksplisit tetap sellable'
);
assert.equal(
  PW.isSellablePosMenuItem({ id: 3, name: 'Beras Mentah Internal', price: null, is_sellable_pos: false, is_active: true }),
  false,
  'Produk internal tanpa harga tidak boleh masuk katalog kasir POS'
);
assert.equal(
  PW.isSellablePosMenuItem({ id: 4, name: 'Kaldu Internal Berharga', price: 15000, is_sellable_pos: false, is_active: true }),
  false,
  'Produk internal (is_sellable_pos = false) meskipun punya harga tidak boleh masuk katalog kasir POS'
);
assert.equal(
  PW.isSellablePosMenuItem({ id: 5, name: 'Menu Tanpa Harga', price: null, is_sellable_pos: true, is_active: true }),
  false,
  'Produk tanpa harga valid (price = null) tidak boleh masuk katalog kasir POS'
);
assert.equal(
  PW.isSellablePosMenuItem({ id: 6, name: 'Menu Nonaktif', price: 20000, is_sellable_pos: true, is_active: false }),
  false,
  'Produk nonaktif tidak boleh masuk katalog kasir POS'
);
console.log('  PASS  U3: Guard katalog kasir POS (isSellablePosMenuItem) menolak produk internal & tanpa harga');

// 4. Verifikasi source ProductMasterPage.tsx menggunakan scope=master & tidak memalsukan stok/HPP
const pmSource = fs.readFileSync(path.resolve(__dirname, '../src/features/products/ProductMasterPage.tsx'), 'utf8');
assert.ok(pmSource.includes('scope=master'), 'ProductMasterPage wajib memanggil GET /api/pos/menu dengan scope=master');
assert.ok(pmSource.includes('Belum diatur'), 'ProductMasterPage wajib menampilkan "Belum diatur" untuk atribut kosong');
assert.ok(pmSource.includes('Timbangan (Roadmap)'), 'Opsi roadmap Timbangan harus tampil sebagai Roadmap (disabled)');
console.log('  PASS  U4: Kontrak query scope=master, roadmap options, dan label di ProductMasterPage.tsx terverifikasi');

// 5. MP-02A: Preselect tipe produk dari tab aktif (tanpa menebak pada Semua Tipe / Belum diatur)
assert.equal(PM.resolveInitialProductTypeFromTab('FINISHED_GOOD'), 'FINISHED_GOOD');
assert.equal(PM.resolveInitialProductTypeFromTab('SEMI_FINISHED'), 'SEMI_FINISHED');
assert.equal(PM.resolveInitialProductTypeFromTab('RAW_MATERIAL'), 'RAW_MATERIAL');
assert.equal(PM.resolveInitialProductTypeFromTab('ALL'), '');
assert.equal(PM.resolveInitialProductTypeFromTab('UNSET'), '');

assert.equal(PM.createInitialAddProductForm('FINISHED_GOOD').productType, 'FINISHED_GOOD');
assert.equal(PM.createInitialAddProductForm('SEMI_FINISHED').productType, 'SEMI_FINISHED');
assert.equal(PM.createInitialAddProductForm('RAW_MATERIAL').productType, 'RAW_MATERIAL');
assert.equal(PM.createInitialAddProductForm('ALL').productType, '');
assert.equal(PM.createInitialAddProductForm('UNSET').productType, '');
console.log('  PASS  U5: Preselect tipe awal mengikuti tab aktif dan tidak menebak pada Semua Tipe / Belum diatur');

// 6. MP-02A: Pilihan 3 tipe, pergantian tipe tidak mereset field lain, dan edit mempertahankan klasifikasi kosong
assert.equal(Array.isArray(PM.PRODUCT_TYPE_CHOICES), true);
assert.deepEqual(
  Array.from(PM.PRODUCT_TYPE_CHOICES, (c) => ({ value: c.value, label: c.label })),
  [
    { value: 'FINISHED_GOOD', label: 'Produk Jadi' },
    { value: 'SEMI_FINISHED', label: 'Setengah Jadi' },
    { value: 'RAW_MATERIAL', label: 'Bahan Baku' },
  ]
);

const typedDraft = {
  code: 'SKU-777',
  name: 'Kaldu Ayam Kampung',
  category: '3',
  price: '25000',
  description: 'Kaldu dasar dapur utama',
  productType: 'FINISHED_GOOD',
  productKind: 'STANDARD',
  baseUnit: 'Liter',
  isSellablePos: false,
};
const switchedToRaw = PM.applyProductTypeChange(typedDraft, 'RAW_MATERIAL');
assert.equal(switchedToRaw.productType, 'RAW_MATERIAL');
assert.equal(switchedToRaw.code, 'SKU-777');
assert.equal(switchedToRaw.name, 'Kaldu Ayam Kampung');
assert.equal(switchedToRaw.category, '3');
assert.equal(switchedToRaw.price, '25000');
assert.equal(switchedToRaw.description, 'Kaldu dasar dapur utama');
assert.equal(switchedToRaw.productKind, 'STANDARD');
assert.equal(switchedToRaw.baseUnit, 'Liter');
assert.equal(switchedToRaw.isSellablePos, false);

const switchedToUnset = PM.applyProductTypeChange(switchedToRaw, '');
assert.equal(switchedToUnset.productType, '');
assert.equal(switchedToUnset.name, 'Kaldu Ayam Kampung');
assert.equal(switchedToUnset.code, 'SKU-777');

const legacyUnsetItem = {
  id: 91,
  item_code: null,
  name: 'Menu Lama Tanpa Klasifikasi',
  category_id: 2,
  price: 30000,
  description: null,
  product_type: null,
  product_kind: null,
  base_unit: null,
  is_sellable_pos: true,
};
const editLegacyForm = PM.buildEditProductForm(legacyUnsetItem);
assert.equal(editLegacyForm.productType, '', 'Produk existing tanpa tipe wajib tetap kosong (Belum diatur)');
assert.equal(editLegacyForm.productKind, '', 'Produk existing tanpa jenis wajib tetap kosong (Belum diatur)');
assert.equal(editLegacyForm.baseUnit, '', 'Produk existing tanpa satuan wajib tetap kosong');
assert.equal(editLegacyForm.name, 'Menu Lama Tanpa Klasifikasi');
assert.equal(editLegacyForm.category, '2');
assert.equal(editLegacyForm.price, '30000');
assert.equal(editLegacyForm.isSellablePos, true);
console.log('  PASS  U6: Pilihan 3 tipe jelas, ganti tipe tidak menghapus field lain, & klasifikasi kosong existing terjaga');

// 7. MP-02A: Harness komponen untuk menguji tombol + melayang, permission, urutan field,
//    collapsible opsional tanpa kehilangan nilai saat submit, fokus nama, serta istilah non-POS
(async () => {
  function createHarness({ canCreate = true, canEdit = true } = {}) {
    const states = [];
    const refs = [];
    const effects = [];
    const fetchCalls = [];
    let customFetchHandler = null;
    let stateCursor = 0;
    let refCursor = 0;

    const reactMock = {
      useState: (init) => {
        const idx = stateCursor++;
        if (!(idx in states)) {
          states[idx] = typeof init === 'function' ? init() : init;
        }
        const setState = (val) => {
          states[idx] = typeof val === 'function' ? val(states[idx]) : val;
        };
        return [states[idx], setState];
      },
      useRef: (init) => {
        const idx = refCursor++;
        if (!(idx in refs)) {
          refs[idx] = { current: init };
        }
        return refs[idx];
      },
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useEffect: (fn, deps) => {
        effects.push({ fn, deps });
      },
      jsx: (type, props, key) => ({ type, props: props || {}, key }),
      jsxs: (type, props, key) => ({ type, props: props || {}, key }),
      Fragment: 'Fragment',
    };

    const mod = compileAndLoad('src/features/products/ProductMasterPage.tsx', {
      react: reactMock,
      'react/jsx-runtime': reactMock,
      '../auth/AuthContext': {
        useAuth: () => ({
          effectiveAccess: { role: canCreate ? 'SUPER_ADMIN' : 'FO', permissions: [] },
          granularPermissions: [],
          hasGranularPermission: () => false,
        }),
      },
      './productMasterPermissions': {
        getMasterProductCapabilities: () => ({
          canView: true,
          canCreate,
          canEdit,
          canToggleStatus: canEdit,
          canManageCategory: canCreate,
          canDeleteCategory: canCreate,
        }),
      },
      '../../lib/authenticatedFetch': {
        authenticatedFetch: async (url, options = {}) => {
          fetchCalls.push({ url, options });
          if (customFetchHandler) {
            const customRes = await customFetchHandler(url, options);
            if (customRes !== undefined) return customRes;
          }
          return {
            ok: true,
            json: async () => ({
              data: {
                items: [
                  {
                    id: 101,
                    item_code: 'RAW-01',
                    name: 'Biji Kopi Arabika',
                    category_id: 1,
                    category_name: 'Minuman',
                    price: null,
                    is_active: true,
                    is_sellable_pos: false,
                    product_type: null,
                    product_kind: null,
                    base_unit: 'Kg',
                    description: 'Biji kopi house blend',
                  },
                ],
                categories: [{ id: 1, name: 'Minuman' }],
              },
            }),
          };
        },
      },
    });

    function render(props = { propertyId: 1, items: [] }) {
      stateCursor = 0;
      refCursor = 0;
      effects.length = 0;
      return mod.default(props);
    }

    return {
      render,
      effects,
      fetchCalls,
      refs,
      setFetchHandler: (fn) => {
        customFetchHandler = fn;
      },
    };
  }

  function findAllNodes(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      for (const item of node) findAllNodes(item, predicate, out);
      return out;
    }
    if (predicate(node)) out.push(node);
    const children = node.props && node.props.children;
    if (children !== undefined) findAllNodes(children, predicate, out);
    return out;
  }

  function collectText(node, out = []) {
    if (node === null || node === undefined || typeof node === 'boolean') return out;
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node));
      return out;
    }
    if (Array.isArray(node)) {
      for (const item of node) collectText(item, out);
      return out;
    }
    if (typeof node === 'object' && node.props && node.props.children !== undefined) {
      collectText(node.props.children, out);
    }
    return out;
  }

  // 7a. Permission tambah = false -> tombol + melayang tidak muncul
  const readOnlyHarness = createHarness({ canCreate: false, canEdit: false });
  const readOnlyTree = readOnlyHarness.render({ propertyId: 1, items: [] });
  const readOnlyAddBtns = findAllNodes(
    readOnlyTree,
    (n) => n.type === 'button' && n.props && n.props['aria-label'] === 'Tambah produk'
  );
  assert.equal(readOnlyAddBtns.length, 0, 'Tombol + melayang tidak boleh tampil bila user tidak punya permission tambah');

  // 7b. Permission tambah = true -> tombol + melayang tampil di kanan bawah & tidak ada tombol Tambah Produk di header
  const adminHarness = createHarness({ canCreate: true, canEdit: true });
  let tree = adminHarness.render({
    propertyId: 1,
    items: [
      {
        id: 101,
        item_code: 'RAW-01',
        name: 'Biji Kopi Arabika',
        category_id: 1,
        category_name: 'Minuman',
        price: null,
        is_active: true,
        is_sellable_pos: false,
        product_type: null,
        product_kind: null,
        base_unit: 'Kg',
        description: 'Biji kopi house blend',
      },
    ],
  });

  // Pastikan container utama memiliki ruang bawah agar floating button tidak menutupi aksi terakhir
  assert.match(tree.props.className || '', /pb-24/);

  const headerTambahBtns = findAllNodes(
    tree,
    (n) => n.type === 'button' && collectText(n).join(' ').includes('Tambah Produk')
  );
  assert.equal(headerTambahBtns.length, 0, 'Tombol Tambah Produk lama di header harus sudah diganti');

  const fabBtns = findAllNodes(
    tree,
    (n) => n.type === 'button' && n.props && n.props['aria-label'] === 'Tambah produk'
  );
  assert.equal(fabBtns.length, 1, 'Tombol + melayang harus ada tepat 1 dengan aria-label="Tambah produk"');
  assert.match(fabBtns[0].props.className || '', /fixed/);
  assert.match(fabBtns[0].props.className || '', /bottom-6/);
  assert.match(fabBtns[0].props.className || '', /right-6/);

  // 7c. Istilah UI: tidak menyamakan Non-POS dengan "Internal"
  const pageText = collectText(tree).join(' ');
  assert.ok(pageText.includes('Produk non-POS'), 'Kartu KPI harus menampilkan "Produk non-POS"');
  assert.ok(pageText.includes('Tidak dijual di POS'), 'Filter dan badge tabel harus menampilkan "Tidak dijual di POS"');
  assert.ok(!pageText.includes('Internal (Non-POS)'), 'Tidak boleh lagi menampilkan "Internal (Non-POS)"');
  assert.ok(!pmSource.includes("'Ya (POS)' : 'Internal'"), 'Badge tabel tidak boleh lagi menampilkan "Internal"');
  assert.equal(PM.formatPosSellabilityBadge(false), 'Tidak dijual di POS');
  assert.equal(PM.formatPosSellabilityBadge(true), 'Dijual di POS');

  // 7d. Klik tab "Bahan Baku" lalu klik tombol + -> modal tambah terbuka dengan tipe RAW_MATERIAL
  const rawTabBtn = findAllNodes(
    tree,
    (n) => n.type === 'button' && collectText(n).join(' ').includes('Bahan Baku')
  )[0];
  assert.ok(rawTabBtn, 'Tab Bahan Baku harus ditemukan');
  rawTabBtn.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });

  const fabAfterTab = findAllNodes(
    tree,
    (n) => n.type === 'button' && n.props && n.props['aria-label'] === 'Tambah produk'
  )[0];
  fabAfterTab.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });

  // Input Nama Produk di modal tambah harus autoFocus
  const addForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  assert.ok(addForm, 'Form modal tambah harus terbuka setelah klik tombol +');
  const addNameInput = findAllNodes(
    addForm,
    (n) => n.type === 'input' && n.props && n.props.required === true && n.props.type === 'text'
  )[0];
  assert.ok(addNameInput, 'Input Nama Produk harus ditemukan');
  assert.equal(addNameInput.props.autoFocus, true, 'Input Nama Produk wajib mendapat autoFocus saat modal tambah dibuka');

  // Verifikasi urutan label form inti di modal tambah:
  // Nama Produk -> Kategori -> Tipe Produk -> Jenis Produk -> Satuan Dasar -> Dijual di POS -> Harga Jual (IDR)
  const addFormText = collectText(addForm).join(' | ');
  const idxNama = addFormText.indexOf('Nama Produk');
  const idxKategori = addFormText.indexOf('Kategori');
  const idxTipe = addFormText.indexOf('Tipe Produk');
  const idxSatuan = addFormText.indexOf('Satuan Dasar');
  const idxPos = addFormText.indexOf('Dijual di POS');
  const idxHarga = addFormText.indexOf('Harga Jual (IDR)');
  const idxOpsional = addFormText.indexOf('Detail Opsional');
  assert.ok(
    idxNama >= 0 &&
      idxNama < idxKategori &&
      idxKategori < idxTipe &&
      idxTipe < idxSatuan &&
      idxSatuan < idxPos &&
      idxPos < idxHarga &&
      idxHarga < idxOpsional,
    `Urutan field form inti tidak sesuai: ${JSON.stringify({ idxNama, idxKategori, idxTipe, idxSatuan, idxPos, idxHarga, idxOpsional })}`
  );

  // Pastikan tombol tipe "Bahan Baku" sedang terpilih (aria-pressed=true) karena dibuka dari tab Bahan Baku
  const rawChoiceBtn = findAllNodes(
    addForm,
    (n) => n.type === 'button' && n.props['aria-pressed'] !== undefined && collectText(n).join(' ').includes('Bahan Baku')
  )[0];
  assert.ok(rawChoiceBtn, 'Tombol pilihan tipe Bahan Baku di modal harus ada');
  assert.equal(rawChoiceBtn.props['aria-pressed'], true, 'Tipe Bahan Baku harus otomatis terpilih mengikuti tab aktif');

  // 7e. Buka bagian opsional, isi SKU & Deskripsi, tutup kembali bagian opsional, ganti tipe, lalu submit:
  //     Nilai SKU & Deskripsi tidak boleh hilang!
  addNameInput.props.onChange({ target: { value: 'Sirup Vanilla House' } });
  tree = adminHarness.render({ propertyId: 1, items: [] });

  let currentForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  const priceInput = findAllNodes(currentForm, (n) => n.type === 'input' && n.props.type === 'number')[0];
  priceInput.props.onChange({ target: { value: '18000' } });
  tree = adminHarness.render({ propertyId: 1, items: [] });

  currentForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  const toggleOptionalBtn = findAllNodes(
    currentForm,
    (n) => n.type === 'button' && n.props['aria-expanded'] !== undefined
  )[0];
  assert.equal(toggleOptionalBtn.props['aria-expanded'], false, 'Bagian opsional tambah awalnya tertutup');
  toggleOptionalBtn.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });

  currentForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  const skuInput = findAllNodes(
    currentForm,
    (n) => n.type === 'input' && typeof n.props.placeholder === 'string' && n.props.placeholder.includes('FNB-001')
  )[0];
  const descTextarea = findAllNodes(currentForm, (n) => n.type === 'textarea')[0];
  assert.ok(skuInput && descTextarea, 'Input SKU dan Deskripsi harus tampil saat bagian opsional dibuka');

  skuInput.props.onChange({ target: { value: 'srp-09' } });
  tree = adminHarness.render({ propertyId: 1, items: [] });
  currentForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  const descTextarea2 = findAllNodes(currentForm, (n) => n.type === 'textarea')[0];
  descTextarea2.props.onChange({ target: { value: 'Sirup racikan barista' } });
  tree = adminHarness.render({ propertyId: 1, items: [] });

  // Tutup kembali bagian opsional
  currentForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  const toggleOptionalCloseBtn = findAllNodes(
    currentForm,
    (n) => n.type === 'button' && n.props['aria-expanded'] === true
  )[0];
  toggleOptionalCloseBtn.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });

  // Ganti tipe ke Setengah Jadi
  currentForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  const semiChoiceBtn = findAllNodes(
    currentForm,
    (n) => n.type === 'button' && n.props['aria-pressed'] !== undefined && collectText(n).join(' ').includes('Setengah Jadi')
  )[0];
  semiChoiceBtn.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });

  // Submit form tambah saat bagian opsional tertutup
  currentForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  await currentForm.props.onSubmit({ preventDefault: () => {} });

  const postCall = adminHarness.fetchCalls.find((c) => c.options && c.options.method === 'POST');
  assert.ok(postCall, 'Submit tambah produk harus memanggil POST /api/pos/menu/items');
  const postPayload = JSON.parse(postCall.options.body);
  assert.equal(postPayload.name, 'Sirup Vanilla House');
  assert.equal(postPayload.product_type, 'SEMI_FINISHED');
  assert.equal(postPayload.price, 18000);
  assert.equal(postPayload.item_code, 'SRP-09', 'Kode SKU di bagian opsional yang ditutup tetap wajib terkirim');
  assert.equal(postPayload.description, 'Sirup racikan barista', 'Deskripsi di bagian opsional yang ditutup tetap wajib terkirim');

  // 7f. Klik tab "Belum diatur", pastikan klik + tidak menebak tipe, lalu klik Edit pada produk existing
  tree = adminHarness.render({ propertyId: 1, items: [] });
  const unsetTabBtn = findAllNodes(
    tree,
    (n) => n.type === 'button' && collectText(n).join(' ').includes('Belum diatur')
  )[0];
  assert.ok(unsetTabBtn, 'Tab Belum diatur harus ditemukan');
  unsetTabBtn.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });

  const editRowBtn = findAllNodes(
    tree,
    (n) => n.type === 'button' && collectText(n).join(' ').trim() === 'Edit'
  )[0];
  assert.ok(editRowBtn, 'Tombol Edit pada baris produk harus ada');
  editRowBtn.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });

  let editForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  assert.ok(editForm, 'Form modal edit harus terbuka setelah klik Edit');

  // Tutup bagian opsional pada modal edit lalu submit PATCH
  const editToggleOptBtn = findAllNodes(
    editForm,
    (n) => n.type === 'button' && n.props['aria-expanded'] !== undefined
  )[0];
  if (editToggleOptBtn.props['aria-expanded'] === true) {
    editToggleOptBtn.props.onClick();
    tree = adminHarness.render({ propertyId: 1, items: [] });
    editForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  }
  await editForm.props.onSubmit({ preventDefault: () => {} });

  const patchCall = adminHarness.fetchCalls.find((c) => c.options && c.options.method === 'PATCH');
  assert.ok(patchCall, 'Submit edit produk harus memanggil PATCH /api/pos/menu/items/:id');
  const patchPayload = JSON.parse(patchCall.options.body);
  assert.equal(patchPayload.name, 'Biji Kopi Arabika');
  assert.equal(patchPayload.item_code, 'RAW-01', 'SKU tersimpan tetap terkirim saat bagian opsional ditutup');
  assert.equal(patchPayload.description, 'Biji kopi house blend', 'Deskripsi tersimpan tetap terkirim saat bagian opsional ditutup');
  assert.equal(patchPayload.product_type, null, 'Klasifikasi tipe kosong pada produk existing tetap dipertahankan sebagai null');
  assert.equal(patchPayload.product_kind, null, 'Klasifikasi jenis kosong pada produk existing tetap dipertahankan sebagai null');
  assert.equal(patchPayload.base_unit, 'Kg');
  assert.equal(patchPayload.is_sellable_pos, false);

  console.log('  PASS  U7: Floating button +, urutan form inti, collapsible SKU/deskripsi, edit state, & istilah non-POS terverifikasi');

  // ── U8. Guard penutupan modal (✕ dan Batal) selama saving POST & PATCH deferred ──
  function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // 8a. Deferred POST pada modal Tambah Produk
  tree = adminHarness.render({ propertyId: 1, items: [] });
  const openAddBtnForU8 = findAllNodes(
    tree,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Tambah produk'
  )[0];
  assert.ok(openAddBtnForU8, 'Tombol + Tambah produk harus tersedia untuk U8');
  openAddBtnForU8.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });

  let u8AddForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  const u8AddNameInput = findAllNodes(
    u8AddForm,
    (n) => n.type === 'input' && n.props.type === 'text' && n.props.required === true
  )[0];
  u8AddNameInput.props.onChange({ target: { value: 'Saus Karamel Spesial' } });
  tree = adminHarness.render({ propertyId: 1, items: [] });

  u8AddForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  const u8AddPriceInput = findAllNodes(u8AddForm, (n) => n.type === 'input' && n.props.type === 'number')[0];
  u8AddPriceInput.props.onChange({ target: { value: '25000' } });
  tree = adminHarness.render({ propertyId: 1, items: [] });

  const postDeferred = createDeferred();
  adminHarness.setFetchHandler((_url, options = {}) => {
    if (options.method === 'POST') return postDeferred.promise;
    return undefined;
  });

  u8AddForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  const pendingPost = u8AddForm.props.onSubmit({ preventDefault: () => {} });
  tree = adminHarness.render({ propertyId: 1, items: [] });

  const addCloseXBtnPending = findAllNodes(
    tree,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Tutup modal tambah produk'
  )[0];
  const addCancelBtnPending = findAllNodes(
    tree,
    (n) => n.type === 'button' && collectText(n).join(' ').trim() === 'Batal'
  )[0];
  assert.ok(addCloseXBtnPending, 'Tombol ✕ pada modal tambah harus ada');
  assert.ok(addCancelBtnPending, 'Tombol Batal pada modal tambah harus ada');
  assert.equal(addCloseXBtnPending.props.disabled, true, 'Tombol ✕ modal tambah wajib disabled saat saving POST berlangsung');
  assert.equal(addCancelBtnPending.props.disabled, true, 'Tombol Batal modal tambah wajib disabled saat saving POST berlangsung');
  assert.equal(
    addCloseXBtnPending.props.onClick,
    addCancelBtnPending.props.onClick,
    'Tombol ✕ dan Batal pada modal tambah harus memakai helper penutupan yang sama'
  );

  // Panggil langsung handler onClick pada ✕ dan Batal saat saving masih pending
  addCloseXBtnPending.props.onClick();
  addCancelBtnPending.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });

  u8AddForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  assert.ok(u8AddForm, 'Pemanggilan langsung handler penutupan saat POST pending tidak boleh menutup modal tambah');
  const u8AddNameInputDuringSave = findAllNodes(
    u8AddForm,
    (n) => n.type === 'input' && n.props.type === 'text' && n.props.required === true
  )[0];
  const u8AddPriceInputDuringSave = findAllNodes(
    u8AddForm,
    (n) => n.type === 'input' && n.props.type === 'number'
  )[0];
  assert.equal(u8AddNameInputDuringSave.props.value, 'Saus Karamel Spesial', 'Draft nama pada modal tambah tidak boleh hilang saat saving');
  assert.equal(u8AddPriceInputDuringSave.props.value, '25000', 'Draft harga pada modal tambah tidak boleh hilang saat saving');

  // Selesaikan request POST (dengan error agar modal masih terbuka dan kita dapat menguji penutupan normal via ✕)
  postDeferred.resolve({
    ok: false,
    json: async () => ({ error: 'Simulasi gangguan jaringan sementara' }),
  });
  await pendingPost;
  adminHarness.setFetchHandler(null);
  tree = adminHarness.render({ propertyId: 1, items: [] });

  const addCloseXBtnAfter = findAllNodes(
    tree,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Tutup modal tambah produk'
  )[0];
  const addCancelBtnAfter = findAllNodes(
    tree,
    (n) => n.type === 'button' && collectText(n).join(' ').trim() === 'Batal'
  )[0];
  assert.equal(addCloseXBtnAfter.props.disabled, false, 'Tombol ✕ modal tambah harus aktif kembali setelah request selesai');
  assert.equal(addCancelBtnAfter.props.disabled, false, 'Tombol Batal modal tambah harus aktif kembali setelah request selesai');

  addCloseXBtnAfter.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });
  assert.equal(
    findAllNodes(tree, (n) => n.type === 'form').length,
    0,
    'Setelah request POST selesai, tombol ✕ harus kembali dapat menutup modal tambah secara normal'
  );

  // 8b. Deferred PATCH pada modal Edit Produk
  const editRowBtnForU8 = findAllNodes(
    tree,
    (n) => n.type === 'button' && collectText(n).join(' ').trim() === 'Edit'
  )[0];
  assert.ok(editRowBtnForU8, 'Tombol Edit pada baris produk harus tersedia untuk U8');
  editRowBtnForU8.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });

  let u8EditForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  assert.ok(u8EditForm, 'Form modal edit harus terbuka untuk U8');
  const u8EditNameInput = findAllNodes(
    u8EditForm,
    (n) => n.type === 'input' && n.props.type === 'text' && n.props.required === true
  )[0];
  u8EditNameInput.props.onChange({ target: { value: 'Biji Kopi Arabika Spesial' } });
  tree = adminHarness.render({ propertyId: 1, items: [] });

  u8EditForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  const u8EditPriceInput = findAllNodes(u8EditForm, (n) => n.type === 'input' && n.props.type === 'number')[0];
  u8EditPriceInput.props.onChange({ target: { value: '95000' } });
  tree = adminHarness.render({ propertyId: 1, items: [] });

  const patchDeferred = createDeferred();
  adminHarness.setFetchHandler((_url, options = {}) => {
    if (options.method === 'PATCH') return patchDeferred.promise;
    return undefined;
  });

  u8EditForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  const pendingPatch = u8EditForm.props.onSubmit({ preventDefault: () => {} });
  tree = adminHarness.render({ propertyId: 1, items: [] });

  const editCloseXBtnPending = findAllNodes(
    tree,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Tutup modal edit produk'
  )[0];
  const editCancelBtnPending = findAllNodes(
    tree,
    (n) => n.type === 'button' && collectText(n).join(' ').trim() === 'Batal'
  )[0];
  assert.ok(editCloseXBtnPending, 'Tombol ✕ pada modal edit harus ada');
  assert.ok(editCancelBtnPending, 'Tombol Batal pada modal edit harus ada');
  assert.equal(editCloseXBtnPending.props.disabled, true, 'Tombol ✕ modal edit wajib disabled saat saving PATCH berlangsung');
  assert.equal(editCancelBtnPending.props.disabled, true, 'Tombol Batal modal edit wajib disabled saat saving PATCH berlangsung');
  assert.equal(
    editCloseXBtnPending.props.onClick,
    editCancelBtnPending.props.onClick,
    'Tombol ✕ dan Batal pada modal edit harus memakai helper penutupan yang sama'
  );

  // Panggil langsung handler onClick pada ✕ dan Batal saat saving PATCH masih pending
  editCloseXBtnPending.props.onClick();
  editCancelBtnPending.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });

  u8EditForm = findAllNodes(tree, (n) => n.type === 'form')[0];
  assert.ok(u8EditForm, 'Pemanggilan langsung handler penutupan saat PATCH pending tidak boleh menutup modal edit');
  const u8EditNameInputDuringSave = findAllNodes(
    u8EditForm,
    (n) => n.type === 'input' && n.props.type === 'text' && n.props.required === true
  )[0];
  const u8EditPriceInputDuringSave = findAllNodes(
    u8EditForm,
    (n) => n.type === 'input' && n.props.type === 'number'
  )[0];
  assert.equal(u8EditNameInputDuringSave.props.value, 'Biji Kopi Arabika Spesial', 'Draft nama pada modal edit tidak boleh hilang saat saving');
  assert.equal(u8EditPriceInputDuringSave.props.value, '95000', 'Draft harga pada modal edit tidak boleh hilang saat saving');

  // Selesaikan request PATCH (dengan error agar modal masih terbuka dan kita dapat menguji penutupan normal via ✕)
  patchDeferred.resolve({
    ok: false,
    json: async () => ({ error: 'Simulasi gangguan jaringan edit sementara' }),
  });
  await pendingPatch;
  adminHarness.setFetchHandler(null);
  tree = adminHarness.render({ propertyId: 1, items: [] });

  const editCloseXBtnAfter = findAllNodes(
    tree,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Tutup modal edit produk'
  )[0];
  const editCancelBtnAfter = findAllNodes(
    tree,
    (n) => n.type === 'button' && collectText(n).join(' ').trim() === 'Batal'
  )[0];
  assert.equal(editCloseXBtnAfter.props.disabled, false, 'Tombol ✕ modal edit harus aktif kembali setelah request selesai');
  assert.equal(editCancelBtnAfter.props.disabled, false, 'Tombol Batal modal edit harus aktif kembali setelah request selesai');

  editCloseXBtnAfter.props.onClick();
  tree = adminHarness.render({ propertyId: 1, items: [] });
  assert.equal(
    findAllNodes(tree, (n) => n.type === 'form').length,
    0,
    'Setelah request PATCH selesai, tombol ✕ harus kembali dapat menutup modal edit secara normal'
  );

  console.log('  PASS  U8: Guard penutupan modal (✕ & Batal) saat saving POST/PATCH deferred & pemulihan setelah selesai terverifikasi');
  console.log('\n=== Semua test UI Master Produk Tahap 1 & MP-02A LULUS ===');
})().catch((err) => {
  console.error('TEST GAGAL:', err);
  process.exit(1);
});
