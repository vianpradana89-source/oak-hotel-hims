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

function compileAndLoad(relPath, mocks = {}, extraGlobals = {}) {
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
      Promise,
      URL,
      FormData: typeof FormData !== 'undefined' ? FormData : class MockFormData {
        constructor() { this.entries = []; }
        append(k, v) { this.entries.push([k, v]); }
      },
      ...extraGlobals,
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
    const createdObjectUrls = [];
    const revokedObjectUrls = [];
    let customFetchHandler = null;
    let stateCursor = 0;
    let refCursor = 0;

    const mockUrlGlobal = {
      createObjectURL: (obj) => {
        const u = `blob:oak-test-${createdObjectUrls.length + 1}`;
        createdObjectUrls.push({ url: u, obj });
        return u;
      },
      revokeObjectURL: (u) => {
        revokedObjectUrls.push(u);
      },
    };

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
          if (options.method === 'POST' && String(url).endsWith('/api/pos/menu/items')) {
            return {
              ok: true,
              json: async () => ({
                status: 'success',
                data: { id: 102 },
              }),
            };
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
    }, { URL: mockUrlGlobal });

    function render(props = { propertyId: 1, items: [] }) {
      stateCursor = 0;
      refCursor = 0;
      effects.length = 0;
      return mod.default(props);
    }

    function unmount() {
      const cleanups = [];
      for (const eff of effects) {
        if (Array.isArray(eff.deps) && eff.deps.length === 1 && typeof eff.deps[0] === 'function') {
          const cleanup = eff.fn();
          if (typeof cleanup === 'function') {
            cleanups.push(cleanup);
          }
        }
      }
      for (const cleanup of cleanups) {
        cleanup();
      }
    }

    return {
      render,
      unmount,
      effects,
      fetchCalls,
      refs,
      createdObjectUrls,
      revokedObjectUrls,
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

  // ── U9. MP-02B: Barcode helper, preservasi nol awal, & pencarian Master Produk ──
  assert.equal(PM.normalizeBarcodeDraft('  0012345678905  '), '0012345678905');
  assert.equal(PM.normalizeBarcodeDraft('0000'), '0000');
  assert.equal(PM.normalizeBarcodeDraft(''), null);
  assert.equal(PM.normalizeBarcodeDraft('   '), null);
  assert.equal(PM.normalizeBarcodeDraft(null), null);
  assert.equal(PM.normalizeBarcodeDraft(undefined), null);

  const sampleBarcodeItem = {
    id: 55,
    item_code: 'SKU-55',
    name: 'Air Mineral Pegunungan',
    barcode: '0012345678905',
  };
  assert.equal(PM.matchesProductSearch(sampleBarcodeItem, '00123'), true, 'Pencarian barcode harus cocok dengan nol awal');
  assert.equal(PM.matchesProductSearch(sampleBarcodeItem, 'sku-55'), true, 'Pencarian SKU tetap berfungsi');
  assert.equal(PM.matchesProductSearch(sampleBarcodeItem, 'pegunungan'), true, 'Pencarian nama tetap berfungsi');
  assert.equal(PM.matchesProductSearch(sampleBarcodeItem, '99999'), false);

  const editFormWithBarcode = PM.buildEditProductForm({
    ...legacyUnsetItem,
    barcode: '00778899',
  });
  assert.equal(editFormWithBarcode.barcode, '00778899');
  assert.equal(PM.buildEditProductForm({ ...legacyUnsetItem, barcode: null }).barcode, '');
  console.log('  PASS  U9: MP-02B helper barcode mempertahankan nol awal, tidak mengisi dari SKU, & mendukung pencarian barcode');

  // ── U10. MP-02B: Validasi foto, input Galeri & Kamera (capture="environment"), preview, & Batal tidak menghapus foto server ──
  assert.equal(PM.validateProductPhotoFile({ type: 'image/png', size: 1024 }), null);
  assert.equal(PM.validateProductPhotoFile({ type: 'image/jpeg', size: 2 * 1024 * 1024 }), null);
  assert.equal(PM.validateProductPhotoFile({ type: 'image/webp', size: 512 }), null);
  assert.match(PM.validateProductPhotoFile({ type: 'application/pdf', size: 1024 }) || '', /PNG, JPEG, atau WebP/);
  assert.match(PM.validateProductPhotoFile({ type: 'image/png', size: 2 * 1024 * 1024 + 1 }) || '', /2 MB/);

  const mp02bItems = [
    {
      id: 201,
      item_code: 'MN-201',
      name: 'Kopi Susu Gula Aren',
      category_id: 1,
      category_name: 'Minuman',
      price: 25000,
      is_active: true,
      is_sellable_pos: true,
      product_type: 'FINISHED_GOOD',
      product_kind: 'STANDARD',
      base_unit: 'Cup',
      barcode: '00201201',
      has_photo: true,
      photo_url: '/api/pos/menu/items/201/photo?property_id=1&v=1',
    },
  ];

  const photoHarness = createHarness({ canCreate: true, canEdit: true });
  let pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  // Buka modal Edit pada produk #201 yang sudah punya foto server (has_photo: true)
  const editBtn201 = findAllNodes(
    pTree,
    (n) => n.type === 'button' && collectText(n).join(' ').trim() === 'Edit'
  )[0];
  editBtn201.props.onClick();
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  let pEditForm = findAllNodes(pTree, (n) => n.type === 'form')[0];
  const galleryInputEdit = findAllNodes(
    pEditForm,
    (n) => n.type === 'input' && n.props['data-photo-source'] === 'gallery'
  )[0];
  const cameraInputEdit = findAllNodes(
    pEditForm,
    (n) => n.type === 'input' && n.props['data-photo-source'] === 'camera'
  )[0];
  assert.ok(galleryInputEdit, 'Input file galeri wajib tersedia di modal edit');
  assert.ok(cameraInputEdit, 'Input file kamera wajib tersedia di modal edit');
  assert.equal(cameraInputEdit.props.capture, 'environment', 'Input kamera wajib memiliki atribut capture="environment"');

  // Klik "Hapus Foto" di modal edit -> foto hanya ditandai akan dihapus saat simpan, BELUM memanggil DELETE ke server
  const markDeletePhotoBtn = findAllNodes(
    pEditForm,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Hapus foto produk'
  )[0];
  assert.ok(markDeletePhotoBtn, 'Tombol Hapus Foto pada produk berfoto harus ada di modal edit');
  markDeletePhotoBtn.props.onClick();
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  assert.equal(
    photoHarness.fetchCalls.some((c) => c.options && c.options.method === 'DELETE'),
    false,
    'Menekan Hapus Foto di dalam form tidak boleh langsung menghapus foto di server sebelum Simpan'
  );

  // Klik "Batal" pada modal edit -> modal tertutup dan tidak ada panggilan DELETE ke server
  const cancelEditBtn = findAllNodes(
    pTree,
    (n) => n.type === 'button' && collectText(n).join(' ').trim() === 'Batal'
  )[0];
  cancelEditBtn.props.onClick();
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });
  assert.equal(
    photoHarness.fetchCalls.some((c) => c.options && c.options.method === 'DELETE'),
    false,
    'Menekan Batal tidak boleh menghapus foto server'
  );
  console.log('  PASS  U10: Input Galeri/Kamera, validasi file, dan jaminan Batal tidak menghapus foto server terverifikasi');

  // ── U11. MP-02B: Proteksi Simpan Tambah Produk + Foto (pendingCreatedItem mencegah produk ganda saat retry) ──
  const openAddBtn = findAllNodes(
    pTree,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Tambah produk'
  )[0];
  openAddBtn.props.onClick();
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  let pAddForm = findAllNodes(pTree, (n) => n.type === 'form')[0];
  const addName = findAllNodes(pAddForm, (n) => n.type === 'input' && n.props.type === 'text' && n.props.required === true)[0];
  addName.props.onChange({ target: { value: 'Croissant Butter' } });
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  pAddForm = findAllNodes(pTree, (n) => n.type === 'form')[0];
  const addPrice = findAllNodes(pAddForm, (n) => n.type === 'input' && n.props.type === 'number')[0];
  addPrice.props.onChange({ target: { value: '22000' } });
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  pAddForm = findAllNodes(pTree, (n) => n.type === 'form')[0];
  const addBarcode = findAllNodes(pAddForm, (n) => n.type === 'input' && n.props['aria-label'] === 'Barcode produk')[0];
  addBarcode.props.onChange({ target: { value: '0055443322' } });
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  pAddForm = findAllNodes(pTree, (n) => n.type === 'form')[0];
  const addGalleryInput = findAllNodes(pAddForm, (n) => n.type === 'input' && n.props['data-photo-source'] === 'gallery')[0];
  const fakePhotoFile = { name: 'croissant.png', type: 'image/png', size: 12000 };
  addGalleryInput.props.onChange({ target: { files: [fakePhotoFile], value: 'C:\\fakepath\\croissant.png' } });
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  // Pastikan preview foto tampil di modal tambah
  pAddForm = findAllNodes(pTree, (n) => n.type === 'form')[0];
  const previewImg = findAllNodes(pAddForm, (n) => n.type === 'img' && n.props.alt === 'Preview foto produk baru')[0];
  assert.ok(previewImg, 'Preview foto lokal wajib tampil setelah memilih file');

  // Simulasikan: POST /api/pos/menu/items berhasil membuat produk #777,
  // namun POST /api/pos/menu/items/777/photo pertama kali gagal!
  let photoUploadAttempt = 0;
  const photoUploadDeferred = createDeferred();
  photoHarness.fetchCalls.length = 0;
  photoHarness.setFetchHandler(async (url, options = {}) => {
    if (url === '/api/pos/menu/items' && options.method === 'POST') {
      return {
        ok: true,
        json: async () => ({
          data: {
            id: 777,
            name: 'Croissant Butter',
            price: 22000,
            barcode: '0055443322',
            is_active: true,
            is_sellable_pos: true,
            has_photo: false,
            photo_url: null,
          },
        }),
      };
    }
    if (url.startsWith('/api/pos/menu/items/777/photo') && options.method === 'POST') {
      photoUploadAttempt++;
      if (photoUploadAttempt === 1) {
        return photoUploadDeferred.promise;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            id: 777,
            name: 'Croissant Butter',
            price: 22000,
            barcode: '0055443322',
            is_active: true,
            is_sellable_pos: true,
            has_photo: true,
            photo_url: '/api/pos/menu/items/777/photo?property_id=1&v=2',
          },
        }),
      };
    }
    if (url.startsWith('/api/pos/menu/items/777') && options.method === 'PATCH') {
      return {
        ok: true,
        json: async () => ({
          data: {
            id: 777,
            name: 'Croissant Butter',
            price: 22000,
            barcode: '0055443322',
            is_active: true,
            is_sellable_pos: true,
            has_photo: false,
            photo_url: null,
          },
        }),
      };
    }
    return undefined;
  });

  pAddForm = findAllNodes(pTree, (n) => n.type === 'form')[0];
  const firstSubmitPromise = pAddForm.props.onSubmit({ preventDefault: () => {} });
  // Tunggu microtask agar POST item selesai dan masuk ke tahap upload foto yang masih pending
  await Promise.resolve();
  await Promise.resolve();
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  // Selama upload foto sedang berlangsung, saving wajib masih true (✕ dan Batal disabled)
  const closeXDuringPhoto = findAllNodes(
    pTree,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Tutup modal tambah produk'
  )[0];
  assert.equal(closeXDuringPhoto.props.disabled, true, 'Status saving wajib melindungi seluruh rangkaian simpan termasuk upload foto');

  // Gagalkan percobaan pertama upload foto
  photoUploadDeferred.resolve({
    ok: false,
    json: async () => ({ message: 'Koneksi terputus saat mengunggah foto' }),
  });
  await firstSubmitPromise;
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  // Modal tambah harus tetap terbuka dan menampilkan informasi bahwa produk #777 sudah tersimpan
  pAddForm = findAllNodes(pTree, (n) => n.type === 'form')[0];
  assert.ok(pAddForm, 'Modal tambah wajib tetap terbuka ketika upload foto gagal');
  const modalWarningText = collectText(pAddForm).join(' ');
  assert.ok(modalWarningText.includes('#777'), 'Modal harus menjelaskan ID produk yang sudah dibuat (#777)');
  assert.ok(modalWarningText.includes('tanpa membuat produk kedua'), 'Modal harus menjelaskan bahwa Simpan ulang tidak membuat produk kedua');

  // Klik Simpan Produk lagi (Retry) -> wajib memanggil PATCH /api/pos/menu/items/777 + POST /photo (BUKAN POST /api/pos/menu/items kedua!)
  photoHarness.fetchCalls.length = 0;
  await pAddForm.props.onSubmit({ preventDefault: () => {} });
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  const createCallsOnRetry = photoHarness.fetchCalls.filter(
    (c) => c.url === '/api/pos/menu/items' && c.options && c.options.method === 'POST'
  );
  const patchCallsOnRetry = photoHarness.fetchCalls.filter(
    (c) => c.url.startsWith('/api/pos/menu/items/777') && c.options && c.options.method === 'PATCH'
  );
  const photoCallsOnRetry = photoHarness.fetchCalls.filter(
    (c) => c.url.startsWith('/api/pos/menu/items/777/photo') && c.options && c.options.method === 'POST'
  );
  assert.equal(createCallsOnRetry.length, 0, 'Simpan ulang TIDAK BOLEH membuat produk kedua (POST /api/pos/menu/items)');
  assert.equal(patchCallsOnRetry.length, 1, 'Simpan ulang harus memperbarui produk #777 via PATCH');
  assert.equal(photoCallsOnRetry.length, 1, 'Simpan ulang harus mengulang unggah foto ke produk #777');
  assert.equal(findAllNodes(pTree, (n) => n.type === 'form').length, 0, 'Setelah retry berhasil, modal harus tertutup');
  console.log('  PASS  U11: Proteksi simpan (data + foto) & retry tanpa duplikasi produk kedua terverifikasi');

  // ── U12. MP-02B: Hapus foto saat Simpan Perubahan pada modal Edit memanggil DELETE /photo ──
  const editBtnAgain = findAllNodes(
    pTree,
    (n) => n.type === 'button' && collectText(n).join(' ').trim() === 'Edit'
  )[0];
  editBtnAgain.props.onClick();
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  pEditForm = findAllNodes(pTree, (n) => n.type === 'form')[0];
  const markDelBtn2 = findAllNodes(
    pEditForm,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Hapus foto produk'
  )[0];
  markDelBtn2.props.onClick();
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  photoHarness.fetchCalls.length = 0;
  photoHarness.setFetchHandler(async (url, options = {}) => {
    if (url.startsWith('/api/pos/menu/items/201/photo') && options.method === 'DELETE') {
      return {
        ok: true,
        json: async () => ({
          data: { ...mp02bItems[0], has_photo: false, photo_url: null },
        }),
      };
    }
    if (url.startsWith('/api/pos/menu/items/201') && options.method === 'PATCH') {
      return {
        ok: true,
        json: async () => ({
          data: { ...mp02bItems[0] },
        }),
      };
    }
    return undefined;
  });

  pEditForm = findAllNodes(pTree, (n) => n.type === 'form')[0];
  await pEditForm.props.onSubmit({ preventDefault: () => {} });
  pTree = photoHarness.render({ propertyId: 1, items: mp02bItems });

  assert.equal(
    photoHarness.fetchCalls.some(
      (c) => c.url.startsWith('/api/pos/menu/items/201/photo') && c.options && c.options.method === 'DELETE'
    ),
    true,
    'Simpan Perubahan setelah menandai hapus foto wajib memanggil DELETE /api/pos/menu/items/:id/photo'
  );
  console.log('  PASS  U12: Penghapusan foto server diterapkan saat Simpan Perubahan pada modal Edit');

  // ── U13. MP-02B: Pemuatan gambar terlindungi via authenticatedFetch & kartu POS ──
  const pwSource = fs.readFileSync(path.resolve(__dirname, '../src/features/pos/PosWorkspace.tsx'), 'utf8');
  assert.ok(
    pmSource.includes('URL.createObjectURL') && pmSource.includes('URL.revokeObjectURL'),
    'ProductMasterPage wajib mengelola lifecycle object URL (createObjectURL & revokeObjectURL)'
  );
  assert.ok(
    pwSource.includes('URL.createObjectURL') && pwSource.includes('URL.revokeObjectURL'),
    'PosWorkspace wajib mengelola lifecycle object URL (createObjectURL & revokeObjectURL) untuk gambar kartu POS'
  );
  assert.ok(
    pwSource.includes('item.barcode'),
    'PosWorkspace wajib mendukung pencarian barcode pada katalog POS'
  );
  console.log('  PASS  U13: Pemuatan thumbnail Master Produk & gambar kartu POS via authenticatedFetch + cleanup revokeObjectURL terverifikasi');

  // ── U14. MP-02B: Respons POST tidak valid (data.id hilang/invalid & JSON tidak terbaca) ──
  //    - Tidak boleh melanjutkan upload foto atau menutup modal / menampilkan sukses
  //    - Mempertahankan draft dan pilihan/preview foto
  //    - Menampilkan error jujur & memblokir POST kedua secara buta
  //    - Menyediakan pemulihan melalui pemeriksaan daftar produk ("Periksa Daftar Produk")
  const invalidPostHarness = createHarness({ canCreate: true, canEdit: true });
  let invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  // Skenario A: Respons POST 201 tetapi data.id hilang/tidak valid ({ data: { id: null } })
  const openAddInvA = findAllNodes(
    invTree,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Tambah produk'
  )[0];
  openAddInvA.props.onClick();
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  let invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  findAllNodes(invForm, (n) => n.type === 'input' && n.props.required === true && n.props.type === 'text')[0]
    .props.onChange({ target: { value: 'Matcha Latte Botol' } });
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  findAllNodes(invForm, (n) => n.type === 'input' && n.props.type === 'number')[0]
    .props.onChange({ target: { value: '28000' } });
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  findAllNodes(invForm, (n) => n.type === 'input' && n.props['aria-label'] === 'Barcode produk')[0]
    .props.onChange({ target: { value: '0077889900' } });
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  const invGalleryInputA = findAllNodes(
    invForm,
    (n) => n.type === 'input' && n.props.type === 'file' && n.props['data-photo-source'] === 'gallery'
  )[0];
  invGalleryInputA.props.onChange({
    target: { files: [{ name: 'matcha.png', type: 'image/png', size: 15000 }] },
  });
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  const previewUrlScenarioA = invalidPostHarness.createdObjectUrls[invalidPostHarness.createdObjectUrls.length - 1].url;

  invalidPostHarness.fetchCalls.length = 0;
  invalidPostHarness.setFetchHandler(async (url, options = {}) => {
    if (url === '/api/pos/menu/items' && options.method === 'POST') {
      return {
        ok: true,
        json: async () => ({ data: { id: null, name: 'Matcha Latte Botol' } }),
      };
    }
    return undefined;
  });

  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  await invForm.props.onSubmit({ preventDefault: () => {} });
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  // 1) Modal wajib tetap terbuka, tidak menampilkan sukses, dan menampilkan error jujur
  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  assert.ok(invForm, 'Modal tambah wajib tetap terbuka saat respons POST tidak memiliki data.id valid');
  const invModalTextA = collectText(invForm).join(' ');
  assert.ok(
    invModalTextA.includes('Respons server tidak memuat ID produk yang valid'),
    `Pesan error jujur harus tampil, aktual: ${invModalTextA}`
  );
  assert.equal(
    collectText(invTree).join(' ').includes('berhasil ditambahkan ke katalog master'),
    false,
    'Tidak boleh menampilkan pesan sukses saat data.id tidak valid'
  );

  // 2) Upload foto tidak boleh dipanggil dan preview foto + draft form tetap utuh
  assert.equal(
    invalidPostHarness.fetchCalls.some((c) => c.url.includes('/photo')),
    false,
    'Endpoint upload foto tidak boleh dipanggil tanpa ID produk yang valid'
  );
  assert.equal(
    invalidPostHarness.revokedObjectUrls.includes(previewUrlScenarioA),
    false,
    'Preview foto tidak boleh dihapus/di-revoke saat respons POST tidak valid'
  );
  const preservedPreviewImgA = findAllNodes(
    invForm,
    (n) => n.type === 'img' && n.props.alt === 'Preview foto produk baru'
  )[0];
  assert.ok(preservedPreviewImgA, 'Preview foto harus tetap tampil di modal');
  assert.equal(preservedPreviewImgA.props.src, previewUrlScenarioA);
  const preservedNameInputA = findAllNodes(
    invForm,
    (n) => n.type === 'input' && n.props.required === true && n.props.type === 'text'
  )[0];
  assert.equal(preservedNameInputA.props.value, 'Matcha Latte Botol', 'Draft nama produk harus tetap dipertahankan');

  // 3) Tombol Simpan Produk disabled & pemanggilan onSubmit langsung diblokir (tidak mengirim POST kedua)
  const submitBtnInvA = findAllNodes(
    invForm,
    (n) => n.type === 'button' && n.props.type === 'submit'
  )[0];
  assert.equal(submitBtnInvA.props.disabled, true, 'Tombol Simpan Produk harus disabled untuk mencegah POST kedua secara buta');
  invalidPostHarness.fetchCalls.length = 0;
  await invForm.props.onSubmit({ preventDefault: () => {} });
  assert.equal(
    invalidPostHarness.fetchCalls.filter((c) => c.url === '/api/pos/menu/items' && c.options.method === 'POST').length,
    0,
    'Pemanggilan onSubmit langsung tidak boleh mengirim POST kedua secara buta'
  );

  // 4) Pemulihan melalui tombol "Periksa Daftar Produk":
  //    4a) GET deferred -> selama pending, modal/draft/foto/unconfirmedCreate tetap utuh;
  //        ketika selesai dengan HTTP 500, form + preview foto + blokir POST kedua tetap dipertahankan,
  //        error tampil, dan tombol "Periksa Daftar Produk" aktif kembali untuk dicoba ulang.
  const inspectBtnA = findAllNodes(
    invForm,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Periksa daftar produk'
  )[0];
  assert.ok(inspectBtnA, 'Tombol pemulihan "Periksa Daftar Produk" wajib tersedia');

  const inspectGetDeferred500 = createDeferred();
  invalidPostHarness.fetchCalls.length = 0;
  invalidPostHarness.setFetchHandler((url, options = {}) => {
    if (url.includes('/api/pos/menu?property_id=1') && (!options.method || options.method === 'GET')) {
      return inspectGetDeferred500.promise;
    }
    return undefined;
  });

  const pendingInspect500 = inspectBtnA.props.onClick();
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  // Selama GET masih pending (deferred), modal/draft/foto belum boleh dibersihkan atau ditutup
  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  assert.ok(invForm, 'Selama GET Periksa Daftar Produk masih pending, modal tambah tidak boleh ditutup');
  assert.equal(
    invalidPostHarness.revokedObjectUrls.includes(previewUrlScenarioA),
    false,
    'Selama GET Periksa Daftar Produk masih pending, preview foto tidak boleh di-revoke'
  );
  const inspectBtnWhilePending = findAllNodes(
    invForm,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Periksa daftar produk'
  )[0];
  assert.equal(inspectBtnWhilePending.props.disabled, true, 'Tombol Periksa Daftar Produk disabled selama GET in-flight');

  // Selesaikan GET deferred dengan HTTP 500
  inspectGetDeferred500.resolve({
    ok: false,
    status: 500,
    json: async () => ({ message: 'Gagal memuat daftar produk (HTTP 500)' }),
  });
  await pendingInspect500;
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  assert.ok(invForm, 'Saat GET Periksa Daftar Produk gagal HTTP 500, modal tambah wajib tetap terbuka');
  assert.ok(
    collectText(invForm).join(' ').includes('Gagal memuat daftar produk (HTTP 500)'),
    'Pesan error GET HTTP 500 wajib ditampilkan di modal'
  );
  assert.equal(
    invalidPostHarness.revokedObjectUrls.includes(previewUrlScenarioA),
    false,
    'Preview foto tidak boleh di-revoke ketika GET Periksa Daftar Produk gagal HTTP 500'
  );
  assert.equal(
    findAllNodes(invForm, (n) => n.type === 'input' && n.props.required === true && n.props.type === 'text')[0].props.value,
    'Matcha Latte Botol',
    'Draft nama wajib tetap utuh setelah GET gagal HTTP 500'
  );
  assert.equal(
    findAllNodes(invForm, (n) => n.type === 'input' && n.props.type === 'number')[0].props.value,
    '28000',
    'Draft harga wajib tetap utuh setelah GET gagal HTTP 500'
  );
  assert.equal(
    findAllNodes(invForm, (n) => n.type === 'input' && n.props['aria-label'] === 'Barcode produk')[0].props.value,
    '0077889900',
    'Draft barcode wajib tetap utuh setelah GET gagal HTTP 500'
  );
  const submitBtnAfter500 = findAllNodes(invForm, (n) => n.type === 'button' && n.props.type === 'submit')[0];
  assert.equal(submitBtnAfter500.props.disabled, true, 'POST kedua wajib tetap diblokir setelah GET gagal HTTP 500');
  invalidPostHarness.fetchCalls.length = 0;
  await invForm.props.onSubmit({ preventDefault: () => {} });
  assert.equal(
    invalidPostHarness.fetchCalls.filter((c) => c.url === '/api/pos/menu/items' && c.options.method === 'POST').length,
    0,
    'Pemanggilan onSubmit langsung tetap tidak boleh mengirim POST kedua setelah GET gagal HTTP 500'
  );

  //    4b) Coba pemeriksaan daftar lagi dengan respons GET tidak valid (200 tetapi data.items bukan array)
  const inspectBtnRetryInvalid = findAllNodes(
    invForm,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Periksa daftar produk'
  )[0];
  assert.ok(inspectBtnRetryInvalid, 'Tombol Periksa Daftar Produk harus tetap tersedia untuk dicoba ulang');
  assert.equal(inspectBtnRetryInvalid.props.disabled, false, 'Tombol Periksa Daftar Produk harus kembali aktif setelah GET selesai');

  invalidPostHarness.setFetchHandler(async (url, options = {}) => {
    if (url.includes('/api/pos/menu?property_id=1') && (!options.method || options.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { items: null } }),
      };
    }
    return undefined;
  });
  await inspectBtnRetryInvalid.props.onClick();
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  assert.ok(invForm, 'Saat respons GET tidak valid, modal wajib tetap terbuka');
  assert.ok(
    collectText(invForm).join(' ').includes('Respons daftar produk dari server tidak valid'),
    'Pesan error respons daftar produk tidak valid wajib ditampilkan'
  );
  assert.equal(
    invalidPostHarness.revokedObjectUrls.includes(previewUrlScenarioA),
    false,
    'Preview foto tetap tidak boleh di-revoke saat respons GET tidak valid'
  );

  //    4c) Coba pemeriksaan daftar lagi ketika respons GET basi (stale karena ada request GET lain yang lebih baru)
  const inspectBtnRetryStale = findAllNodes(
    invForm,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Periksa daftar produk'
  )[0];
  const staleGetDeferred = createDeferred();
  let getCallSeq = 0;
  invalidPostHarness.setFetchHandler((url, options = {}) => {
    if (url.includes('/api/pos/menu?property_id=1') && (!options.method || options.method === 'GET')) {
      getCallSeq++;
      if (getCallSeq === 1) return staleGetDeferred.promise;
      return Promise.resolve({
        ok: false,
        status: 503,
        json: async () => ({ message: 'Refresh latar gagal' }),
      });
    }
    return undefined;
  });

  const pendingInspectStale = inspectBtnRetryStale.props.onClick();
  // Pemicu GET kedua (mis. tombol Muat Ulang di halaman) menaikkan fetchGenRef sehingga GET pertama menjadi basi
  const refreshHeaderBtn = findAllNodes(
    invTree,
    (n) => n.type === 'button' && n.props.title === 'Refresh Data'
  )[0];
  assert.ok(refreshHeaderBtn, 'Tombol Refresh Data harus ada untuk simulasi fetch konkuren');
  await refreshHeaderBtn.props.onClick();

  staleGetDeferred.resolve({
    ok: true,
    status: 200,
    json: async () => ({ data: { items: mp02bItems, categories: [{ id: 1, name: 'Minuman' }] } }),
  });
  await pendingInspectStale;
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  assert.ok(invForm, 'Saat respons GET basi (stale), modal wajib tetap terbuka');
  assert.ok(
    collectText(invForm).join(' ').includes('basi'),
    'Pesan error respons basi wajib ditampilkan di modal'
  );
  assert.equal(
    invalidPostHarness.revokedObjectUrls.includes(previewUrlScenarioA),
    false,
    'Preview foto tetap dipertahankan saat respons GET basi'
  );
  assert.equal(
    findAllNodes(invForm, (n) => n.type === 'button' && n.props.type === 'submit')[0].props.disabled,
    true,
    'POST kedua tetap diblokir saat respons GET basi'
  );

  //    4d) Coba pemeriksaan daftar lagi dan GET berhasil (HTTP 200 valid) -> barulah draft/foto dibersihkan & modal ditutup
  invalidPostHarness.setFetchHandler(null);
  invalidPostHarness.fetchCalls.length = 0;
  const inspectBtnSuccess = findAllNodes(
    invForm,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Periksa daftar produk'
  )[0];
  assert.equal(inspectBtnSuccess.props.disabled, false, 'Tombol Periksa Daftar Produk dapat diklik ulang setelah respons basi');
  await inspectBtnSuccess.props.onClick();
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  assert.equal(findAllNodes(invTree, (n) => n.type === 'form').length, 0, 'Modal ditutup setelah GET Periksa Daftar Produk berhasil');
  assert.equal(
    invalidPostHarness.fetchCalls.some((c) => c.url.includes('/api/pos/menu?property_id=1') && c.url.includes('scope=master')),
    true,
    'Pemulihan wajib memuat ulang daftar produk master'
  );
  assert.equal(
    invalidPostHarness.revokedObjectUrls.includes(previewUrlScenarioA),
    true,
    'Preview foto dibersihkan setelah GET Periksa Daftar Produk berhasil terkonfirmasi'
  );

  // Skenario B: Respons POST 201 tetapi JSON tidak terbaca (res.json() throw SyntaxError)
  const openAddInvB = findAllNodes(
    invTree,
    (n) => n.type === 'button' && n.props['aria-label'] === 'Tambah produk'
  )[0];
  openAddInvB.props.onClick();
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  findAllNodes(invForm, (n) => n.type === 'input' && n.props.required === true && n.props.type === 'text')[0]
    .props.onChange({ target: { value: 'Teh Tarik Spesial' } });
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  findAllNodes(invForm, (n) => n.type === 'input' && n.props.type === 'number')[0]
    .props.onChange({ target: { value: '20000' } });
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  const invGalleryInputB = findAllNodes(
    invForm,
    (n) => n.type === 'input' && n.props.type === 'file' && n.props['data-photo-source'] === 'gallery'
  )[0];
  invGalleryInputB.props.onChange({
    target: { files: [{ name: 'tehtarik.jpg', type: 'image/jpeg', size: 18000 }] },
  });
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });
  const previewUrlScenarioB = invalidPostHarness.createdObjectUrls[invalidPostHarness.createdObjectUrls.length - 1].url;

  invalidPostHarness.fetchCalls.length = 0;
  invalidPostHarness.setFetchHandler(async (url, options = {}) => {
    if (url === '/api/pos/menu/items' && options.method === 'POST') {
      return {
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      };
    }
    return undefined;
  });

  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  await invForm.props.onSubmit({ preventDefault: () => {} });
  invTree = invalidPostHarness.render({ propertyId: 1, items: mp02bItems });

  invForm = findAllNodes(invTree, (n) => n.type === 'form')[0];
  assert.ok(invForm, 'Modal tambah wajib tetap terbuka saat JSON respons POST tidak terbaca');
  assert.ok(
    collectText(invForm).join(' ').includes('Respons server tidak memuat ID produk yang valid'),
    'Pesan error jujur wajib ditampilkan saat JSON tidak terbaca'
  );
  assert.equal(
    invalidPostHarness.fetchCalls.some((c) => c.url.includes('/photo')),
    false,
    'Upload foto tidak boleh dijalankan saat JSON respons POST tidak terbaca'
  );
  assert.equal(
    invalidPostHarness.revokedObjectUrls.includes(previewUrlScenarioB),
    false,
    'Preview foto tidak boleh di-revoke saat JSON respons POST tidak terbaca'
  );
  // Pastikan percobaan submit ulang diblokir
  invalidPostHarness.fetchCalls.length = 0;
  await invForm.props.onSubmit({ preventDefault: () => {} });
  assert.equal(
    invalidPostHarness.fetchCalls.filter((c) => c.url === '/api/pos/menu/items' && c.options.method === 'POST').length,
    0,
    'POST kedua wajib diblokir saat JSON respons pertama tidak terbaca'
  );
  console.log('  PASS  U14: Respons POST tanpa data.id valid / JSON tidak terbaca mempertahankan draft & foto, memblokir POST kedua, & menyediakan pemulihan');

  // ── U15. MP-02B: Cleanup unmount me-revoke Blob URL preview lokal pada modal Tambah dan Edit ──
  // 1) Unmount saat modal Tambah memiliki preview foto lokal aktif
  const unmountAddHarness = createHarness({ canCreate: true, canEdit: true });
  let uAddTree = unmountAddHarness.render({ propertyId: 1, items: mp02bItems });
  findAllNodes(uAddTree, (n) => n.type === 'button' && n.props['aria-label'] === 'Tambah produk')[0].props.onClick();
  uAddTree = unmountAddHarness.render({ propertyId: 1, items: mp02bItems });

  const uAddForm = findAllNodes(uAddTree, (n) => n.type === 'form')[0];
  findAllNodes(uAddForm, (n) => n.type === 'input' && n.props.type === 'file' && n.props['data-photo-source'] === 'gallery')[0]
    .props.onChange({
      target: { files: [{ name: 'unmount-add.png', type: 'image/png', size: 12000 }] },
    });
  uAddTree = unmountAddHarness.render({ propertyId: 1, items: mp02bItems });

  assert.equal(unmountAddHarness.createdObjectUrls.length, 1);
  const addUnmountPreviewUrl = unmountAddHarness.createdObjectUrls[0].url;
  assert.equal(unmountAddHarness.revokedObjectUrls.includes(addUnmountPreviewUrl), false);

  unmountAddHarness.unmount();
  assert.equal(
    unmountAddHarness.revokedObjectUrls.includes(addUnmountPreviewUrl),
    true,
    'Blob URL preview lokal pada modal Tambah wajib di-revoke ketika komponen unmount'
  );

  // 2) Unmount saat modal Edit memiliki preview foto lokal aktif
  const unmountEditHarness = createHarness({ canCreate: true, canEdit: true });
  let uEditTree = unmountEditHarness.render({ propertyId: 1, items: mp02bItems });
  findAllNodes(uEditTree, (n) => n.type === 'button' && collectText(n).join(' ').trim() === 'Edit')[0].props.onClick();
  uEditTree = unmountEditHarness.render({ propertyId: 1, items: mp02bItems });

  const uEditForm = findAllNodes(uEditTree, (n) => n.type === 'form')[0];
  findAllNodes(uEditForm, (n) => n.type === 'input' && n.props.type === 'file' && n.props['data-photo-source'] === 'gallery')[0]
    .props.onChange({
      target: { files: [{ name: 'unmount-edit.webp', type: 'image/webp', size: 14000 }] },
    });
  uEditTree = unmountEditHarness.render({ propertyId: 1, items: mp02bItems });

  assert.equal(unmountEditHarness.createdObjectUrls.length, 1);
  const editUnmountPreviewUrl = unmountEditHarness.createdObjectUrls[0].url;
  assert.equal(unmountEditHarness.revokedObjectUrls.includes(editUnmountPreviewUrl), false);

  unmountEditHarness.unmount();
  assert.equal(
    unmountEditHarness.revokedObjectUrls.includes(editUnmountPreviewUrl),
    true,
    'Blob URL preview lokal pada modal Edit wajib di-revoke ketika komponen unmount'
  );
  console.log('  PASS  U15: Cleanup unmount me-revoke Blob URL preview lokal pada modal Tambah dan modal Edit');

  console.log('\n=== Semua test UI Master Produk Tahap 1, MP-02A, & MP-02B LULUS ===');
})().catch((err) => {
  console.error('TEST GAGAL:', err);
  process.exit(1);
});
