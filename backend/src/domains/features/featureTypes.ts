export const FEATURE_KEYS = {
  // Housekeeping Module Master Switch
  HK_ENABLED: 'housekeeping.enabled',

  // Housekeeping Core Operational Sub-Features
  HK_ROOM_OPERATIONS: 'housekeeping.room_operations',
  HK_CHECKOUT_INSPECTION: 'housekeeping.checkout_inspection',
  HK_FINAL_INSPECTION: 'housekeeping.final_inspection',
  HK_SERVICE_REQUESTS: 'housekeeping.service_requests',
  HK_DEPARTMENT_TASKS: 'housekeeping.department_tasks',

  // Housekeeping Extended Operational Sub-Features (Default OFF)
  HK_PUBLIC_AREA_CLEANING: 'housekeeping.public_area_cleaning',
  HK_RECURRING_CLEANING: 'housekeeping.recurring_cleaning',

  // Housekeeping Laundry Sub-Features (Default OFF)
  HK_LAUNDRY: 'housekeeping.laundry',
  HK_LAUNDRY_INTERNAL: 'housekeeping.laundry_internal',
  HK_LAUNDRY_VENDOR: 'housekeeping.laundry_vendor',
  HK_GUEST_LAUNDRY: 'housekeeping.guest_laundry',

  // Housekeeping Inventory Sub-Features (Default OFF)
  HK_LINEN_INVENTORY: 'housekeeping.linen_inventory',
  HK_AMENITIES_INVENTORY: 'housekeeping.amenities_inventory',
  HK_CHEMICAL_INVENTORY: 'housekeeping.chemical_inventory',
  HK_PANTRY_INVENTORY: 'housekeeping.hk_pantry_inventory',

  // Housekeeping Lost and Found (Default OFF)
  HK_LOST_AND_FOUND: 'housekeeping.lost_and_found',

  // Legacy / Backward Compatibility Aliases
  HK_LINEN_ALIAS: 'housekeeping.linen',
  HK_AMENITIES_ALIAS: 'housekeeping.amenities',

  // Other Domain Master Switches (Architecture preparation)
  FO_ENABLED: 'front_office.enabled',
  POS_ENABLED: 'pos.enabled',
  FINANCE_ENABLED: 'finance.enabled',
  HRD_ENABLED: 'hrd.enabled',
  EVENTS_BANQUET_ENABLED: 'events_banquet.enabled',
  MARKETING_ENABLED: 'marketing.enabled',
  PURCHASING_ENABLED: 'purchasing.enabled',
  GENERAL_AFFAIR_ENABLED: 'general_affair.enabled',
} as const;

export type FeatureKey = typeof FEATURE_KEYS[keyof typeof FEATURE_KEYS];

export const FEATURE_ALIASES: Record<string, string> = {
  'housekeeping.linen': 'housekeeping.linen_inventory',
  'housekeeping.amenities': 'housekeeping.amenities_inventory',
};

export const DEFAULT_FEATURE_FLAGS: Record<string, boolean> = {
  // Housekeeping Core
  'housekeeping.enabled': true,
  'housekeeping.room_operations': true,
  'housekeeping.checkout_inspection': true,
  'housekeeping.final_inspection': true,
  'housekeeping.service_requests': true,
  'housekeeping.department_tasks': true,

  // Housekeeping Extended (Default OFF)
  'housekeeping.public_area_cleaning': false,
  'housekeeping.recurring_cleaning': false,
  'housekeeping.laundry': false,
  'housekeeping.laundry_internal': false,
  'housekeeping.laundry_vendor': false,
  'housekeeping.guest_laundry': false,
  'housekeeping.linen_inventory': false,
  'housekeeping.amenities_inventory': false,
  'housekeeping.chemical_inventory': false,
  'housekeeping.hk_pantry_inventory': false,
  'housekeeping.lost_and_found': false,

  // Legacy Aliases
  'housekeeping.linen': false,
  'housekeeping.amenities': false,

  // Hotel Domains Master Switches
  'front_office.enabled': true,
  'pos.enabled': true,
  'finance.enabled': true,
  'hrd.enabled': true,
  'events_banquet.enabled': false,
  'marketing.enabled': true,
  'purchasing.enabled': false,
  'general_affair.enabled': false,
};

export interface PropertyFeatureRecord {
  id: number;
  property_id: number;
  feature_key: string;
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}
