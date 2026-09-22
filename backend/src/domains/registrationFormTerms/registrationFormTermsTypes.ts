export interface RegistrationFormClause {
  text: string;
}

export interface PropertyRegistrationFormTermsRecord {
  id?: number;
  property_id: number;
  terms_content: RegistrationFormClause[];
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
  updated_by?: string | null;
}

export interface UpdatePropertyRegistrationFormTermsDTO {
  terms_content: RegistrationFormClause[];
  is_active?: boolean;
}

export const MAX_CLAUSE_COUNT = 12;
export const MAX_CLAUSE_CHARS = 200;
