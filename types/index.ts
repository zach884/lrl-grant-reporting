// types/index.ts — Shared TypeScript types for LRL Activity Tracker

// --- GHL Iframe Auth ---
export interface GHLUser {
  locationId: string;
  userId: string;
  userEmail: string;
  userName: string;
  isAdmin: boolean;
}

// --- Contact ---
export interface ContactOption {
  id: string;
  display: string; // company_name or full_name
  company_name: string;
  full_name: string;
  email: string;
  phone: string;
  address1: string;
  city: string;
  state: string;
  postal_code: string;
  minority_owned: string;
}

// --- Activity ---
export interface ActivityRecord {
  id?: string;
  activity_name: string;
  activity_date: string;
  activity_type: string;
  activity_notes: string;
  appointment_id: string;
  activity_owner: string;
  program__grant_association: string[];
  referral_type: string;
  contact_id: string;
  referred_to_id?: string;
}

// --- Config Sheet Types ---
export interface ReferralTypeGrantMapping {
  referral_type_key: string;
  display_label: string;
  grant: string;
  grant_reporting_label: string;
}

export interface GrantSheetMapping {
  grant: string;
  activity_type_key: string;
  sheet_id: string;
  active: boolean;
}

export interface FieldMapping {
  grant: string;
  activity_type_key: string;
  sheet_id: string;
  column_letter: string;
  data_source: 'contact' | 'activity' | 'referred_to' | 'computed' | 'static';
  field_key: string;
  display_label: string;
  write_condition: string;
  header_row: number;
}

export interface ReportingPeriod {
  grant: string;
  period_label: string;
  sheet_id: string;
  tab_name: string;
  date_from: string;
  date_to: string;
  active: boolean;
}

export interface ConfigData {
  referralTypeGrantMapping: ReferralTypeGrantMapping[];
  grantSheetMapping: GrantSheetMapping[];
  fieldMapping: FieldMapping[];
  reportingPeriods: ReportingPeriod[];
}

// --- Enrichment ---
export interface EnrichmentResult {
  county: string | null;
  /** hubzone || opportunityZone (null when geocode failed). Kept for the Sheets export. */
  geoDisadvantaged: boolean | null;
  /** In an SBA HUBZone. */
  hubzone?: boolean | null;
  /** In an Opportunity Zone. */
  opportunityZone?: boolean | null;
}

// --- GHL Field Options ---
export interface FieldOption {
  key: string;
  label: string;
}
