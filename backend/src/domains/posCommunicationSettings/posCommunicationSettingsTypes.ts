export interface PosCommunicationSettingsRecord {
  property_id: number;
  whatsapp_enabled: boolean;
  whatsapp_intro_message: string | null;
  whatsapp_closing_message: string | null;
  created_at?: string;
  updated_at?: string;
  updated_by?: string | null;
}

/**
 * Canonical response shape returned by GET and PUT.
 * Intentionally does NOT expose created_at / updated_by ΓÇö those are
 * audit metadata, not business fields of the settings contract.
 */
export interface PosCommunicationSettingsData {
  whatsapp_enabled: boolean;
  whatsapp_intro_message: string | null;
  whatsapp_closing_message: string | null;
}

export interface UpdatePosCommunicationSettingsDTO {
  property_id?: number;
  whatsapp_enabled?: boolean;
  whatsapp_intro_message?: string | null;
  whatsapp_closing_message?: string | null;
}
