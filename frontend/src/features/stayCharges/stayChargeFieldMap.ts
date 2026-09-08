import type {
  CreateStayChargeRuleDto,
  StayChargeCalculationType,
  StayChargeRule,
  StayChargeType,
  UpdateStayChargeRuleDto
} from './stayChargesTypes';

const CALC_TO_METHOD: Record<string, string> = {
  FIXED: 'FIXED_AMOUNT',
  FIXED_AMOUNT: 'FIXED_AMOUNT',
  PERCENT_ROOM_RATE: 'PERCENTAGE_OF_NIGHTLY_RATE',
  PERCENTAGE_OF_NIGHTLY_RATE: 'PERCENTAGE_OF_NIGHTLY_RATE',
  FULL_NIGHT_RATE: 'FULL_NIGHT',
  FULL_NIGHT: 'FULL_NIGHT',
  FREE: 'FREE',
  MANUAL: 'MANUAL'
};

const METHOD_TO_CALC: Record<string, StayChargeCalculationType> = {
  FIXED_AMOUNT: 'FIXED',
  FIXED: 'FIXED',
  PERCENTAGE_OF_NIGHTLY_RATE: 'PERCENT_ROOM_RATE',
  PERCENT_ROOM_RATE: 'PERCENT_ROOM_RATE',
  FULL_NIGHT: 'FULL_NIGHT_RATE',
  FULL_NIGHT_RATE: 'FULL_NIGHT_RATE',
  FREE: 'FREE',
  MANUAL: 'MANUAL'
};

export function mapCalculationTypeToChargeMethod(
  value?: string | null
): string | undefined {
  if (!value) return undefined;
  return CALC_TO_METHOD[String(value).trim().toUpperCase()];
}

export function mapChargeMethodToCalculationType(
  value?: string | null
): StayChargeCalculationType {
  if (!value) return 'FIXED';
  return METHOD_TO_CALC[String(value).trim().toUpperCase()] || 'FIXED';
}

export function normalizeStayChargeRule(raw: any): StayChargeRule {
  const chargeMethod = String(raw?.charge_method || mapCalculationTypeToChargeMethod(raw?.calculation_type) || 'FIXED_AMOUNT');
  const calculationType = mapChargeMethodToCalculationType(raw?.calculation_type || chargeMethod);
  const taxable = raw?.taxable !== undefined ? Boolean(raw.taxable) : Boolean(raw?.is_taxable);
  const serviceChargeable = raw?.service_chargeable !== undefined
    ? Boolean(raw.service_chargeable)
    : Boolean(raw?.is_service_chargeable);
  const percentage = Number(raw?.percentage_rate ?? raw?.percentage_of_rate ?? 0);
  const sortOrder = Number(raw?.sort_order ?? raw?.display_order ?? 0);

  return {
    id: Number(raw?.id),
    property_id: Number(raw?.property_id),
    charge_type: raw?.charge_type as StayChargeType,
    code: String(raw?.code || ''),
    name: String(raw?.name || ''),
    description: raw?.description ?? null,
    calculation_type: calculationType,
    charge_method: chargeMethod,
    default_amount: Number(raw?.default_amount || 0),
    percentage_of_rate: percentage,
    percentage_rate: percentage,
    min_hours: raw?.min_hours ?? null,
    max_hours: raw?.max_hours ?? null,
    is_taxable: taxable,
    taxable,
    is_service_chargeable: serviceChargeable,
    service_chargeable: serviceChargeable,
    is_active: Boolean(raw?.is_active),
    is_archived: Boolean(raw?.is_archived),
    display_order: sortOrder,
    sort_order: sortOrder,
    created_at: raw?.created_at || '',
    updated_at: raw?.updated_at || ''
  };
}

/** Build edit-modal state from a normalized rule so tax/method never silently default wrong. */
export function toStayChargeEditForm(rule: StayChargeRule): Partial<StayChargeRule> {
  return {
    id: rule.id,
    property_id: rule.property_id,
    charge_type: rule.charge_type,
    code: rule.code,
    name: rule.name,
    description: rule.description || '',
    calculation_type: rule.calculation_type || 'FIXED',
    default_amount: Number(rule.default_amount || 0),
    percentage_of_rate: Number(rule.percentage_of_rate ?? rule.percentage_rate ?? 0),
    min_hours: rule.min_hours || 0,
    max_hours: rule.max_hours || 0,
    is_taxable: rule.is_taxable ?? rule.taxable ?? false,
    is_service_chargeable: rule.is_service_chargeable ?? rule.service_chargeable ?? false,
    is_active: rule.is_active,
    display_order: Number(rule.display_order ?? rule.sort_order ?? 1)
  };
}

export function toStayChargeWritePayload(
  dto: CreateStayChargeRuleDto | UpdateStayChargeRuleDto
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    property_id: dto.property_id
  };

  if (dto.charge_type !== undefined) payload.charge_type = dto.charge_type;
  if (dto.code !== undefined) payload.code = dto.code;
  if (dto.name !== undefined) payload.name = dto.name;
  if (dto.description !== undefined) payload.description = dto.description;
  if (dto.default_amount !== undefined) payload.default_amount = dto.default_amount;
  if (dto.is_active !== undefined) payload.is_active = dto.is_active;

  const chargeMethod = mapCalculationTypeToChargeMethod(
    (dto as any).charge_method || dto.calculation_type
  );
  if (chargeMethod !== undefined) payload.charge_method = chargeMethod;

  const percentage = dto.percentage_of_rate ?? (dto as any).percentage_rate;
  if (percentage !== undefined) payload.percentage_rate = percentage;

  const taxable = dto.is_taxable ?? (dto as any).taxable;
  if (taxable !== undefined) payload.taxable = taxable;

  const serviceChargeable = dto.is_service_chargeable ?? (dto as any).service_chargeable;
  if (serviceChargeable !== undefined) payload.service_chargeable = serviceChargeable;

  const sortOrder = dto.display_order ?? (dto as any).sort_order;
  if (sortOrder !== undefined) payload.sort_order = sortOrder;

  return payload;
}

export async function parseStayChargeResponse(
  res: Response,
  fallbackMessage: string
): Promise<any> {
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const raw = await res.text();
  const trimmed = raw.trim();
  const looksJson = contentType.includes('application/json')
    || trimmed.startsWith('{')
    || trimmed.startsWith('[');

  let json: any = null;
  if (looksJson && trimmed) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const fromJson = json && typeof json === 'object' ? (json.message || json.error) : null;
    throw new Error(fromJson || `${fallbackMessage} (HTTP ${res.status})`);
  }

  if (trimmed && json == null) {
    throw new Error(`${fallbackMessage} (HTTP ${res.status})`);
  }

  return json;
}
