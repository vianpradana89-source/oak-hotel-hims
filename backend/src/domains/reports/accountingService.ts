import { Pool } from 'pg';

let schemaInitialized = false;
const initializedProperties = new Set<number>();

const DEFAULT_SYSTEM_ACCOUNTS: Array<{
  account_number: string;
  account_name: string;
  classification: string;
}> = [
  { account_number: '11101', account_name: 'Kas', classification: 'Kas & Bank' },
  { account_number: '11102', account_name: 'Bank', classification: 'Kas & Bank' },
  { account_number: '11105', account_name: 'Transfer BCA', classification: 'Kas & Bank' },
  { account_number: '11106', account_name: 'Qris', classification: 'Kas & Bank' },
  {
    account_number: '11200',
    account_name: 'Investasi jangka pendek dan surat berharga',
    classification: 'Investasi jangka pendek',
  },
  { account_number: '11300', account_name: 'Piutang', classification: 'Piutang' },
  { account_number: '11400', account_name: 'Persediaan Barang Dagang', classification: 'Persediaan' },
  { account_number: '12000', account_name: 'Aset Tetap', classification: 'Peralatan' },
  { account_number: '21000', account_name: 'Hutang Usaha', classification: 'Kewajiban Lancar' },
];

export async function ensureAccountingSchema(pool: Pool, propertyId = 1): Promise<void> {
  if (!schemaInitialized) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounting_coa_accounts (
        id SERIAL PRIMARY KEY,
        property_id INT NOT NULL DEFAULT 1,
        account_number VARCHAR(32) NOT NULL,
        account_name VARCHAR(160) NOT NULL,
        classification VARCHAR(80) NOT NULL DEFAULT 'Kas & Bank',
        opening_balance NUMERIC(16, 2) NOT NULL DEFAULT 0,
        opening_date DATE NULL,
        is_system BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (property_id, account_number)
      );

      CREATE TABLE IF NOT EXISTS accounting_bank_accounts (
        id SERIAL PRIMARY KEY,
        property_id INT NOT NULL DEFAULT 1,
        bank_name VARCHAR(120) NOT NULL,
        account_number VARCHAR(80) NOT NULL DEFAULT '-',
        account_holder VARCHAR(160) NOT NULL DEFAULT '-',
        balance NUMERIC(16, 2) NOT NULL DEFAULT 0,
        notes TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS accounting_investor_transfers (
        id SERIAL PRIMARY KEY,
        property_id INT NOT NULL DEFAULT 1,
        source_account VARCHAR(80) NOT NULL,
        investor_name VARCHAR(160) NOT NULL,
        amount NUMERIC(16, 2) NOT NULL DEFAULT 0,
        transfer_date DATE NOT NULL DEFAULT CURRENT_DATE,
        notes TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS accounting_fixed_assets (
        id SERIAL PRIMARY KEY,
        property_id INT NOT NULL DEFAULT 1,
        asset_code VARCHAR(80) NULL,
        asset_name VARCHAR(180) NOT NULL,
        category VARCHAR(100) NOT NULL DEFAULT 'Peralatan',
        storage_location VARCHAR(160) NULL DEFAULT '-',
        purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
        purchase_price NUMERIC(16, 2) NOT NULL DEFAULT 0,
        current_value NUMERIC(16, 2) NOT NULL DEFAULT 0,
        depreciation_rate NUMERIC(6, 2) NOT NULL DEFAULT 0,
        status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
        notes TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE accounting_fixed_assets
        ADD COLUMN IF NOT EXISTS storage_location VARCHAR(160) NULL DEFAULT '-';
      ALTER TABLE accounting_fixed_assets
        ADD COLUMN IF NOT EXISTS asset_code VARCHAR(80) NULL;
      ALTER TABLE accounting_fixed_assets
        ADD COLUMN IF NOT EXISTS brand VARCHAR(160) NULL DEFAULT '-';
      ALTER TABLE accounting_fixed_assets
        ADD COLUMN IF NOT EXISTS serial_number VARCHAR(160) NULL DEFAULT '-';
      ALTER TABLE accounting_fixed_assets
        ADD COLUMN IF NOT EXISTS photo_data_url TEXT NULL;

      UPDATE accounting_fixed_assets
      SET
        asset_code = CASE WHEN asset_code IS NOT NULL THEN UPPER(asset_code) ELSE NULL END,
        asset_name = UPPER(asset_name),
        category = UPPER(category),
        brand = CASE WHEN brand IS NOT NULL THEN UPPER(brand) ELSE '-' END,
        serial_number = CASE WHEN serial_number IS NOT NULL THEN UPPER(serial_number) ELSE '-' END,
        storage_location = CASE WHEN storage_location IS NOT NULL THEN UPPER(storage_location) ELSE '-' END,
        notes = CASE WHEN notes IS NOT NULL THEN UPPER(notes) ELSE NULL END
      WHERE
        asset_name IS DISTINCT FROM UPPER(asset_name)
        OR category IS DISTINCT FROM UPPER(category)
        OR (storage_location IS NOT NULL AND storage_location IS DISTINCT FROM UPPER(storage_location));

      CREATE TABLE IF NOT EXISTS accounting_asset_categories (
        id SERIAL PRIMARY KEY,
        property_id INT NOT NULL DEFAULT 1,
        category_name VARCHAR(100) NOT NULL,
        is_system BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (property_id, category_name)
      );

      CREATE TABLE IF NOT EXISTS accounting_manual_payables (
        id SERIAL PRIMARY KEY,
        property_id INT NOT NULL DEFAULT 1,
        supplier_name VARCHAR(160) NOT NULL,
        transaction_no VARCHAR(80) NOT NULL,
        total_amount NUMERIC(16, 2) NOT NULL DEFAULT 0,
        paid_amount NUMERIC(16, 2) NOT NULL DEFAULT 0,
        due_date DATE NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'UNPAID',
        notes TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE accounting_manual_payables ADD COLUMN IF NOT EXISTS proof_url TEXT NULL;
      ALTER TABLE accounting_manual_payables ADD COLUMN IF NOT EXISTS proof_filename TEXT NULL;
      ALTER TABLE accounting_manual_payables ADD COLUMN IF NOT EXISTS proof_data BYTEA NULL;
      ALTER TABLE accounting_manual_payables ADD COLUMN IF NOT EXISTS proof_mime_type VARCHAR(100) NULL;
      ALTER TABLE accounting_manual_payables ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100) NULL;
      ALTER TABLE accounting_manual_payables ADD COLUMN IF NOT EXISTS bank_account VARCHAR(100) NULL;
      ALTER TABLE accounting_manual_payables ADD COLUMN IF NOT EXISTS bank_holder VARCHAR(100) NULL;
      ALTER TABLE accounting_manual_payables ADD COLUMN IF NOT EXISTS supplier_email VARCHAR(160) NULL;
      ALTER TABLE accounting_manual_payables ADD COLUMN IF NOT EXISTS warehouse_code VARCHAR(40) NULL;

      CREATE TABLE IF NOT EXISTS accounting_manual_receivables (
        id SERIAL PRIMARY KEY,
        property_id INT NOT NULL DEFAULT 1,
        customer_name VARCHAR(160) NOT NULL,
        transaction_no VARCHAR(80) NOT NULL,
        total_amount NUMERIC(16, 2) NOT NULL DEFAULT 0,
        paid_amount NUMERIC(16, 2) NOT NULL DEFAULT 0,
        due_date DATE NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'UNPAID',
        notes TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tx_prop_type_date_active
        ON transactions(property_id, transaction_type, transaction_date)
        WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_tx_prop_res_active
        ON transactions(property_id, reservation_id)
        WHERE deleted_at IS NULL AND reservation_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tx_prop_booking_active
        ON transactions(property_id, booking_id)
        WHERE deleted_at IS NULL AND booking_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_hk_tasks_prop_active_room
        ON housekeeping_tasks(property_id, is_archived, status, room_id);
    `);
    schemaInitialized = true;
  }

  if (initializedProperties.has(propertyId)) {
    return;
  }

  for (const acc of DEFAULT_SYSTEM_ACCOUNTS) {
    await pool.query(
      `INSERT INTO accounting_coa_accounts
         (property_id, account_number, account_name, classification, opening_balance, is_system)
       VALUES ($1, $2, $3, $4, 0, TRUE)
       ON CONFLICT (property_id, account_number) DO NOTHING`,
      [propertyId, acc.account_number, acc.account_name, acc.classification]
    );
  }

  const catCountRes = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM accounting_asset_categories WHERE property_id = $1`,
    [propertyId]
  );
  if (Number(catCountRes.rows[0]?.cnt || 0) === 0) {
    const defaultAssetCategories = [
      'Peralatan',
      'Elektronik',
      'Furniture & Interior',
      'Kendaraan',
      'Bangunan & Renovasi',
    ];
    for (const cat of defaultAssetCategories) {
      await pool.query(
        `INSERT INTO accounting_asset_categories (property_id, category_name, is_system)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (property_id, category_name) DO NOTHING`,
        [propertyId, cat]
      );
    }
  }
  initializedProperties.add(propertyId);
}

export function computeDepreciatedValue(
  purchasePrice: number,
  currentValueOverride: number | null | undefined,
  depreciationRatePct: number,
  purchaseDateStr: string,
  asOfDateStr: string
): number {
  const price = Math.max(0, Number(purchasePrice) || 0);
  const baseVal =
    currentValueOverride !== null &&
    currentValueOverride !== undefined &&
    Number(currentValueOverride) > 0
      ? Number(currentValueOverride)
      : price;
  const rate = Math.max(0, Math.min(100, Number(depreciationRatePct) || 0));
  if (rate <= 0) return Math.round(baseVal);

  const pDate = new Date(`${String(purchaseDateStr).slice(0, 10)}T00:00:00Z`);
  const refDate = new Date(`${String(asOfDateStr).slice(0, 10)}T00:00:00Z`);
  if (isNaN(pDate.getTime()) || isNaN(refDate.getTime()) || refDate <= pDate) {
    return Math.round(baseVal);
  }
  const elapsedYears = (refDate.getTime() - pDate.getTime()) / (365.25 * 24 * 3600 * 1000);
  const depreciation = baseVal * (rate / 100) * elapsedYears;
  return Math.max(0, Math.round(baseVal - depreciation));
}

export interface AccountingHubContext {
  propertyId: number;
  startDate: string;
  endDate: string;
  cashOnHand: number;
  bankAccount: number;
  transferBank: number;
  qrisBalance: number;
  cardEdc: number;
  inventoryValue: number;
  allTimePiutangTotal: number;
  allTimePiutangItems: any[];
  periodPiutangItems: any[];
  roomSales: any[];
  posItemSales: any[];
  financialsData: any;
  pricingSettings?: any;
}

export async function buildAccountingSubledgerData(pool: Pool, ctx: AccountingHubContext) {
  await ensureAccountingSchema(pool, ctx.propertyId);

  const [
    coaRes,
    manualBanksRes,
    investorTransfersRes,
    fixedAssetsRes,
    assetCategoriesRes,
    manualPayablesRes,
    himsPurchasesRes,
    manualReceivablesRes,
    settledHimsArRes,
  ] = await Promise.all([
    pool.query(
      `SELECT id, property_id, account_number, account_name, classification,
              opening_balance::numeric(16,2) AS opening_balance,
              to_char(opening_date, 'YYYY-MM-DD') AS opening_date,
              is_system
       FROM accounting_coa_accounts
       WHERE property_id = $1
       ORDER BY account_number ASC, id ASC`,
      [ctx.propertyId]
    ),
    pool.query(
      `SELECT id, property_id, bank_name, account_number, account_holder,
              balance::numeric(16,2) AS balance, notes
       FROM accounting_bank_accounts
       WHERE property_id = $1
       ORDER BY id ASC`,
      [ctx.propertyId]
    ),
    pool.query(
      `SELECT id, property_id, source_account, investor_name,
              amount::numeric(16,2) AS amount,
              to_char(transfer_date, 'YYYY-MM-DD') AS transfer_date,
              notes,
              to_char(created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS created_at
       FROM accounting_investor_transfers
       WHERE property_id = $1
       ORDER BY transfer_date DESC, id DESC`,
      [ctx.propertyId]
    ),
    pool.query(
      `SELECT id, property_id,
              COALESCE(NULLIF(BTRIM(asset_code), ''), 'AST-' || LPAD(id::text, 4, '0')) AS asset_code,
              asset_name, category,
              COALESCE(NULLIF(BTRIM(brand), ''), '-') AS brand,
              COALESCE(NULLIF(BTRIM(serial_number), ''), '-') AS serial_number,
              photo_data_url,
              COALESCE(NULLIF(BTRIM(storage_location), ''), '-') AS storage_location,
              to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date,
              purchase_price::numeric(16,2) AS purchase_price,
              current_value::numeric(16,2) AS current_value,
              depreciation_rate::numeric(6,2) AS depreciation_rate,
              status, notes
       FROM accounting_fixed_assets
       WHERE property_id = $1
       ORDER BY purchase_date DESC, id DESC`,
      [ctx.propertyId]
    ),
    pool.query(
      `SELECT id, property_id, category_name, is_system
       FROM accounting_asset_categories
       WHERE property_id = $1
       ORDER BY is_system DESC, category_name ASC`,
      [ctx.propertyId]
    ),
    pool.query(
      `SELECT id, property_id, supplier_name, transaction_no,
              total_amount::numeric(16,2) AS total_amount,
              paid_amount::numeric(16,2) AS paid_amount,
              to_char(due_date, 'YYYY-MM-DD') AS due_date,
              status, notes,
              to_char(created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS tx_date,
              bank_name, bank_account, bank_holder, supplier_email,
              COALESCE(warehouse_code, '—') AS warehouse_code,
              proof_url, proof_filename, proof_mime_type
       FROM accounting_manual_payables
       WHERE property_id = $1
       ORDER BY created_at DESC, id DESC`,
      [ctx.propertyId]
    ),
    pool.query(
      `SELECT * FROM (
         SELECT
           t.id,
           t.transaction_no,
           to_char(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
           COALESCE(s.name, NULLIF(BTRIM(t.party_name), ''), 'Supplier / Vendor') AS supplier_name,
           COALESCE(NULLIF(BTRIM(t.description), ''), 'Pembelian Operasional / PO') AS notes,
           COALESCE(t.net_amount, 0)::numeric(16,2) AS total_amount,
           CASE
             WHEN UPPER(COALESCE(t.payment_status, 'UNPAID')) = 'PAID' THEN COALESCE(t.net_amount, 0)
             ELSE LEAST(COALESCE(t.net_amount, 0), COALESCE(pmt.total_paid, 0))
           END::numeric(16,2) AS paid_amount,
           NULL::text AS due_date,
           COALESCE(NULLIF(BTRIM(t.payment_method), ''), 'Cash') AS payment_method,
           UPPER(COALESCE(t.payment_status, 'UNPAID')) AS payment_status,
           s.bank_name,
           s.bank_account,
           s.bank_holder,
           s.email AS supplier_email,
           COALESCE(
             sl_po.code,
             (
               SELECT sl_gr.code
               FROM pos_goods_receipts gr
               JOIN stock_locations sl_gr ON sl_gr.id = gr.location_id
               WHERE (gr.transaction_id = t.id OR (t.po_id IS NOT NULL AND gr.po_id = t.po_id))
               LIMIT 1
             ),
             '—'
           ) AS warehouse_code,
           (
             SELECT json_build_object(
               'id', ta.id,
               'original_name', ta.original_name,
               'file_name', ta.file_name,
               'mime_type', ta.mime_type
             )
             FROM transaction_attachments ta
             WHERE ta.transaction_id = t.id AND ta.property_id = t.property_id
             ORDER BY CASE WHEN ta.attachment_purpose IN ('PAYMENT_PROOF', 'RECEIPT') THEN 0 ELSE 1 END, ta.id DESC
             LIMIT 1
           ) AS payment_proof_attachment
         FROM transactions t
         LEFT JOIN suppliers s ON s.id = t.supplier_id
         LEFT JOIN pos_purchase_orders ppo ON ppo.id = t.po_id AND ppo.property_id = t.property_id
         LEFT JOIN stock_locations sl_po ON sl_po.id = ppo.destination_location_id AND sl_po.property_id = t.property_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(pt.amount), 0)::numeric(16,2) AS total_paid
           FROM payment_transactions pt
           WHERE pt.transaction_id = t.id
             AND pt.status = 'SUCCESS'
             AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
         ) pmt ON TRUE
         WHERE t.property_id = $1
           AND t.transaction_type = 'PURCHASE'
           AND t.deleted_at IS NULL
           AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
           AND COALESCE(UPPER(t.approval_status), 'APPROVED') != 'REJECTED'

         UNION ALL

         SELECT
           ppo.id,
           ppo.po_number AS transaction_no,
           to_char(ppo.order_date, 'YYYY-MM-DD') AS tx_date,
           COALESCE(ps.name, 'Supplier PO') AS supplier_name,
           'Purchase Order POS' AS notes,
           COALESCE(ppo.total_estimated_amount, 0)::numeric(16,2) AS total_amount,
           CASE
             WHEN ppo.status = 'COMPLETED' THEN COALESCE(ppo.total_estimated_amount, 0)
             ELSE 0
           END::numeric(16,2) AS paid_amount,
           NULL::text AS due_date,
           'Cash' AS payment_method,
           CASE WHEN ppo.status = 'COMPLETED' THEN 'PAID' ELSE 'UNPAID' END AS payment_status,
           s_pos.bank_name,
           s_pos.bank_account,
           s_pos.bank_holder,
           COALESCE(s_pos.email, ps.email) AS supplier_email,
           COALESCE(sl_ppo.code, '—') AS warehouse_code,
           NULL::json AS payment_proof_attachment
         FROM pos_purchase_orders ppo
         LEFT JOIN pos_suppliers ps ON ps.id = ppo.supplier_id AND ps.property_id = ppo.property_id
         LEFT JOIN suppliers s_pos ON s_pos.id = COALESCE(ppo.canonical_supplier_id, ps.canonical_supplier_id)
         LEFT JOIN stock_locations sl_ppo ON sl_ppo.id = ppo.destination_location_id AND sl_ppo.property_id = ppo.property_id
         WHERE ppo.property_id = $1
           AND COALESCE(UPPER(ppo.status), 'DRAFT') = 'COMPLETED'
           AND COALESCE(UPPER(ppo.approval_status), 'APPROVED') = 'APPROVED'
           AND NOT EXISTS (
             SELECT 1
             FROM transactions t
             WHERE t.property_id = ppo.property_id
               AND t.transaction_type = 'PURCHASE'
               AND t.deleted_at IS NULL
               AND t.source_reference = ppo.po_number
           )
       ) combined_pur
       ORDER BY tx_date DESC, id DESC
       LIMIT 500`,
      [ctx.propertyId]
    ),
    pool.query(
      `SELECT id, property_id, customer_name, transaction_no,
              total_amount::numeric(16,2) AS total_amount,
              paid_amount::numeric(16,2) AS paid_amount,
              to_char(due_date, 'YYYY-MM-DD') AS due_date,
              status, notes,
              to_char(created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS tx_date
       FROM accounting_manual_receivables
       WHERE property_id = $1
       ORDER BY created_at DESC, id DESC`,
      [ctx.propertyId]
    ),
    pool.query(
      `SELECT
         COALESCE(b.bid, r.booking_number, t.transaction_no) AS bid,
         MAX(COALESCE(NULLIF(BTRIM(r.guest_name), ''), NULLIF(BTRIM(t.party_name), ''), 'Tamu Hotel')) AS guest_name,
         STRING_AGG(DISTINCT COALESCE(rm.room_number, '') || ' ' || COALESCE(rt.name, ''), ', ') AS room_summary,
         MIN(to_char(r.check_in::date, 'YYYY-MM-DD')) AS check_in,
         MAX(to_char(r.check_out::date, 'YYYY-MM-DD')) AS check_out,
         GREATEST(
           SUM(COALESCE(t.net_amount, 0)),
           MAX(COALESCE(r.total_price, 0)),
           COALESCE(MAX(pmt_sum.total_paid), 0)
         )::numeric(16,2) AS net_amount
       FROM transactions t
       JOIN reservations r ON r.id = t.reservation_id
       LEFT JOIN bookings b ON b.id = r.booking_id
       LEFT JOIN rooms rm ON rm.id = r.room_id
       LEFT JOIN room_types rt ON rt.id = COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot)
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(pt2.amount), 0) AS total_paid
         FROM payment_transactions pt2
         WHERE (pt2.transaction_id = t.id OR pt2.reservation_id = r.id)
           AND pt2.status = 'SUCCESS'
           AND pt2.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
       ) pmt_sum ON TRUE
       WHERE t.property_id = $1
         AND t.transaction_type = 'SALE'
         AND t.deleted_at IS NULL
         AND r.status = 'CHECKED_OUT'
         AND UPPER(COALESCE(t.payment_status, '')) = 'PAID'
         AND EXISTS (
           SELECT 1 FROM payment_transactions pt
           WHERE (pt.transaction_id = t.id OR pt.reservation_id = r.id)
             AND pt.status = 'SUCCESS'
             AND (
               COALESCE(pt.reference_code, '') ILIKE 'PELUNASAN-%'
               OR COALESCE(pt.reference_code, '') ILIKE 'PIUTANG-%'
             )
         )
       GROUP BY COALESCE(b.bid, r.booking_number, t.transaction_no)
       ORDER BY MAX(r.check_out) DESC
       LIMIT 100`,
      [ctx.propertyId]
    ),
  ]);

  // 1. Investor transfers aggregation
  const transfersBySource = new Map<string, number>();
  let periodInvestorTransfers = 0;
  for (const tr of investorTransfersRes.rows) {
    const amt = Math.max(0, Number(tr.amount) || 0);
    const src = String(tr.source_account || '').toUpperCase();
    const tDate = String(tr.transfer_date || '').slice(0, 10);
    if (tDate <= ctx.endDate) {
      transfersBySource.set(src, (transfersBySource.get(src) || 0) + amt);
    }
    if (tDate >= ctx.startDate && tDate <= ctx.endDate) {
      periodInvestorTransfers += amt;
    }
  }

  // 2. Fixed assets valuation
  const assetsItems = fixedAssetsRes.rows.map((a: any) => {
    const purchasePrice = Number(a.purchase_price) || 0;
    const currentOverride = Number(a.current_value) || purchasePrice;
    const depRate = Number(a.depreciation_rate) || 0;
    const effectiveValue = computeDepreciatedValue(
      purchasePrice,
      currentOverride,
      depRate,
      a.purchase_date,
      ctx.endDate
    );
    return {
      id: Number(a.id),
      property_id: Number(a.property_id || ctx.propertyId),
      asset_code: String(a.asset_code || `AST-${String(a.id).padStart(4, '0')}`),
      asset_name: String(a.asset_name || '-'),
      category: String(a.category || 'PERALATAN'),
      brand: String(a.brand || '-'),
      serial_number: String(a.serial_number || '-'),
      photo_data_url: a.photo_data_url ? String(a.photo_data_url) : null,
      storage_location: String(a.storage_location || '-'),
      purchase_date: String(a.purchase_date || ''),
      purchase_price: purchasePrice,
      current_value: effectiveValue,
      depreciation_rate: depRate,
      status: String(a.status || 'ACTIVE').toUpperCase(),
      notes: a.notes ? String(a.notes) : null,
    };
  });

  const activeAssets = assetsItems.filter(
    (a) => a.status === 'ACTIVE' || a.status === 'AKTIF'
  );
  const activeAssetsTotalValue = activeAssets.reduce((s, a) => s + a.current_value, 0);
  const periodAssetPurchases = assetsItems
    .filter((a) => a.purchase_date >= ctx.startDate && a.purchase_date <= ctx.endDate)
    .reduce((s, a) => s + a.purchase_price, 0);

  // 3. Payables (HIMS Purchases + Manual Payables)
  const payablesItems: Array<{
    id: string;
    source: 'HIMS_PURCHASE' | 'MANUAL';
    raw_id: number;
    supplier_name: string;
    transaction_no: string;
    tx_date: string;
    due_date: string | null;
    total_amount: number;
    paid_amount: number;
    remaining_amount: number;
    status: 'UNPAID' | 'PARTIAL' | 'PAID';
    notes: string | null;
    payment_method?: string;
    bank_name?: string | null;
    bank_account?: string | null;
    bank_holder?: string | null;
    supplier_email?: string | null;
    warehouse_code?: string | null;
    proof_url?: string | null;
    payment_proof_attachment?: any;
  }> = [];

  for (const p of himsPurchasesRes.rows) {
    const total = Math.max(0, Math.round(Number(p.total_amount) || 0));
    const paid = Math.max(0, Math.min(total, Math.round(Number(p.paid_amount) || 0)));
    const remaining = Math.max(0, total - paid);
    const status: 'UNPAID' | 'PARTIAL' | 'PAID' =
      remaining <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';
    const proofUrl = p.payment_proof_attachment
      ? `/api/transactions/${p.id}/attachments/${p.payment_proof_attachment.id}/file`
      : null;
    payablesItems.push({
      id: `HIMS-PUR-${p.id}`,
      source: 'HIMS_PURCHASE',
      raw_id: Number(p.id),
      supplier_name: String(p.supplier_name || '-'),
      transaction_no: String(p.transaction_no || `PO-${p.id}`),
      tx_date: String(p.tx_date || ''),
      due_date: p.due_date || null,
      total_amount: total,
      paid_amount: paid,
      remaining_amount: remaining,
      status,
      notes: p.notes ? String(p.notes) : null,
      payment_method: String(p.payment_method || 'Cash'),
      bank_name: p.bank_name || null,
      bank_account: p.bank_account || null,
      bank_holder: p.bank_holder || null,
      supplier_email: p.supplier_email || null,
      warehouse_code: p.warehouse_code || '—',
      proof_url: proofUrl,
      payment_proof_attachment: p.payment_proof_attachment || null,
    });
  }

  for (const mp of manualPayablesRes.rows) {
    const total = Math.max(0, Math.round(Number(mp.total_amount) || 0));
    const paid = Math.max(0, Math.min(total, Math.round(Number(mp.paid_amount) || 0)));
    const remaining = Math.max(0, total - paid);
    const status: 'UNPAID' | 'PARTIAL' | 'PAID' =
      remaining <= 0 || String(mp.status).toUpperCase() === 'PAID'
        ? 'PAID'
        : paid > 0
        ? 'PARTIAL'
        : 'UNPAID';
    payablesItems.push({
      id: `MANUAL-AP-${mp.id}`,
      source: 'MANUAL',
      raw_id: Number(mp.id),
      supplier_name: String(mp.supplier_name || '-'),
      transaction_no: String(mp.transaction_no || `HTG-${mp.id}`),
      tx_date: String(mp.tx_date || ''),
      due_date: mp.due_date || null,
      total_amount: total,
      paid_amount: status === 'PAID' ? total : paid,
      remaining_amount: status === 'PAID' ? 0 : remaining,
      status,
      notes: mp.notes ? String(mp.notes) : null,
      bank_name: mp.bank_name || null,
      bank_account: mp.bank_account || null,
      bank_holder: mp.bank_holder || null,
      supplier_email: mp.supplier_email || null,
      warehouse_code: mp.warehouse_code || '—',
      proof_url: (mp.proof_url || mp.proof_filename) ? `/api/reports/accounting/payables/${mp.id}/proof` : null,
      payment_proof_attachment: mp.proof_filename ? { id: mp.id, original_name: mp.proof_filename, file_name: mp.proof_filename, mime_type: mp.proof_mime_type || null } : null,
    });
  }

  payablesItems.sort((a, b) => b.tx_date.localeCompare(a.tx_date));
  const payablesTotalAmount = payablesItems.reduce((s, i) => s + i.total_amount, 0);
  const payablesPaidTotal = payablesItems.reduce((s, i) => s + i.paid_amount, 0);
  const payablesUnpaidTotal = payablesItems.reduce((s, i) => s + i.remaining_amount, 0);
  const payablesUnpaidCount = payablesItems.filter((i) => i.remaining_amount > 0).length;

  // 4. Receivables (Real HIMS Sheet Piutang + Manual Receivables)
  const receivablesItems: Array<{
    id: string;
    source: 'HIMS_RESERVATION' | 'MANUAL';
    raw_id: number | string;
    customer_name: string;
    transaction_no: string;
    tx_date: string;
    due_date: string | null;
    room_summary?: string;
    total_amount: number;
    paid_amount: number;
    remaining_amount: number;
    status: 'UNPAID' | 'PARTIAL' | 'PAID';
    notes: string | null;
  }> = [];

  const activePiutangBids = new Set<string>();
  for (const item of ctx.allTimePiutangItems || []) {
    const total = Math.max(0, Math.round(Number(item.net) || 0));
    const paid = Math.max(0, Math.round(Number(item.paid) || 0));
    const remaining = Math.max(0, Math.round(Number(item.remaining) || 0));
    const status: 'UNPAID' | 'PARTIAL' | 'PAID' =
      remaining <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';
    const bidStr = String(item.bid || '-');
    activePiutangBids.add(bidStr);
    receivablesItems.push({
      id: `HIMS-AR-${bidStr}`,
      source: 'HIMS_RESERVATION',
      raw_id: bidStr,
      customer_name: String(item.guest_name || '-'),
      transaction_no: bidStr,
      tx_date: String(item.tx_date || item.check_in || ''),
      due_date: item.check_out || null,
      room_summary: String(item.room_summary || ''),
      total_amount: total,
      paid_amount: paid,
      remaining_amount: remaining,
      status,
      notes: 'Reservasi Check-Out Belum Lunas (Sheet Piutang)',
    });
  }

  for (const sItem of settledHimsArRes.rows) {
    const bidStr = String(sItem.bid || '-');
    if (activePiutangBids.has(bidStr)) continue;
    const total = Math.max(0, Math.round(Number(sItem.net_amount) || 0));
    if (total <= 0) continue;
    receivablesItems.push({
      id: `HIMS-AR-${bidStr}`,
      source: 'HIMS_RESERVATION',
      raw_id: bidStr,
      customer_name: String(sItem.guest_name || '-'),
      transaction_no: bidStr,
      tx_date: String(sItem.check_in || ''),
      due_date: sItem.check_out || null,
      room_summary: String(sItem.room_summary || '').trim(),
      total_amount: total,
      paid_amount: total,
      remaining_amount: 0,
      status: 'PAID',
      notes: 'Reservasi Piutang Lunas (Sheet Selesai)',
    });
  }

  for (const mr of manualReceivablesRes.rows) {
    const total = Math.max(0, Math.round(Number(mr.total_amount) || 0));
    const paid = Math.max(0, Math.min(total, Math.round(Number(mr.paid_amount) || 0)));
    const remaining = Math.max(0, total - paid);
    const status: 'UNPAID' | 'PARTIAL' | 'PAID' =
      remaining <= 0 || String(mr.status).toUpperCase() === 'PAID'
        ? 'PAID'
        : paid > 0
        ? 'PARTIAL'
        : 'UNPAID';
    receivablesItems.push({
      id: `MANUAL-AR-${mr.id}`,
      source: 'MANUAL',
      raw_id: Number(mr.id),
      customer_name: String(mr.customer_name || '-'),
      transaction_no: String(mr.transaction_no || `PTG-${mr.id}`),
      tx_date: String(mr.tx_date || ''),
      due_date: mr.due_date || null,
      total_amount: total,
      paid_amount: status === 'PAID' ? total : paid,
      remaining_amount: status === 'PAID' ? 0 : remaining,
      status,
      notes: mr.notes ? String(mr.notes) : null,
    });
  }

  receivablesItems.sort((a, b) => b.tx_date.localeCompare(a.tx_date));
  const receivablesTotalAmount = receivablesItems.reduce((s, i) => s + i.total_amount, 0);
  const receivablesPaidTotal = receivablesItems.reduce((s, i) => s + i.paid_amount, 0);
  const receivablesUnpaidTotal = receivablesItems.reduce((s, i) => s + i.remaining_amount, 0);
  const receivablesUnpaidCount = receivablesItems.filter((i) => i.remaining_amount > 0).length;

  // 5. Manual Banks
  const manualBanksTotal = manualBanksRes.rows.reduce(
    (s: number, b: any) => s + (Number(b.balance) || 0),
    0
  );

  // 6. Chart of Accounts (COA) live balances
  const coaAccounts = coaRes.rows.map((row: any) => {
    const accNum = String(row.account_number || '').trim();
    const opening = Number(row.opening_balance) || 0;
    const deductedByAccNum = transfersBySource.get(accNum.toUpperCase()) || 0;
    let liveMovement = 0;

    if (accNum === '11101') {
      liveMovement = ctx.cashOnHand - (transfersBySource.get('CASH') || 0);
    } else if (accNum === '11102') {
      liveMovement = ctx.bankAccount + manualBanksTotal - (transfersBySource.get('BANK') || 0);
    } else if (accNum === '11105') {
      liveMovement =
        ctx.transferBank -
        (transfersBySource.get('TRANSFER_BANK') || 0) -
        (transfersBySource.get('TRANSFER BANK') || 0);
    } else if (accNum === '11106') {
      liveMovement = ctx.qrisBalance - (transfersBySource.get('QRIS') || 0);
    } else if (accNum === '11300') {
      liveMovement = receivablesUnpaidTotal;
    } else if (accNum === '11400') {
      liveMovement = ctx.inventoryValue;
    } else if (accNum === '12000') {
      liveMovement = activeAssetsTotalValue;
    } else if (accNum === '21000') {
      liveMovement = payablesUnpaidTotal;
    }

    const currentBalance = Math.max(0, Math.round(opening + liveMovement - deductedByAccNum));
    return {
      id: Number(row.id),
      property_id: Number(row.property_id || ctx.propertyId),
      account_number: accNum,
      account_name: String(row.account_name || ''),
      classification: String(row.classification || 'Kas & Bank'),
      opening_balance: Math.round(opening),
      opening_date: row.opening_date || null,
      current_balance: currentBalance,
      is_system: Boolean(row.is_system),
    };
  });

  // 7. Bank List (Auto HIMS payment methods + Manual banks)
  const autoBankList = [
    {
      id: 'AUTO-CASH',
      bank_name: 'Cash',
      account_number: '-',
      account_holder: '-',
      balance: Math.max(
        0,
        Math.round(
          ctx.cashOnHand -
            (transfersBySource.get('CASH') || 0) -
            (transfersBySource.get('11101') || 0)
        )
      ),
      source_type: 'AUTO' as const,
      method_code: 'CASH',
    },
    {
      id: 'AUTO-TRANSFER',
      bank_name: 'Transfer Bank',
      account_number: '-',
      account_holder: '-',
      balance: Math.max(
        0,
        Math.round(
          ctx.transferBank -
            (transfersBySource.get('TRANSFER_BANK') || 0) -
            (transfersBySource.get('TRANSFER BANK') || 0) -
            (transfersBySource.get('11105') || 0)
        )
      ),
      source_type: 'AUTO' as const,
      method_code: 'TRANSFER_BANK',
    },
    {
      id: 'AUTO-QRIS',
      bank_name: 'QRIS',
      account_number: '-',
      account_holder: '-',
      balance: Math.max(
        0,
        Math.round(
          ctx.qrisBalance -
            (transfersBySource.get('QRIS') || 0) -
            (transfersBySource.get('11106') || 0)
        )
      ),
      source_type: 'AUTO' as const,
      method_code: 'QRIS',
    },
    ...(ctx.cardEdc > 0
      ? [
          {
            id: 'AUTO-EDC',
            bank_name: 'EDC / Kartu Debit & Kredit',
            account_number: '-',
            account_holder: '-',
            balance: Math.max(
              0,
              Math.round(ctx.cardEdc - (transfersBySource.get('EDC') || 0))
            ),
            source_type: 'AUTO' as const,
            method_code: 'EDC',
          },
        ]
      : []),
    {
      id: 'AUTO-AR',
      bank_name: 'PIUTANG',
      account_number: '-',
      account_holder: '-',
      balance: Math.max(0, Math.round(receivablesUnpaidTotal)),
      source_type: 'AUTO' as const,
      method_code: 'AR',
    },
  ];

  const manualBankList = manualBanksRes.rows.map((b: any) => {
    const bankNameUpper = String(b.bank_name || '').toUpperCase();
    const deducted = transfersBySource.get(bankNameUpper) || 0;
    return {
      id: `MANUAL-BANK-${b.id}`,
      bank_name: String(b.bank_name || ''),
      account_number: String(b.account_number || '-'),
      account_holder: String(b.account_holder || '-'),
      balance: Math.max(0, Math.round((Number(b.balance) || 0) - deducted)),
      source_type: 'MANUAL' as const,
      manual_id: Number(b.id),
    };
  });

  const bankList = [...autoBankList, ...manualBankList];

  // 8. General Journal (Jurnal Umum)
  const rawJournal: Array<{
    sortKey: string;
    id: string;
    bid_or_ref: string;
    badge_type: 'Penjualan' | 'Pemasukan' | 'Pengeluaran' | 'Pembelian' | 'Transfer Investor';
    tx_date: string;
    tx_datetime: string;
    description: string;
    payment_method: string;
    cash_in: number;
    cash_out: number;
  }> = [];

  for (const r of ctx.roomSales || []) {
    if (r.is_complimentary) continue;
    const pMethod = String(r.payment_method || '').trim();
    const pMethodUpper = pMethod.toUpperCase();
    const pStatusUpper = String(r.payment_status || '').toUpperCase();
    if (pMethodUpper.includes('BELUM BAYAR') || pMethodUpper.includes('PIUTANG')) continue;
    const paidAmt = Math.round(Number(r.amount_paid) || 0);
    const totalAmt = Math.round(Number(r.total_price) || 0);
    const isPaidOrOtaCollect =
      pStatusUpper === 'PAID' ||
      pStatusUpper === 'LUNAS' ||
      pMethodUpper === 'OTA COLLECT';
    const amount = paidAmt > 0 ? paidAmt : isPaidOrOtaCollect ? totalAmt : 0;
    if (amount <= 0) continue;
    const txDate = String(r.tx_date || r.check_in || '').slice(0, 10);
    const txDatetime = r.tx_datetime ? String(r.tx_datetime).slice(0, 16) : `${txDate}, 14.00`;
    const stayLabel =
      String(r.stay_type || '').toUpperCase() === 'DAY_USE'
        ? 'Day Use'
        : `${r.nights || 1} malam`;
    rawJournal.push({
      sortKey: `${txDate}_1_${r.booking_code || r.reservation_id}`,
      id: `JRN-RM-${r.reservation_id}`,
      bid_or_ref: String(r.booking_code || `RES-${r.reservation_id}`),
      badge_type: 'Penjualan',
      tx_date: txDate,
      tx_datetime: txDatetime,
      description: `Booking ${r.guest_name || 'Tamu'} (${r.check_in || txDate} - ${r.check_out || txDate}, ${stayLabel}) • Kamar ${r.room_number || '-'}`,
      payment_method: String(r.payment_method || 'Cash'),
      cash_in: amount,
      cash_out: 0,
    });
  }

  for (const p of ctx.posItemSales || []) {
    if (p.is_complimentary) continue;
    const pStatusUpper = String(p.payment_status || 'PAID').toUpperCase();
    const pMethodUpper = String(p.payment_method || '').toUpperCase();
    if (
      ['UNPAID', 'OPEN', 'PENDING', 'BILL_TO_ROOM', 'BILLED_TO_ROOM'].includes(pStatusUpper) ||
      pMethodUpper.includes('BELUM BAYAR') ||
      pMethodUpper.includes('PIUTANG')
    ) {
      continue;
    }
    const amount = Math.round(Number(p.line_total) || 0);
    if (amount <= 0) continue;
    const txDate = String(p.tx_date || '').slice(0, 10);
    const txDatetime = p.tx_datetime ? String(p.tx_datetime).slice(0, 16) : `${txDate}, 12.00`;
    rawJournal.push({
      sortKey: `${txDate}_2_${p.booking_or_order_no || p.order_item_id}`,
      id: `JRN-POS-${p.order_item_id}`,
      bid_or_ref: String(p.booking_or_order_no || `POS-${p.order_id}`),
      badge_type: 'Penjualan',
      tx_date: txDate,
      tx_datetime: txDatetime,
      description: `POS ${p.item_name || 'Produk'} (${Number(p.quantity) || 1}x) — ${p.customer_name || 'Walk-In'}`,
      payment_method: String(p.payment_method || 'Cash'),
      cash_in: amount,
      cash_out: 0,
    });
  }

  for (const inc of ctx.financialsData?.other_income?.items || []) {
    if (String((inc as any).payment_status || 'PAID').toUpperCase() === 'UNPAID') continue;
    const amount = Math.round(Number(inc.net_amount) || 0);
    if (amount <= 0) continue;
    const txDate = String(inc.transaction_date || '').slice(0, 10);
    rawJournal.push({
      sortKey: `${txDate}_3_${inc.transaction_no || inc.id}`,
      id: `JRN-INC-${inc.id}`,
      bid_or_ref: String(inc.transaction_no || `INC-${inc.id}`),
      badge_type: 'Pemasukan',
      tx_date: txDate,
      tx_datetime: `${txDate}, 10.00`,
      description: `${inc.description || inc.category_name || 'Pemasukan Lain'} (${inc.party_name || '-'})`,
      payment_method: String(inc.payment_method || 'Cash'),
      cash_in: amount,
      cash_out: 0,
    });
  }

  for (const exp of ctx.financialsData?.expense?.items || []) {
    if (String((exp as any).payment_status || 'PAID').toUpperCase() === 'UNPAID') continue;
    const amount = Math.round(Number(exp.net_amount) || 0);
    if (amount <= 0) continue;
    const txDate = String(exp.transaction_date || '').slice(0, 10);
    rawJournal.push({
      sortKey: `${txDate}_4_${exp.transaction_no || exp.id}`,
      id: `JRN-EXP-${exp.id}`,
      bid_or_ref: String(exp.transaction_no || `EXP-${exp.id}`),
      badge_type: 'Pengeluaran',
      tx_date: txDate,
      tx_datetime: `${txDate}, 15.00`,
      description: `${exp.description || exp.category_name || 'Pengeluaran Operasional'}`,
      payment_method: String(exp.payment_method || 'Cash'),
      cash_in: 0,
      cash_out: amount,
    });
  }

  for (const pur of payablesItems) {
    if (pur.tx_date < ctx.startDate || pur.tx_date > ctx.endDate) continue;
    const paidAmt = Math.round(Number(pur.paid_amount) || 0);
    if (paidAmt <= 0) continue;
    rawJournal.push({
      sortKey: `${pur.tx_date}_5_${pur.transaction_no}`,
      id: `JRN-PUR-${pur.id}`,
      bid_or_ref: pur.transaction_no,
      badge_type: 'Pembelian',
      tx_date: pur.tx_date,
      tx_datetime: `${pur.tx_date}, 11.00`,
      description: `${pur.notes || 'Pembelian Barang'} — ${pur.supplier_name}`,
      payment_method: String(pur.payment_method || 'Cash'),
      cash_in: 0,
      cash_out: paidAmt,
    });
  }

  for (const tr of investorTransfersRes.rows) {
    const tDate = String(tr.transfer_date || '').slice(0, 10);
    if (tDate < ctx.startDate || tDate > ctx.endDate) continue;
    const amount = Math.round(Number(tr.amount) || 0);
    if (amount <= 0) continue;
    rawJournal.push({
      sortKey: `${tDate}_6_${tr.id}`,
      id: `JRN-INV-${tr.id}`,
      bid_or_ref: `INV-${tr.id}`,
      badge_type: 'Transfer Investor',
      tx_date: tDate,
      tx_datetime: String(tr.created_at || `${tDate}, 16.00`),
      description: `Transfer ke Investor: ${tr.investor_name}${tr.notes ? ` (${tr.notes})` : ''}`,
      payment_method: String(tr.source_account || 'Kas & Bank'),
      cash_in: 0,
      cash_out: amount,
    });
  }

  rawJournal.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  let runningBalance = 0;
  let totalIn = 0;
  let totalOut = 0;
  const journalRows = rawJournal.map((row, idx) => {
    totalIn += row.cash_in;
    totalOut += row.cash_out;
    runningBalance += row.cash_in - row.cash_out;
    return {
      row_no: idx + 1,
      id: row.id,
      bid_or_ref: row.bid_or_ref,
      badge_type: row.badge_type,
      tx_date: row.tx_date,
      tx_datetime: row.tx_datetime,
      description: row.description,
      payment_method: row.payment_method,
      cash_in: row.cash_in,
      cash_out: row.cash_out,
      running_balance: runningBalance,
    };
  });

  // 9. PPN Summary (Rekap Pajak PPN) & Service Charge Summary
  const taxPct = Number(
    ctx.pricingSettings?.tax_percentage ?? ctx.pricingSettings?.tax_percent ?? 11
  );
  const servicePct = Number(
    ctx.pricingSettings?.service_charge_percentage ??
      ctx.pricingSettings?.service_charge_percent ??
      0
  );

  const ppnRows: Array<{
    id: string;
    tx_date: string;
    ref_no: string;
    source: 'KAMAR' | 'POS' | 'PEMBELIAN';
    party_name: string;
    dpp_amount: number;
    ppn_amount: number;
    total_amount: number;
  }> = [];

  const serviceChargeRows: Array<{
    id: string;
    tx_date: string;
    ref_no: string;
    source: 'KAMAR' | 'POS';
    party_name: string;
    dpp_amount: number;
    service_amount: number;
    total_amount: number;
  }> = [];

  let roomTaxTotal = 0;
  let posTaxTotal = 0;
  const purchaseTaxTotal = 0;

  let roomServiceTotal = 0;
  let posServiceTotal = 0;

  for (const r of ctx.roomSales || []) {
    if (r.is_complimentary) continue;
    if (String(r.reservation_status || '').toUpperCase() === 'CANCELLED') continue;
    const payStatus = String(r.payment_status || '').trim().toUpperCase();
    const payMethod = String(r.payment_method || '').trim().toUpperCase();
    const remBal = Number(r.full_remaining_balance ?? r.remaining_balance ?? 0);
    if (payStatus !== 'PAID' || remBal > 0) continue;
    if (payMethod.includes('COMP') || payMethod.includes('BELUM BAYAR') || payMethod.includes('PIUTANG')) continue;
    if (payStatus.includes('COMP')) continue;
    const total = Math.round(Number(r.total_price) || 0);
    if (total <= 0) continue;
    const taxAmt = Math.round(Number(r.tax_amount) || 0);
    const svcAmt = Math.round(Number(r.service_amount) || 0);
    const txDate = String(r.tx_date || r.check_in || '').slice(0, 10);
    const refNo = String(r.booking_code || `RES-${r.reservation_id}`);
    const partyName = String(r.guest_name || '-');

    if (taxAmt > 0) {
      roomTaxTotal += taxAmt;
      ppnRows.push({
        id: `PPN-RM-${r.reservation_id}`,
        tx_date: txDate,
        ref_no: refNo,
        source: 'KAMAR',
        party_name: partyName,
        dpp_amount: Math.max(0, total - taxAmt - svcAmt),
        ppn_amount: taxAmt,
        total_amount: total,
      });
    }

    if (svcAmt > 0) {
      roomServiceTotal += svcAmt;
      serviceChargeRows.push({
        id: `SVC-RM-${r.reservation_id}`,
        tx_date: txDate,
        ref_no: refNo,
        source: 'KAMAR',
        party_name: partyName,
        dpp_amount: Math.max(0, total - taxAmt - svcAmt),
        service_amount: svcAmt,
        total_amount: total,
      });
    }
  }

  const posOrderMap = new Map<
    string,
    {
      id: string;
      tx_date: string;
      ref_no: string;
      party_name: string;
      total_amount: number;
      tax_amount: number;
      service_amount: number;
    }
  >();

  for (const p of ctx.posItemSales || []) {
    if (p.is_complimentary) continue;
    const posPayStatus = String(p.payment_status || '').trim().toUpperCase();
    const posPayMethod = String(p.payment_method || '').trim().toUpperCase();
    if (posPayStatus !== 'PAID') continue;
    if (posPayMethod.includes('COMP') || posPayMethod.includes('BELUM BAYAR') || posPayMethod.includes('PIUTANG')) continue;
    const key = String(p.order_id ?? p.transaction_id ?? p.order_item_id);
    const lineTotal = Math.round(Number(p.line_total) || 0);
    if (lineTotal <= 0) continue;
    const taxAmt = Math.round(Number(p.tax_amount) || 0);
    const svcAmt = Math.round(Number(p.service_amount) || 0);
    const existing = posOrderMap.get(key);
    if (!existing) {
      posOrderMap.set(key, {
        id: key,
        tx_date: String(p.tx_date || '').slice(0, 10),
        ref_no: String(p.booking_or_order_no || `POS-${p.order_id}`),
        party_name: String(p.customer_name || 'Walk-In'),
        total_amount: lineTotal,
        tax_amount: taxAmt,
        service_amount: svcAmt,
      });
    } else {
      existing.total_amount += lineTotal;
      if (taxAmt > existing.tax_amount) existing.tax_amount = taxAmt;
      if (svcAmt > existing.service_amount) existing.service_amount = svcAmt;
    }
  }

  for (const posOrd of posOrderMap.values()) {
    const dpp = Math.max(0, posOrd.total_amount);
    const grandTotal = dpp + posOrd.service_amount + posOrd.tax_amount;
    if (posOrd.tax_amount > 0) {
      posTaxTotal += posOrd.tax_amount;
      ppnRows.push({
        id: `PPN-POS-${posOrd.id}`,
        tx_date: posOrd.tx_date,
        ref_no: posOrd.ref_no,
        source: 'POS',
        party_name: posOrd.party_name,
        dpp_amount: dpp,
        ppn_amount: posOrd.tax_amount,
        total_amount: grandTotal,
      });
    }
    if (posOrd.service_amount > 0) {
      posServiceTotal += posOrd.service_amount;
      serviceChargeRows.push({
        id: `SVC-POS-${posOrd.id}`,
        tx_date: posOrd.tx_date,
        ref_no: posOrd.ref_no,
        source: 'POS',
        party_name: posOrd.party_name,
        dpp_amount: dpp,
        service_amount: posOrd.service_amount,
        total_amount: grandTotal,
      });
    }
  }

  // Also include any folio_entries or standalone transactions with service_amount > 0 not already in serviceChargeRows
  const extraSvcRes = await pool.query(
    `SELECT
       t.id,
       to_char(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
       COALESCE(b.bid, r.booking_number, t.transaction_no) AS ref_no,
       CASE
         WHEN UPPER(COALESCE(t.source_type, '')) IN ('POS', 'POS_ORDER')
           OR UPPER(COALESCE(t.category_code, '')) LIKE '%POS%'
           OR UPPER(COALESCE(t.category_code, '')) LIKE '%FNB%'
         THEN 'POS'
         ELSE 'KAMAR'
       END AS source,
       COALESCE(NULLIF(BTRIM(t.guest_name_snapshot), ''), NULLIF(BTRIM(t.party_name), ''), NULLIF(BTRIM(r.guest_name), ''), 'Tamu Hotel') AS party_name,
       COALESCE(t.amount, t.net_amount, 0)::numeric(14,2) AS gross_amount,
       COALESCE(t.service_amount, 0)::numeric(14,2) AS service_amount,
       COALESCE(t.net_amount, 0)::numeric(14,2) AS net_amount
     FROM transactions t
     LEFT JOIN reservations r ON r.id = t.reservation_id
     LEFT JOIN bookings b ON b.id = COALESCE(t.booking_id, r.booking_id)
     WHERE t.property_id = $1
       AND t.transaction_type IN ('SALE', 'INCOME')
       AND t.deleted_at IS NULL
       AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
       AND UPPER(COALESCE(t.payment_status, '')) = 'PAID'
       AND NOT EXISTS (
         SELECT 1 FROM transactions t_rev
         WHERE t_rev.property_id = t.property_id
           AND t_rev.reversal_of_transaction_id = t.id
           AND t_rev.deleted_at IS NULL
       )
       AND (r.id IS NULL OR (
         COALESCE(UPPER(r.status), '') NOT IN ('CANCELLED', 'NO_SHOW', 'VOID', 'VOIDED')
         AND COALESCE(UPPER(r.stay_status), '') NOT IN ('CANCELLED', 'NO_SHOW')
         AND COALESCE(r.discount_percent, 0) < 100
         AND COALESCE(r.total_price, 0) > 0
         AND UPPER(COALESCE(r.payment_status, '')) = 'PAID'
         AND COALESCE(r.remaining_balance, GREATEST(0, COALESCE(r.total_price, 0) - COALESCE(r.amount_paid, 0))) <= 0
         AND UPPER(COALESCE(r.payment_status, '')) NOT LIKE '%COMP%'
         AND UPPER(COALESCE(r.payment_status, '')) NOT LIKE '%FREE%'
         AND UPPER(COALESCE(r.payment_status, '')) NOT LIKE '%VOUCHER%'
         AND UPPER(COALESCE(r.special_requests, '')) NOT LIKE '%COMPLIMENT%'
         AND UPPER(COALESCE(r.special_requests, '')) NOT LIKE '%HOUSE USE%'
         AND NOT EXISTS (
           SELECT 1 FROM reservation_complimentary_requests rcr
           WHERE rcr.reservation_id = r.id
             AND UPPER(COALESCE(rcr.status, '')) IN ('APPROVED', 'APPLIED', 'ACTIVE', 'COMPLETED')
         )
       ))
       AND (b.id IS NULL OR COALESCE(UPPER(b.booking_status), '') NOT IN ('CANCELLED', 'NO_SHOW', 'VOID', 'VOIDED'))
       AND COALESCE(t.net_amount, 0) > 0
       AND UPPER(COALESCE(t.payment_method, '')) NOT LIKE '%COMP%'
       AND UPPER(COALESCE(t.payment_status, '')) NOT LIKE '%COMP%'
       AND UPPER(COALESCE(t.description, '')) NOT LIKE '%COMPLIMENT%'
       AND UPPER(COALESCE(t.description, '')) NOT LIKE '%HOUSE USE%'
       AND COALESCE(t.service_amount, 0) > 0
       AND t.transaction_date >= $2::date
       AND t.transaction_date <= $3::date
     ORDER BY t.transaction_date DESC, t.id DESC`,
    [ctx.propertyId, ctx.startDate, ctx.endDate]
  );

  const existingSvcRefSet = new Set(serviceChargeRows.map((s) => `${s.source}:${s.ref_no}`));
  for (const ex of extraSvcRes.rows) {
    const src = String(ex.source) === 'POS' ? ('POS' as const) : ('KAMAR' as const);
    const refNo = String(ex.ref_no || `TRX-${ex.id}`);
    if (existingSvcRefSet.has(`${src}:${refNo}`)) continue;
    const svcAmt = Math.round(Number(ex.service_amount) || 0);
    if (svcAmt <= 0) continue;
    const totalAmt = Math.round(Number(ex.net_amount) || 0);
    const dppAmt = Math.max(0, totalAmt - svcAmt);
    existingSvcRefSet.add(`${src}:${refNo}`);
    if (src === 'POS') posServiceTotal += svcAmt;
    else roomServiceTotal += svcAmt;
    serviceChargeRows.push({
      id: `SVC-TX-${ex.id}`,
      tx_date: String(ex.tx_date || ''),
      ref_no: refNo,
      source: src,
      party_name: String(ex.party_name || '-'),
      dpp_amount: dppAmt,
      service_amount: svcAmt,
      total_amount: totalAmt,
    });
  }

  ppnRows.sort((a, b) => b.tx_date.localeCompare(a.tx_date));
  serviceChargeRows.sort((a, b) => b.tx_date.localeCompare(a.tx_date));

  return {
    coa_accounts: coaAccounts,
    bank_list: bankList,
    investor_transfers: investorTransfersRes.rows.map((r: any) => ({
      id: Number(r.id),
      property_id: Number(r.property_id || ctx.propertyId),
      source_account: String(r.source_account || ''),
      investor_name: String(r.investor_name || ''),
      amount: Math.round(Number(r.amount) || 0),
      transfer_date: String(r.transfer_date || ''),
      notes: r.notes ? String(r.notes) : null,
      created_at: String(r.created_at || ''),
    })),
    fixed_assets: {
      items: assetsItems,
      categories: assetCategoriesRes.rows.map((c: any) => ({
        id: Number(c.id),
        category_name: String(c.category_name || ''),
        is_system: Boolean(c.is_system),
      })),
      active_count: activeAssets.length,
      active_total_value: activeAssetsTotalValue,
      period_purchase_total: periodAssetPurchases,
    },
    payables: {
      items: payablesItems,
      total_amount: payablesTotalAmount,
      paid_total: payablesPaidTotal,
      unpaid_total: payablesUnpaidTotal,
      unpaid_count: payablesUnpaidCount,
    },
    receivables: {
      items: receivablesItems,
      total_amount: receivablesTotalAmount,
      paid_total: receivablesPaidTotal,
      unpaid_total: receivablesUnpaidTotal,
      unpaid_count: receivablesUnpaidCount,
    },
    general_journal: {
      opening_balance: 0,
      total_in: totalIn,
      total_out: totalOut,
      closing_balance: runningBalance,
      tx_count: journalRows.length,
      rows: journalRows,
    },
    ppn_summary: {
      tax_percentage: taxPct,
      room_tax_total: roomTaxTotal,
      pos_tax_total: posTaxTotal,
      purchase_tax_total: purchaseTaxTotal,
      net_ppn_payable: Math.max(0, roomTaxTotal + posTaxTotal - purchaseTaxTotal),
      rows: ppnRows,
    },
    service_charge_summary: {
      service_percentage: servicePct,
      room_service_total: roomServiceTotal,
      pos_service_total: posServiceTotal,
      total_service_charge: roomServiceTotal + posServiceTotal,
      rows: serviceChargeRows,
    },
    period_investor_transfers: periodInvestorTransfers,
  };
}
