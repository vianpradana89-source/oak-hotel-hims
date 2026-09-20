import { Pool } from 'pg';
import {
  PropertyPaymentInstructionsRecord,
  UpdatePropertyPaymentInstructionsDTO,
} from './propertyPaymentInstructionsTypes';

export class PropertyPaymentInstructionsError extends Error {
  code: string;
  statusCode: number;

  constructor(message: string, code: string, statusCode: number = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, PropertyPaymentInstructionsError.prototype);
  }
}

export async function getPropertyPaymentInstructions(
  pool: Pool,
  propertyId: number
): Promise<PropertyPaymentInstructionsRecord> {
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new PropertyPaymentInstructionsError(
      'Invalid property ID parameter',
      'VALIDATION_ERROR',
      400
    );
  }

  // 1. Verify property existence
  const propCheck = await pool.query(
    'SELECT id, name, property_code FROM properties WHERE id = $1',
    [propertyId]
  );

  if ((propCheck.rowCount ?? 0) === 0) {
    throw new PropertyPaymentInstructionsError(
      `Property with ID ${propertyId} not found`,
      'PROPERTY_NOT_FOUND',
      404
    );
  }

  // 2. Fetch payment instructions if configured
  const res = await pool.query(
    `SELECT id, property_id, bank_name, bank_account_name, bank_account_number,
            bank_branch, payment_note, is_active, created_at, updated_at, updated_by
     FROM property_payment_instructions
     WHERE property_id = $1`,
    [propertyId]
  );

  if ((res.rowCount ?? 0) > 0) {
    const row = res.rows[0];
    return {
      id: row.id,
      property_id: row.property_id,
      bank_name: row.bank_name || null,
      bank_account_name: row.bank_account_name || null,
      bank_account_number: row.bank_account_number || null,
      bank_branch: row.bank_branch || null,
      payment_note: row.payment_note || null,
      is_active: row.is_active !== false,
      created_at: row.created_at,
      updated_at: row.updated_at,
      updated_by: row.updated_by || null,
    };
  }

  // 3. Fallback: clean unconfigured record for this property (no fake defaults)
  return {
    property_id: propertyId,
    bank_name: null,
    bank_account_name: null,
    bank_account_number: null,
    bank_branch: null,
    payment_note: null,
    is_active: true,
  };
}

export async function updatePropertyPaymentInstructions(
  pool: Pool,
  propertyId: number,
  dto: UpdatePropertyPaymentInstructionsDTO,
  actorName?: string
): Promise<PropertyPaymentInstructionsRecord> {
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new PropertyPaymentInstructionsError(
      'Invalid property ID parameter',
      'VALIDATION_ERROR',
      400
    );
  }

  // 1. Verify property existence
  const propCheck = await pool.query(
    'SELECT id FROM properties WHERE id = $1',
    [propertyId]
  );

  if ((propCheck.rowCount ?? 0) === 0) {
    throw new PropertyPaymentInstructionsError(
      `Property with ID ${propertyId} not found`,
      'PROPERTY_NOT_FOUND',
      404
    );
  }

  // 2. Sanitize and trim fields
  const bankName = dto.bank_name !== undefined ? (dto.bank_name ? dto.bank_name.trim() : null) : null;
  const bankAccountName = dto.bank_account_name !== undefined ? (dto.bank_account_name ? dto.bank_account_name.trim() : null) : null;
  const bankAccountNumber = dto.bank_account_number !== undefined ? (dto.bank_account_number ? dto.bank_account_number.trim() : null) : null;
  const bankBranch = dto.bank_branch !== undefined ? (dto.bank_branch ? dto.bank_branch.trim() : null) : null;
  const paymentNote = dto.payment_note !== undefined ? (dto.payment_note ? dto.payment_note.trim() : null) : null;
  const isActive = dto.is_active !== undefined ? Boolean(dto.is_active) : true;
  const actor = actorName ? actorName.trim().slice(0, 100) : 'SYSTEM';

  // 3. Atomic upsert
  const query = `
    INSERT INTO property_payment_instructions (
      property_id, bank_name, bank_account_name, bank_account_number,
      bank_branch, payment_note, is_active, updated_by, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (property_id)
    DO UPDATE SET
      bank_name = EXCLUDED.bank_name,
      bank_account_name = EXCLUDED.bank_account_name,
      bank_account_number = EXCLUDED.bank_account_number,
      bank_branch = EXCLUDED.bank_branch,
      payment_note = EXCLUDED.payment_note,
      is_active = EXCLUDED.is_active,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING id, property_id, bank_name, bank_account_name, bank_account_number,
              bank_branch, payment_note, is_active, created_at, updated_at, updated_by;
  `;

  const values = [
    propertyId,
    bankName,
    bankAccountName,
    bankAccountNumber,
    bankBranch,
    paymentNote,
    isActive,
    actor,
  ];

  const res = await pool.query(query, values);
  const row = res.rows[0];

  return {
    id: row.id,
    property_id: row.property_id,
    bank_name: row.bank_name || null,
    bank_account_name: row.bank_account_name || null,
    bank_account_number: row.bank_account_number || null,
    bank_branch: row.bank_branch || null,
    payment_note: row.payment_note || null,
    is_active: row.is_active !== false,
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_by: row.updated_by || null,
  };
}
