export const CASH_PAY = 'Cash Pay';

export const NATIONAL_PROVIDERS = [
  'Aetna',
  'Cigna',
  'UnitedHealthcare',
  'Humana',
  'Optum',
  'Magellan',
  'TRICARE',
  'Medicare',
];

interface StatePlans {
  medicaid: string;
  regional: string[];
}

export const STATE_PLANS: Record<string, StatePlans> = {
  UT: {
    medicaid: 'Utah Medicaid',
    regional: ['SelectHealth', 'Regence BCBS of Utah', 'EMI Health', 'University of Utah Health Plans'],
  },
  AZ: {
    medicaid: 'AHCCCS (Arizona Medicaid)',
    regional: ['Blue Cross Blue Shield of Arizona', 'Banner Health Plans'],
  },
  CA: {
    medicaid: 'Medi-Cal',
    regional: ['Kaiser Permanente', 'Anthem Blue Cross of California', 'Blue Shield of California', 'Health Net'],
  },
  CO: {
    medicaid: 'Health First Colorado (Medicaid)',
    regional: ['Anthem BCBS Colorado', 'Kaiser Permanente', 'Rocky Mountain Health Plans', 'Denver Health Medical Plan'],
  },
  TX: {
    medicaid: 'Texas Medicaid (STAR)',
    regional: ['Blue Cross Blue Shield of Texas', 'Superior HealthPlan', 'Baylor Scott & White Health Plan'],
  },
  TN: {
    medicaid: 'TennCare',
    regional: ['BlueCross BlueShield of Tennessee', 'Farm Bureau Health Plans'],
  },
  MT: {
    medicaid: 'Montana Medicaid',
    regional: ['Blue Cross Blue Shield of Montana', 'PacificSource'],
  },
  NC: {
    medicaid: 'NC Medicaid',
    regional: ['Blue Cross NC', 'AmeriHealth Caritas NC'],
  },
  ID: {
    medicaid: 'Idaho Medicaid',
    regional: ['Blue Cross of Idaho', 'SelectHealth', 'PacificSource'],
  },
};

export function statePlansFor(state: string): StatePlans {
  return STATE_PLANS[state] ?? { medicaid: `${state} Medicaid`, regional: [] };
}

export interface DropdownSection {
  header?: string;
  items: string[];
}

/** Options for the Match screen payment dropdown, grouped by section. */
export function paymentSectionsForState(state: string | null): DropdownSection[] {
  const sections: DropdownSection[] = [{ items: [CASH_PAY] }];
  if (state) {
    const plans = statePlansFor(state);
    sections.push({ header: 'Medicaid', items: [plans.medicaid] });
    if (plans.regional.length > 0) {
      sections.push({ header: 'Regional Providers', items: plans.regional });
    }
  }
  sections.push({ header: 'National Providers', items: NATIONAL_PROVIDERS });
  return sections;
}

/** Flat insurance option list for the referent add/edit form. */
export function insuranceOptionsForState(state: string): string[] {
  const opts: string[] = [];
  if (state && state.length === 2) {
    const plans = statePlansFor(state);
    opts.push(plans.medicaid, ...plans.regional);
  }
  opts.push(...NATIONAL_PROVIDERS, 'Out-of-Network');
  return Array.from(new Set(opts));
}
