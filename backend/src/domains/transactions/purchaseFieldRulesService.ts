import { Pool, PoolClient } from 'pg';
import type { FieldMode } from '../frontOffice/frontOfficeSettingsService';
import type { CreatePurchaseTransactionDto } from './transactionTypes';
import {
  ALLOWED_PURCHASE_FIELD_MODES,
  DEFAULT_PURCHASE_FIELD_MODES,
  PURCHASE_FIELD_KEYS,
  PURCHASE_FIELD_LABELS,
  applyPurchaseFieldPolicyToCreateDto,
  isFieldMode,
  isPurchaseFieldKey,
  mergePurchaseFieldModes,
  policyError,
  validatePurchaseFieldRuleSettings,
  type PurchaseFieldKey,
} from './purchaseFieldPolicy';

export interface PurchaseFieldRuleItem {
  field_key: PurchaseFieldKey;
  field_mode: FieldMode;
  default_mode: FieldMode;
  allowed_modes: FieldMode[];
  label: string;
}

export interface PurchaseFieldPolicyPayload {
  property_id: number;
  fields: PurchaseFieldRuleItem[];
  modes: Record<PurchaseFieldKey, FieldMode>;
  default_purchase_category_id: number | null;
}

function mapPolicy(
  propertyId: number,
  modes: Record<PurchaseFieldKey, FieldMode>,
  defaultPurchaseCategoryId: number | null
): PurchaseFieldPolicyPayload {
  return {
    property_id: propertyId,
    modes,
    default_purchase_category_id: defaultPurchaseCategoryId,
    fields: PURCHASE_FIELD_KEYS.map((key) => ({
      field_key: key,
      field_mode: modes[key],
      default_mode: DEFAULT_PURCHASE_FIELD_MODES[key],
      allowed_modes: ALLOWED_PURCHASE_FIELD_MODES[key],
      label: PURCHASE_FIELD_LABELS[key],
    })),
  };
}

export async function getEffectivePurchaseFieldPolicy(
  pool: Pool | PoolClient,
  propertyId: number
): Promise<PurchaseFieldPolicyPayload> {
  const [rulesRes, settingsRes] = await Promise.all([
    pool.query(
      `SELECT field_key, field_mode
       FROM property_purchase_field_rules
       WHERE property_id = $1`,
      [propertyId]
    ),
    pool.query(
      `SELECT default_purchase_category_id
       FROM property_purchase_settings
       WHERE property_id = $1`,
      [propertyId]
    ),
  ]);

  const stored: Record<string, unknown> = {};
  for (const row of rulesRes.rows) {
    if (isPurchaseFieldKey(row.field_key)) {
      stored[row.field_key] = row.field_mode;
    }
  }
  const modes = mergePurchaseFieldModes(stored);
  const defaultIdRaw = settingsRes.rows[0]?.default_purchase_category_id;
  const defaultPurchaseCategoryId = Number.isInteger(Number(defaultIdRaw)) && Number(defaultIdRaw) > 0
    ? Number(defaultIdRaw)
    : null;

  return mapPolicy(propertyId, modes, defaultPurchaseCategoryId);
}

export async function assertValidDefaultPurchaseCategory(
  pool: Pool | PoolClient,
  propertyId: number,
  categoryId: number
): Promise<{ id: number; code: string; name: string }> {
  const found = await pool.query(
    `SELECT id, property_id, code, name, transaction_type, is_active
     FROM transaction_custom_categories
     WHERE id = $1`,
    [categoryId]
  );
  if ((found.rowCount ?? 0) === 0) {
    throw policyError(400, `Kategori default #${categoryId} tidak valid`, 'VALIDATION_ERROR');
  }
  const row = found.rows[0];
  if (Number(row.property_id) !== propertyId) {
    throw policyError(403, 'Kategori default bukan milik properti ini', 'CROSS_PROPERTY_CATEGORY');
  }
  if (String(row.transaction_type || '').toUpperCase() !== 'PURCHASE') {
    throw policyError(400, `Kategori '${row.code}' bukan kategori pembelian`, 'VALIDATION_ERROR');
  }
  if (row.is_active === false) {
    throw policyError(400, `Kategori default '${row.code}' tidak aktif`, 'VALIDATION_ERROR');
  }
  return { id: Number(row.id), code: String(row.code), name: String(row.name) };
}

export async function savePurchaseFieldRules(
  pool: Pool,
  propertyId: number,
  dto: {
    rules?: Record<string, unknown> | null;
    default_purchase_category_id?: number | string | null;
    actor_name?: string | null;
  }
): Promise<PurchaseFieldPolicyPayload> {
  const current = await getEffectivePurchaseFieldPolicy(pool, propertyId);

  const incomingRules = dto.rules && typeof dto.rules === 'object' ? dto.rules : {};
  for (const key of Object.keys(incomingRules)) {
    if (!isPurchaseFieldKey(key)) {
      throw policyError(400, `field_key '${key}' tidak dikenali`, 'INVALID_FIELD_KEY');
    }
    if (!isFieldMode(incomingRules[key])) {
      throw policyError(400, `field_mode untuk '${key}' tidak valid`, 'INVALID_FIELD_MODE');
    }
    if (!ALLOWED_PURCHASE_FIELD_MODES[key].includes(incomingRules[key] as FieldMode)) {
      if ((key === 'receipt_attachment' || key === 'payment_evidence') && incomingRules[key] === 'REQUIRED') {
        throw policyError(
          400,
          'Lampiran Wajib belum dapat ditegakkan pada alur unggah setelah create. Gunakan Opsional atau Sembunyikan.',
          'ATTACHMENT_REQUIRED_UNSUPPORTED'
        );
      }
      if (key === 'line_unit') {
        throw policyError(
          400,
          'Satuan item harus Wajib. Mode Opsional/Sembunyikan tidak diizinkan karena tidak ada satuan kanonik properti.',
          'INVALID_FIELD_MODE'
        );
      }
      throw policyError(
        400,
        `Mode '${String(incomingRules[key])}' tidak diizinkan untuk field ${PURCHASE_FIELD_LABELS[key]}`,
        'INVALID_FIELD_MODE'
      );
    }
  }

  const modes = mergePurchaseFieldModes({ ...current.modes, ...incomingRules });

  let defaultCategoryId = current.default_purchase_category_id;
  if (dto.default_purchase_category_id !== undefined) {
    if (dto.default_purchase_category_id === null || dto.default_purchase_category_id === '') {
      defaultCategoryId = null;
    } else {
      const parsed = Number(dto.default_purchase_category_id);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw policyError(400, 'default_purchase_category_id tidak valid', 'VALIDATION_ERROR');
      }
      await assertValidDefaultPurchaseCategory(pool, propertyId, parsed);
      defaultCategoryId = parsed;
    }
  }

  validatePurchaseFieldRuleSettings({
    modes,
    defaultPurchaseCategoryId: defaultCategoryId,
  });

  if (modes.category === 'HIDDEN' && defaultCategoryId) {
    await assertValidDefaultPurchaseCategory(pool, propertyId, defaultCategoryId);
  }

  const actor = dto.actor_name || 'Staff';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const key of PURCHASE_FIELD_KEYS) {
      await client.query(
        `INSERT INTO property_purchase_field_rules
           (property_id, field_key, field_mode, created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4, NOW(), NOW())
         ON CONFLICT (property_id, field_key)
         DO UPDATE SET
           field_mode = EXCLUDED.field_mode,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [propertyId, key, modes[key], actor]
      );
    }
    await client.query(
      `INSERT INTO property_purchase_settings
         (property_id, default_purchase_category_id, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $3, NOW(), NOW())
       ON CONFLICT (property_id)
       DO UPDATE SET
         default_purchase_category_id = EXCLUDED.default_purchase_category_id,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [propertyId, defaultCategoryId, actor]
    );
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
       VALUES ('TRANSACTIONS', 'PURCHASE_FIELD_RULES_UPDATED', 'property_purchase_field_rules', $1, $2, $3)`,
      [String(propertyId), JSON.stringify({ modes, default_purchase_category_id: defaultCategoryId, actor }), propertyId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return getEffectivePurchaseFieldPolicy(pool, propertyId);
}

export async function preparePurchaseCreateDto(
  pool: Pool | PoolClient,
  dto: CreatePurchaseTransactionDto
): Promise<CreatePurchaseTransactionDto> {
  const propertyId = Number(dto.property_id);
  const policy = await getEffectivePurchaseFieldPolicy(pool, propertyId);
  let defaultCategoryId = policy.default_purchase_category_id;
  if (policy.modes.category === 'HIDDEN') {
    if (!defaultCategoryId) {
      throw policyError(
        400,
        'Kategori pembelian default properti tidak valid. Setel kategori default di pengaturan.',
        'DEFAULT_PURCHASE_CATEGORY_REQUIRED'
      );
    }
    const canonical = await assertValidDefaultPurchaseCategory(pool, propertyId, defaultCategoryId);
    defaultCategoryId = canonical.id;
  }
  return applyPurchaseFieldPolicyToCreateDto({
    dto,
    modes: policy.modes,
    defaultPurchaseCategoryId: defaultCategoryId,
  });
}
