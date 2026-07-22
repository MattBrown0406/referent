export type PartnerType =
  | 'Inpatient'
  | 'IOP / PHP'
  | 'Interventionist'
  | 'Therapist'
  | 'Sober Living'
  | 'Detox';

export type ReferralDirection = 'Inbound' | 'Outbound';
export type InsuranceNetworkPreference = 'In-network' | 'Out-of-network';

export type Partner = {
  id: string;
  name: string;
  organization: string;
  type: PartnerType;
  types?: PartnerType[];
  city: string;
  state: string;
  regions: string[];
  phone: string;
  email: string;
  website?: string;
  cashMin: number;
  cashMax: number;
  insurance: string[];
  therapies: string[];
  populations: string[];
  levels: string[];
  note: string;
  inbound: number;
  outbound: number;
  lastContact: string;
  favorite?: boolean;
};

export type Referral = {
  id: string;
  partnerId: string;
  direction: ReferralDirection;
  date: string;
  clientLabel: string;
  outcome: 'Placed' | 'Introduced' | 'Consulted' | 'Pending';
  note: string;
};

export type ReferralMatch = {
  id: string;
  clientLabel: string;
  levelOfCare: PartnerType | 'Any type';
  state: string;
  insurance: string;
  networkPreferences?: InsuranceNetworkPreference[];
  maxBudget?: number;
  therapies: string[];
  status: 'Matching' | 'Referred';
  createdAt: string;
  updatedAt: string;
  assignedPartnerId?: string;
  referralId?: string;
};

export const partnerTypes: PartnerType[] = [
  'Inpatient',
  'IOP / PHP',
  'Interventionist',
  'Therapist',
  'Sober Living',
  'Detox',
];

export const therapyOptions = [
  'Men only',
  'Women only',
  'Adolescent',
  'LGBTQ+',
  'Trauma',
  'Dual diagnosis',
  'Eating disorders',
  'Gambling',
  'Sex addiction',
  'Chronic relapse',
  'MAT',
  'CBT',
  'DBT',
  'EMDR',
  'IFS',
  'Equine',
  'Adventure',
  'Family systems',
  'Chronic pain',
  'Faith based',
];

export const nationalInsuranceProviders = [
  'Cash pay',
  'Aetna',
  'Cigna',
  'UnitedHealthcare',
  'Blue Cross',
  'Anthem',
  'Tricare',
  'Humana',
  'Kaiser Permanente',
  'Molina Healthcare',
  'Ambetter',
  'Oscar Health',
];

export const stateOptions = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' }, { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' }, { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' }, { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' }, { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' }, { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' }, { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' }, { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' }, { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' }, { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' }, { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' }, { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' }, { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' }, { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' }, { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' }, { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];

export const regionalInsuranceByState: Record<string, string[]> = {
  AL: ['Blue Cross and Blue Shield of Alabama'],
  AK: ['Premera Blue Cross Blue Shield of Alaska'],
  AZ: ['Blue Cross Blue Shield of Arizona', 'Banner|Aetna'],
  AR: ['Arkansas Blue Cross and Blue Shield'],
  CA: ['Blue Shield of California', 'Health Net', 'L.A. Care Health Plan', 'CalOptima Health'],
  CO: ['Rocky Mountain Health Plans', 'Denver Health Medical Plan'],
  CT: ['ConnectiCare'],
  DE: ['Highmark Blue Cross Blue Shield Delaware'],
  DC: ['CareFirst BlueCross BlueShield'],
  FL: ['Florida Blue', 'AvMed', 'Capital Health Plan'],
  GA: ['Blue Cross Blue Shield of Georgia', 'CareSource Georgia'],
  HI: ['Hawaii Medical Service Association', 'Kaiser Permanente Hawaii'],
  ID: ['Blue Cross of Idaho', 'Regence BlueShield of Idaho'],
  IL: ['Blue Cross and Blue Shield of Illinois'],
  IN: ['Anthem Blue Cross and Blue Shield Indiana', 'Indiana University Health Plans'],
  IA: ['Wellmark Blue Cross and Blue Shield'],
  KS: ['Blue Cross and Blue Shield of Kansas'],
  KY: ['Anthem Blue Cross and Blue Shield Kentucky'],
  LA: ['Blue Cross and Blue Shield of Louisiana'],
  ME: ['Maine Community Health Options'],
  MD: ['CareFirst BlueCross BlueShield'],
  MA: ['Blue Cross Blue Shield of Massachusetts', 'Harvard Pilgrim Health Care', 'Tufts Health Plan'],
  MI: ['Blue Cross Blue Shield of Michigan', 'Priority Health', 'Health Alliance Plan'],
  MN: ['Blue Cross and Blue Shield of Minnesota', 'HealthPartners', 'Medica', 'UCare'],
  MS: ['Blue Cross & Blue Shield of Mississippi'],
  MO: ['Blue Cross and Blue Shield of Kansas City'],
  MT: ['Blue Cross and Blue Shield of Montana'],
  NE: ['Blue Cross and Blue Shield of Nebraska'],
  NV: ['Health Plan of Nevada', 'Hometown Health'],
  NH: ['Harvard Pilgrim Health Care', 'Anthem Blue Cross and Blue Shield New Hampshire'],
  NJ: ['Horizon Blue Cross Blue Shield of New Jersey', 'AmeriHealth New Jersey'],
  NM: ['Presbyterian Health Plan', 'Blue Cross Blue Shield of New Mexico'],
  NY: ['EmblemHealth', 'Healthfirst', 'Fidelis Care', 'Independent Health', 'CDPHP'],
  NC: ['Blue Cross and Blue Shield of North Carolina'],
  ND: ['Blue Cross Blue Shield of North Dakota', 'Sanford Health Plan'],
  OH: ['Medical Mutual of Ohio', 'CareSource'],
  OK: ['Blue Cross and Blue Shield of Oklahoma', 'CommunityCare'],
  OR: ['Regence BlueCross BlueShield of Oregon', 'PacificSource Health Plans', 'Moda Health'],
  PA: ['Highmark Blue Cross Blue Shield', 'Independence Blue Cross', 'UPMC Health Plan', 'Geisinger Health Plan'],
  RI: ['Blue Cross & Blue Shield of Rhode Island', 'Neighborhood Health Plan of Rhode Island'],
  SC: ['BlueChoice HealthPlan'],
  SD: ['Avera Health Plans', 'Sanford Health Plan'],
  TN: ['BlueCross BlueShield of Tennessee'],
  TX: ['Blue Cross and Blue Shield of Texas', 'Baylor Scott & White Health Plan', 'Community Health Choice'],
  UT: ['Select Health', 'University of Utah Health Plans'],
  VT: ['Blue Cross and Blue Shield of Vermont'],
  VA: ['CareFirst BlueCross BlueShield', 'Sentara Health Plans'],
  WA: ['Premera Blue Cross', 'Regence BlueShield', 'Community Health Plan of Washington'],
  WV: ['Highmark West Virginia'],
  WI: ['Quartz', 'Dean Health Plan', 'Security Health Plan'],
  WY: ['Blue Cross Blue Shield of Wyoming'],
};

// State program names plus major comprehensive or behavioral-health Medicaid
// managed-care plans reported in the CMS 2024 managed-care enrollment data.
export const medicaidPlansByState: Record<string, string[]> = {
  AL: ['Alabama Medicaid'],
  AK: ['Alaska Medicaid'],
  AZ: ['AHCCCS', 'UnitedHealthcare Community Plan of Arizona', 'Mercy Care', 'Arizona Complete Health', 'Banner – University Family Care', 'Health Choice Arizona', 'Molina Complete Care of Arizona'],
  AR: ['Arkansas Medicaid / ARHOME', 'Empower Healthcare Solutions', 'Summit Community Care', 'Arkansas Total Care', 'CareSource Arkansas'],
  CA: ['Medi-Cal', 'L.A. Care Health Plan', 'Health Net Community Solutions', 'CalOptima Health', 'Inland Empire Health Plan', 'Kaiser Permanente Medi-Cal', 'Community Health Group', 'Kern Family Health Care'],
  CO: ['Health First Colorado'],
  CT: ['HUSKY Health / Connecticut Medicaid'],
  DE: ['Delaware Medicaid', 'Highmark Health Options of Delaware', 'AmeriHealth Caritas Delaware', 'Delaware First Health'],
  DC: ['DC Medicaid', 'AmeriHealth Caritas District of Columbia', 'MedStar Family Choice – DC', 'Wellpoint District of Columbia', 'UnitedHealthcare Community Plan of DC', 'Health Services for Children with Special Needs'],
  FL: ['Florida Medicaid / Statewide Medicaid Managed Care', 'Sunshine Health', 'Humana Healthy Horizons Florida', 'Simply Healthcare Plans', 'UnitedHealthcare Community Plan of Florida', 'Aetna Better Health of Florida', 'Molina Healthcare of Florida'],
  GA: ['Georgia Medicaid / Georgia Families', 'Peach State Health Plan', 'Wellpoint Georgia', 'CareSource Georgia Medicaid'],
  HI: ['Med-QUEST / QUEST Integration', 'HMSA QUEST Integration', 'AlohaCare QUEST Integration', 'UnitedHealthcare Community Plan QUEST Integration', 'Kaiser Permanente QUEST Integration', 'Ohana Health Plan QUEST Integration'],
  ID: ['Idaho Medicaid', 'Magellan of Idaho', 'Blue Cross of Idaho Medicaid', 'Molina Healthcare of Idaho'],
  IL: ['Illinois Medicaid / HealthChoice Illinois', 'MeridianHealth', 'Blue Cross Community Health Plans', 'CountyCare Health Plan', 'Aetna Better Health of Illinois', 'Molina Healthcare of Illinois', 'YouthCare'],
  IN: ['Indiana Medicaid / Hoosier Healthwise', 'Anthem Blue Cross and Blue Shield Medicaid', 'MDwise', 'Managed Health Services', 'CareSource Indiana Medicaid', 'UnitedHealthcare Community Plan of Indiana', 'Humana Healthy Horizons Indiana'],
  IA: ['Iowa Medicaid / IA Health Link', 'Wellpoint Iowa', 'Iowa Total Care', 'Molina Healthcare of Iowa'],
  KS: ['KanCare', 'UnitedHealthcare Community Plan of Kansas', 'Sunflower Health Plan', 'Aetna Better Health of Kansas'],
  KY: ['Kentucky Medicaid', 'WellCare of Kentucky', 'Passport by Molina Healthcare', 'Aetna Better Health of Kentucky', 'Anthem Medicaid Kentucky', 'Humana Healthy Horizons Kentucky', 'UnitedHealthcare Community Plan of Kentucky'],
  LA: ['Healthy Louisiana', 'Louisiana Healthcare Connections', 'UnitedHealthcare Community Plan of Louisiana', 'Healthy Blue Louisiana', 'AmeriHealth Caritas Louisiana', 'Aetna Better Health of Louisiana', 'Humana Healthy Horizons Louisiana'],
  ME: ['MaineCare'],
  MD: ['Maryland Medicaid / HealthChoice', 'Priority Partners', 'Wellpoint Maryland', 'Maryland Physicians Care', 'UnitedHealthcare Community Plan of Maryland', 'Kaiser Permanente Medicaid', 'MedStar Family Choice', 'CareFirst Community Health Plan Maryland', 'Aetna Better Health of Maryland'],
  MA: ['MassHealth', 'Massachusetts Behavioral Health Partnership', 'Mass General Brigham Health Plan Medicaid', 'WellSense Health Plan', 'Tufts Health Together', 'BeHealthy Partnership'],
  MI: ['Michigan Medicaid', 'Meridian Health Plan of Michigan', 'Molina Healthcare of Michigan', 'Blue Cross Complete of Michigan', 'UnitedHealthcare Community Plan of Michigan', 'McLaren Health Plan Medicaid', 'Priority Health Choice'],
  MN: ['Minnesota Medical Assistance', 'UCare Medicaid', 'Blue Plus Medicaid', 'HealthPartners Medicaid', 'PrimeWest Health', 'UnitedHealthcare Community Plan of Minnesota', 'Hennepin Health', 'Medica Medicaid'],
  MS: ['Mississippi Medicaid / MississippiCAN', 'Magnolia Health', 'UnitedHealthcare Community Plan of Mississippi', 'Molina Healthcare of Mississippi'],
  MO: ['MO HealthNet', 'Healthy Blue Missouri', 'Home State Health', 'UnitedHealthcare Community Plan of Missouri', 'Show Me Healthy Kids'],
  MT: ['Montana Medicaid'],
  NE: ['Nebraska Medicaid / Heritage Health', 'Nebraska Total Care', 'Molina Healthcare of Nebraska', 'UnitedHealthcare Community Plan of Nebraska'],
  NV: ['Nevada Medicaid', 'Health Plan of Nevada Medicaid', 'Anthem Medicaid Nevada', 'SilverSummit Healthplan', 'Molina Healthcare of Nevada'],
  NH: ['New Hampshire Medicaid', 'WellSense Health Plan', 'New Hampshire Healthy Families', 'AmeriHealth Caritas New Hampshire'],
  NJ: ['NJ FamilyCare', 'Horizon NJ Health', 'UnitedHealthcare Community Plan of New Jersey', 'Wellpoint New Jersey', 'Aetna Better Health of New Jersey', 'WellCare of New Jersey'],
  NM: ['Turquoise Care', 'Presbyterian Turquoise Care', 'Blue Cross Community Centennial', 'Molina Healthcare of New Mexico', 'UnitedHealthcare Community Plan of New Mexico'],
  NY: ['New York Medicaid', 'Fidelis Care Medicaid', 'Healthfirst Medicaid', 'MetroPlusHealth Medicaid', 'HealthPlus Medicaid', 'UnitedHealthcare Community Plan of New York', 'Molina Healthcare of New York', 'Excellus Medicaid', 'MVP Medicaid'],
  NC: ['NC Medicaid', 'Healthy Blue of North Carolina', 'WellCare of North Carolina', 'UnitedHealthcare Community Plan of North Carolina', 'AmeriHealth Caritas North Carolina', 'Carolina Complete Health', 'Trillium Health Resources', 'Alliance Health', 'Vaya Health'],
  ND: ['North Dakota Medicaid', 'North Dakota Medicaid Expansion'],
  OH: ['Ohio Medicaid', 'CareSource Ohio Medicaid', 'Buckeye Health Plan', 'UnitedHealthcare Community Plan of Ohio', 'Molina Healthcare of Ohio', 'Anthem Ohio Medicaid', 'Humana Healthy Horizons Ohio', 'AmeriHealth Caritas Ohio', 'Aetna Better Health of Ohio'],
  OK: ['SoonerCare / SoonerSelect', 'Oklahoma Complete Health', 'Humana Healthy Horizons Oklahoma', 'Aetna Better Health of Oklahoma'],
  OR: ['Oregon Health Plan', 'Health Share of Oregon', 'PacificSource Community Solutions', 'InterCommunity Health Network CCO', 'Eastern Oregon CCO', 'AllCare Health', 'Jackson Care Connect', 'CareOregon'],
  PA: ['Pennsylvania Medical Assistance / HealthChoices', 'UPMC for You', 'Keystone First', 'Geisinger Health Plan Family', 'AmeriHealth Caritas Pennsylvania', 'Health Partners Plans Medicaid', 'Highmark Wholecare'],
  RI: ['Rhode Island Medicaid', 'Neighborhood Health Plan of Rhode Island Medicaid', 'UnitedHealthcare Community Plan of Rhode Island', 'Tufts Health RITogether'],
  SC: ['Healthy Connections Medicaid', 'First Choice by Select Health', 'Absolute Total Care', 'Healthy Blue South Carolina', 'Molina Healthcare of South Carolina', 'Humana Healthy Horizons South Carolina'],
  SD: ['South Dakota Medicaid'],
  TN: ['TennCare', 'BlueCare Tennessee', 'TennCare Select', 'UnitedHealthcare Community Plan of Tennessee', 'Wellpoint Tennessee'],
  TX: ['Texas Medicaid / STAR', 'Superior HealthPlan', 'Wellpoint Texas Medicaid', "Texas Children’s Health Plan", 'Community Health Choice', "Driscoll Children’s Health Plan", 'UnitedHealthcare Community Plan of Texas', 'Parkland Community Health Plan', 'Molina Healthcare of Texas'],
  UT: ['Utah Medicaid', 'Select Health Community Care', 'Molina Medicaid Utah', 'Healthy U Medicaid', 'Health Choice Utah Medicaid', 'Salt Lake County Behavioral Health', 'Wasatch Behavioral Health'],
  VT: ['Green Mountain Care / Vermont Medicaid'],
  VA: ['Cardinal Care', 'Sentara Community Plan', 'Anthem HealthKeepers Plus', 'Aetna Better Health of Virginia', 'UnitedHealthcare Community Plan of Virginia', 'Molina Complete Care of Virginia', 'Humana Healthy Horizons Virginia'],
  WA: ['Apple Health', 'Molina Healthcare of Washington', 'Community Health Plan of Washington', 'UnitedHealthcare Community Plan of Washington', 'Coordinated Care of Washington', 'Wellpoint Washington'],
  WV: ['West Virginia Medicaid / Mountain Health Trust', 'Wellpoint West Virginia Medicaid', 'Aetna Better Health of West Virginia', 'The Health Plan Medicaid', 'Highmark Health Options West Virginia'],
  WI: ['BadgerCare Plus', 'UnitedHealthcare Community Plan of Wisconsin', 'Anthem Medicaid Wisconsin', 'Chorus Community Health Plans', 'Molina Healthcare of Wisconsin', 'Security Health Plan Medicaid', 'MHS Health Wisconsin', 'Group Health Cooperative Medicaid'],
  WY: ['Wyoming Medicaid'],
};

export function insuranceProvidersForState(stateCode: string) {
  const medicaid = stateCode === 'ANY' ? [] : medicaidPlansByState[stateCode] || [];
  const regional = stateCode === 'ANY' ? [] : regionalInsuranceByState[stateCode] || [];
  return Array.from(new Set(['Cash pay', ...medicaid, ...regional, ...nationalInsuranceProviders.filter((provider) => provider !== 'Cash pay')]));
}

export const initialPartners: Partner[] = [];

export const initialReferrals: Referral[] = [];

export const initialReferralMatches: ReferralMatch[] = [];

export const formatMoney = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);

export const shortDate = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
