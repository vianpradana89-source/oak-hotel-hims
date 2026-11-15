export interface PosPricingSettingsRecord {
  property_id: number;
  service_charge_enabled: boolean;
  service_charge_percent: number;
  tax_enabled: boolean;
  tax_percent: number;
  created_at?: string;
  updated_at?: string;
  updated_by?: string | null;
}

/**
 * Canonical response shape returned by GET and PUT.
 * Intentionally does NOT expose created_at / updated_by — those are
 * audit metadata, not business fields of the settings contract.
 *
 * V1 EXCLUSIVE ONLY: no prices_include_service / prices_include_tax.
 */
export interface PosPricingSettingsData {
  service_charge_enabled: boolean;
  service_charge_percent: number;
  tax_enabled: boolean;
  tax_percent: number;
}

export interface UpdatePosPricingSettingsDTO {
  property_id?: number;
  service_charge_enabled?: boolean;
  service_charge_percent?: number;
  tax_enabled?: boolean;
  tax_percent?: number;
}
