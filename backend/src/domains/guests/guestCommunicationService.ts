import type { Pool, PoolClient } from 'pg';
import {
  httpError,
  parsePropertyId,
  assertPropertyExists,
  assertGuestBelongsToProperty,
  assertReservationBelongsToProperty,
} from './guestService';
import { normalizeRole } from './guestService';
import { isPlatformSuperAdmin } from '../auth/authService';
import type { AuthUserPayload } from '../auth/authService';
import type {
  GuestCommunicationTemplate,
  GuestCommunicationTemplateCreateInput,
  GuestCommunicationTemplateUpdateInput,
  GuestCommunicationLog,
  PrepareCommunicationInput,
  PrepareCommunicationResult,
  CommunicationHistoryFilters,
  CommunicationHistoryResponse,
  ActorSnapshot,
  GuestCommunicationScope,
  GuestCommunicationCategory,
  GuestCommunicationStatus,
} from './guestCommunicationTypes';
import { ALLOWED_TEMPLATE_VARIABLES } from './guestCommunicationTypes';

// ─── Enum sets (strict) ──────────────────────────────────────────────────────

const VALID_SCOPES: GuestCommunicationScope[] = [
  'STAY_OPERATIONAL',
  'CRM_CAMPAIGN',
  'BIRTHDAY',
  'POST_STAY',
  'PROMOTION',
];

const VALID_CATEGORIES: GuestCommunicationCategory[] = [
  'CHECKOUT_REMINDER',
  'DINNER_PROMO',
  'BREAKFAST_INFO',
  'LAUNDRY_PROMO',
  'LATE_CHECKOUT',
  'BIRTHDAY',
  'PROMOTION',
  'POST_STAY',
  'CUSTOM',
];

const VALID_STATUSES: GuestCommunicationStatus[] = ['INITIATED', 'OPENED_WHATSAPP'];

function validateEnum<T>(value: unknown, validSet: T[], field: string): T {
  if (!validSet.includes(value as T)) {
    throw httpError(400, 'VALIDATION_ERROR', `${field} must be one of: ${validSet.join(', ')}`);
  }
  return value as T;
}

// ─── Phone normalization ─────────────────────────────────────────────────────

/**
 * Normalizes a phone string for WhatsApp deep-link use.
 * Rules:
 *  - Strip all non-digit characters.
 *  - Leading "0" is treated as a domestic prefix and replaced with "62" (Indonesia).
 *  - Leading "+"" is stripped by the digit-only pass; result is kept as-is.
 *  - Minimum 8 digits, maximum 15 digits (conservative E.164 bound).
 */
function normalizeWhatsAppDestination(phone: string | null | undefined): string {
  if (!phone || String(phone).trim() === '') {
    throw httpError(400, 'VALIDATION_ERROR', 'Guest phone number is required for WhatsApp communication');
  }
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw httpError(400, 'VALIDATION_ERROR', 'Invalid phone number length after normalization (8-15 digits required)');
  }
  // Replace leading domestic prefix "0" with country code "62"
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  }
  return digits;
}



// ─── Display-order validation ────────────────────────────────────────────────
// Returns the validated number when supplied; undefined means caller decides.
// Throws on null (explicitly supplied with invalid type/value).

function validateDisplayOrder(value: unknown): number {
  if (value === null) {
    throw httpError(400, 'VALIDATION_ERROR', 'display_order must be a finite integer >= 0');
  }
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'display_order must be a finite integer >= 0');
  }
  return num;
}

// ─── is_active validation ────────────────────────────────────────────────────
// Returns the validated boolean when supplied; undefined means caller decides.

function validateIsActive(value: unknown): boolean {
  if (value === undefined) {
    throw httpError(400, 'VALIDATION_ERROR', 'is_active must be a boolean value (true/false)');
  }
  if (typeof value !== 'boolean') {
    throw httpError(400, 'VALIDATION_ERROR', 'is_active must be a boolean value (true/false)');
  }
  return value;
}

// ─── JSON array validation ───────────────────────────────────────────────────
// Returns the validated array when supplied; undefined means caller decides.
// Throws on null (explicitly supplied but invalid).

function validateStringArray(value: unknown, fieldName: string): string[] {
  if (value === null) {
    throw httpError(400, 'VALIDATION_ERROR', `${fieldName} must be an array`);
  }
  if (!Array.isArray(value)) {
    throw httpError(400, 'VALIDATION_ERROR', `${fieldName} must be an array`);
  }
  const trimmed: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', `${fieldName} must contain only string items`);
    }
    const s = item.trim();
    if (s === '') {
      throw httpError(400, 'VALIDATION_ERROR', `${fieldName} contains a blank item`);
    }
    trimmed.push(s);
  }
  return trimmed;
}

function validateTemplateVariables(value: unknown): string[] {
  const items = validateStringArray(value, 'template_variables');
  const seen = new Set<string>();
  for (const v of items) {
    if (!ALLOWED_TEMPLATE_VARIABLES.has(v)) {
      throw httpError(400, 'VALIDATION_ERROR', `Unknown template variable: ${v}`);
    }
    if (seen.has(v)) {
      throw httpError(400, 'VALIDATION_ERROR', `Duplicate template variable: ${v}`);
    }
    seen.add(v);
  }
  return items;
}

// ─── Placeholder parsing in message_body ─────────────────────────────────────

function extractPlaceholders(text: string): string[] {
  const re = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.push(m[1]);
  }
  return found;
}

function validatePlaceholders(placeholders: string[]): void {
  for (const v of placeholders) {
    if (!ALLOWED_TEMPLATE_VARIABLES.has(v)) {
      throw httpError(400, 'VALIDATION_ERROR', `Unknown placeholder in message_body: {{${v}}}`);
    }
  }
}

// ─── Audit logging helper ────────────────────────────────────────────────────
// audit_logs canonical columns: module, action, entity, record_id, new_value, correlation_id, property_id
// Actor snapshot and old/new values are stored inside new_value JSON.

async function insertAudit(
  client: PoolClient,
  module: string,
  action: string,
  entityType: string,
  recordId: number | null,
  propertyId: number,
  newValue: unknown,
  oldValue: unknown,
  actor: ActorSnapshot | null,
  correlationId: string | null
): Promise<void> {
  const auditPayload = {
    actor: actor
      ? {
          user_id: actor.userId ?? null,
          name: actor.name ?? null,
          role: actor.role ?? null,
        }
      : null,
    old_value: oldValue !== undefined ? oldValue : null,
    new_value: newValue !== undefined ? newValue : null,
  };

  await client.query(
    `INSERT INTO audit_logs
       (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      module,
      action,
      entityType,
      recordId !== null ? String(recordId) : null,
      JSON.stringify(auditPayload),
      correlationId,
      propertyId,
    ]
  );
}
// ─── List templates ──────────────────────────────────────────────────────────

export async function listTemplates(
  pool: Pool,
  propertyId: number,
  scope?: GuestCommunicationScope | null,
  category?: GuestCommunicationCategory | null,
  isActive?: boolean | null
): Promise<GuestCommunicationTemplate[]> {
  let sql = `
    SELECT id, property_id, code, name, channel, scope, category, message_body,
           allowed_reservation_statuses, template_variables,
           is_active, display_order,
           created_by_user_id, updated_by_user_id, created_at, updated_at
    FROM guest_communication_templates
    WHERE property_id = $1
  `;
  const params: unknown[] = [propertyId];
  let p = 2;

  if (scope) {
    sql += ` AND scope = $${p++}`;
    params.push(scope);
  }
  if (category) {
    sql += ` AND category = $${p++}`;
    params.push(category);
  }
  if (isActive !== undefined && isActive !== null) {
    sql += ` AND is_active = $${p++}`;
    params.push(isActive);
  }
  sql += ' ORDER BY display_order ASC, id ASC';

  const res = await pool.query(sql, params);
  return res.rows;
}

// ─── Get template by ID ──────────────────────────────────────────────────────

export async function getTemplate(
  pool: Pool,
  templateId: number,
  propertyId: number
): Promise<GuestCommunicationTemplate> {
  const res = await pool.query(
    `SELECT id, property_id, code, name, channel, scope, category, message_body,
            allowed_reservation_statuses, template_variables,
            is_active, display_order,
            created_by_user_id, updated_by_user_id, created_at, updated_at
     FROM guest_communication_templates
     WHERE id = $1 AND property_id = $2`,
    [templateId, propertyId]
  );
  if ((res.rowCount ?? 0) === 0) {
    throw httpError(404, 'TEMPLATE_NOT_FOUND', `Template ${templateId} not found`);
  }
  return res.rows[0];
}

// ─── Create template ─────────────────────────────────────────────────────────

export async function createTemplate(
  pool: Pool,
  input: GuestCommunicationTemplateCreateInput,
  actor: ActorSnapshot,
  correlationId: string
): Promise<GuestCommunicationTemplate> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertPropertyExists(client, input.property_id);

    // ── Required string fields: strict typeof guard, NO String(...) coercion ──
    if (typeof input.code !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'code must be a non-blank string');
    }
    const code = input.code.trim().toUpperCase();
    if (code === '') {
      throw httpError(400, 'VALIDATION_ERROR', 'code must be a non-blank string');
    }

    if (typeof input.name !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'name must be a non-blank string');
    }
    const name = input.name.trim();
    if (name === '') {
      throw httpError(400, 'VALIDATION_ERROR', 'name must be a non-blank string');
    }

    if (typeof input.message_body !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'message_body must be a non-blank string');
    }
    const messageBody = input.message_body.trim();
    if (messageBody === '') {
      throw httpError(400, 'VALIDATION_ERROR', 'message_body must be a non-blank string');
    }

    const scope = validateEnum(input.scope, VALID_SCOPES, 'scope');
    const category = validateEnum(input.category, VALID_CATEGORIES, 'category');

    const displayOrder = input.display_order === undefined
      ? 0
      : validateDisplayOrder(input.display_order);

    const isActive = input.is_active === undefined
      ? true
      : validateIsActive(input.is_active);

    // Validate arrays: undefined => [], otherwise validate (null will be rejected by validator)
    const allowedReservationStatuses = input.allowed_reservation_statuses === undefined
      ? []
      : validateStringArray(input.allowed_reservation_statuses, 'allowed_reservation_statuses');

    const templateVariables = input.template_variables === undefined
      ? []
      : validateTemplateVariables(input.template_variables);

    // Validate placeholders in message_body
    const placeholders = extractPlaceholders(messageBody);
    validatePlaceholders(placeholders);

    // Duplicate check
    const dup = await client.query(
      'SELECT id FROM guest_communication_templates WHERE property_id=$1 AND code=$2',
      [input.property_id, code]
    );
    if ((dup.rowCount ?? 0) > 0) {
      throw httpError(409, 'DUPLICATE_ERROR', `Template code '${code}' already exists for this property`);
    }

    const res = await client.query(
      `INSERT INTO guest_communication_templates
         (property_id, code, name, channel, scope, category, message_body,
          allowed_reservation_statuses, template_variables, is_active, display_order,
          created_by_user_id, updated_by_user_id)
       VALUES ($1,$2,$3,'WHATSAPP',$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        input.property_id,
        code,
        name,
        scope,
        category,
        messageBody,
        JSON.stringify(allowedReservationStatuses),
        JSON.stringify(templateVariables),
        isActive,
        displayOrder,
        actor.userId,
        actor.userId,
      ]
    );

    // Catch PostgreSQL unique-violation as a safety net (race condition)
    if ((res.rowCount ?? 0) === 0 && (dup.rowCount ?? 0) > 0) {
      throw httpError(409, 'DUPLICATE_ERROR', `Template code '${code}' already exists for this property`);
    }

    await insertAudit(
      client, 'GUEST_CRM', 'GUEST_COMM_TEMPLATE_CREATE', 'GUEST_COMMUNICATION_TEMPLATE',
      res.rows[0].id, input.property_id, res.rows[0], null, actor, correlationId
    );

    await client.query('COMMIT');
    return res.rows[0];
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    // Translate PostgreSQL unique-violation (23505) to 409
    if (err?.code === '23505') {
      throw httpError(409, 'DUPLICATE_ERROR', 'Template code already exists for this property');
    }
    throw err;
  } finally {
    client.release();
  }
}

// ─── Update template ─────────────────────────────────────────────────────────

export async function updateTemplate(
  pool: Pool,
  templateId: number,
  propertyId: number,
  input: GuestCommunicationTemplateUpdateInput,
  actor: ActorSnapshot,
  correlationId: string
): Promise<GuestCommunicationTemplate> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Assert property exists before locking
    await assertPropertyExists(client, propertyId);

    // Lock row FOR UPDATE
    const lockRes = await client.query(
      'SELECT * FROM guest_communication_templates WHERE id=$1 AND property_id=$2 FOR UPDATE',
      [templateId, propertyId]
    );
    if ((lockRes.rowCount ?? 0) === 0) {
      throw httpError(404, 'TEMPLATE_NOT_FOUND', `Template ${templateId} not found`);
    }
    const existing = lockRes.rows[0];

    // ── Code: strict typeof guard, NO String(...) coercion ──
    let code: string;
    if (input.code !== undefined) {
      if (typeof input.code !== 'string') {
        throw httpError(400, 'VALIDATION_ERROR', 'code must be a non-blank string');
      }
      code = input.code.trim().toUpperCase();
      if (code === '') {
        throw httpError(400, 'VALIDATION_ERROR', 'code must be a non-blank string');
      }
    } else {
      code = existing.code;
    }

    // ── Name: strict typeof guard, NO String(...) coercion ──
    let name: string;
    if (input.name !== undefined) {
      if (typeof input.name !== 'string') {
        throw httpError(400, 'VALIDATION_ERROR', 'name must be a non-blank string');
      }
      name = input.name.trim();
      if (name === '') {
        throw httpError(400, 'VALIDATION_ERROR', 'name must be a non-blank string');
      }
    } else {
      name = existing.name;
    }

    // ── Message body: strict typeof guard, NO String(...) coercion ──
    let messageBody: string;
    if (input.message_body !== undefined) {
      if (typeof input.message_body !== 'string') {
        throw httpError(400, 'VALIDATION_ERROR', 'message_body must be a non-blank string');
      }
      messageBody = input.message_body.trim();
      if (messageBody === '') {
        throw httpError(400, 'VALIDATION_ERROR', 'message_body must be a non-blank string');
      }
    } else {
      messageBody = existing.message_body;
    }

    const scope = input.scope !== undefined ? validateEnum(input.scope, VALID_SCOPES, 'scope') : existing.scope;
    const category = input.category !== undefined ? validateEnum(input.category, VALID_CATEGORIES, 'category') : existing.category;

    // display_order: omit => preserve existing; supplied => must be valid integer >= 0
    const displayOrder = input.display_order === undefined
      ? existing.display_order
      : validateDisplayOrder(input.display_order);

    // is_active: omit => preserve existing; supplied => must be boolean
    const isActive = input.is_active === undefined
      ? existing.is_active
      : validateIsActive(input.is_active);

    // Validate arrays: omit => preserve existing; supplied => must be array
    const allowedReservationStatuses = input.allowed_reservation_statuses === undefined
      ? (existing.allowed_reservation_statuses as string[])
      : validateStringArray(input.allowed_reservation_statuses, 'allowed_reservation_statuses');
    const templateVariables = input.template_variables === undefined
      ? (existing.template_variables as string[])
      : validateTemplateVariables(input.template_variables);

    // Validate placeholders in new message_body
    const placeholders = extractPlaceholders(messageBody);
    validatePlaceholders(placeholders);

    // Duplicate check excluding self
    const dup = await client.query(
      'SELECT id FROM guest_communication_templates WHERE property_id=$1 AND code=$2 AND id<>$3',
      [propertyId, code, templateId]
    );
    if ((dup.rowCount ?? 0) > 0) {
      throw httpError(409, 'DUPLICATE_ERROR', `Template code '${code}' already exists for this property`);
    }

    const res = await client.query(
      `UPDATE guest_communication_templates SET
         code=$1, name=$2, scope=$3, category=$4, message_body=$5,
         allowed_reservation_statuses=$6, template_variables=$7,
         is_active=$8, display_order=$9, updated_by_user_id=$10, updated_at=NOW()
       WHERE id=$11 AND property_id=$12
       RETURNING *`,
      [
        code, name, scope, category, messageBody,
        JSON.stringify(allowedReservationStatuses),
        JSON.stringify(templateVariables),
        isActive, displayOrder, actor.userId,
        templateId, propertyId,
      ]
    );

    await insertAudit(
      client, 'GUEST_CRM', 'GUEST_COMM_TEMPLATE_UPDATE', 'GUEST_COMMUNICATION_TEMPLATE',
      res.rows[0].id, propertyId, res.rows[0], existing, actor, correlationId
    );

    await client.query('COMMIT');
    return res.rows[0];
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err?.code === '23505') {
      throw httpError(409, 'DUPLICATE_ERROR', 'Template code already exists for this property');
    }
    throw err;
  } finally {
    client.release();
  }
}

// ─── Prepare WhatsApp communication ──────────────────────────────────────────

export async function prepareWhatsAppCommunication(
  pool: Pool,
  input: PrepareCommunicationInput,
  actor: ActorSnapshot,
  correlationId: string
): Promise<PrepareCommunicationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertPropertyExists(client, input.property_id);
    await assertGuestBelongsToProperty(client, input.guest_id, input.property_id);

    // Fetch guest including preferred_name
    const guestRes = await client.query(
      'SELECT id, full_name, preferred_name, phone FROM guests WHERE id=$1',
      [input.guest_id]
    );
    const guest = guestRes.rows[0];
    if (!guest) throw httpError(404, 'GUEST_NOT_FOUND', `Guest ${input.guest_id} not found`);
    if (!guest.phone || String(guest.phone).trim() === '') {
      throw httpError(400, 'VALIDATION_ERROR', 'Guest has no phone number configured for WhatsApp communication');
    }

    // Normalize WhatsApp destination
    const waDestination = normalizeWhatsAppDestination(guest.phone);

    // Fetch template
    const tplRes = await client.query(
      `SELECT * FROM guest_communication_templates
       WHERE id=$1 AND property_id=$2 AND channel='WHATSAPP' AND is_active=true FOR UPDATE`,
      [input.template_id, input.property_id]
    );
    if ((tplRes.rowCount ?? 0) === 0) {
      throw httpError(404, 'TEMPLATE_NOT_FOUND', `Template ${input.template_id} not found or inactive`);
    }
    const template = tplRes.rows[0];

    // STAY_OPERATIONAL enforcement: reservation_id is mandatory
    if (template.scope === 'STAY_OPERATIONAL' && (input.reservation_id == null)) {
      throw httpError(400, 'VALIDATION_ERROR', 'reservation_id is required for STAY_OPERATIONAL templates');
    }

    // Fetch reservation context if provided
    let reservation: any = null;
    let propertyRow: any = null;
    let roomRow: any = null;
    let roomTypeRow: any = null;

    if (input.reservation_id != null) {
      const { reservation: reserved } = await assertReservationBelongsToProperty(
        client, Number(input.reservation_id), input.property_id
      );
      reservation = reserved;

      // Verify guest linked to reservation (basic linkage check, all scopes)
      const linkCheck = await client.query(
        'SELECT is_staying FROM reservation_guests WHERE reservation_id=$1 AND guest_id=$2',
        [reservation.id, input.guest_id]
      );
      if ((linkCheck.rowCount ?? 0) === 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'Guest is not linked to the specified reservation');
      }

      // ── STAY_OPERATIONAL enforcement: is_staying=true AND CHECKED_IN ──
      if (template.scope === 'STAY_OPERATIONAL') {
        const stayingGuest = linkCheck.rows[0];
        if (!stayingGuest || stayingGuest.is_staying !== true) {
          throw httpError(400, 'VALIDATION_ERROR', 'Guest is not a staying guest for this reservation');
        }
        if (String(reservation.status) !== 'CHECKED_IN') {
          throw httpError(400, 'VALIDATION_ERROR',
            `STAY_OPERATIONAL template requires reservation status CHECKED_IN, got '${reservation.status}'`);
        }
      }

      // allowed_reservation_statuses remains an ADDITIONAL gate for ALL scopes
      if (template.allowed_reservation_statuses.length > 0) {
        const allowed = template.allowed_reservation_statuses as string[];
        if (!allowed.includes(String(reservation.status))) {
          throw httpError(400, 'VALIDATION_ERROR',
            `Reservation status '${reservation.status}' is not allowed for this template`);
        }
      }

      // Fetch property name
      const propRes = await client.query('SELECT id, name FROM properties WHERE id=$1', [input.property_id]);
      propertyRow = propRes.rows[0];

      // Fetch room + room-type info for reservation
      const roomRes = await client.query(
        `SELECT rm.id, rm.room_number, rm.room_type_id,
                rt.name AS room_type_name,
                r.booked_room_type_name_snapshot
         FROM reservations r
         JOIN bookings b ON b.id = r.booking_id
         LEFT JOIN rooms rm ON rm.id = r.room_id
         LEFT JOIN room_types rt ON rt.id = COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot)
         WHERE r.id = $1 AND b.property_id = $2`,
        [reservation.id, input.property_id]
      );
      roomRow = roomRes.rows[0];
    }

    // Build variable map — only populate when a real non-empty value exists
    const vars: Record<string, string> = {};
    const preferredName = guest.preferred_name && String(guest.preferred_name).trim() !== ''
      ? String(guest.preferred_name).trim()
      : guest.full_name;
    vars['guest_name'] = preferredName;
    vars['guest_full_name'] = guest.full_name;

    if (propertyRow) {
      const propName = propertyRow.name && String(propertyRow.name).trim() !== ''
        ? String(propertyRow.name).trim()
        : null;
      if (propName) {
        vars['property_name'] = propName;
      }
    }

    if (reservation) {
      vars['reservation_id'] = String(reservation.id);
      if (reservation.check_in) {
        vars['check_in_date'] = String(reservation.check_in);
      }
      if (reservation.check_out) {
        vars['check_out_date'] = String(reservation.check_out);
      }
      // room_type: prefer joined room_type_name, fallback to snapshot
      const roomTypeName = roomRow?.room_type_name
        || roomRow?.booked_room_type_name_snapshot
        || null;
      if (roomTypeName) {
        vars['room_type'] = roomTypeName;
      }
      if (roomRow?.room_number) {
        vars['room_number'] = String(roomRow.room_number);
      }
    }

    // Render message
    let renderedMessage = template.message_body;
    for (const [key, value] of Object.entries(vars)) {
      renderedMessage = renderedMessage.split(`{{${key}}}`).join(value);
    }

    // Check for unresolved placeholders
    const remaining = extractPlaceholders(renderedMessage);
    if (remaining.length > 0) {
      throw httpError(400, 'VALIDATION_ERROR',
        `Unresolved template placeholders: ${remaining.map((v) => `{{${v}}}`).join(', ')}`);
    }

    // ── Strict metadata validation ─────────────────────────────────────────
    // undefined → use {} (omit silently)
    // null → 400 VALIDATION_ERROR
    // array/string/number/boolean → 400 VALIDATION_ERROR
    // plain object → accepted; server keys override client keys
    let validatedClientMeta: Record<string, unknown> = {};
    if (input.metadata !== undefined) {
      if (
        input.metadata === null ||
        typeof input.metadata !== 'object' ||
        Array.isArray(input.metadata)
      ) {
        throw httpError(400, 'VALIDATION_ERROR',
          'metadata must be a non-null plain object (not array, string, number, boolean, or null)');
      }
      validatedClientMeta = input.metadata as Record<string, unknown>;
    }

    // Build metadata — server keys override client-provided values (no mutation of input.metadata)
    const metadata: Record<string, unknown> = {
      ...validatedClientMeta,
      normalized_destination: waDestination,
      template_id: template.id,
      guest_id: guest.id,
      reservation_id: input.reservation_id ?? null,
    };

    // Insert communication log
    const logRes = await client.query(
      `INSERT INTO guest_communication_logs
         (property_id, guest_id, guest_name_snapshot, destination_snapshot,
          reservation_id, template_id, template_code_snapshot, template_name_snapshot,
          channel, scope, category, message_snapshot, status,
          initiated_by_user_id, initiated_by_name_snapshot, initiated_by_role_snapshot,
          correlation_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        input.property_id,
        guest.id,
        guest.full_name,
        waDestination,
        input.reservation_id ?? null,
        template.id,
        template.code,
        template.name,
        'WHATSAPP',
        template.scope,
        template.category,
        renderedMessage,
        'INITIATED',
        actor.userId,
        actor.name,
        actor.role,
        correlationId,
        JSON.stringify(metadata),
      ]
    );

    const log = logRes.rows[0];

    await insertAudit(
      client, 'GUEST_CRM', 'GUEST_COMMUNICATION_INITIATED', 'GUEST_COMMUNICATION',
      log.id, input.property_id, log, null, actor, correlationId
    );

    await client.query('COMMIT');

    const whatsappDeepLink = `https://wa.me/${waDestination}?text=${encodeURIComponent(renderedMessage)}`;

    return {
      log,
      rendered_message: renderedMessage,
      normalized_destination: waDestination,
      whatsapp_deep_link: whatsappDeepLink,
    };
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── Mark WhatsApp opened ────────────────────────────────────────────────────
// NOTE: guest_communication_logs has NO updated_at column. Only status changes.

export async function markWhatsAppOpened(
  pool: Pool,
  propertyId: number,
  communicationId: number,
  actor: ActorSnapshot,
  correlationId: string
): Promise<GuestCommunicationLog> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lockRes = await client.query(
      'SELECT * FROM guest_communication_logs WHERE id=$1 AND property_id=$2 FOR UPDATE',
      [communicationId, propertyId]
    );
    if ((lockRes.rowCount ?? 0) === 0) {
      throw httpError(404, 'COMMUNICATION_NOT_FOUND', `Communication ${communicationId} not found`);
    }
    const existing = lockRes.rows[0];

    if (existing.channel !== 'WHATSAPP') {
      throw httpError(400, 'VALIDATION_ERROR', 'Only WhatsApp communications can be marked as opened');
    }

    // Idempotent: if already OPENED_WHATSAPP, return as-is without duplicate audit
    if (existing.status === 'OPENED_WHATSAPP') {
      await client.query('COMMIT');
      return existing;
    }

    if (existing.status !== 'INITIATED') {
      throw httpError(400, 'VALIDATION_ERROR',
        `Cannot transition from status '${existing.status}' to OPENED_WHATSAPP`);
    }

    // Update ONLY status — no updated_at column on this table
    const res = await client.query(
      `UPDATE guest_communication_logs
       SET status = 'OPENED_WHATSAPP'
       WHERE id=$1 AND property_id=$2
       RETURNING *`,
      [communicationId, propertyId]
    );

    await insertAudit(
      client, 'GUEST_CRM', 'GUEST_COMMUNICATION_WHATSAPP_OPENED', 'GUEST_COMMUNICATION',
      communicationId, propertyId, res.rows[0], existing, actor, correlationId
    );

    await client.query('COMMIT');
    return res.rows[0];
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── Communication history ───────────────────────────────────────────────────

export async function getCommunicationHistory(
  pool: Pool,
  filters: CommunicationHistoryFilters
): Promise<CommunicationHistoryResponse> {
  const { property_id, guest_id, reservation_id, template_id, status, limit, offset } = filters;

  // ── Defensive validation at service entry ──────────────────────────────────

  // property_id
  if (!Number.isFinite(property_id) || !Number.isInteger(property_id) || property_id <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'property_id must be a positive integer');
  }
  await assertPropertyExists(pool, property_id);

  // guest_id
  if (guest_id != null) {
    if (!Number.isFinite(guest_id) || !Number.isInteger(guest_id) || guest_id <= 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'guest_id must be a positive integer');
    }
    await assertGuestBelongsToProperty(pool, guest_id, property_id);
  }

  // reservation_id
  if (reservation_id != null) {
    if (!Number.isFinite(reservation_id) || !Number.isInteger(reservation_id) || reservation_id <= 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'reservation_id must be a positive integer');
    }
    await assertReservationBelongsToProperty(pool, reservation_id, property_id);
  }

  // template_id
  if (template_id != null) {
    if (!Number.isFinite(template_id) || !Number.isInteger(template_id) || template_id <= 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'template_id must be a positive integer');
    }
    const tplCheck = await pool.query(
      'SELECT id FROM guest_communication_templates WHERE id=$1 AND property_id=$2',
      [template_id, property_id]
    );
    if ((tplCheck.rowCount ?? 0) === 0) {
      throw httpError(404, 'TEMPLATE_NOT_FOUND', `Template ${template_id} not found for this property`);
    }
  }

  // status
  if (status !== null && status !== 'INITIATED' && status !== 'OPENED_WHATSAPP') {
    throw httpError(400, 'VALIDATION_ERROR', 'status must be exactly INITIATED or OPENED_WHATSAPP');
  }

  // limit — strict 1..100, no clamping
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw httpError(400, 'VALIDATION_ERROR', 'limit must be a finite integer between 1 and 100');
  }

  // offset — strict >= 0, no clamp
  if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset < 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'offset must be a finite integer >= 0');
  }

  // ── Query execution ────────────────────────────────────────────────────────

  let sql = `
    SELECT id, property_id, guest_id, guest_name_snapshot, destination_snapshot,
           reservation_id, template_id, template_code_snapshot, template_name_snapshot,
           channel, scope, category, message_snapshot, status,
           initiated_by_user_id, initiated_by_name_snapshot, initiated_by_role_snapshot,
           correlation_id, metadata, initiated_at
    FROM guest_communication_logs
    WHERE property_id = $1
  `;
  const params: unknown[] = [property_id];
  let p = 2;

  if (guest_id != null) {
    sql += ` AND guest_id = $${p++}`;
    params.push(guest_id);
  }
  if (reservation_id != null) {
    sql += ` AND reservation_id = $${p++}`;
    params.push(reservation_id);
  }
  if (template_id != null) {
    sql += ` AND template_id = $${p++}`;
    params.push(template_id);
  }
  if (status != null) {
    sql += ` AND status = $${p++}`;
    params.push(status);
  }
  sql += ` ORDER BY initiated_at DESC, id DESC LIMIT $${p++} OFFSET $${p++}`;
  params.push(limit, offset);

  // Count query
  let countSql = `
    SELECT COUNT(*)::bigint AS total
    FROM guest_communication_logs
    WHERE property_id = $1
  `;
  const countParams: unknown[] = [property_id];
  let cp = 2;
  if (guest_id != null) { countSql += ` AND guest_id = $${cp++}`; countParams.push(guest_id); }
  if (reservation_id != null) { countSql += ` AND reservation_id = $${cp++}`; countParams.push(reservation_id); }
  if (template_id != null) { countSql += ` AND template_id = $${cp++}`; countParams.push(template_id); }
  if (status != null) { countSql += ` AND status = $${cp++}`; countParams.push(status); }

  const [dataRes, countRes] = await Promise.all([
    pool.query(sql, params),
    pool.query(countSql, countParams),
  ]);

  return {
    data: dataRes.rows,
    total: Number(countRes.rows[0]?.total || 0),
    limit,
    offset,
  };
}
