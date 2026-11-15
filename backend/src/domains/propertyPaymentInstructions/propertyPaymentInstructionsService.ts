import type { Pool } from 'pg';
import type { PropertyPaymentInstructionsRecord, UpdatePropertyPaymentInstructionsDTO } from './propertyPaymentInstructionsTypes';
import { propertyQrisImageExists, isPropertyQrisImageKey } from './qrisImageStorage';

export class PropertyPaymentInstructionsError extends Error {
  constructor(message: string, public code: string, public statusCode: number = 400) {
    super(message); Object.setPrototypeOf(this, PropertyPaymentInstructionsError.prototype);
  }
}
const textFields: Record<string, number> = {
  bank_name:100, bank_account_name:150, bank_account_number:100, bank_branch:100, payment_note:0,
  qris_terminal_name:100, qris_merchant_id:100, transfer_ref_note:5000, debit_edc_terminal:100,
};
const booleanFields = ['is_active','qris_enabled','transfer_enabled','debit_enabled'];
const fields = [...Object.keys(textFields), ...booleanFields, 'qris_image_path'];
const returning = 'id, property_id, ' + fields.join(', ') + ', created_at, updated_at, updated_by';
function assertPropertyId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) throw new PropertyPaymentInstructionsError('Property ID tidak valid.', 'VALIDATION_ERROR');
}
function record(row: any, propertyId: number): PropertyPaymentInstructionsRecord {
  const r: any = {property_id:propertyId,is_active:true,qris_enabled:false,transfer_enabled:false,debit_enabled:false};
  for (const field of Object.keys(textFields)) r[field] = null;
  r.qris_image_path = null;
  if (row) Object.assign(r,row);
  return r;
}
function patchFromDTO(dto: UpdatePropertyPaymentInstructionsDTO): Record<string, unknown> {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) throw new PropertyPaymentInstructionsError('Payload tidak valid.', 'VALIDATION_ERROR');
  if (Object.prototype.hasOwnProperty.call(dto,'qris_image_path'))
    throw new PropertyPaymentInstructionsError('Gunakan tombol unggah/hapus gambar QRIS.', 'QRIS_IMAGE_UPLOAD_REQUIRED');
  const patch: Record<string, unknown> = {};
  for (const [field,max] of Object.entries(textFields)) {
    const value = (dto as any)[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') throw new PropertyPaymentInstructionsError(`${field} harus teks atau kosong.`, 'VALIDATION_ERROR');
    const normalized = value === null ? null : value.trim() || null;
    if (max && normalized && normalized.length > max) throw new PropertyPaymentInstructionsError(`${field} maksimal ${max} karakter.`, 'VALIDATION_ERROR');
    patch[field] = normalized;
  }
  for (const field of booleanFields) {
    const value = (dto as any)[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new PropertyPaymentInstructionsError(`${field} harus boolean.`, 'VALIDATION_ERROR');
    patch[field] = value;
  }
  return patch;
}
export async function getPropertyPaymentInstructions(pool: Pool, propertyId: number): Promise<PropertyPaymentInstructionsRecord> {
  assertPropertyId(propertyId);
  if (!(await pool.query('SELECT id FROM properties WHERE id=$1',[propertyId])).rows.length)
    throw new PropertyPaymentInstructionsError('Properti tidak ditemukan.', 'PROPERTY_NOT_FOUND',404);
  const result = await pool.query(`SELECT ${returning} FROM property_payment_instructions WHERE property_id=$1`,[propertyId]);
  return record(result.rows[0],propertyId);
}
async function updateRecord(pool: Pool, propertyId: number, patch: Record<string, unknown>, actorName?: string): Promise<{
  data: PropertyPaymentInstructionsRecord; previousQrisKey: string | null;
}> {
  assertPropertyId(propertyId);
  const client = await pool.connect();
  let active = false, discard = false, primaryError: unknown = null;
  try {
    await client.query('BEGIN'); active = true;
    // Serialize both initial creation and all subsequent config/image changes per property.
    if (!(await client.query('SELECT id FROM properties WHERE id=$1 FOR UPDATE',[propertyId])).rows.length)
      throw new PropertyPaymentInstructionsError('Properti tidak ditemukan.','PROPERTY_NOT_FOUND',404);
    const current = record((await client.query(`SELECT ${returning} FROM property_payment_instructions WHERE property_id=$1`,[propertyId])).rows[0],propertyId);
    const merged: any = {...current,...patch};
    if (merged.qris_enabled && !await propertyQrisImageExists(merged.qris_image_path,propertyId))
      throw new PropertyPaymentInstructionsError('Unggah gambar QRIS resmi sebelum mengaktifkan QRIS.','QRIS_NOT_CONFIGURED',422);
    if (merged.transfer_enabled && !merged.bank_account_number?.trim())
      throw new PropertyPaymentInstructionsError('Isi rekening bank sebelum mengaktifkan Transfer.','TRANSFER_NOT_CONFIGURED',422);
    if (merged.debit_enabled && !merged.debit_edc_terminal?.trim())
      throw new PropertyPaymentInstructionsError('Isi identitas terminal EDC sebelum mengaktifkan Debit.','DEBIT_NOT_CONFIGURED',422);
    const actor = actorName?.trim().slice(0,100) || 'SYSTEM';
    const values = [propertyId,...fields.map(field=>merged[field]),actor];
    const assignments = fields.map(field=>`${field}=EXCLUDED.${field}`).join(', ');
    const result = await client.query(`INSERT INTO property_payment_instructions(property_id,${fields.join(', ')},updated_by,updated_at)
      VALUES(${values.map((_,i)=>'$'+(i+1)).join(', ')},CURRENT_TIMESTAMP)
      ON CONFLICT(property_id) DO UPDATE SET ${assignments},updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP
      RETURNING ${returning}`,values);
    if (!result.rows[0]) throw new Error('Payment configuration write returned no row');
    await client.query('COMMIT'); active = false;
    return {data:record(result.rows[0],propertyId),previousQrisKey:current.qris_image_path || null};
  } catch (e) {
    primaryError = e;
    if (active) try {await client.query('ROLLBACK');active=false;} catch (_) {discard=true;}
    throw e;
  } finally {
    try {client.release(discard);} catch (releaseError) {if(!primaryError) throw releaseError;console.error('[PAYMENT SETTINGS] client release failed');}
  }
}
export async function updatePropertyPaymentInstructions(pool: Pool, propertyId: number, dto: UpdatePropertyPaymentInstructionsDTO,
  actorName?: string): Promise<PropertyPaymentInstructionsRecord> {
  return (await updateRecord(pool,propertyId,patchFromDTO(dto),actorName)).data;
}
export async function replacePropertyQrisImage(pool: Pool, propertyId: number, key: string | null, actorName?: string) {
  if (key !== null && !isPropertyQrisImageKey(key,propertyId))
    throw new PropertyPaymentInstructionsError('Gambar QRIS bukan milik properti ini.','INVALID_QRIS_IMAGE');
  return updateRecord(pool,propertyId,key===null ? {qris_image_path:null,qris_enabled:false} : {qris_image_path:key},actorName);
}
/** Public instructions for the POS cashier; editing remains under Settings Edit. */
export async function getPosPaymentConfig(pool: Pool, propertyId: number) {
  const r = await getPropertyPaymentInstructions(pool,propertyId);
  return {
    property_id:propertyId,qris_enabled:r.qris_enabled===true,qris_terminal_name:r.qris_terminal_name,
    qris_merchant_id:r.qris_merchant_id,qris_image_path:r.qris_image_path,
    qris_image_available:await propertyQrisImageExists(r.qris_image_path,propertyId),
    transfer_enabled:r.transfer_enabled===true,transfer_ref_note:r.transfer_ref_note,
    bank_name:r.bank_name,bank_account_name:r.bank_account_name,bank_account_number:r.bank_account_number,
    debit_enabled:r.debit_enabled===true,debit_edc_terminal:r.debit_edc_terminal,
  };
}
