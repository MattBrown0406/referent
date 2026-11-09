// The family assessment's questions and rules, shared word for word by the
// family's page (portal/src/assessment-schema.ts) and the app
// (src/lib/assessment-schema.ts). scripts/family-assessment-test.mjs checks
// the two copies are identical: change one, copy it to the other.
//
// Modeled section for section on Freedom Interventions' family intake
// (freedominterventions.com/assessment, Matt's own form): the same twelve
// sections, questions, options and stored values, with ReferralFit's
// changes (docs/FAMILY_ASSESSMENT.md):
//   * written for any practice ("your practitioner"), not one person;
//   * the signature is one consent at the end (CONSENT in the page), signed
//     by checking a box and typing a full name;
//   * answers that suggest danger show 911 and 988 right away (safetyFlags),
//     and mark the assessment for the practitioner's attention today;
//   * the insurance card photos are uploaded to private storage by link.
//
// Answers are one object keyed by field id: text, choice and yes/no answers
// are strings (yes/no store "yes" or "no"), checkboxes are string arrays,
// lists are arrays of row objects (a checkbox in a row stores true/false),
// and dsmBehaviors maps each criterion id to true/false. Card photos are
// not answers: the assessment row records that each side arrived.
//
// Pure: no React, no network. Plain TypeScript for both the portal (Vite)
// and the app (React Native).

export const ASSESSMENT_FORM_VERSION = '2026-11-08';

export type ShowIf = { field: string; equals: string | string[] };

export type Field =
  | { id: string; kind: 'text' | 'textarea' | 'email' | 'phone' | 'date' | 'number'; label: string; help?: string; required?: boolean; showIf?: ShowIf }
  | { id: string; kind: 'choice'; label: string; options: string[]; values?: string[]; help?: string; required?: boolean; showIf?: ShowIf }
  | { id: string; kind: 'multi'; label: string; options: string[]; help?: string; showIf?: ShowIf }
  | { id: string; kind: 'yesno'; label: string; help?: string; required?: boolean; showIf?: ShowIf }
  | { id: string; kind: 'list'; label: string; itemLabel: string; fields: Field[]; help?: string; showIf?: ShowIf }
  | { id: string; kind: 'photo'; label: string; help?: string }
  | { id: string; kind: 'dsm'; label: string; criteria: { id: string; criterion: string; question: string; examples: string }[] }
  | { id: string; kind: 'signature'; label: string; help?: string; required?: boolean };

export type Section = { id: string; title: string; intro?: string; fields: Field[] };

export type Answers = Record<string, unknown>;

/** Notes the page shows at fixed places, in the practice's name where it matters. */
export const NOTES = {
  intro: (practice: string) => `${practice} asked you to fill out this confidential assessment about your loved one. It gathers background for planning an intervention and finding the right care. It is not a diagnosis or a clinical evaluation.`,
  saving: 'Your answers save as you go, so you can stop and come back with the same link. Answer what you can; only a few questions are required.',
  time: 'It takes most families 30 to 45 minutes.',
  privacy: (practice: string) => `Your answers go only to ${practice}. Please do not forward the link: anyone with it can see what you have saved so far.`,
  insuranceWhy: "Why we ask: your loved one's insurance card and details are used only to find treatment programs that accept their insurance, so their benefits can help with the cost of treatment. Everything here is optional.",
  insuranceCard: "Uploading your loved one's insurance card lets your practitioner check benefits with treatment programs ahead of time, so you have options ready when the time comes.",
  insuranceTyped: 'No card handy, or prefer to type it in? Add what you can from the card. All optional.',
  mentalHealthWarning: 'This section asks about suicide and self-harm. Your honest answers help keep your loved one safe. If anyone is in danger right now, call 911. For a mental health crisis, call or text 988.',
  dsmNote: 'This count is not a diagnosis. It helps your practitioner understand what you are seeing.',
} as const;

/** Where to turn in an emergency, wherever the page has nothing else to say. */
export const CRISIS_SHORT = 'If anyone is in immediate danger, call 911 now. For a mental health crisis, call or text 988 (the Suicide & Crisis Lifeline).';

/** What the page shows when an answer suggests danger (safetyFlags). */
export const CRISIS_TEXT = `${CRISIS_SHORT} You can finish this form later; your answers are saved.`;

/** What the page shows when withdrawal could be medically dangerous (withdrawalWarning). */
export const WITHDRAWAL_TEXT = 'Seizures or DTs during withdrawal are a medical emergency. Stopping alcohol or sedatives suddenly can be dangerous: talk with a doctor before your loved one stops, and call 911 for a seizure or severe confusion.';

// ─── The questions ──────────────────────────────────────────────────────────

export const SECTIONS: Section[] = [
  // ─────────────────────────────────────────────────────────────── Section 1
  {
    id: 'contact', // progress bar: "Contact Information"
    title: 'Your Contact Information',
    fields: [
      { id: 'contactName', kind: 'text', label: 'Your Full Name', required: true },
      {
        id: 'contactRelationship', kind: 'choice', label: 'Relationship to Individual', required: true, // select
        options: ['Parent', 'Spouse/Partner', 'Adult Child', 'Sibling', 'Close Friend', 'Employer', 'Other'],
        values: ['parent', 'spouse', 'child', 'sibling', 'friend', 'employer', 'other'],
      },
      { id: 'contactEmail', kind: 'email', label: 'Email Address', required: true },
      { id: 'contactPhone', kind: 'phone', label: 'Phone Number', required: true },
      {
        id: 'bestDayToContact', kind: 'choice', label: 'Best Day to Contact', // select
        options: ['Today - URGENT', 'Any Day', 'Weekdays', 'Weekends'],
        values: ['today', 'any', 'weekdays', 'weekends'],
      },
      {
        id: 'bestTimeToContact', kind: 'choice', label: 'Best Time to Contact', // select
        options: ['Morning (9 AM - 12 PM)', 'Afternoon (12 PM - 5 PM)', 'Evening (5 PM - 8 PM)', 'Any Time'],
        values: ['morning', 'afternoon', 'evening', 'any'],
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────── Section 2
  {
    id: 'demographics', // progress bar: "Demographics & Background"
    title: 'Individual Demographics & Background',
    fields: [
      { id: 'fullName', kind: 'text', label: 'Full Legal Name', required: true },
      { id: 'age', kind: 'number', label: 'Age', required: true },
      { id: 'dateOfBirth', kind: 'date', label: 'Date of Birth' },
      {
        id: 'gender', kind: 'choice', label: 'Gender', // select
        options: ['Male', 'Female', 'Non-binary', 'Other'],
        values: ['male', 'female', 'non-binary', 'other'],
      },
      {
        id: 'maritalStatus', kind: 'choice', label: 'Marital Status', // select
        options: ['Single', 'Married', 'Divorced', 'Separated', 'Widowed', 'Domestic Partnership'],
        values: ['single', 'married', 'divorced', 'separated', 'widowed', 'domestic-partnership'],
      },
      {
        id: 'employmentStatus', kind: 'choice', label: 'Employment Status', // select
        options: ['Employed Full-time', 'Employed Part-time', 'Self-employed', 'Unemployed', 'Disabled', 'Retired', 'Student'],
        values: ['employed-full', 'employed-part', 'self-employed', 'unemployed', 'disabled', 'retired', 'student'],
      },
      { id: 'occupation', kind: 'text', label: 'Occupation/Profession' },
      {
        id: 'educationLevel', kind: 'choice', label: 'Education Level', // select
        options: ['Less than High School', 'High School/GED', 'Some College', "Associate's Degree", "Bachelor's Degree", "Master's Degree", 'Doctorate'],
        values: ['less-than-hs', 'hs-diploma', 'some-college', 'associates', 'bachelors', 'masters', 'doctorate'],
      },
      {
        id: 'livingSituation', kind: 'choice', label: 'Living Situation', // select
        options: ['Owns Home', 'Renting', 'Living with Family', 'Homeless', 'Sober Living', 'Shelter'],
        values: ['own-home', 'renting', 'with-family', 'homeless', 'sober-living', 'shelter'],
      },
      {
        id: 'veteranStatus', kind: 'choice', label: 'Veteran Status', // radio
        options: ['Not a Veteran', 'Veteran', 'Active Duty'],
        values: ['no', 'yes', 'active'],
      },

      // ── separator, then a note box (ShieldCheck icon):
      // "Why we ask: Your insurance card and details are used only to help find quality treatment programs that accept
      //  your loved one's insurance, so their benefits can help offset the cost of treatment. They aren't used for any
      //  other purpose. Everything here is optional."
      // ── InsuranceCardUpload: heading "Health Insurance Card (Optional)", then:
      // "Uploading your loved one's insurance card helps us coordinate treatment options in advance. We'll verify
      //  benefits with potential treatment centers to ensure they accept the patient's insurance, so you'll have vetted
      //  options ready when the time comes."
      // Each side is a button that opens a file picker (accept image/jpeg,image/png,image/webp,application/pdf; max 10MB).
      // It uploads right away to the private Supabase bucket 'insurance-cards' and stores the object path
      // ("uploads/<uuid>-front.<ext>"), not a URL. Once uploaded it shows "Front uploaded" / "Back uploaded" with a remove (X) button.
      { id: 'insuranceCardFront', kind: 'photo', label: 'Front of Insurance Card', help: 'Upload front of card' },
      { id: 'insuranceCardBack', kind: 'photo', label: 'Back of Insurance Card', help: 'Upload back of card' },
      // footnote: "Accepted formats: JPG, PNG, WebP, or PDF. Maximum file size: 10MB. Your insurance information is kept
      //            confidential and secure."
      // Error toasts: "Invalid file type" / "Please upload a JPG, PNG, WebP, or PDF file."; "File too large" / "Please
      //   upload a file smaller than 10MB."; "Upload failed". Success: "Upload successful" / "Insurance card {side} uploaded successfully."

      // lead-in: "No card handy, or prefer to type it in? Add what you can from the card. All optional."
      // The four typed fields below are NOT in types.ts. On submit they are joined into insurance_information as
      // "Provider: …; Policy/Member ID: …; Group #: …; Insurance phone: …".
      { id: 'insuranceProvider', kind: 'text', label: 'Insurance provider', help: 'e.g. Blue Cross, Aetna, Kaiser' }, // maxLength 100
      { id: 'insurancePolicyNumber', kind: 'text', label: 'Policy / Member ID number' }, // maxLength 50
      { id: 'insuranceGroupNumber', kind: 'text', label: 'Group number' }, // maxLength 50
      { id: 'insurancePhone', kind: 'phone', label: 'Insurance phone number', help: 'Usually on the back of the card (member services or behavioral health).' }, // maxLength 30
      // single checkbox, not a radio. Checked stores "yes", unchecked stores "no". Stays "" until first touched.
      { id: 'stateMedicaid', kind: 'yesno', label: 'Individual has insurance funded by State Medicaid' },
      // types.ts files budgetForTreatment under "Intervention Planning", but the UI shows it here.
      {
        id: 'budgetForTreatment', kind: 'choice', label: 'Treatment Budget (If Uninsured or Underinsured)', // select
        help: "The out-of-pocket cost of treatment centers can be significant. If your loved one doesn't have health insurance or has limited coverage, please indicate what range of out-of-pocket expense best represents your budget. This helps your practitioner recommend options that are both right for your loved one and affordable for your family.",
        options: ['$10,000 - $15,000', '$15,000 - $20,000', '$20,000 - $30,000', '$30,000 - $40,000', '$40,000 - $50,000', '$50,000+ (typical for 90-day programs)', 'Not Applicable - Have Insurance'],
        values: ['10000-15000', '15000-20000', '20000-30000', '30000-40000', '40000-50000', '50000+', 'not-applicable'],
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────── Section 3
  {
    id: 'substance_history', // progress bar: "Substance Use History"
    title: 'Comprehensive Substance Use History',
    fields: [
      { id: 'primarySubstances', kind: 'textarea', label: 'Primary Substance(s) of Concern', help: 'List all substances of concern', required: true },
      {
        id: 'substancesUsed', kind: 'list', label: 'Detailed Substance History', itemLabel: 'Substance', // button "Add Substance"; table, trash icon per row
        fields: [
          { id: 'substance', kind: 'choice', label: 'Substance', options: [
            "Alcohol",
            "Heroin",
            "Fentanyl",
            "Other opioids (Oxycodone, Hydrocodone, etc.)",
            "Cocaine/Crack",
            "Methamphetamine",
            "Benzodiazepines (Xanax, Valium, etc.)",
            "Cannabis/Marijuana",
            "Prescription stimulants (Adderall, etc.)",
            "MDMA/Ecstasy",
            "Hallucinogens (LSD, mushrooms)",
            "Synthetic cannabinoids (K2/Spice)",
            "Kratom",
            "Inhalants",
            "GHB",
            "Ketamine",
            "Tobacco/Nicotine",
            "Gambling (behavioral)",
            "Other",
          ] }, // select; stored value = text
          { id: 'ageFirstUsed', kind: 'number', label: 'Age Started' },
          { id: 'routeOfAdministration', kind: 'choice', label: 'Route', options: [
            "Oral (swallowing)",
            "Smoking",
            "Snorting/intranasal",
            "Injection (IV)",
            "Injection (IM/subcutaneous)",
            "Sublingual (under tongue)",
            "Transdermal (patches)",
            "Rectal",
            "Multiple routes",
          ] }, // select; stored value = text
          {
            id: 'frequency', kind: 'choice', label: 'Frequency', // select
            options: ['Multiple/day', 'Daily', 'Weekly', 'Occasional'],
            values: ['daily-multiple', 'daily', 'weekly', 'occasional'],
          },
          { id: 'lastUsed', kind: 'text', label: 'Last Used', help: 'e.g., Today' },
          { id: 'currentlyUsing', kind: 'yesno', label: 'Current' }, // checkbox -> boolean
        ],
      },
      { id: 'polysubstanceUse', kind: 'yesno', label: 'Polysubstance Use?' },
      {
        id: 'ivDrugUse', kind: 'choice', label: 'IV Drug Use (injection)?', // radio
        options: ['Current', 'Past', 'Never'],
        values: ['current', 'past', 'never'],
      },
      { id: 'overdoseHistory', kind: 'yesno', label: 'History of Overdose?' },
      { id: 'naloxoneReversals', kind: 'number', label: '# of Narcan/Naloxone Reversals', showIf: { field: 'overdoseHistory', equals: 'yes' } },
      { id: 'overdoseDetails', kind: 'textarea', label: 'Overdose Details', help: 'Describe circumstances...', showIf: { field: 'overdoseHistory', equals: 'yes' } },
      { id: 'ageFirstUsed', kind: 'number', label: 'Age of First Use' },
      {
        id: 'durationOfUse', kind: 'choice', label: 'Duration of Problematic Use', // select
        options: ['Less than 6 months', '6-12 months', '1-2 years', '2-5 years', '5-10 years', '10+ years'],
        values: ['less-6-months', '6-12-months', '1-2-years', '2-5-years', '5-10-years', '10-plus'],
      },
      {
        id: 'longestSobrietyPeriod', kind: 'choice', label: 'Longest Sobriety Period', // select
        options: ['Never sober', 'Days', 'Weeks', '1-6 months', '6-12 months', '1+ years'],
        values: ['never', 'days', 'weeks', 'months', '6-12-months', '1-plus-years'],
      },
      { id: 'typicalDailyUse', kind: 'textarea', label: 'Describe Typical Daily Use Pattern', help: 'e.g., Drinks 12+ beers starting at noon...' },
    ],
  },

  // ─────────────────────────────────────────────────────────────── Section 4
  {
    id: 'dsm', // progress bar: "DSM-5 Criteria"
    title: 'DSM-5 Substance Use Disorder Criteria',
    intro: 'Based on observations over the past 12 months. Check all that apply.',
    fields: [
      // One checkbox card per criterion: `criterion` is the checkbox label, `question` sits under it, `examples` in small italics.
      // Stored as dsmBehaviors: Record<criterionId, boolean>. (types.ts also declares 11 string fields dsmLargerAmounts…dsmWithdrawal,
      // which the form never uses.) The group has no label of its own, so `label` repeats the section title.
      { id: 'dsmBehaviors', kind: 'dsm', label: 'DSM-5 Substance Use Disorder Criteria', criteria: [
        {
          id: "larger_amounts",
          criterion: "1. Taking larger amounts or using over longer periods",
          question: "Has your loved one used substances in larger amounts or for longer periods than they originally intended?",
          examples: "Examples: Started with 'just one drink' but ends up drinking all night; planned to use 'just this once' but continued for days/weeks",
        },
        {
          id: "desire_cut_down",
          criterion: "2. Persistent desire or unsuccessful efforts to cut down",
          question: "Has your loved one expressed a desire to cut down or stop using but been unable to do so?",
          examples: "Examples: Made promises to quit, set limits that were broken, tried to moderate without success",
        },
        {
          id: "time_spent",
          criterion: "3. Great deal of time spent obtaining, using, or recovering",
          question: "Does your loved one spend a significant amount of time obtaining, using, or recovering from substances?",
          examples: "Examples: Whole days spent obtaining drugs, using, or 'sleeping it off'; neglecting other activities",
        },
        {
          id: "cravings",
          criterion: "4. Craving or strong desire to use",
          question: "Does your loved one experience strong cravings or urges to use substances?",
          examples: "Examples: Talks about needing to use, becomes agitated when substances aren't available, obsessive thoughts about using",
        },
        {
          id: "failure_obligations",
          criterion: "5. Failure to fulfill major role obligations",
          question: "Has substance use caused your loved one to miss important family events, work responsibilities, or school obligations?",
          examples: "Examples: Missing work, getting fired, failing classes, missing children's events, neglecting household duties",
        },
        {
          id: "continued_despite_problems",
          criterion: "6. Continued use despite social/interpersonal problems",
          question: "Has your loved one continued using despite it causing problems in their relationships or social life?",
          examples: "Examples: Fighting with spouse, estrangement from family, losing friendships, damaged trust",
        },
        {
          id: "activities_given_up",
          criterion: "7. Important activities given up or reduced",
          question: "Has your loved one given up or reduced participation in activities they once enjoyed because of substance use?",
          examples: "Examples: No longer exercises, stopped hobbies, withdrew from social activities, lost interest in career",
        },
        {
          id: "hazardous_use",
          criterion: "8. Recurrent use in hazardous situations",
          question: "Has your loved one engaged in risky behaviors while using, such as driving under the influence or unsafe sexual activity?",
          examples: "Examples: DUIs, operating machinery while impaired, mixing substances dangerously, risky sexual behavior",
        },
        {
          id: "continued_despite_knowledge",
          criterion: "9. Continued use despite knowledge of physical/psychological problems",
          question: "Has your loved one continued using despite knowing it's causing or worsening physical or mental health problems?",
          examples: "Examples: Drinking despite liver problems, using despite worsening depression, ignoring doctor's warnings",
        },
        {
          id: "tolerance",
          criterion: "10. Tolerance (needing more for same effect)",
          question: "Has your loved one needed to use more of the substance to achieve the same effect they used to get with less?",
          examples: "Examples: Drinking more to feel drunk, needing larger doses of pills, escalating amounts over time",
        },
        {
          id: "withdrawal",
          criterion: "11. Withdrawal symptoms or use to avoid withdrawal",
          question: "Has your loved one experienced physical or emotional withdrawal symptoms when not using, or used specifically to avoid withdrawal?",
          examples: "Examples: Shaking, sweating, nausea, anxiety, using 'just to feel normal', morning use to stop shaking",
        },
      ] },
      // ── separator, then a live readout box shown to the family (always visible):
      //   "Criteria Met: {count} / 11"
      //   "Severity: 2-3 = Mild, 4-5 = Moderate, 6+ = Severe"
      //   "Indicated Severity: {level}". The level is count >= 6 "Severe" (red), >= 4 "Moderate" (orange),
      //   >= 2 "Mild" (yellow), else "Below clinical threshold" (green).
      //   Submitted as dsm_yes_count and severity_level.
    ],
  },

  // ─────────────────────────────────────────────────────────────── Section 5
  {
    id: 'medical_withdrawal', // progress bar: "Medical & Withdrawal Risk"
    title: 'Medical & Withdrawal Risk Assessment',
    intro: 'Withdrawal and physical health.',
    fields: [
      // These two arrays are not in types.ts (types.ts has withdrawalSymptoms: string). On submit they are sent together as
      // withdrawal_symptoms = JSON.stringify({ physical: [...], psychological: [...] }).
      {
        id: 'physicalWithdrawalSymptoms', kind: 'multi', label: 'Observable Physical Withdrawal Symptoms',
        help: "Check all symptoms you have observed in your loved one when they haven't used or are between uses:",
        options: [
          "Tremors/shaking (hands, body)",
          "Sweating (excessive perspiration)",
          "Nausea/vomiting",
          "Diarrhea/stomach cramps",
          "Rapid heart rate/palpitations",
          "Elevated blood pressure",
          "Fever/chills",
          "Muscle aches/pains",
          "Headaches",
          "Loss of appetite",
          "Fatigue/exhaustion",
          "Insomnia/difficulty sleeping",
          "Hypersomnia (sleeping too much)",
          "Dilated pupils",
          "Runny nose/watery eyes",
          "Goosebumps/skin crawling sensations",
          "Yawning (excessive)",
          "Seizures",
          "Coordination problems/unsteady gait",
          "Restless legs/body movements",
        ],
      },
      {
        id: 'psychologicalWithdrawalSymptoms', kind: 'multi', label: 'Observable Psychological Withdrawal Symptoms',
        help: 'Check all psychological/emotional symptoms you have observed:',
        options: [
          "Anxiety/nervousness",
          "Agitation/irritability",
          "Restlessness/inability to sit still",
          "Depression/low mood",
          "Mood swings",
          "Difficulty concentrating",
          "Memory problems/confusion",
          "Cravings (intense urges to use)",
          "Panic attacks",
          "Paranoia/suspiciousness",
          "Hallucinations (seeing/hearing things)",
          "Disorientation/confusion",
          "Nightmares/vivid dreams",
          "Emotional numbness",
          "Suicidal thoughts",
          "Anger outbursts",
          "Social withdrawal",
          "Loss of motivation/anhedonia",
          "Racing thoughts",
          "Feeling of impending doom",
        ],
      },
      // readout, shown only when either list has a selection: "Selected symptoms: {physical + psychological count}"
      { id: 'withdrawalDescription', kind: 'textarea', label: 'Additional details about withdrawal symptoms', help: 'Describe timing, severity, duration of symptoms observed...' },
      { id: 'seizureHistory', kind: 'yesno', label: 'History of seizures during withdrawal?' },
      { id: 'deliriumTremensHistory', kind: 'yesno', label: 'History of delirium tremens (DTs)?' },
      { id: 'hospitalizedDetox', kind: 'yesno', label: 'Previous medical detox?' },
      { id: 'healthIssues', kind: 'yesno', label: 'Known health issues?' },
      { id: 'healthIssuesList', kind: 'textarea', label: 'Describe health conditions', help: 'Liver disease, heart problems, diabetes, infections, etc.', showIf: { field: 'healthIssues', equals: 'yes' } },
      { id: 'chronicPain', kind: 'yesno', label: 'Chronic pain issues?' },
      { id: 'recentERVisits', kind: 'yesno', label: 'Recent ER visits/hospitalizations?' },
      { id: 'prescribedMedications', kind: 'yesno', label: 'Current prescribed medications?' },
      { id: 'prescribedMedicationsList', kind: 'textarea', label: 'List all medications and dosages', showIf: { field: 'prescribedMedications', equals: 'yes' } },
    ],
  },

  // ─────────────────────────────────────────────────────────────── Section 6
  {
    id: 'mental_health', // progress bar: "Mental Health Assessment"
    title: 'Mental Health Assessment',
    intro: 'Emotional, behavioral and thinking concerns.',
    fields: [
      // SAFETY: a warning box is always shown at the top of this section (red AlertTriangle icon):
      // "This section addresses sensitive topics including suicide and self-harm. Your honest answers help ensure safety."
      // No answer below triggers any extra on-screen message.
      { id: 'mentalHealthSigns', kind: 'yesno', label: 'Signs of depression, anxiety, or mood disorders?' },
      { id: 'currentMentalHealthSymptoms', kind: 'multi', label: 'Current symptoms observed (check all that apply):', options: [
        "Depression/persistent sadness",
        "Anxiety/panic attacks",
        "Mood swings/irritability",
        "Paranoia/suspiciousness",
        "Hallucinations (seeing/hearing things)",
        "Delusions (false beliefs)",
        "Memory problems",
        "Difficulty concentrating",
        "Insomnia/sleep disturbance",
        "Excessive sleep",
        "Social withdrawal/isolation",
        "Loss of interest in activities",
        "Agitation/restlessness",
        "Impulsive behavior",
        "Self-destructive behavior",
        "Obsessive thoughts",
        "Compulsive behaviors",
      ] },
      // ── separator
      {
        id: 'suicideIdeation', kind: 'choice', label: 'Current suicidal thoughts or ideation?', // radio: Yes / No / Unknown
        options: ['Yes', 'No', 'Unknown'],
        values: ['yes', 'no', 'unknown'],
      },
      { id: 'suicideAttemptsHistory', kind: 'yesno', label: 'History of suicide attempts?' },
      { id: 'selfHarmHistory', kind: 'yesno', label: 'History of self-harm?' },
      { id: 'homicidalIdeation', kind: 'yesno', label: 'Homicidal thoughts or threats?' },
      {
        id: 'traumaHistory', kind: 'choice', label: 'History of trauma (abuse, neglect, violence, accidents, sexual, abandonment, PTSD)?', // radio
        options: ['Yes', 'No', 'Suspected'],
        values: ['yes', 'no', 'suspected'],
      },
      // shown for "yes" only, not for "suspected"
      { id: 'traumaDetails', kind: 'textarea', label: 'Describe trauma history (if known and comfortable sharing)', showIf: { field: 'traumaHistory', equals: 'yes' } },
      { id: 'psychiatricHistory', kind: 'yesno', label: 'Psychiatric hospitalizations or diagnoses?' },
      { id: 'psychiatricDetails', kind: 'textarea', label: 'Describe diagnoses and hospitalizations', help: 'e.g., Bipolar disorder, hospitalized twice for manic episodes...', showIf: { field: 'psychiatricHistory', equals: 'yes' } },
    ],
  },

  // ─────────────────────────────────────────────────────────────── Section 7
  {
    id: 'readiness', // progress bar: "Readiness to Change"
    title: 'Readiness to Change',
    intro: 'Motivation and openness to treatment.',
    fields: [
      {
        id: 'stageOfChange', kind: 'choice', label: 'Stage of Change (Prochaska & DiClemente Model)', // select
        options: [
          'Precontemplation - Denies problem, no intention to change',
          'Contemplation - Aware of problem, considering change',
          'Preparation - Ready to take action soon',
          'Action - Actively working on change',
          'Maintenance - Sustaining change, preventing relapse',
        ],
        values: ['precontemplation', 'contemplation', 'preparation', 'action', 'maintenance'],
      },
      {
        id: 'acknowledgesProblem', kind: 'choice', label: 'Does your loved one acknowledge they have a problem?', // radio
        options: ['Complete denial', 'Partially acknowledges', 'Fully acknowledges'],
        values: ['full-denial', 'partial', 'acknowledges'],
      },
      {
        id: 'willingnessToChange', kind: 'choice', label: 'Willingness to accept help (1-10 scale)', // select
        options: [
          '1 (Very resistant)', '2 (Very resistant)', '3 (Very resistant)',
          '4 (Ambivalent)', '5 (Ambivalent)', '6 (Ambivalent)',
          '7 (Willing)', '8 (Willing)', '9 (Willing)', '10 (Willing)',
        ],
        values: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
      },
      { id: 'whatWorkedBefore', kind: 'textarea', label: 'What has worked in past recovery attempts?', help: 'Programs, approaches, supports that were helpful...' },
      { id: 'whatDidntWork', kind: 'textarea', label: 'What has NOT worked in past attempts?', help: 'Approaches that failed, reasons for leaving treatment...' },
      { id: 'resistanceFactors', kind: 'textarea', label: 'What resistance or objections do you anticipate?', help: 'Common excuses, fears, objections they may raise...' },
    ],
  },

  // ─────────────────────────────────────────────────────────────── Section 8
  {
    id: 'relapse_treatment', // progress bar: "Relapse Potential & History"
    title: 'Relapse Potential & Treatment History',
    intro: 'The risk of continued use or relapse, and treatment so far.',
    fields: [
      { id: 'relapseTriggers', kind: 'multi', label: 'Known relapse triggers (check all that apply):', options: [
        "Stress",
        "Boredom",
        "Loneliness",
        "Anger/frustration",
        "Anxiety",
        "Depression",
        "Celebrations/parties",
        "Relationship conflicts",
        "Financial problems",
        "Work problems",
        "Chronic pain",
        "Sleep problems",
        "Environmental cues (places/people)",
        "Traumatic memories",
        "Overconfidence in recovery",
      ] },
      { id: 'highRiskSituations', kind: 'textarea', label: 'Describe high-risk situations', help: 'People, places, events that trigger use...' },
      { id: 'priorTreatment', kind: 'yesno', label: 'Prior treatment attempts?' },
      {
        id: 'treatmentHistory', kind: 'list', label: 'Treatment History', itemLabel: 'Program', // button "Add Program"; table, trash icon per row
        help: 'Please list all treatment programs you can remember, including detox, rehab, outpatient, sober living, etc.', // shown under the table
        showIf: { field: 'priorTreatment', equals: 'yes' },
        // Row state also carries durationDays and reasonForLeaving (both ""), which are never rendered.
        // ageAtTreatment is a form-only key (not in types.ts TreatmentEntry).
        fields: [
          { id: 'programName', kind: 'text', label: 'Program Name', help: 'Program name' },
          {
            id: 'programType', kind: 'choice', label: 'Type', // select
            options: ['Detox', 'Residential', 'PHP', 'IOP', 'Outpatient', 'Sober Living', '12-Step Program', 'Other'],
            values: ['detox', 'residential', 'php', 'iop', 'outpatient', 'sober-living', '12-step', 'other'],
          },
          { id: 'ageAtTreatment', kind: 'number', label: 'Age', help: 'Age' },
          { id: 'dateAttended', kind: 'text', label: 'Date', help: 'e.g., Jan 2023' },
          { id: 'successfulCompletion', kind: 'yesno', label: 'Completed' }, // checkbox -> boolean
          { id: 'aftercareFollowed', kind: 'yesno', label: 'Followed Aftercare' }, // checkbox -> boolean
        ],
      },
      {
        id: 'twelveStepInvolvement', kind: 'choice', label: '12-Step or peer support involvement?', // radio
        options: ['Active', 'Past involvement', 'Resistant', 'Never tried'],
        values: ['active', 'past', 'resistant', 'never'],
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────── Section 9
  {
    id: 'recovery_environment', // progress bar: "Recovery Environment"
    title: 'Recovery Environment',
    intro: 'Home, support and the living situation.',
    fields: [
      { id: 'stableLiving', kind: 'yesno', label: 'Stable housing?' },
      { id: 'peopleUsingInHome', kind: 'yesno', label: 'Others using substances in home?' },
      {
        id: 'supportNetwork', kind: 'choice', label: 'Support network (sober family/friends)?', // radio
        options: ['Strong', 'Weak', 'None'],
        values: ['strong', 'weak', 'none'],
      },
      // ── separator
      { id: 'legalIssues', kind: 'yesno', label: 'Current legal issues?' },
      { id: 'probationParole', kind: 'yesno', label: 'On probation or parole?' },
      { id: 'legalIssuesDetails', kind: 'textarea', label: 'Describe legal situation', help: 'Pending charges, court dates, etc.', showIf: { field: 'legalIssues', equals: 'yes' } },
      { id: 'duiHistory', kind: 'yesno', label: 'History of DUI/DWI?' },
    ],
  },

  // ─────────────────────────────────────────────────────────────── Section 10
  {
    id: 'family_system', // progress bar: "Family System Dynamics"
    title: 'Family System Dynamics',
    intro: 'Understanding family dynamics is critical for intervention planning',
    fields: [
      {
        // The form's state is `familyMembers`; it is submitted as family_members_participating (= types.ts familyMembersParticipating).
        id: 'familyMembersParticipating', kind: 'list', label: 'Family Members Who May Participate in Intervention', itemLabel: 'Member', // button "Add Member"
        // types.ts FamilyMemberEntry also has age and relationshipWithLovedOne; the form never renders or stores them.
        // leverageDetails is always shown, even when hasLeverage is unchecked.
        fields: [
          { id: 'name', kind: 'text', label: 'Name' },
          { id: 'relationship', kind: 'text', label: 'Relationship' },
          { id: 'willingToParticipate', kind: 'yesno', label: 'Willing' }, // checkbox -> boolean
          { id: 'hasLeverage', kind: 'yesno', label: 'Has Leverage' }, // checkbox -> boolean
          { id: 'leverageDetails', kind: 'text', label: 'Leverage Details', help: 'e.g., finances, housing' },
        ],
      },
      {
        id: 'familyUnityLevel', kind: 'choice', label: 'Family Unity Level', // select
        options: ['Unified - All on same page', 'Mostly unified with minor disagreements', 'Divided - Significant disagreements', 'Highly conflicted - Major opposition'],
        values: ['unified', 'mostly-unified', 'divided', 'conflicted'],
      },
      {
        id: 'familyEnabling', kind: 'choice', label: 'Is family enabling the addiction?', // radio
        options: ['Yes', 'Some members', 'No'],
        values: ['yes', 'some', 'no'],
      },
      { id: 'enablingDetails', kind: 'textarea', label: 'Describe enabling behaviors', help: 'e.g., Giving money, making excuses, providing housing without conditions...', showIf: { field: 'familyEnabling', equals: ['yes', 'some'] } },
      { id: 'whoHoldsLeverage', kind: 'textarea', label: 'Who holds the most leverage? How?', help: 'e.g., Mother controls finances, employer can terminate, spouse can file for divorce...' },
      { id: 'childrenPresent', kind: 'yesno', label: 'Children present in home (<18)?' },
      { id: 'childrenImpacted', kind: 'yesno', label: 'Are children being impacted?', showIf: { field: 'childrenPresent', equals: 'yes' } },
      { id: 'familyTraumaHistory', kind: 'textarea', label: 'Family trauma or significant events impacting dynamics', help: 'Deaths, divorces, abuse history, financial losses, etc.' },
    ],
  },

  // ─────────────────────────────────────────────────────────────── Section 11
  {
    id: 'family_history', // progress bar: "Family History"
    title: 'Family Addiction & Mental Health History',
    intro: 'Generational patterns inform treatment approach',
    fields: [
      {
        // Row keys are relationship / condition / details as the form stores them.
        // types.ts FamilyAddictionEntry declares relationship / substanceOrBehavior / currentStatus / recoveryStatus instead.
        id: 'familyAddictionHistory', kind: 'list', label: 'Family Addiction History', itemLabel: 'Entry', // button "Add Entry"
        fields: [
          { id: 'relationship', kind: 'text', label: 'Relationship', help: 'e.g., Father, Grandfather' },
          { id: 'condition', kind: 'text', label: 'Substance/Behavior', help: 'e.g., Alcohol, Opioids' },
          { id: 'details', kind: 'text', label: 'Status (active/recovery/deceased)', help: 'e.g., In recovery 10 years' },
        ],
      },
      { id: 'generationalAddictionPattern', kind: 'yesno', label: 'Is there a generational pattern of addiction?' },
      { id: 'familyOverdoseDeaths', kind: 'yesno', label: 'Any family overdose deaths?' },
      // ── separator
      {
        // Row keys are relationship / condition / details as the form stores them.
        // types.ts FamilyMentalHealthEntry declares relationship / diagnosis / treatmentStatus instead.
        id: 'familyMentalHealthHistory', kind: 'list', label: 'Family Mental Health History', itemLabel: 'Entry', // button "Add Entry"
        fields: [
          { id: 'relationship', kind: 'text', label: 'Relationship', help: 'e.g., Mother, Sister' },
          { id: 'condition', kind: 'text', label: 'Diagnosis', help: 'e.g., Bipolar, Depression' },
          { id: 'details', kind: 'text', label: 'Treatment Status', help: 'e.g., Medicated, untreated' },
        ],
      },
      { id: 'familySuicideHistory', kind: 'yesno', label: 'Family history of suicide?' },
    ],
  },

  // ─────────────────────────────────────────────────────────────── Section 12
  {
    id: 'consequences_planning', // progress bar: "Consequences & Planning"
    title: 'Consequences & Intervention Planning',
    fields: [
      // FI's types.ts files violenceHistory under the mental health area, but its form shows it here.
      { id: 'violenceHistory', kind: 'yesno', label: 'History of violence or aggression?' },
      { id: 'stolenFromFamily', kind: 'yesno', label: 'Stolen from family?' },
      {
        id: 'financialImpact', kind: 'choice', label: 'Financial impact (job loss, debt, bankruptcy)?', // radio
        options: ['Severe', 'Moderate', 'Minimal'],
        values: ['severe', 'moderate', 'minimal'],
      },
      {
        id: 'familyReadyIntervention', kind: 'choice', label: 'Is family ready for intervention?', // radio
        options: ['Yes', 'Mostly ready', 'Unsure'],
        values: ['yes', 'mostly', 'unsure'],
      },
      { id: 'whatMotivatesIndividual', kind: 'textarea', label: 'What motivates this person? What do they care about?', help: 'Children, career, relationships, health, hobbies, reputation...' },
      { id: 'treatmentPreferences', kind: 'textarea', label: 'Treatment preferences or requirements', help: 'Gender-specific, faith-based, executive, etc.' },
      {
        // "crisis" triggers no on-screen message; on the server it marks the staff email HIGH PRIORITY (see top of file).
        id: 'urgencyLevel', kind: 'choice', label: 'Urgency Level', // select
        options: ['Crisis - Immediate danger', 'Urgent - Within days', 'Soon - Within 1-2 weeks', 'Planning stage'],
        values: ['crisis', 'urgent', 'soon', 'planning'],
      },
      { id: 'immediateSafetyConcerns', kind: 'textarea', label: 'Any immediate safety concerns?', help: 'Access to weapons, active psychosis, threats, etc.' },
      { id: 'additionalInformation', kind: 'textarea', label: 'Additional information we should know', help: 'Anything else that would help us understand the situation...' },
      // The signature is the consent step after this section (CONSENT in the page), not a field.
    ],
  },
];


// ─── Rules ───────────────────────────────────────────────────────────────────

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A field is shown when it has no condition, or its condition's answer matches. */
export function fieldVisible(field: Field, answers: Answers): boolean {
  const rule = 'showIf' in field ? field.showIf : undefined;
  if (!rule) return true;
  const value = text(answers[rule.field]);
  return Array.isArray(rule.equals) ? rule.equals.includes(value) : rule.equals === value;
}

/** The visible required fields of a section that are still empty (labels, in order). */
export function missingRequired(section: Section, answers: Answers): string[] {
  return section.fields
    .filter((field) => 'required' in field && field.required && fieldVisible(field, answers))
    .filter((field) => !text(answers[field.id]))
    .map((field) => field.label);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What stops a section from moving on: a required answer, or an email that is not one. '' when it can. */
export function sectionProblem(section: Section, answers: Answers): string {
  const missing = missingRequired(section, answers);
  if (missing.length) return `Please answer: ${missing.join(', ')}.`;
  const email = section.fields.find((field) => field.kind === 'email' && text(answers[field.id]));
  if (email && !EMAIL.test(text(answers[email.id]))) return 'Please check the email address.';
  return '';
}

/** How many of the eleven criteria the family checked. */
export function dsmCount(answers: Answers): number {
  const checked = answers.dsmBehaviors;
  if (!checked || typeof checked !== 'object' || Array.isArray(checked)) return 0;
  return DSM_IDS.filter((id) => (checked as Record<string, unknown>)[id] === true).length;
}

export type DsmSeverity = 'none' | 'mild' | 'moderate' | 'severe';

/** 2-3 mild, 4-5 moderate, 6 or more severe (DSM-5 substance use disorder). */
export function dsmSeverity(count: number): DsmSeverity {
  if (count >= 6) return 'severe';
  if (count >= 4) return 'moderate';
  if (count >= 2) return 'mild';
  return 'none';
}

export const DSM_SEVERITY_LABEL: Record<DsmSeverity, string> = {
  none: 'Below the threshold',
  mild: 'Mild',
  moderate: 'Moderate',
  severe: 'Severe',
};

// "None", "n/a", "no concerns" and the like are not a safety concern.
const NO_CONCERN = /^(none|no|nope|n\/?a|na|not applicable|nothing|no concerns?|none at this time|none currently|not at this time|-+)$/;

export type SafetyFlag = 'suicidal_thoughts' | 'homicidal_thoughts' | 'crisis' | 'safety_concern';

export const SAFETY_FLAG_LABEL: Record<SafetyFlag, string> = {
  suicidal_thoughts: 'Suicidal thoughts reported',
  homicidal_thoughts: 'Homicidal thoughts or threats reported',
  crisis: 'The family marked it a crisis: immediate danger',
  safety_concern: 'The family described an immediate safety concern',
};

/**
 * Answers that suggest someone may be in danger now. The page shows 911
 * and 988 as soon as one is given, and the practitioner is told to reach
 * out today. The database computes the same flags on submit
 * (family_assessment_urgent in 20261109140000), so keep the two in step.
 */
export function safetyFlags(answers: Answers): SafetyFlag[] {
  const flags: SafetyFlag[] = [];
  if (text(answers.suicideIdeation) === 'yes') flags.push('suicidal_thoughts');
  if (text(answers.homicidalIdeation) === 'yes') flags.push('homicidal_thoughts');
  if (text(answers.urgencyLevel) === 'crisis') flags.push('crisis');
  const concern = text(answers.immediateSafetyConcerns).toLowerCase().replace(/[.!\s]+$/, '');
  if (concern && !NO_CONCERN.test(concern)) flags.push('safety_concern');
  return flags;
}

/** Seizures or DTs in withdrawal: a medical warning on the page, and a note for the practitioner. */
export function withdrawalWarning(answers: Answers): boolean {
  return text(answers.seizureHistory) === 'yes' || text(answers.deliriumTremensHistory) === 'yes';
}

/** All fields, by id (top level only). */
export function fieldIndex(): Map<string, Field> {
  return new Map(SECTIONS.flatMap((section) => section.fields.map((field) => [field.id, field] as [string, Field])));
}

/** The words a stored choice value shows as ("spouse" is "Spouse/Partner"). */
export function choiceLabel(field: Field, value: unknown): string {
  const stored = text(value);
  if (field.kind !== 'choice' || !stored) return stored;
  const index = (field.values ?? field.options).indexOf(stored);
  return index >= 0 ? field.options[index] : stored;
}

const DSM_FIELD = SECTIONS.flatMap((section) => section.fields).find((field) => field.kind === 'dsm');
export const DSM_IDS: string[] = DSM_FIELD && DSM_FIELD.kind === 'dsm' ? DSM_FIELD.criteria.map((item) => item.id) : [];

// ─── Reading answers back ────────────────────────────────────────────────────

export type AnswerLine = { label: string; value: string };

function valueWords(field: Field, value: unknown): string {
  if (value === null || value === undefined) return '';
  switch (field.kind) {
    case 'choice': return choiceLabel(field, value);
    case 'yesno':
      if (value === true) return 'Yes';
      if (value === false) return '';
      return text(value) === 'yes' ? 'Yes' : text(value) === 'no' ? 'No' : text(value);
    case 'multi': return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).join(', ') : '';
    case 'list': {
      if (!Array.isArray(value)) return '';
      return value
        .map((row) => {
          if (!row || typeof row !== 'object') return '';
          const record = row as Record<string, unknown>;
          return field.fields
            .map((sub) => {
              const words = valueWords(sub, record[sub.id]);
              return words ? `${sub.label}: ${words}` : '';
            })
            .filter(Boolean)
            .join('; ');
        })
        .filter(Boolean)
        .map((line, index) => `${index + 1}) ${line}`)
        .join('\n');
    }
    case 'dsm': {
      const checked = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return field.criteria.filter((item) => checked[item.id] === true).map((item) => item.criterion).join('\n');
    }
    case 'photo':
    case 'signature':
      return '';
    default: return text(value);
  }
}

/** A section's answers in words, skipping anything unanswered or hidden. */
export function sectionAnswerLines(section: Section, answers: Answers): AnswerLine[] {
  return section.fields
    .filter((field) => fieldVisible(field, answers))
    .map((field) => ({ label: field.label, value: valueWords(field, answers[field.id]) }))
    .filter((line) => line.value);
}
