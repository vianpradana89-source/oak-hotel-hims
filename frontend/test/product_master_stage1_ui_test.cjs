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

console.log('\n=== Semua test UI Master Produk Tahap 1 LULUS ===');
