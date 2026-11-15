# OAK HIMS — MP-03B: Kontrak Implementasi Satuan dan Lokasi Stok

- **Status Dokumen:** Kontrak Teknis & Fungsional — Revisi Review MP-03B (Siap Implementasi untuk Tahap MP-03C)
- **Workspace:** `E:\oak-hims-staging-pos-wa`
- **Baseline:** Branch `staging-pos-wa-integration`, HEAD `948ee04c2ecda44edc1fbf9919ceba2771e3d48b` (`948ee04`)
- **Prinsip Arsitektur (`AGENTS.md`):**
  ```text
  ONE HOTEL / PROPERTY
  → ONE SOURCE OF TRUTH PER DOMAIN
  → ONE TRANSACTION FLOW
  → ONE AUDIT TRAIL
  ```

---

## 1. Ringkasan Rekomendasi Utama

Gunakan pendekatan **aditif bertahap (dual-field untuk satuan dasar + tabel terpisah untuk kemasan produk dan lokasi stok)**:

1. **Satuan Dasar Produk (`pos_menu_items`):**
   - Pertahankan kolom `base_unit VARCHAR(50)` untuk kompatibilitas mundur dan tampilan teks existing (termasuk nilai `NULL` dan teks lama yang belum dipetakan).
   - Tambahkan kolom `canonical_base_unit_code VARCHAR(30) NULL` pada [`pos_menu_items`](file:///e:/oak-hims-staging-pos-wa/backend/src/db/schema_v3.ts#L170-L197) yang merujuk pada **Katalog Satuan Standar Sistem** (`COUNT`, `WEIGHT`, `VOLUME`).
   - Tidak ada *backfill* paksa atau penafsiran otomatis atas teks `base_unit` yang tidak dikenal.
2. **Konversi Ukuran Umum vs Kemasan Khusus Produk:**
   - **Konversi Ukuran Umum (Intra-Dimensi):** Ditetapkan secara deterministik oleh konstanta sistem di dalam dimensi yang sama (`1 KG = 1000 GRAM`, `1 LITER = 1000 ML`). Konversi otomatis lintas dimensi (`KG` $\leftrightarrow$ `LITER`, `KG` $\leftrightarrow$ `PCS`) **dilarang**.
   - **Kemasan Khusus Produk (`product_packaging_conversions`):** Tabel baru (relasi `1-to-N` dari `pos_menu_items.id`) yang mendefinisikan satuan kemasan/beli per produk (mis. `1 Karton = 24 Botol`, `1 Jerigen = 5.000 Liter`) dengan faktor positif eksplisit `to_base_factor NUMERIC(12, 3)` dan **ikatan satuan dasar immutable `base_unit_code VARCHAR(30) NOT NULL`** pada setiap baris kemasan.
   - Perubahan satuan dasar produk (saat seluruh kemasan nonaktif) **tidak pernah menafsirkan ulang kemasan lama**, dan kemasan nonaktif **dilarang diaktifkan kembali** apabila `base_unit_code` miliknya berbeda dari `canonical_base_unit_code` produk saat ini.
3. **Master Lokasi Stok (`stock_locations`):**
   - Tabel baru per `property_id` untuk lokasi penyimpanan fisik (`WAREHOUSE`, `KITCHEN`, `POS_OUTLET`, `HK_PANTRY`, `ROOM_MINIBAR`).
   - Master kamar fisik tetap berada di [`rooms`](file:///e:/oak-hims-staging-pos-wa/backend/src/db/schema_v2.ts#L276). Lokasi bertipe `ROOM_MINIBAR` wajib mengikat `room_id REFERENCES rooms(id)` pada properti yang sama dengan indeks unik `(property_id, room_id) WHERE room_id IS NOT NULL`.
   - Atribut identitas struktural lokasi (`property_id`, `location_type`, `room_id`) bersifat **immutable** setelah dibuat agar lokasi tidak diam-diam berpindah makna.
   - Kandidat kamar untuk `ROOM_MINIBAR` disediakan melalui endpoint khusus berizin `Master Produk` (`GET /api/pos/stock-locations/room-candidates`) tanpa memperluas izin ke seluruh `Master Kamar`.
   - Lokasi stok tidak pernah dihapus secara fisik (*no hard delete*); penonaktifan dilakukan via `is_active = FALSE`.
4. **Batas Pembelian (`transaction_lines`):**
   - [`transaction_lines.product_id`](file:///e:/oak-hims-staging-pos-wa/backend/src/db/schema_v3.ts#L3283) **tidak** dipasangi FK dan **tidak** dipetakan secara historis pada batch ini. Integrasi penerimaan pembelian ke `pos_menu_items.id` akan dilakukan pada batch mutasi stok berikutnya untuk transaksi baru.

---

## 2. Katalog Satuan Standar Sistem & Aturan Kuantitas/Konversi

### 2.1. Katalog Satuan Kanonik Sistem (`SYSTEM_CANONICAL_UNITS`)

Katalog satuan didefinisikan sebagai konstanta domain kanonik di backend dan diekspos ke frontend agar memiliki satu sumber kebenaran. Setiap satuan memiliki atribut:
- `code`: Kode kanonik huruf besar (`VARCHAR(30)`).
- `label`: Label tampilan standar (selaras dengan [`COMMON_BASE_UNITS`](file:///e:/oak-hims-staging-pos-wa/frontend/src/features/products/ProductMasterPage.tsx#L124) di Master Produk).
- `dimension`: `'COUNT'` (diskrit), `'WEIGHT'` (berat), atau `'VOLUME'` (volume cair).
- `max_decimal_places`: `0` untuk `COUNT`, `3` untuk `WEIGHT` dan `VOLUME`.
- `dimension_base_code` & `to_dimension_base_factor`: Faktor konversi eksak terhadap satuan terkecil di dalam dimensi yang sama (`GRAM` untuk `WEIGHT`, `ML` untuk `VOLUME`, `null` untuk `COUNT`).
- `aliases`: Daftar penulisan sinonim (dinormalisasi dengan `LOWER(BTRIM(input))`) untuk pencocokan eksplisit.

| `code` | `label` | `dimension` | Presisi Kuantitas (`max_decimal_places`) | Konversi Ukuran Umum Intra-Dimensi | Alias Penulisan (`LOWER(BTRIM)`) |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `PCS` | `Pcs` | `COUNT` | `0` (Integer) | Tidak ada (diskrit) | `pcs`, `pc`, `piece`, `pieces`, `buah`, `biji`, `unit` |
| `PORSI` | `Porsi` | `COUNT` | `0` (Integer) | Tidak ada (diskrit) | `porsi`, `portion`, `piring` |
| `GELAS` | `Gelas` | `COUNT` | `0` (Integer) | Tidak ada (diskrit) | `gelas`, `glass` |
| `CUP` | `Cup` | `COUNT` | `0` (Integer) | Tidak ada (diskrit) | `cup` |
| `BOTOL` | `Botol` | `COUNT` | `0` (Integer) | Tidak ada (diskrit) | `botol`, `btl`, `bottle` |
| `KALENG` | `Kaleng` | `COUNT` | `0` (Integer) | Tidak ada (diskrit) | `kaleng`, `klg`, `can`, `tin` |
| `PACK` | `Pack` | `COUNT` | `0` (Integer) | Tidak ada (diskrit) | `pack`, `pak`, `pck`, `bungkus`, `bks`, `sachet` |
| `BOX` | `Box` | `COUNT` | `0` (Integer) | Tidak ada (diskrit) | `box`, `kotak`, `dus`, `karton`, `ctn`, `carton`, `krat` |
| `ROLL` | `Roll` | `COUNT` | `0` (Integer) | Tidak ada (diskrit) | `roll`, `rol`, `gulung` |
| `SET` | `Set` | `COUNT` | `0` (Integer) | Tidak ada (diskrit) | `set`, `pasang`, `pair` |
| `LEMBAR` | `Lembar` | `COUNT` | `0` (Integer) | Tidak ada (diskrit) | `lembar`, `lbr`, `sheet` |
| `KG` | `Kg` | `WEIGHT` | `3` (`0.001`) | `1 KG = 1000 GRAM` (`1 GRAM = 0.001 KG`) | `kg`, `kilogram`, `kilo` |
| `GRAM` | `Gram` | `WEIGHT` | `3` (`0.001`) | `1 GRAM = 1 GRAM` | `gram`, `gr`, `g`, `gm` |
| `LITER` | `Liter` | `VOLUME` | `3` (`0.001`) | `1 LITER = 1000 ML` (`1 ML = 0.001 LITER`) | `liter`, `ltr`, `l`, `lt` |
| `ML` | `Ml` | `VOLUME` | `3` (`0.001`) | `1 ML = 1 ML` | `ml`, `mililiter`, `milliliter`, `cc` |

> [!IMPORTANT]
> **Pemisahan Tegas Konversi:**
> 1. **Konversi Ukuran Umum (`WEIGHT` & `VOLUME`):** Hanya berlaku di dalam dimensi yang sama (`KG` $\leftrightarrow$ `GRAM` dan `LITER` $\leftrightarrow$ `ML`). Satuan dasar produk **tidak wajib** menjadi satuan terkecil: produk dengan `canonical_base_unit_code = 'KG'` dapat langsung mencatat pemakaian `"0.250"` `KG` (setara `"250.000"` `GRAM`).
> 2. **Larangan Konversi Lintas Dimensi:** Sistem menolak konversi otomatis antara `WEIGHT` dan `VOLUME` (mis. `KG` $\leftrightarrow$ `LITER`) maupun ke `COUNT` dengan kode error `422 CROSS_DIMENSION_CONVERSION_FORBIDDEN`.
> 3. **Bukan Resep / BOM:** Transformasi produksi (mis. `1 KG Biji Kopi` $\rightarrow$ `50 CUP Espresso`) adalah domain Resep/BOM, **bukan** konversi kemasan produk.

---

### 2.2. Presisi Numerik, Batas Nilai, Representasi API, dan Validasi Batas Hasil Konversi

#### A. Tipe Penyimpanan & Batas Nilai Input
1. **Kuantitas Stok/Transaksi (`quantity` — `NUMERIC(12, 3)`):**
   - Kapasitas kolom PostgreSQL `NUMERIC(12, 3)`: maksimal 9 digit bulat dan 3 digit desimal (`<= 999999999.999`).
   - **Barang Diskrit (`dimension = 'COUNT'`):**
     - Wajib bilangan bulat (`scale = 0`).
     - Batas nilai mutasi/input positif: **`"1"` s/d `"999999999"`** (atau `"0"` s/d `"999999999"` untuk hasil hitung fisik/opname/inspeksi minibar).
   - **Barang Berat/Volume (`dimension IN ('WEIGHT', 'VOLUME')`):**
     - Mendukung pecahan hingga maksimal **3 tempat desimal** (`scale <= 3`, resolusi `0.001`).
     - Batas nilai mutasi/input positif: **`"0.001"` s/d `"999999999.999"`** (atau `"0.000"` untuk hasil hitung fisik).
2. **Faktor Konversi Kemasan (`to_base_factor` — `NUMERIC(12, 3)`):**
   - Menyatakan jumlah `base_unit_code` dalam `1` unit kemasan (`base_quantity = packaging_quantity * to_base_factor`).
   - **Jika `base_unit_code` berdimensi `COUNT`:**
     - `to_base_factor` **wajib bilangan bulat** (`scale = 0`, yaitu `to_base_factor = TRUNC(to_base_factor)`), rentang **`"1"` s/d `"100000"`** (disimpan/dikembalikan sebagai `"1.000"` s/d `"100000.000"`, contoh: `1 Karton = 24 Botol`).
   - **Jika `base_unit_code` berdimensi `WEIGHT` atau `VOLUME`:**
     - `to_base_factor` mendukung maksimal **3 tempat desimal** (`scale <= 3`), rentang **`"0.001"` s/d `"100000.000"`** (contoh: `1 Pouch = "0.900"` `LITER`, `1 Sachet = "0.025"` `KG`, `1 Jerigen = "5.000"` `LITER`).

#### B. Representasi JSON API (String Desimal sebagai Nilai Otoritatif)
- **Alasan Teknis:** Pada JSON standar, tipe `number` diparse oleh `JSON.parse()` menjadi IEEE-754 *double-precision float* sebelum kode aplikasi berjalan, sehingga bentuk literal asli hilang (`1e3` sudah menjadi `1000`, `1.5000` menjadi `1.5`, dan presisi desimal dapat terdistorsi).
- **Request JSON (`POST`/`PATCH`) — Kontrak Otoritatif:**
  - Untuk seluruh field numerik baru (`to_base_factor` serta `quantity` konversi/mutasi), **representasi otoritatif adalah `string` desimal bertitik (`.`)**.
  - Nilai `typeof value !== 'string'` (termasuk JSON `number`, `boolean`, `object`) **ditolak dengan `400 VALIDATION_ERROR` (`DECIMAL_STRING_REQUIRED`)** agar validasi format literal (termasuk penolakan notasi ilmiah seperti `"1e3"` atau `"1e-3"`, spasi dalam, koma lokal `"0,250"`, dan jumlah digit desimal seperti `"1.0000"`) dapat ditegakkan secara deterministik sebelum parsing numerik.
  - Format regex ketat atas `string` input:
    - Integer (`COUNT`): `/^(?:0|[1-9]\d{0,8})(?:\.0{1,3})?$/`
    - Desimal (`WEIGHT`/`VOLUME`): `/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/`
  - UI di browser bertugas menormalisasi input pengguna (mis. `"0,250"` atau `"24"`) menjadi `string` desimal kanonik (`"0.250"`, `"24"`) sebelum mengirim JSON.
- **Response JSON — Kontrak Otoritatif:**
  - `to_base_factor`: dikembalikan sebagai **`string` desimal kanonik 3 digit** langsung dari PostgreSQL `NUMERIC(12, 3)` (mis. `"24.000"`, `"0.250"`). Field `to_base_factor` (string) adalah **satu-satunya nilai otoritatif** untuk form edit, perbandingan kesetaraan, rekonsiliasi retry, dan perhitungan.
  - Jika response menyertakan field tambahan `to_base_factor_num: number` (mis. `24`, `0.25`), field tersebut **hanya bersifat bantu untuk tampilan (display-only)**, tunduk pada keterbatasan representasi *floating-point* IEEE-754, dan **tidak boleh** dipakai sebagai sumber perhitungan atau pembanding otoritatif.

#### C. Aturan Penolakan Input & Validasi Batas Hasil Konversi (Output Overflow Check)
1. **Tidak Ada Pembulatan Diam-diam (Zero Silent Rounding):**
   - Input `string` dengan lebih dari 3 tempat desimal (mis. `"0.2505"`), notasi ilmiah (`"1e3"`), nilai `<= 0`, atau nilai pecahan pada satuan `COUNT` (mis. `"1.5"` Botol) **ditolak langsung dengan `400 VALIDATION_ERROR`**.
2. **Perhitungan Konversi Eksak (`BigInt` Mili-Unit Arithmetic):**
   - Semua konversi di backend dievaluasi menggunakan skala integer $\times 1000$ (`BigInt` mili-unit: `1.000 unit = 1000n mili-unit`) atau `NUMERIC` PostgreSQL.
   - Kuantitas input dalam satuan **kemasan khusus produk** (`product_packaging_conversions`) wajib bilangan bulat positif (`"1"`, `"2"`, `"3"`, ...; $\text{scale} = 0$), sehingga $\text{packaging\_qty} \times \text{to\_base\_factor}$ selalu menghasilkan nilai mili-unit bulat tanpa pecahan sub-mili.
   - Untuk konversi ukuran umum intra-dimensi (`GRAM` $\rightarrow$ `KG` atau `ML` $\rightarrow$ `LITER`), jika input `GRAM`/`ML` bernilai pecahan (mis. `"0.500"` `GRAM` = `0.0005 KG`) yang tidak habis dibagi `1000n` mili-unit pada satuan tujuan `KG`/`LITER`, konversi **ditolak dengan `422 SUB_MILLI_UNIT_PRECISION_LOSS`**.
3. **Validasi Batas Kapasitas Hasil Konversi (`CONVERSION_RESULT_OVERFLOW`):**
   - Validasi batas **wajib diterapkan pada hasil akhir konversi (`target_quantity` / `base_quantity`)**, bukan hanya pada masing-masing input secara terpisah:
     - Kapasitas maksimum `NUMERIC(12, 3)` untuk `WEIGHT`/`VOLUME`: **`999,999,999.999`** (`MAX_DECIMAL_MILLI = 999_999_999_999n`).
     - Kapasitas maksimum `NUMERIC(12, 3)` untuk `COUNT`: **`999,999,999`** (`MAX_COUNT_MILLI = 999_999_999_000n`, wajib kelipatan `1000n`).
   - Jika hasil perkalian $\text{packaging\_qty} \times \text{to\_base\_factor}$ atau hasil konversi intra-dimensi (`KG` $\rightarrow$ `GRAM` atau `LITER` $\rightarrow$ `ML`) melampaui batas kapasitas satuan tujuan tersebut, backend **wajib menolak dengan `422 CONVERSION_RESULT_OVERFLOW`** sebelum menyentuh database (mencegah PostgreSQL error `22003 numeric field overflow`).
4. **Pembulatan Nilai Uang (Rupiah):**
   - Nilai uang (`unit_price`, `line_total`) tetap berupa integer Rupiah (`BIGINT`) sesuai aturan [`transactionService.ts`](file:///e:/oak-hims-staging-pos-wa/backend/src/domains/transactions/transactionService.ts#L1414): `ROUND(quantity::numeric * unit_price::bigint)::bigint` (`HALF_UP` ke Rupiah terdekat pada nilai uang, bukan pada kuantitas barang).

#### D. Tabel Contoh Nilai Batas (Input & Hasil Konversi)

| Skenario Input / Konversi | Satuan Dasar / Tujuan | Nilai yang Diuji | Hasil Validasi Server | Penjelasan |
| :--- | :--- | :--- | :--- | :--- |
| Pemakaian bahan baku pecahan | `KG` (`WEIGHT`) | `quantity = "0.250"` | **DITERIMA** (`"0.250"` `KG`) | String desimal 3 digit valid, setara `"250.000"` `GRAM`. |
| Batas terkecil berat/volume | `LITER` (`VOLUME`) | `quantity = "0.001"` | **DITERIMA** (`"0.001"` `LITER`) | Nilai positif minimum `NUMERIC(12,3)` (`1 ML`). |
| Input bukan string / notasi ilmiah | Semua | `to_base_factor = 1000` (number) atau `"1e3"` | **DITOLAK (`400`)** | Wajib `string` desimal kanonik tanpa notasi ilmiah (`DECIMAL_STRING_REQUIRED` / `VALIDATION_ERROR`). |
| Desimal lebih dari 3 digit | `KG` (`WEIGHT`) | `quantity = "0.2505"` atau `"1.0000"` | **DITOLAK (`400`)** | Melebihi 3 tempat desimal; tidak dibulatkan otomatis. |
| Barang diskrit diberi pecahan | `BOTOL` (`COUNT`) | `quantity = "1.5"` | **DITOLAK (`400`)** | Dimensi `COUNT` wajib bilangan bulat (`scale = 0`). |
| Kemasan produk diskrit bulat | `BOTOL` (`COUNT`) | `to_base_factor = "24"` atau `"24.000"` | **DITERIMA** (`"24.000"`) | `1 Karton = 24 Botol`. |
| Kemasan produk diskrit pecahan | `BOTOL` (`COUNT`) | `to_base_factor = "2.5"` | **DITOLAK (`400`)** | Satuan dasar `COUNT` tidak boleh punya faktor kemasan pecahan. |
| Kemasan produk berat pecahan | `KG` (`WEIGHT`) | `to_base_factor = "0.250"` | **DITERIMA** (`"0.250"`) | `1 Pack Kopi = 0.250 Kg` (`250 Gram`). |
| Faktor konversi nol / negatif | Semua | `to_base_factor = "0"` atau `"-1"` | **DITOLAK (`400`)** | Faktor konversi wajib `> 0`. |
| Faktor melebihi batas atas | Semua | `to_base_factor = "100000.001"` | **DITOLAK (`400`)** | Melebihi batas maksimum `"100000.000"`. |
| **Overflow hasil konversi kemasan** | `BOTOL` (`COUNT`) | `packaging_qty = "10000"`, `to_base_factor = "100000"` | **DITOLAK (`422`)** | Masing-masing input valid, tetapi hasil `1,000,000,000` melampaui batas `999,999,999` (`CONVERSION_RESULT_OVERFLOW`). |
| **Overflow hasil konversi `KG` $\rightarrow$ `GRAM`** | `KG` $\rightarrow$ `GRAM` | `quantity = "1500000.000"` `KG` | **DITOLAK (`422`)** | Input valid dalam `KG`, tetapi hasil `1,500,000,000.000 GRAM` melampaui `NUMERIC(12, 3)` (`CONVERSION_RESULT_OVERFLOW`). |
| **Hilang presisi `GRAM` $\rightarrow$ `KG`** | `GRAM` $\rightarrow$ `KG` | `quantity = "0.500"` `GRAM` | **DITOLAK (`422`)** | Hasil `0.0005 KG` membutuhkan 4 desimal (`SUB_MILLI_UNIT_PRECISION_LOSS`). |

---

## 3. Model Data, Constraint Database, dan Kesiapan Schema (PostgreSQL)

Seluruh perubahan schema bersifat **aditif dan 100% idempotent** (aman dijalankan berulang kali tanpa gagal pada `ADD CONSTRAINT`, `CREATE INDEX`, maupun `CREATE TRIGGER`).

### 3.1. Perluasan Tabel `pos_menu_items`

```sql
-- 1. Kolom kode satuan kanonik (nullable agar produk existing tetap kompatibel)
ALTER TABLE pos_menu_items
  ADD COLUMN IF NOT EXISTS canonical_base_unit_code VARCHAR(30);

-- 2. Idempotent ADD + VALIDATE CONSTRAINT untuk daftar kode satuan kanonik
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_pos_menu_items_canonical_base_unit_code'
      AND conrelid = 'public.pos_menu_items'::regclass
  ) THEN
    ALTER TABLE pos_menu_items
      ADD CONSTRAINT chk_pos_menu_items_canonical_base_unit_code
      CHECK (
        canonical_base_unit_code IS NULL
        OR canonical_base_unit_code IN (
          'PCS', 'PORSI', 'GELAS', 'CUP', 'BOTOL', 'KALENG',
          'PACK', 'BOX', 'ROLL', 'SET', 'LEMBAR',
          'KG', 'GRAM', 'LITER', 'ML'
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE pos_menu_items
  VALIDATE CONSTRAINT chk_pos_menu_items_canonical_base_unit_code;

-- 3. Idempotent ADD + VALIDATE CONSTRAINT: jika canonical_base_unit_code terisi, base_unit tidak boleh NULL/kosong
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_pos_menu_items_canonical_unit_requires_label'
      AND conrelid = 'public.pos_menu_items'::regclass
  ) THEN
    ALTER TABLE pos_menu_items
      ADD CONSTRAINT chk_pos_menu_items_canonical_unit_requires_label
      CHECK (
        canonical_base_unit_code IS NULL
        OR (base_unit IS NOT NULL AND LENGTH(BTRIM(base_unit)) > 0)
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE pos_menu_items
  VALIDATE CONSTRAINT chk_pos_menu_items_canonical_unit_requires_label;
```

### 3.2. Tabel Baru: `product_packaging_conversions` (Kemasan per Produk dengan Ikatan Satuan Dasar & Identitas Operasi Idempoten)

Setiap baris kemasan menyimpan **`base_unit_code VARCHAR(30) NOT NULL`** yang mengikat makna `to_base_factor` secara permanen ke satuan dasar produk pada saat kemasan dibuat, serta **`idempotency_key VARCHAR(150) NOT NULL`** yang mengikat identitas operasi pembuatan kemasan secara deterministik per `(property_id, menu_item_id)`.

```sql
CREATE TABLE IF NOT EXISTS product_packaging_conversions (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  menu_item_id INTEGER NOT NULL REFERENCES pos_menu_items(id) ON DELETE CASCADE,
  packaging_code VARCHAR(30) NOT NULL,
  packaging_label VARCHAR(100) NOT NULL,
  base_unit_code VARCHAR(30) NOT NULL,
  to_base_factor NUMERIC(12, 3) NOT NULL,
  is_default_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  idempotency_key VARCHAR(150) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Guard kolom & constraint secara idempotent (aman bila tabel sudah ada sebelumnya)
ALTER TABLE product_packaging_conversions
  ADD COLUMN IF NOT EXISTS base_unit_code VARCHAR(30);

ALTER TABLE product_packaging_conversions
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(150);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ppc_code_non_empty'
      AND conrelid = 'public.product_packaging_conversions'::regclass
  ) THEN
    ALTER TABLE product_packaging_conversions
      ADD CONSTRAINT chk_ppc_code_non_empty
      CHECK (LENGTH(BTRIM(packaging_code)) BETWEEN 1 AND 30);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ppc_label_non_empty'
      AND conrelid = 'public.product_packaging_conversions'::regclass
  ) THEN
    ALTER TABLE product_packaging_conversions
      ADD CONSTRAINT chk_ppc_label_non_empty
      CHECK (LENGTH(BTRIM(packaging_label)) BETWEEN 1 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ppc_base_unit_code_valid'
      AND conrelid = 'public.product_packaging_conversions'::regclass
  ) THEN
    ALTER TABLE product_packaging_conversions
      ADD CONSTRAINT chk_ppc_base_unit_code_valid
      CHECK (
        base_unit_code IN (
          'PCS', 'PORSI', 'GELAS', 'CUP', 'BOTOL', 'KALENG',
          'PACK', 'BOX', 'ROLL', 'SET', 'LEMBAR',
          'KG', 'GRAM', 'LITER', 'ML'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ppc_code_not_same_as_base_unit'
      AND conrelid = 'public.product_packaging_conversions'::regclass
  ) THEN
    ALTER TABLE product_packaging_conversions
      ADD CONSTRAINT chk_ppc_code_not_same_as_base_unit
      CHECK (UPPER(BTRIM(packaging_code)) <> base_unit_code);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ppc_factor_bounds'
      AND conrelid = 'public.product_packaging_conversions'::regclass
  ) THEN
    ALTER TABLE product_packaging_conversions
      ADD CONSTRAINT chk_ppc_factor_bounds
      CHECK (to_base_factor >= 0.001 AND to_base_factor <= 100000.000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ppc_idempotency_key_non_empty'
      AND conrelid = 'public.product_packaging_conversions'::regclass
  ) THEN
    ALTER TABLE product_packaging_conversions
      ADD CONSTRAINT chk_ppc_idempotency_key_non_empty
      CHECK (LENGTH(BTRIM(idempotency_key)) BETWEEN 1 AND 150);
  END IF;
END $$;

-- Kode dan label kemasan unik per produk dalam properti (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS uq_ppc_item_packaging_code
  ON product_packaging_conversions (property_id, menu_item_id, UPPER(BTRIM(packaging_code)));

CREATE UNIQUE INDEX IF NOT EXISTS uq_ppc_item_packaging_label
  ON product_packaging_conversions (property_id, menu_item_id, LOWER(BTRIM(packaging_label)));

-- Identitas operasi pembuatan kemasan unik per produk dalam properti
CREATE UNIQUE INDEX IF NOT EXISTS uq_ppc_item_idempotency_key
  ON product_packaging_conversions (property_id, menu_item_id, BTRIM(idempotency_key));

-- Maksimal 1 kemasan default pembelian aktif per produk
CREATE UNIQUE INDEX IF NOT EXISTS uq_ppc_item_default_purchase
  ON product_packaging_conversions (property_id, menu_item_id)
  WHERE is_default_purchase = TRUE AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_ppc_property_item
  ON product_packaging_conversions (property_id, menu_item_id, is_active);
```

**Trigger Konsistensi Properti, Ikatan Satuan Dasar, Immutability, & Penguncian pada `product_packaging_conversions` dan `pos_menu_items`:**

1. **Trigger `ppc_enforce_property_and_base_unit()` (`BEFORE INSERT OR UPDATE ON product_packaging_conversions`):**
   - Mengunci baris induk `SELECT property_id, canonical_base_unit_code FROM pos_menu_items WHERE id = NEW.menu_item_id FOR UPDATE` untuk serialisasi terhadap perubahan satuan produk maupun retry pembuatan kemasan secara bersamaan.
   - Memastikan `NEW.property_id = parent.property_id` (jika berbeda $\rightarrow$ exception `CROSS_PROPERTY_PACKAGING_FORBIDDEN`).
   - Pada `UPDATE`: melarang perubahan identitas `property_id`, `menu_item_id`, `base_unit_code` (`IF NEW.base_unit_code IS DISTINCT FROM OLD.base_unit_code` $\rightarrow$ exception `PACKAGING_BASE_UNIT_IMMUTABLE`), maupun `idempotency_key` (`IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key` $\rightarrow$ exception `PACKAGING_IDEMPOTENCY_KEY_IMMUTABLE`).
   - Pada `INSERT` **atau** ketika `NEW.is_active = TRUE` (termasuk saat reaktivasi kemasan dari `FALSE` ke `TRUE` atau mengubah kemasan aktif):
     - Wajib `parent.canonical_base_unit_code IS NOT NULL` (jika `NULL` $\rightarrow$ exception `BASE_UNIT_NOT_CANONICAL`).
     - Wajib `NEW.base_unit_code = parent.canonical_base_unit_code`. Jika berbeda $\rightarrow$ exception `PACKAGING_BASE_UNIT_MISMATCH` (mencegah kemasan `25.000 KG` diaktifkan kembali saat produk sudah berganti satuan menjadi `GRAM`).
   - Pada `UPDATE` saat `OLD.is_active = FALSE AND NEW.is_active = FALSE`:
     - Jika `parent.canonical_base_unit_code IS DISTINCT FROM OLD.base_unit_code`, melarang perubahan `to_base_factor` atau `is_default_purchase = TRUE` (`PACKAGING_BASE_UNIT_MISMATCH`).
   - Memvalidasi presisi `NEW.to_base_factor` terhadap dimensi dari `NEW.base_unit_code`: jika `NEW.base_unit_code` berdimensi `COUNT`, maka wajib `NEW.to_base_factor = TRUNC(NEW.to_base_factor)` dan `NEW.to_base_factor >= 1`.

2. **Trigger `pmi_guard_active_packaging_on_unit_change()` (`BEFORE UPDATE OF canonical_base_unit_code, base_unit ON pos_menu_items`):**
   - Jika `NEW.canonical_base_unit_code IS DISTINCT FROM OLD.canonical_base_unit_code`:
     - Memeriksa `EXISTS (SELECT 1 FROM product_packaging_conversions WHERE menu_item_id = NEW.id AND is_active = TRUE)`.
     - Jika ada kemasan aktif $\rightarrow$ exception `BASE_UNIT_HAS_ACTIVE_PACKAGING`.
   - Trigger dipasang secara idempotent (`DROP TRIGGER IF EXISTS ...; CREATE TRIGGER ...`).

### 3.3. Tabel Baru: `stock_locations` (Master Lokasi Stok per Properti)

```sql
CREATE TABLE IF NOT EXISTS stock_locations (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(120) NOT NULL,
  location_type VARCHAR(30) NOT NULL,
  room_id INTEGER NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_locations_code_non_empty'
      AND conrelid = 'public.stock_locations'::regclass
  ) THEN
    ALTER TABLE stock_locations
      ADD CONSTRAINT chk_stock_locations_code_non_empty
      CHECK (LENGTH(BTRIM(code)) BETWEEN 1 AND 50);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_locations_name_non_empty'
      AND conrelid = 'public.stock_locations'::regclass
  ) THEN
    ALTER TABLE stock_locations
      ADD CONSTRAINT chk_stock_locations_name_non_empty
      CHECK (LENGTH(BTRIM(name)) BETWEEN 1 AND 120);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_locations_type'
      AND conrelid = 'public.stock_locations'::regclass
  ) THEN
    ALTER TABLE stock_locations
      ADD CONSTRAINT chk_stock_locations_type
      CHECK (location_type IN ('WAREHOUSE', 'KITCHEN', 'POS_OUTLET', 'HK_PANTRY', 'ROOM_MINIBAR'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_locations_room_minibar_binding'
      AND conrelid = 'public.stock_locations'::regclass
  ) THEN
    ALTER TABLE stock_locations
      ADD CONSTRAINT chk_stock_locations_room_minibar_binding
      CHECK (
        (location_type = 'ROOM_MINIBAR' AND room_id IS NOT NULL)
        OR (location_type <> 'ROOM_MINIBAR' AND room_id IS NULL)
      );
  END IF;
END $$;

-- Kode dan nama lokasi unik per properti (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_property_code
  ON stock_locations (property_id, UPPER(BTRIM(code)));

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_property_name
  ON stock_locations (property_id, LOWER(BTRIM(name)));

-- Pencegahan relasi ganda: 1 kamar fisik maksimal dirujuk oleh 1 lokasi stok minibar
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_property_room
  ON stock_locations (property_id, room_id)
  WHERE room_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_locations_property_type_active
  ON stock_locations (property_id, location_type, is_active);
```

**Trigger Konsistensi Properti & Immutability Identitas Lokasi (`stock_locations_enforce_identity_and_scope`):**
- `BEFORE INSERT OR UPDATE ON stock_locations`:
  1. **Immutability pada `UPDATE`:**
     - Jika `NEW.property_id IS DISTINCT FROM OLD.property_id` $\rightarrow$ exception `STOCK_LOCATION_PROPERTY_IMMUTABLE`.
     - Jika `NEW.location_type IS DISTINCT FROM OLD.location_type` $\rightarrow$ exception `STOCK_LOCATION_TYPE_IMMUTABLE`.
     - Jika `NEW.room_id IS DISTINCT FROM OLD.room_id` $\rightarrow$ exception `STOCK_LOCATION_ROOM_BINDING_IMMUTABLE`.
  2. **Validasi Properti Kamar pada `INSERT`:**
     - Jika `NEW.room_id IS NOT NULL`, periksa `SELECT property_id FROM rooms WHERE id = NEW.room_id`. Jika kamar tidak ditemukan $\rightarrow$ exception `ROOM_NOT_FOUND`; jika `rooms.property_id <> NEW.property_id` $\rightarrow$ exception `CROSS_PROPERTY_ROOM_LOCATION`.
- Dipasang secara idempotent (`DROP TRIGGER IF EXISTS trg_stock_locations_enforce_identity_and_scope ON stock_locations; CREATE TRIGGER ...`).

---

### 3.4. Kesiapan Schema (Schema Readiness) vs Kegagalan Pemeriksaan Penggunaan

Tabel-tabel minibar (`room_type_minibar_standard`, `minibar_baseline_verification`, `minibar_stay_event`, `minibar_inspection_report_line`) atau tabel ledger stok tahap mendatang mungkin **belum dibuat** pada environment tertentu. Sistem wajib membedakan secara tegas antara **ketiadaan tabel yang terkonfirmasi** dan **kegagalan eksekusi query**:

| Kondisi | Cara Deteksi Otoritatif | Perilaku pada `GET /api/pos/menu` (Baca Katalog) | Perilaku pada `PATCH /api/pos/menu/items/:id` & Endpoint Kemasan (Mutasi) |
| :--- | :--- | :--- | :--- |
| **1. Tabel opsional minibar / ledger mendatang belum ada di schema** | `SELECT to_regclass('public.<table_name>')` menghasilkan `NULL` tanpa SQL error. | **Berhasil (`200 OK`)**. Tabel yang belum ada dianggap memiliki `0` referensi (tidak mengunci produk). Katalog POS & Master Produk tidak pernah gagal hanya karena tabel opsional belum dibuat. | **Diizinkan lanjut** ke pemeriksaan tabel lain yang sudah ada (`product_packaging_conversions` dan tabel opsional yang `to_regclass IS NOT NULL`). |
| **2. Tabel wajib MP-03C (`product_packaging_conversions`) belum dimigrasikan** | `SELECT to_regclass('public.product_packaging_conversions')` menghasilkan `NULL`. | **Degradasi aman (`200 OK`)** agar operasional POS tidak lumpuh saat rolling deploy: `packaging_conversions = []`, namun `is_base_unit_locked` diset **`true` (fail-closed)** untuk semua produk yang sudah punya `base_unit` agar satuan tidak diubah saat tabel pengunci belum siap. | **Ditolak Fail-Closed (`503 SCHEMA_NOT_READY`)** untuk segala mutasi satuan dasar produk maupun endpoint kemasan sampai migrasi MP-03C dijalankan. |
| **3. Kegagalan query pemeriksaan penggunaan pada tabel yang sudah ada** | Query `to_regclass` sendiri gagal, atau query `SELECT EXISTS (...)` pada tabel yang `to_regclass IS NOT NULL` melempar exception (koneksi putus, *lock timeout*, *permission denied*, error sintaks/kolom). | **Gagal (`500 INTERNAL_SERVER_ERROR`)**. Tidak boleh menelan error dan memalsukan `is_base_unit_locked: false`. | **Ditolak Fail-Closed (`500` / `503 USAGE_CHECK_FAILED`)** dan transaksi di-`ROLLBACK`. Perubahan satuan dasar dilarang keras dilanjutkan bila status penguncian gagal diverifikasi. |

---

## 4. Aturan Perubahan Satuan, Kemasan, dan Lokasi Stok

### 4.1. Koreksi Label vs Perubahan Makna Kuantitas & Ikatan Kemasan Nonaktif

| Jenis Perubahan | Contoh | Status Izin | Aturan Backend |
| :--- | :--- | :--- | :--- |
| **Pemetaan Awal Satuan Kanonik** | Produk lama `base_unit = NULL` atau `base_unit = 'Botol'` (`canonical_base_unit_code = NULL`) dipetakan ke `canonical_base_unit_code = 'BOTOL'`. | **Diizinkan** | Mengisi `canonical_base_unit_code = 'BOTOL'` dan menyelaraskan `base_unit = 'Botol'`. Riwayat penjualan POS (`pos_order_items`) **tidak** menghalangi pemetaan ini. |
| **Koreksi Label Kemasan** | Mengubah `packaging_label` dari `'Karton'` menjadi `'Karton (24 Botol)'` dengan `to_base_factor` tetap `"24.000"`. | **Diizinkan** | Hanya memperbarui label tampilan tanpa mengubah kuantitas konversi. |
| **Perubahan `canonical_base_unit_code` saat ada kemasan aktif** | Mengubah `canonical_base_unit_code` dari `'KG'` ke `'GRAM'` atau menghapus ke `NULL` padahal produk memiliki baris `product_packaging_conversions` dengan `is_active = TRUE`. | **Ditolak (`409`)** | Kode error `BASE_UNIT_HAS_ACTIVE_PACKAGING`. User harus menonaktifkan kemasan terlebih dahulu. |
| **Perubahan `canonical_base_unit_code` saat hanya ada kemasan nonaktif** | Kemasan `Karung 25 Kg` (`base_unit_code = 'KG'`, `to_base_factor = "25.000"`, `is_active = FALSE`), lalu satuan produk diubah dari `'KG'` menjadi `'GRAM'` (dan belum dipakai di minibar/stok). | **Diizinkan tanpa menafsirkan ulang kemasan lama** | Satuan produk berubah menjadi `'GRAM'`. Baris kemasan lama tetap menyimpan `base_unit_code = 'KG'` dan `to_base_factor = "25.000"` (`25.000 KG`, **bukan** `25.000 GRAM`). |
| **Reaktivasi kemasan nonaktif yang satuannya berbeda dari satuan produk saat ini** | Mengaktifkan kembali (`is_active: true`) kemasan `Karung 25 Kg` (`base_unit_code = 'KG'`) ketika produk saat ini bersatuan `'GRAM'` atau `NULL`. | **Ditolak (`409`)** | Kode error `PACKAGING_BASE_UNIT_MISMATCH`. Kemasan dengan `base_unit_code <> canonical_base_unit_code` produk tidak dapat diaktifkan atau diedit faktornya; user harus membuat kemasan baru untuk satuan `'GRAM'` (atau mengembalikan satuan produk ke `'KG'`). |
| **Perubahan `canonical_base_unit_code` setelah dipakai di Minibar / Inventori** | Mengubah `canonical_base_unit_code` dari `'BOTOL'` ke `'PCS'` setelah produk terdaftar di `room_type_minibar_standard`, `minibar_baseline_verification`, `minibar_stay_event`, `minibar_inspection_report_line`, atau ledger stok mendatang. | **Ditolak (`409`)** | Kode error `BASE_UNIT_LOCKED_BY_INVENTORY_USAGE`. Satuan dasar terkunci demi menjaga integritas kuantitas historis. |
| **Perubahan `to_base_factor` kemasan** | Mengubah `to_base_factor` dari `"24.000"` menjadi `"12.000"`. | **Bersyarat** | Hanya diizinkan jika `base_unit_code = canonical_base_unit_code` produk saat ini dan kemasan belum pernah direferensikan oleh transaksi penerimaan/mutasi stok. Jika nantinya sudah direferensikan oleh mutasi stok, ditolak (`409 PACKAGING_FACTOR_LOCKED`). |

> [!NOTE]
> **Kontrak Snapshot untuk Riwayat Transaksi Stok Mendatang:**
> Setiap tabel mutasi stok atau penerimaan barang pada tahap berikutnya wajib menyimpan kolom snapshot immutable pada saat transaksi terjadi: `unit_code_snapshot VARCHAR(30)`, `unit_label_snapshot VARCHAR(100)`, `base_unit_code_snapshot VARCHAR(30)`, `to_base_factor_snapshot NUMERIC(12, 3)`, dan `base_quantity NUMERIC(12, 3)`.

### 4.2. Pemisahan Lokasi Stok vs Departemen Biaya vs Kanal Penjualan & Immutability Identitas Lokasi

1. **Lokasi Stok (`stock_locations`):** Posisi fisik tempat persediaan disimpan dan dihitung (mis. `GDG-UTAMA`, `DPR-FNB`, `PNT-HK-1`, `MB-101`).
2. **Departemen Biaya (`hr_departments` & `property_purchase_allowed_departments`):** Unit organisasi/alokasi beban akuntansi (`FRONT_OFFICE`, `HOUSEKEEPING`, `FNB`, `MAINTENANCE`, `ADMIN`).
3. **Kanal Penjualan (`pos_orders`, `saleSourceIdentity`):** Jalur transaksi pendapatan (`POS`, `OTHER_OUTLET`, `MINIBAR`).
4. **Immutability Identitas Lokasi & Aturan Nonaktivasi:**
   - Setelah baris `stock_locations` dibuat, **`property_id`, `location_type`, dan `room_id` bersifat permanen (immutable)**. Lokasi `WAREHOUSE` tidak dapat diubah menjadi `ROOM_MINIBAR`, dan lokasi minibar `Kamar 101` tidak dapat dipindahkan ke `Kamar 102` (`409 STOCK_LOCATION_TYPE_IMMUTABLE` / `409 STOCK_LOCATION_ROOM_BINDING_IMMUTABLE`).
   - Hanya `code`, `name`, `notes`, dan `is_active` yang dapat diperbarui melalui `PATCH`.
   - Tidak ada penghapusan baris (`DELETE`) pada `stock_locations`. Lokasi yang dinonaktifkan (`is_active = FALSE`) tetap mempertahankan ikatan `room_id` dan riwayatnya, namun ditolak (`409 INACTIVE_STOCK_LOCATION`) bila dipilih pada mutasi baru.

---

## 5. Kontrak API, Permission, Scope Properti, dan Konkurensi

### 5.1. Permission & Guard Properti
Seluruh endpoint menggunakan kembali fondasi yang sudah berjalan di [`accessControlService.ts`](file:///e:/oak-hims-staging-pos-wa/backend/src/domains/settings/accessControlService.ts#L63-L67) dan [`operationalAccessGuard.ts`](file:///e:/oak-hims-staging-pos-wa/backend/src/domains/settings/operationalAccessGuard.ts#L66-L70):
- **Resource:** `'Master Produk'`
  - Operasi Baca (`GET`): membutuhkan `view` (`inventory.view`) — atau `['POS', 'Master Produk']` untuk pembacaan katalog menu POS (`GET /api/pos/menu`).
  - Operasi Tulis (`POST`, `PATCH`): membutuhkan `edit` (`inventory.create` / `inventory.edit`).
- **Property Scope:** Wajib menyertakan `property_id` yang tervalidasi melalui `assertPropertyScope(req, propertyId)` dan guard `createOperationalAccessGuard`. Akses lintas properti ditolak dengan `403 FORBIDDEN`.
- **Isolasi Izin Kamar:** Pengguna yang hanya memiliki izin `'Master Produk'` **tidak** diberi akses ke `GET /api/rooms` atau resource `'Master Kamar'`. Untuk kebutuhan pemilihan kamar pada lokasi `ROOM_MINIBAR`, disediakan endpoint khusus `GET /api/pos/stock-locations/room-candidates` di bawah guard `'Master Produk'`.

### 5.2. Spesifikasi Endpoint & Matriks Kompatibilitas

#### 1. `GET /api/pos/menu` (Perluasan Kompatibel)
- **Response tambahan pada `data`:**
  - `canonical_units`: Array katalog satuan standar sistem (`code`, `label`, `dimension`, `max_decimal_places`, `aliases`).
- **Response tambahan pada setiap objek item di `data.items`:**
  - `base_unit`: `string | null` (tetap ada, tidak berubah).
  - `canonical_base_unit_code`: `string | null` (kode satuan kanonik jika sudah terpetakan, atau `null`).
  - `base_unit_dimension`: `'COUNT' | 'WEIGHT' | 'VOLUME' | null`.
  - `is_base_unit_locked`: `boolean` (`true` jika produk memiliki kemasan aktif `is_active = TRUE` atau sudah direferensikan di tabel minibar/inventori).
  - `packaging_conversions`: Array kemasan milik item tersebut (`id`, `packaging_code`, `packaging_label`, `base_unit_code`, `to_base_factor` [string otoritatif `"24.000"`], `to_base_factor_num` [display-only], `is_default_purchase`, `is_active`, `is_compatible_with_current_base_unit`).

#### 2. `POST /api/pos/menu/items` & `PATCH /api/pos/menu/items/:id` — Matriks Eksplisit Satuan Dasar

Untuk menjamin kompatibilitas caller lama sekaligus mencegah pelepasan `canonical_base_unit_code` yang melewati penguncian, server menerapkan matriks keputusan berikut setelah mengunci baris produk (`SELECT ... FOR UPDATE`):

**Definisi Kesetaraan Teks/Alias (`isEquivalentToUnit(inputText, canonicalCode)`):**
Sebuah string `inputText` dinyatakan **setara** dengan `canonicalCode` (mis. `'BOTOL'`) apabila `LOWER(BTRIM(inputText))` sama dengan `LOWER(unit.code)` (`'botol'`), `LOWER(unit.label)` (`'botol'`), atau salah satu elemen di `unit.aliases` (`'btl'`, `'bottle'`).

##### Tabel Matriks `PATCH /api/pos/menu/items/:id`

| Jalur Caller & Isi Payload (`canonical_base_unit_code`, `base_unit`) | Produk Belum Terpetakan (`canonical_base_unit_code = NULL`, mis. `base_unit = 'Botol'` atau `NULL`) — **Tidak Terkunci** | Produk Belum Terpetakan (`canonical_base_unit_code = NULL`, `base_unit = 'Botol'`) — **Terkunci Minibar/Inventori** | Produk Sudah Kanonik (`canonical_base_unit_code = 'BOTOL'`, `base_unit = 'Botol'`) — **Tidak Terkunci** | Produk Sudah Kanonik (`canonical_base_unit_code = 'BOTOL'`, `base_unit = 'Botol'`) — **Terkunci (Kemasan Aktif / Minibar)** |
| :--- | :--- | :--- | :--- | :--- |
| **L1. Legacy: Kedua field dihilangkan (`undefined`)** | **200 OK** — Pertahankan `base_unit` & `canonical_base_unit_code = NULL` apa adanya. | **200 OK** — Pertahankan `base_unit` & `canonical_base_unit_code = NULL` apa adanya. | **200 OK** — Pertahankan `canonical_base_unit_code = 'BOTOL'` & `base_unit = 'Botol'`. | **200 OK** — Pertahankan `canonical_base_unit_code = 'BOTOL'` & `base_unit = 'Botol'`. |
| **L2. Legacy: `canonical_base_unit_code` dihilangkan, `base_unit` berisi teks/alias yang SETARA dengan satuan produk saat ini** (mis. `'Botol'`, `'botol'`, `'btl'`) | **200 OK** — Simpan `base_unit = BTRIM(input)`, `canonical_base_unit_code` tetap `NULL` (tidak menebak otomatis). | **200 OK** — Jika `LOWER(BTRIM(input)) = LOWER(BTRIM(existing.base_unit))`, pertahankan nilai existing; jika berbeda teks pada produk unmapped terkunci $\rightarrow$ **409 `BASE_UNIT_LOCKED_BY_INVENTORY_USAGE`**. | **200 OK** — **Pertahankan `canonical_base_unit_code = 'BOTOL'`** dan selaraskan `base_unit = 'Botol'`. Tidak melepas kode kanonik. | **200 OK** — **Pertahankan `canonical_base_unit_code = 'BOTOL'`** dan `base_unit = 'Botol'`. Tidak melepas kode kanonik & tidak memicu konflik palsu. |
| **L3. Legacy: `canonical_base_unit_code` dihilangkan, `base_unit` berisi teks BERBEDA (satuan lain `'Kaleng'` atau teks tidak dikenal `'ikat'`)** | **200 OK** — Simpan `base_unit = BTRIM(input)`, `canonical_base_unit_code = NULL` (tidak menafsirkan otomatis teks baru). | **409 Conflict** (`BASE_UNIT_LOCKED_BY_INVENTORY_USAGE`) — Ditolak karena satuan produk sedang terkunci. | **200 OK** — Simpan `base_unit = BTRIM(input)`, `canonical_base_unit_code = NULL` (karena produk tidak terkunci; kemasan nonaktif lama tetap terikat pada `'BOTOL'` dan tidak bisa diaktifkan). | **409 Conflict** (`BASE_UNIT_HAS_ACTIVE_PACKAGING` atau `BASE_UNIT_LOCKED_BY_INVENTORY_USAGE`) — **Ditolak!** Jalur legacy dilarang melepas kode kanonik untuk melewati penguncian. |
| **L4. Legacy: `canonical_base_unit_code` dihilangkan, `base_unit` berisi `null` atau `""`** | **200 OK** — Set `base_unit = NULL`, `canonical_base_unit_code = NULL`. | **409 Conflict** (`BASE_UNIT_LOCKED_BY_INVENTORY_USAGE`) — Ditolak (kecuali existing `base_unit` memang sudah `NULL`). | **200 OK** — Set `base_unit = NULL`, `canonical_base_unit_code = NULL`. | **409 Conflict** (`BASE_UNIT_HAS_ACTIVE_PACKAGING` atau `BASE_UNIT_LOCKED_BY_INVENTORY_USAGE`) — **Ditolak!** |
| **C1. Kanonik: `canonical_base_unit_code = 'BOTOL'` (sama dengan kode existing)** (dengan `base_unit` kosong atau setara `'Botol'`/`'btl'`) | **200 OK** — Petakan ke `canonical_base_unit_code = 'BOTOL'`, `base_unit = 'Botol'`. | **200 OK** — Jika existing `base_unit` setara dengan `'BOTOL'`, izinkan konfirmasi pemetaan ke `'BOTOL'`; jika existing `base_unit` berbeda (mis. `'Kaleng'`) $\rightarrow$ **409**. | **200 OK** — Pertahankan `canonical_base_unit_code = 'BOTOL'`, `base_unit = 'Botol'`. | **200 OK** — Pertahankan `canonical_base_unit_code = 'BOTOL'`, `base_unit = 'Botol'`. |
| **C2. Kanonik: `canonical_base_unit_code = 'KALENG'` (berbeda dari satuan existing)** | **200 OK** — Set `canonical_base_unit_code = 'KALENG'`, `base_unit = 'Kaleng'`. | **409 Conflict** (`BASE_UNIT_LOCKED_BY_INVENTORY_USAGE`) — Ditolak. | **200 OK** — Set `canonical_base_unit_code = 'KALENG'`, `base_unit = 'Kaleng'`. (Kemasan nonaktif lama tetap ber-`base_unit_code = 'BOTOL'`). | **409 Conflict** (`BASE_UNIT_HAS_ACTIVE_PACKAGING` atau `BASE_UNIT_LOCKED_BY_INVENTORY_USAGE`) — **Ditolak!** |
| **C3. Kanonik: `canonical_base_unit_code = null` atau `""`** | **200 OK** — Set `canonical_base_unit_code = NULL`, `base_unit = NULL`. | **409 Conflict** (`BASE_UNIT_LOCKED_BY_INVENTORY_USAGE`) — Ditolak. | **200 OK** — Set `canonical_base_unit_code = NULL`, `base_unit = NULL`. | **409 Conflict** (`BASE_UNIT_HAS_ACTIVE_PACKAGING` atau `BASE_UNIT_LOCKED_BY_INVENTORY_USAGE`) — **Ditolak!** |
| **C4. Kanonik: `canonical_base_unit_code` tidak dikenal (`'GALON_X'`) atau `base_unit` bertentangan (`code='KG'`, `base_unit='Liter'`)** | **400 Bad Request** (`INVALID_CANONICAL_UNIT_CODE` / `UNIT_LABEL_MISMATCH`). | **400 Bad Request**. | **400 Bad Request**. | **400 Bad Request**. |

*(Untuk `POST /api/pos/menu/items` produk baru: mengikuti kolom "Produk Belum Terpetakan — Tidak Terkunci".)*

#### 3. Protokol Transaksi & Penguncian Konsisten (Concurrency Control)

Untuk mencegah kondisi balapan (*race condition*) antara perubahan satuan dasar produk dan pembuatan/reaktivasi kemasan (atau perubahan standar minibar), seluruh operasi tulis wajib mematuhi urutan penguncian berikut di dalam transaksi eksplisit (`BEGIN ... COMMIT`):

1. **Kunci Induk Produk Terlebih Dahulu (`Lock Ordering`):**
   Setiap `PATCH /api/pos/menu/items/:id`, `POST /api/pos/menu/items/:id/packagings`, dan `PATCH /api/pos/menu/items/:id/packagings/:packagingId` **wajib** mengawali transaksi dengan:
   ```sql
   SELECT id, property_id, base_unit, canonical_base_unit_code
   FROM pos_menu_items
   WHERE id = $1 AND property_id = $2
   FOR UPDATE;
   ```
2. **Serialisasi Penuh:**
   - Jika **Request A** (`PATCH` ubah satuan produk `#10` dari `'KG'` ke `'GRAM'`) dan **Request B** (`POST` tambah kemasan baru atau `PATCH` reaktivasi kemasan `'KG'` pada produk `#10`) datang bersamaan:
     - Bila **Request A** mendapat lock lebih dulu: Request A memverifikasi tidak ada kemasan aktif, mengubah `canonical_base_unit_code` menjadi `'GRAM'`, lalu `COMMIT`. Saat **Request B** memperoleh lock, Request B membaca `canonical_base_unit_code = 'GRAM'` (atau bila Request B adalah pembuatan kemasan yang mengirim ekspektasi satuan / reaktivasi kemasan ber-`base_unit_code = 'KG'`), sehingga Request B ditolak dengan **`409 PACKAGING_BASE_UNIT_MISMATCH`**.
     - Bila **Request B** mendapat lock lebih dulu: Request B membuat/mengaktifkan kemasan dengan `base_unit_code = 'KG'`, `is_active = TRUE`, lalu `COMMIT`. Saat **Request A** memperoleh lock, pemeriksaan kemasan aktif (serta trigger `pmi_guard_active_packaging_on_unit_change`) mendeteksi kemasan aktif dan menolak Request A dengan **`409 BASE_UNIT_HAS_ACTIVE_PACKAGING`**.

#### 4. Endpoint Kemasan per Produk
- **`GET /api/pos/menu/items/:id/packagings?property_id=<id>&include_inactive=true`**
  - Mengembalikan daftar kemasan untuk produk `:id` pada `property_id`, mencakup `id`, `packaging_code`, `packaging_label`, `base_unit_code`, `to_base_factor` (string desimal 3 digit), `to_base_factor_num` (display-only), `is_default_purchase`, `is_active`, `idempotency_key`, dan `is_compatible_with_current_base_unit` (`row.base_unit_code === item.canonical_base_unit_code`).
- **`POST /api/pos/menu/items/:id/packagings`**
  - Body: `{ property_id, packaging_code, packaging_label, base_unit_code, to_base_factor, is_default_purchase?, idempotency_key }`
  - Validasi & Idempotensi (di dalam transaksi setelah `SELECT ... FROM pos_menu_items WHERE id = $1 AND property_id = $2 FOR UPDATE`):
    - **`base_unit_code` WAJIB dikirim** pada endpoint pembuatan kemasan (diambil oleh UI dari snapshot satuan dasar produk saat pengguna membuka/mengisi form kemasan). Jika `base_unit_code` tidak disertakan atau tidak valid $\rightarrow$ `400 VALIDATION_ERROR` (`BASE_UNIT_CODE_REQUIRED` / `INVALID_CANONICAL_UNIT_CODE`).
    - **`idempotency_key` WAJIB dikirim** (string 1–150 karakter setelah trim, stabil untuk satu operasi pembuatan kemasan dan terikat pada `property_id`, `menu_item_id`, serta snapshot payload). Jika tidak disertakan $\rightarrow$ `400 VALIDATION_ERROR` (`IDEMPOTENCY_KEY_REQUIRED`).
    - Produk `:id` wajib milik `property_id` (`404` jika tidak ditemukan).
    - **Pemeriksaan Idempotency Key Terlebih Dahulu (di bawah lock produk):**
      - Periksa apakah sudah ada baris di `product_packaging_conversions` dengan `(property_id, menu_item_id, BTRIM(idempotency_key))`.
      - Jika **sudah ada**:
        - Bandingkan snapshot payload yang dikirim (`UPPER(BTRIM(packaging_code))`, `BTRIM(packaging_label)`, `base_unit_code`, `to_base_factor` kanonik 3 desimal, `Boolean(is_default_purchase)`) terhadap baris yang tersimpan.
        - Jika **identik**: kembalikan baris dan `id` yang sama (`200 OK` dengan `replayed: true`, tanpa membuat baris duplikat).
        - Jika **berbeda** (key yang sama dikirim dengan payload berbeda): tolak dengan **`409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`**.
    - **Pemeriksaan Satuan Dasar Produk Saat Ini (untuk Operasi Baru):**
      - Produk `:id` wajib memiliki `canonical_base_unit_code IS NOT NULL` (jika `NULL`: `409 BASE_UNIT_NOT_CANONICAL`).
      - Bandingkan `body.base_unit_code` terhadap `pos_menu_items.canonical_base_unit_code` saat ini (setelah mengunci baris produk). Jika berbeda $\rightarrow$ **tolak dengan `409 PACKAGING_BASE_UNIT_MISMATCH`**. Backend **dilarang keras** mengisi otomatis memakai satuan terbaru produk sehingga `to_base_factor` berubah makna.
    - `packaging_code` (1–30 karakter setelah trim) tidak boleh sama dengan `base_unit_code` (`400 PACKAGING_CODE_EQUALS_BASE_UNIT`) dan unik per produk (`409 PACKAGING_CODE_DUPLICATE`).
    - `packaging_label` (1–100 karakter setelah trim) unik per produk (`409 PACKAGING_LABEL_DUPLICATE`).
    - `to_base_factor` wajib berupa **`string` desimal** sesuai presisi dimensi `base_unit_code` (`400 VALIDATION_ERROR` jika bukan string, bernotasi ilmiah, atau melanggar batas/presisi).
- **`PATCH /api/pos/menu/items/:id/packagings/:packagingId`**
  - Body: `{ property_id, packaging_code?, packaging_label?, to_base_factor?, is_default_purchase?, is_active? }`
  - Validasi (di dalam transaksi setelah `SELECT ... FROM pos_menu_items FOR UPDATE`):
    - `base_unit_code` dan `idempotency_key` pada baris kemasan bersifat **immutable** (tidak dapat diubah).
    - Jika kemasan sedang aktif (`is_active = TRUE`) atau akan diaktifkan kembali (`is_active: true`): wajib `packaging.base_unit_code === item.canonical_base_unit_code`. Jika satuan dasar produk saat ini sudah berbeda (atau `NULL`), tolak dengan **`409 PACKAGING_BASE_UNIT_MISMATCH`**.
    - Jika kemasan tetap nonaktif (`is_active = FALSE`) tetapi `packaging.base_unit_code !== item.canonical_base_unit_code`: hanya mengizinkan koreksi `packaging_code` / `packaging_label` (atau penonaktifan), dan menolak perubahan `to_base_factor` atau `is_default_purchase: true` dengan **`409 PACKAGING_BASE_UNIT_MISMATCH`**.

#### 5. Endpoint Master Lokasi Stok & Kandidat Kamar per Properti
- **`GET /api/pos/stock-locations/room-candidates?property_id=<id>`**
  - **Izin & Scope:** Menggunakan guard `'Master Produk'` (`inventory.view` / `inventory.create` / `inventory.edit`) dan `assertPropertyScope(req, propertyId)`. Pengguna dengan akses **hanya** `'Master Produk'` dapat memanggil endpoint ini tanpa memerlukan izin `'Master Kamar'` (`GET /api/rooms` tetap terlindungi dan tidak diperluas izinnya).
  - **Response:** Hanya mengembalikan identitas kandidat kamar fisik untuk pengikatan minibar pada `property_id` tersebut (tanpa mengekspos status housekeeping, tamu, harga, atau mutasi kamar):
    ```json
    {
      "ok": true,
      "data": [
        {
          "room_id": 11,
          "room_number": "101",
          "room_type_id": 2,
          "room_type_name": "Deluxe King",
          "existing_stock_location_id": 5,
          "existing_stock_location_code": "MB-101",
          "is_available_for_minibar": false
        }
      ]
    }
    ```
  - Query mengambil nama tipe kamar kanonik melalui `LEFT JOIN room_types rt ON rt.id = r.room_type_id` (`COALESCE(rt.name, r.type)`) sesuai `AGENTS.md` §2.
- **`GET /api/pos/stock-locations?property_id=<id>&status=ACTIVE|INACTIVE|ALL&location_type=<type>`**
  - Mengembalikan daftar lokasi stok properti beserta info kamar (`room_number`, `room_type_name`) bila `location_type === 'ROOM_MINIBAR'`.
- **`POST /api/pos/stock-locations`**
  - Body: `{ property_id, code, name, location_type, room_id?, notes?, is_active? }`
  - Validasi:
    - `code` (1–50 karakter) unik per `property_id` (`409 LOCATION_CODE_DUPLICATE`).
    - `name` (1–120 karakter) unik per `property_id` (`409 LOCATION_NAME_DUPLICATE`).
    - `location_type` wajib salah satu dari `WAREHOUSE`, `KITCHEN`, `POS_OUTLET`, `HK_PANTRY`, `ROOM_MINIBAR`.
    - Jika `location_type === 'ROOM_MINIBAR'`: `room_id` wajib integer positif, kamar wajib ada di `rooms` dengan `property_id` yang sama (`403 CROSS_PROPERTY_ROOM_LOCATION` / `404 ROOM_NOT_FOUND`), dan belum terikat ke lokasi stok lain (`409 ROOM_MINIBAR_LOCATION_ALREADY_EXISTS`).
    - Jika `location_type !== 'ROOM_MINIBAR'` tetapi `room_id` diisi (`room_id !== undefined && room_id !== null`) $\rightarrow$ `400 VALIDATION_ERROR`.
- **`PATCH /api/pos/stock-locations/:id`**
  - Body: `{ property_id, code?, name?, notes?, is_active?, location_type?, room_id? }`
  - **Aturan Immutability Identitas Lokasi:**
    - Hanya `code`, `name`, `notes`, dan `is_active` yang dapat diubah.
    - `property_id` diverifikasi terhadap scope dan baris lokasi existing (`404` / `403` jika tidak cocok).
    - Jika `location_type` dikirim dan nilainya berbeda dari `existing.location_type` $\rightarrow$ **ditolak `409 STOCK_LOCATION_TYPE_IMMUTABLE`**.
    - Jika `room_id` dikirim dan nilainya berbeda dari `existing.room_id` (termasuk menghapus `room_id` menjadi `null` atau mengganti ke kamar lain) $\rightarrow$ **ditolak `409 STOCK_LOCATION_ROOM_BINDING_IMMUTABLE`**.

*(Catatan Guard: Prefix `/api/pos/stock-locations` didaftarkan pada `OPERATIONAL_ACCESS_RULES` di [`operationalAccessGuard.ts`](file:///e:/oak-hims-staging-pos-wa/backend/src/domains/settings/operationalAccessGuard.ts#L66-L70) dengan `resources: ['Master Produk']`.)*

---

## 6. Perilaku UI, Pemisahan Simpan Produk vs Kemasan, dan Pemulihan Retry Kemasan

### 6.1. Form Tambah/Edit Produk di [`ProductMasterPage.tsx`](file:///e:/oak-hims-staging-pos-wa/frontend/src/features/products/ProductMasterPage.tsx)
1. **Pemilihan Satuan Dasar Kanonik:**
   - Mengganti `<datalist>` bebas menjadi pemilih satuan terstruktur yang dikelompokkan berdasarkan dimensi (`Hitungan Diskrit`, `Berat`, `Volume`) dari `canonical_units`, ditambah opsi `"Belum diatur"`.
2. **Penanganan Produk Existing dengan Teks Lama (Dual-Read Compatibility):**
   - Jika produk existing memiliki `base_unit = NULL`: tampil `"Belum diatur"` dan saat disimpan ulang tanpa memilih satuan, tetap mengirim `null` (tidak dipaksa memilih satuan).
   - Jika produk existing memiliki `base_unit` teks lama dan `canonical_base_unit_code = NULL` (mis. `'Botol'` dari data Tahap 1 atau `'ikat'`):
     - Tabel Master Produk tetap menampilkan label `base_unit` tersebut dengan penanda halus `"Perlu konfirmasi satuan"`.
     - Saat modal Edit dibuka: jika user tidak mengubah field satuan, form tidak mengirim perubahan satuan (atau mempertahankan nilai lama); jika user memilih satuan dari daftar kanonik, `canonical_base_unit_code` dikirim secara eksplisit.
3. **Pemisahan Alur Simpan Produk dari Pengelolaan Kemasan (Pertahankan Mekanisme Retry Foto MP-02B):**
   - Pada **Modal Tambah Produk** (produk belum memiliki `id` tersimpan), UI **tidak** menampilkan form pembuatan kemasan inline. Modal Tambah Produk hanya menyimpan data inti produk (`POST /api/pos/menu/items`) beserta alur unggah/retry foto MP-02B (`pendingCreatedProduct` & `unconfirmedCreate` — **"Periksa Daftar Produk"**) tanpa perubahan perilaku.
   - Pada Modal Tambah Produk ditampilkan informasi ringkas: *"Kemasan pembelian/konversi dapat diatur melalui tombol Kelola Kemasan setelah produk disimpan."*

### 6.2. Dialog Tersendiri "Kelola Kemasan", Snapshot `base_unit_code`, & Identitas Operasi (`idempotency_key`) untuk Retry
1. **Dialog "Kelola Kemasan" (Hanya untuk Produk Tersimpan):**
   - Dibuka dari tombol aksi **"Kemasan"** pada baris produk di tabel Master Produk (atau tombol **"Kelola Kemasan"** di dalam modal Edit Produk setelah produk tersimpan dan memiliki `canonical_base_unit_code !== null`).
   - Menampilkan identitas produk, satuan dasar kanonik aktif saat ini (mis. `Kg`), daftar kemasan aktif maupun nonaktif (lengkap dengan `base_unit_code` masing-masing kemasan dan penanda apabila kemasan nonaktif memiliki `base_unit_code` yang berbeda dari satuan dasar produk saat ini sehingga tidak dapat diaktifkan kembali).
   - Saat pengguna membuka/mengisi form pembuatan kemasan baru, UI mengambil **snapshot `base_unit_code`** dari satuan dasar produk pada saat itu, serta menetapkan **`idempotency_key` stabil** untuk operasi pembuatan kemasan tersebut (terikat pada `property_id`, `menu_item_id`, dan snapshot payload).
   - Sub-form Tambah/Edit Kemasan memiliki tombol **Simpan Kemasan** dan **Batal** yang jelas (`VIEW → ADD/EDIT → BATAL / SIMPAN`). Selama request penyimpanan berlangsung (`savingPackaging = true`), tombol `×`, **Batal**, dan **Simpan Kemasan** di-disable serta handler penutupan dijaga agar tidak menutup dialog atau membuang draft.
2. **Protokol Pemulihan & Identitas Operasi Saat Respons `POST /api/pos/menu/items/:id/packagings` Tidak Pasti (`unconfirmedPackagingCreate`):**
   - `GET` daftar kemasan yang belum mengembalikan baris baru **hanya membuktikan baris belum terlihat saat pemeriksaan**, bukan bahwa `POST` sebelumnya sudah selesai atau pasti gagal.
   - Apabila request `POST` pembuatan kemasan mengalami kegagalan jaringan, timeout, HTTP `5xx`, JSON response tidak terbaca, atau respons `2xx` tanpa `data.id` bulat positif:
     1. UI **tidak** menutup form kemasan, **tidak** menghapus draft input, dan mempertahankan **`idempotency_key` beserta snapshot payload** (`packaging_code`, `packaging_label`, `base_unit_code`, `to_base_factor`, `is_default_purchase`) di dalam state `unconfirmedPackagingCreate`. Selama `unconfirmedPackagingCreate` aktif, field form dikunci terhadap snapshot tersebut agar `idempotency_key` tetap mengacu pada operasi yang sama.
     2. Pengiriman ulang `POST` langsung tanpa pemeriksaan **diblokir**, dan UI menampilkan pesan peringatan beserta tombol **"Periksa Daftar Kemasan"**.
     3. Saat pengguna menekan **"Periksa Daftar Kemasan"**, UI memanggil `GET /api/pos/menu/items/:id/packagings?property_id=<id>&include_inactive=true` dan melakukan rekonsiliasi berdasarkan **`idempotency_key`** serta snapshot:
        - **Jalur A — Terkonfirmasi Berhasil oleh `idempotency_key` Operasi Ini:**
          Ditemukan baris kemasan pada daftar server dengan **`row.idempotency_key === pendingOp.idempotency_key`** (dan cocok dengan snapshot `packaging_code`, `packaging_label`, `base_unit_code`, `to_base_factor`, `is_default_purchase`).
          $\rightarrow$ Sistem mengonfirmasi bahwa operasi ini telah tersimpan. State `unconfirmedPackagingCreate` dan draft dibersihkan, daftar kemasan diperbarui, dan notifikasi sukses ditampilkan.
        - **Jalur B — Terdeteksi Konflik dengan Kemasan dari Operasi Lain (`row.idempotency_key !== pendingOp.idempotency_key`):**
          Ditemukan baris kemasan dengan `packaging_code` (case-insensitive) **atau** `packaging_label` (case-insensitive) yang sama tetapi memiliki `idempotency_key` berbeda (baik field lainnya kebetulan mirip maupun berbeda).
          $\rightarrow$ **Dilarang dianggap sebagai bukti keberhasilan operasi ini!** Sistem melepas blokir `unconfirmedPackagingCreate`, memperbarui tabel daftar kemasan, **mempertahankan draft form** (dengan meregenerasi `idempotency_key` baru bila pengguna mengedit draft), dan menampilkan pesan error konflik agar user dapat meninjau atau mengubah kode/label.
        - **Jalur C — Baris Belum Terlihat saat Pemeriksaan (`No Match` pada `GET`) $\rightarrow$ Retry Aman dengan `idempotency_key` yang Sama:**
          Tidak ditemukan baris dengan `idempotency_key`, `packaging_code`, maupun `packaging_label` tersebut pada hasil `GET`.
          $\rightarrow$ Sistem mengizinkan pengguna menekan **Simpan Kemasan (Coba Lagi)** yang mengirim ulang `POST` menggunakan **`idempotency_key` dan snapshot payload yang persis sama** (selama pengguna tidak mengubah input draft). Karena backend menserialisasikan `POST` dengan `SELECT ... FROM pos_menu_items FOR UPDATE` dan memeriksa `idempotency_key`, maka meskipun `POST` pertama ternyata masih berjalan dan baru selesai sesaat setelah `GET`, retry `POST` kedua akan mengembalikan baris dan `id` yang sama (`replayed: true`) tanpa pernah menggandakan kemasan!
        - **Jalur D — Pemeriksaan `GET` Gagal / Tidak Valid / Basi (Stale):**
          Jika `GET` gagal (`5xx` / jaringan) atau respons tidak valid $\rightarrow$ pertahankan `unconfirmedPackagingCreate`, pertahankan `idempotency_key` dan snapshot draft, tetap blokir `POST` kedua, tampilkan error, dan izinkan mencoba **"Periksa Daftar Kemasan"** kembali.

### 6.3. Panel / Modal Kelola Lokasi Stok di Master Produk
- Dapat diakses dari header area Master Produk mengikuti permission `Master Produk` (`canView` untuk lihat, `canEdit`/`canCreate` untuk tambah/ubah).
- Mendukung filter berdasarkan tipe lokasi (`Gudang`, `Dapur`, `Outlet POS`, `Pantry HK`, `Minibar Kamar`) dan status (`Aktif`, `Nonaktif`, `Semua`).
- Saat menambah lokasi baru bertipe `ROOM_MINIBAR`, form memuat daftar kandidat kamar dari **`GET /api/pos/stock-locations/room-candidates?property_id=<id>`** dan hanya mengizinkan pemilihan kamar dengan `is_available_for_minibar === true`.
- Saat mengedit lokasi existing (`PATCH`), field **Tipe Lokasi** dan **Kamar Fisik** ditampilkan sebagai *read-only* (terkunci) sesuai aturan immutability identitas lokasi.

---

## 7. Contoh Skenario End-to-End

### 7.1. Skenario Kemasan Nonaktif Setelah Perubahan Satuan Dasar Produk
1. Produk `Biji Kopi House Blend` (`id = 15`) memiliki `canonical_base_unit_code = 'KG'` dan kemasan `KARUNG_25` (`packaging_label = 'Karung 25 Kg'`, `base_unit_code = 'KG'`, `to_base_factor = "25.000"`, `is_active = true`).
2. Admin mencoba mengubah satuan dasar produk menjadi `'GRAM'` $\rightarrow$ **Ditolak `409 BASE_UNIT_HAS_ACTIVE_PACKAGING`**.
3. Admin menonaktifkan kemasan `KARUNG_25` (`PATCH .../packagings/1` dengan `{ is_active: false }`) $\rightarrow$ **Berhasil `200 OK`**.
4. Admin mengubah satuan dasar produk menjadi `'GRAM'` (`PATCH /api/pos/menu/items/15` dengan `{ canonical_base_unit_code: 'GRAM' }`) $\rightarrow$ **Berhasil `200 OK`**. Kemasan nonaktif `KARUNG_25` tetap menampilkan `25.000 KG (Nonaktif — satuan dasar berbeda)`.
5. Admin mencoba mengaktifkan kembali `KARUNG_25` (`PATCH .../packagings/1` dengan `{ is_active: true }`) $\rightarrow$ **Ditolak `409 PACKAGING_BASE_UNIT_MISMATCH`** karena `KARUNG_25.base_unit_code ('KG') !== item.canonical_base_unit_code ('GRAM')`. Faktor `25.000` tidak pernah berubah makna menjadi `25.000 GRAM`.

### 7.2. Skenario PATCH Legacy pada Produk Terkunci vs Setara
1. Produk `Cola Can 330ml` (`id = 25`) memiliki `canonical_base_unit_code = 'KALENG'`, `base_unit = 'Kaleng'`, dan memiliki kemasan aktif `KARTON_24` (`is_active = true`).
2. Caller lama mengirim `PATCH /api/pos/menu/items/25` dengan `{ property_id: 1, price: 25000, base_unit: 'kaleng' }` (atau `'klg'`, tanpa `canonical_base_unit_code`):
   - Karena `'kaleng'`/`'klg'` setara dengan `'KALENG'`, server **mempertahankan** `canonical_base_unit_code = 'KALENG'` dan `base_unit = 'Kaleng'` serta memperbarui `price = 25000` (**`200 OK`**).
3. Caller lama mengirim `PATCH /api/pos/menu/items/25` dengan `{ property_id: 1, base_unit: 'Botol' }` atau `{ property_id: 1, base_unit: 'ikat' }` atau `{ property_id: 1, base_unit: null }` (tanpa `canonical_base_unit_code`):
   - Server **menolak dengan `409 BASE_UNIT_HAS_ACTIVE_PACKAGING`** dan **tidak** melepas `canonical_base_unit_code` menjadi `NULL`.

### 7.3. Skenario Lokasi Stok & Kandidat Kamar dengan Izin Hanya `Master Produk`
1. Staf Gudang/Inventory login dengan role yang memiliki izin `'Master Produk'` (`view: true, edit: true`), tetapi **tanpa** izin `'Master Kamar'` (`view: false`).
2. Saat membuka modal Tambah Lokasi Stok dan memilih tipe `ROOM_MINIBAR`, UI memanggil `GET /api/pos/stock-locations/room-candidates?property_id=1` $\rightarrow$ **Berhasil `200 OK`**, mengembalikan daftar kamar Properti `#1` beserta status ketersediaan minibar.
3. Jika staf tersebut mencoba mengakses `GET /api/rooms?property_id=1` $\rightarrow$ **Ditolak `403 FORBIDDEN`** (izin `'Master Kamar'` tidak bocor).
4. Setelah lokasi `MB-101` (`location_type = 'ROOM_MINIBAR'`, `room_id = 11`) dibuat, percobaan `PATCH /api/pos/stock-locations/5` untuk mengubah `room_id: 12` atau `location_type: 'WAREHOUSE'` $\rightarrow$ **Ditolak `409 STOCK_LOCATION_ROOM_BINDING_IMMUTABLE` / `STOCK_LOCATION_TYPE_IMMUTABLE`**.

---

## 8. Batas Implementasi Minimum (MP-03C) & Kriteria Penerimaan (Acceptance Tests)

### 8.1. Batas Implementasi Minimum Batch Berikutnya (MP-03C)
- **Termasuk dalam MP-03C:**
  1. Migrasi aditif & idempotent (`product_master_mp03c_v1.ts` + sinkronisasi `schema_v3.ts`) untuk kolom `canonical_base_unit_code`, tabel `product_packaging_conversions` (dengan `base_unit_code`), dan tabel `stock_locations` beserta constraint terproteksi `pg_constraint`, indeks unik, dan trigger konsistensi/immutability.
  2. Modul domain & handler backend untuk validasi satuan kanonik, matriks kompatibilitas `PATCH`, penguncian transaksi `SELECT ... FOR UPDATE`, CRUD kemasan produk, CRUD lokasi stok, dan endpoint `GET /api/pos/stock-locations/room-candidates`.
  3. Pembaruan UI `ProductMasterPage.tsx` untuk pemilihan satuan kanonik, dialog tersendiri **Kelola Kemasan** (dengan mekanisme pemulihan `unconfirmedPackagingCreate` — **"Periksa Daftar Kemasan"**), serta modal **Kelola Lokasi Stok** (dengan tetap menjaga alur retry foto MP-02B pada tambah/edit produk).
  4. Suite regression test backend & frontend yang mencakup seluruh acceptance test di bawah.
- **TIDAK Termasuk dalam MP-03C (Out of Scope):**
  - Tidak mengubah atau memasang FK pada `transaction_lines.product_id`.
  - Tidak memotong stok otomatis saat penjualan POS atau konsumsi minibar.
  - Tidak menghitung HPP/resep (BOM) atau memposting tagihan minibar ke folio.

### 8.2. Daftar Acceptance Tests Wajib (untuk MP-03C)

1. **Ikatan Satuan pada Kemasan Nonaktif (`PACKAGING_BASE_UNIT_MISMATCH`):**
   - Buat produk bersatuan `'KG'`, tambahkan kemasan `Karung` (`to_base_factor = "25.000"`, `base_unit_code = 'KG'`), nonaktifkan kemasan tersebut (`is_active = false`), lalu ubah satuan produk menjadi `'GRAM'` (`200 OK`).
   - Verifikasi baris kemasan nonaktif tetap menyimpan `base_unit_code = 'KG'` dan `to_base_factor = "25.000"`.
   - Percobaan mengaktifkan kembali (`is_active: true`) atau mengubah `to_base_factor` pada kemasan `Karung` saat satuan produk masih `'GRAM'` **ditolak dengan `409 PACKAGING_BASE_UNIT_MISMATCH`**.
   - Jika satuan produk dikembalikan ke `'KG'`, reaktivasi kemasan `Karung` kembali diizinkan (`200 OK`).

2. **Matriks PATCH Legacy pada Produk Belum Terpetakan & Produk Terkunci:**
   - Produk belum terpetakan (`base_unit = NULL` atau `'ikat'`): `PATCH` field lain mempertahankan satuan; `PATCH` legacy dengan teks baru memperbarui `base_unit` dengan `canonical_base_unit_code = NULL`.
   - Produk sudah kanonik (`canonical_base_unit_code = 'BOTOL'`) dan **terkunci** (punya kemasan aktif atau referensi minibar):
     - `PATCH` legacy dengan `base_unit` dihilangkan (`undefined`) atau berisi label/alias setara (`'Botol'`, `'botol'`, `'btl'`) **berhasil (`200 OK`)** dan **mempertahankan `canonical_base_unit_code = 'BOTOL'`**.
     - `PATCH` legacy dengan `base_unit` berbeda (`'Kaleng'`), teks tidak dikenal (`'ikat'`), maupun `null`/`""` **ditolak dengan `409`** dan tidak melepas `canonical_base_unit_code`.

3. **Perubahan Bersamaan (Concurrency Serialization) & Perubahan Satuan Saat Form Kemasan Terbuka:**
   - Simulasikan dua transaksi konkuren pada produk yang sama (`canonical_base_unit_code = 'KG'`): satu transaksi menjalankan `PATCH` ubah satuan produk ke `'GRAM'`, dan transaksi lainnya menjalankan `POST` tambah kemasan dengan `base_unit_code: 'KG'` (atau `PATCH` reaktivasi kemasan `'KG'`).
   - Verifikasi penguncian `SELECT ... FROM pos_menu_items FOR UPDATE` menserialisasikan kedua operasi sehingga tepat satu transaksi berhasil dan transaksi kedua ditolak deterministik dengan `409` (`BASE_UNIT_HAS_ACTIVE_PACKAGING` atau `PACKAGING_BASE_UNIT_MISMATCH`), tanpa pernah menghasilkan kemasan aktif ber-`base_unit_code = 'KG'` pada produk bersatuan `'GRAM'`.
   - Verifikasi `POST /api/pos/menu/items/:id/packagings` menolak request tanpa `base_unit_code` (`400 BASE_UNIT_CODE_REQUIRED`), dan menolak request ketika satuan produk telah berubah sejak pengguna membuka form kemasan (`409 PACKAGING_BASE_UNIT_MISMATCH`).

4. **Immutability Identitas Lokasi & Akses Pengguna Hanya `Master Produk`:**
   - Pengguna dengan permission hanya `'Master Produk'` (tanpa `'Master Kamar'`) berhasil memanggil `GET /api/pos/stock-locations/room-candidates?property_id=<id>` (`200 OK`), namun tetap ditolak saat memanggil `GET /api/rooms` (`403 FORBIDDEN`).
   - Lokasi `ROOM_MINIBAR` menolak kamar lintas properti (`403`) dan menolak duplikasi kamar dalam properti yang sama (`409`).
   - Pada lokasi stok yang sudah tersimpan, `PATCH` untuk mengubah `location_type` atau `room_id` **ditolak dengan `409`** (`STOCK_LOCATION_TYPE_IMMUTABLE` / `STOCK_LOCATION_ROOM_BINDING_IMMUTABLE`), sedangkan perubahan `code`, `name`, `notes`, dan `is_active` berhasil (`200 OK`).

5. **Pemisahan Dialog Kemasan, Identitas Operasi (`idempotency_key`), & Retry Saat `POST` Pertama Masih Berjalan:**
   - Modal Tambah Produk tetap menjaga alur retry foto & "Periksa Daftar Produk" MP-02B; dialog **Kelola Kemasan** hanya dibuka untuk produk yang sudah memiliki ID tersimpan.
   - `POST /api/pos/menu/items/:id/packagings` dengan `idempotency_key` dan snapshot payload identik mengembalikan hasil dan `id` kemasan yang sama (`replayed: true`), sedangkan `idempotency_key` yang sama dengan payload berbeda ditolak (`409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`).
   - Saat `POST /api/pos/menu/items/:id/packagings` menghasilkan respons tidak pasti (500 / jaringan putus / `201` tanpa `id`), form kemasan tidak tertutup, `idempotency_key` dan snapshot draft dipertahankan, dan `POST` langsung kedua diblokir.
   - Klik **"Periksa Daftar Kemasan"** (`GET` rekonsiliasi):
     - Jika `GET` gagal (`500`): form, `idempotency_key`, snapshot, dan blokir `POST` tetap dipertahankan.
     - Jika `GET` mengembalikan baris dengan `idempotency_key` yang sama dan cocok eksak dengan snapshot: dianggap berhasil dan form dibersihkan.
     - Jika `GET` mengembalikan baris dari operasi lain (`idempotency_key` berbeda, meskipun field mirip atau kode/label bentrok): **tidak dianggap sebagai bukti keberhasilan operasi ini**, tampilkan error konflik, dan pertahankan draft agar user dapat mengoreksi.
     - Jika `GET` belum menemukan baris tersebut (baik karena `POST` pertama gagal maupun karena `POST` pertama masih berjalan di belakang layar): retry `POST` menggunakan `idempotency_key` dan snapshot yang sama menghasilkan tepat satu kemasan dengan `id` yang konsisten tanpa duplikasi.

6. **Representasi String Desimal Otoritatif & Validasi Overflow Konversi:**
   - Input `to_base_factor` atau `quantity` berupa JSON `number` (`1000`, `24`), string notasi ilmiah (`"1e3"`), koma (`"0,250"`), atau $>3$ desimal (`"0.2505"`) ditolak dengan `400 VALIDATION_ERROR`.
   - Perkalian konversi kemasan (`packaging_qty = "10000"` $\times$ `to_base_factor = "100000.000"` = `1,000,000,000`) serta konversi intra-dimensi (`"1500000.000"` `KG` $\rightarrow$ `GRAM`) yang melampaui kapasitas `NUMERIC(12, 3)` (`999,999,999.999`) **ditolak dengan `422 CONVERSION_RESULT_OVERFLOW`**.
   - Konversi `"0.500"` `GRAM` $\rightarrow$ `KG` ditolak dengan `422 SUB_MILLI_UNIT_PRECISION_LOSS`, dan konversi lintas dimensi (`KG` $\leftrightarrow$ `LITER`) ditolak dengan `422 CROSS_DIMENSION_CONVERSION_FORBIDDEN`.

7. **Migrasi Dijalankan Dua Kali & Kesiapan Schema (Missing Optional Tables vs Query Error):**
   - Menjalankan fungsi migrasi MP-03C dua kali berturut-turut selesai dengan exit code `0` tanpa error duplikasi kolom, constraint (`pg_constraint`), indeks, maupun trigger.
   - Saat tabel opsional minibar belum ada di database (`to_regclass IS NULL`), `GET /api/pos/menu` dan `PATCH /api/pos/menu/items/:id` tetap berjalan normal (`200 OK`).
   - Saat pemeriksaan penggunaan pada tabel yang sudah ada mengalami kegagalan query DB, `PATCH` perubahan satuan dasar gagal secara *fail-closed* (`500`/`503`) dan tidak mengizinkan perubahan satuan.

---

## 9. Keputusan Bisnis Penghambat yang Tersisa

**Tidak ada keputusan bisnis penghambat (zero blocking decisions).**
Seluruh koreksi review MP-03B telah dikunci secara eksplisit dan siap diimplementasikan pada tahap **MP-03C**.
