import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { Session } from '@supabase/supabase-js';
import {
  ClientPopulation,
  clientPopulations,
  FinancialRelationship,
  financialRelationshipLabel,
  financialRelationshipOptions,
  formatMoney,
  initialPartners,
  initialReferralMatches,
  initialReferrals,
  InsuranceNetworkPreference,
  insuranceProvidersForState,
  LocationPreference,
  locationPreferences,
  medicaidPlansByState,
  nationalInsuranceProviders,
  Partner,
  partnerTypes,
  PlacementReason,
  placementReasonOptions,
  Referral,
  ReferralDirection,
  ReferralMatch,
  regionalInsuranceByState,
  shortDate,
  stateOptions,
  therapyOptions,
} from './src/data';
import {
  BedOptions,
  defaultMustHaveNeeds,
  hasFinancialRelationship,
  isPopulationNeed,
  monthlyCostForPartner,
  networkCapabilitiesForPartner,
  placementCandidates,
  PlacementCandidate,
  ProgramScore,
  rankOfPartner,
  rankPrograms,
  scoreProgram,
  scoringWeights,
  trackRecordPrior,
  typesForPartner,
} from './src/lib/matching';
import { bedForFromPopulation, bedsCadenceLine, bedsLine, type BedFor } from './src/lib/beds';
import { supabase } from './src/lib/supabase';
import LoginScreen from './src/lib/LoginScreen';
import BusinessDashboard from './src/lib/BusinessDashboard';
import NewLeadSheet, { type NewLeadDraft } from './src/lib/NewLeadSheet';
import WorkspaceScreen from './src/lib/WorkspaceScreen';
import ResetPasswordScreen from './src/lib/ResetPasswordScreen';
import { isRecoveryRedirect, parseAuthRedirect } from './src/lib/auth-flows';
import { DEFAULT_LEAD_SETTINGS, fetchCurrentOrgId, fetchLeadSettings, fetchWorkspaceMembers, memberDisplayName, type LeadSettings, type OrgMember } from './src/lib/org';
import { refreshPushRegistration, unregisterThisDevice } from './src/lib/push';
import { fetchEntitlements, NO_ENTITLEMENTS, type EntitlementState } from './src/lib/entitlements';
import GlobalDirectoryScreen from './src/lib/GlobalDirectoryScreen';
import { fetchListingBeds, fetchOrgDirectoryProfile, submitPartnerToDirectory, upsertOrgDirectoryProfile, type ListingBedsStatus, type OrgDirectoryProfile } from './src/lib/directory';
import { directoryCostLabel, directoryMissingFields, directoryMissingFieldsMessage, isIndividualProfessional, PRIVATE_PAY_ONLY } from './src/lib/directory-submission';
import CaseIntegrationPanel from './src/lib/CaseIntegrationPanel';
import {
  type BusinessData,
  fetchBusinessData,
  LEAD_SOURCES,
} from './src/lib/business';
import {
  assignMatchReferral,
  completeFollowUpWithNext,
  completeFollowUpWithOutcome,
  createFollowUp,
  createMatchProfile,
  deleteMatchProfile,
  createPartner,
  createReferral,
  createTouch,
  bindLocalWorkspace,
  flushWriteQueue,
  finalizeMatchPacket,
  FollowUp,
  FollowUpKind,
  hydrate,
  isNetworkError,
  loadCaseFile,
  loadCaseList,
  logContactActivity,
  PartnerScorecard,
  pendingWriteCount,
  persistCache,
  persistCaseFile,
  persistCaseList,
  PlacementDecision,
  readBoundWorkspace,
  recordPlacementDecision,
  refreshSnapshot,
  saveMatchWithCase,
  Snapshot,
  Touch,
  TouchKind,
  updateFollowUp,
  updateMatchProfile,
  updatePartner,
} from './src/lib/store';
import {
  activateReferralFitNotificationOwner,
  cancelReferralFitNotifications,
  getNotificationPermissionState,
  requestNotificationPermission,
  rescheduleNotifications,
  subscribeToNotificationResponses,
  todayLoad,
} from './src/lib/notifications';
import {
  buildTodaySections,
  cardAssignee,
  defaultTodayScope,
  filterTodaySections,
  type TodayScope,
  followUpToCard,
  formatWaiting,
  minutesWaiting,
  newLeadCards,
  nextStepDate,
  partnersDueToday,
  prunePartnerSnoozes,
  snoozeDate,
  TodayCard,
  WhenChoice,
} from './src/lib/today';
import {
  buildFitReasons,
  buildPacket,
  labelLooksLikeFullName,
  PacketAudience,
  PacketFitInput,
  packetFitInput,
} from './src/lib/packet';
import * as ImagePicker from 'expo-image-picker';
import { MAX_CACHED_EVENTS_PER_FILE } from './src/lib/case-cache';
import {
  CaseContact,
  CaseDocument,
  CaseEvent,
  CaseEventKind,
  CaseRecord,
  CaseSearchResult,
  CaseStatus,
  assignCase,
  completeFollowUpWithCase,
  createCaseBundle,
  createCaseFileSignedUrl,
  createLead,
  leadCaseTitle,
  leadFollowUpTitle,
  saveDocumentWithEvent,
  deleteContact,
  deleteDocumentRow,
  isOpenCase,
  logCaseEvent,
  newDocumentId,
  newUuid,
  PaymentStatus,
  recordCasePayment,
  removeCaseFile,
  restoreDocumentRow,
  saveContactAtomic,
  searchCases,
  updateCase,
  updateCaseBusinessDetailsWithEvent,
  updateCaseDetailsWithEvent,
  updateCasePaymentWithEvent,
  updateCaseWithEvent,
  uploadCaseFile,
} from './src/lib/cases';

type Tab = 'home' | 'match' | 'cases' | 'directory' | 'referrals';
type IconName = React.ComponentProps<typeof Ionicons>['name'];

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  sage: '#9EB7A2',
  mint: '#DCEAE0',
  mintPale: '#EDF4EF',
  cream: '#F6F4EE',
  white: '#FFFFFF',
  coral: '#D9795F',
  coralPale: '#F7E7E1',
  gold: '#D7AD58',
  gray: '#73827D',
  line: '#DDE4DF',
  blue: '#507C86',
};

const notificationPromptKey = (userId: string) => `referralfit-notification-prompt-v2:${userId.toLowerCase()}`;
const notificationScheduleKey = (userId: string) => `referralfit-notification-scheduling-v2:${userId.toLowerCase()}`;
const partnerSnoozeKey = (userId: string) => `referralfit-partner-snooze-v2:${userId.toLowerCase()}`;
const welcomeKey = (userId: string) => `referralfit-welcome-v1:${userId.toLowerCase()}`;
const profilePromptKey = (userId: string) => `referralfit-profile-prompt-v1:${userId.toLowerCase()}`;

// Every table's PK is a Postgres `uuid` column, so client-generated ids MUST be
// valid UUIDs — a prefixed string like `p-1785096121092-t1etoz4` is rejected with
// "invalid input syntax for type uuid" on sync. The prefix argument is kept so
// call sites read the same, but it is intentionally unused.
function makeId(_prefix?: string) {
  return newUuid();
}

// A foreground return within this window of the last refresh that reached the
// server is skipped; pull-to-refresh always runs.
const FOREGROUND_REFRESH_MIN_INTERVAL_MS = 30_000;

// Where the case list / open case file on screen came from. 'cache' is the
// saved offline copy (read-only until the server is reached again);
// 'unavailable' means no connection and no saved copy. userId pins the copy
// to the account it belongs to so it is never persisted under another one.
type CachedCopyState = { userId: string; source: 'remote' | 'cache' | 'unavailable'; savedAt: string; truncated: boolean };

// ─── Case files (v3) ────────────────────────────────────────────────────────

const CASE_STATUSES: CaseStatus[] = ['inquiry', 'consult', 'deciding', 'engaged', 'intervention', 'placed', 'aftercare', 'closed', 'lost'];
const PAYMENT_STATUSES: PaymentStatus[] = ['none', 'quoted', 'deposit', 'paid', 'partial', 'refunded'];

// Color-coded by stage: early (inquiry/consult) sage, working (deciding/
// engaged/intervention) blue, landed (placed/aftercare) forest, ended coral.
const CASE_STATUS_COLORS: Record<CaseStatus, { bg: string; fg: string }> = {
  inquiry: { bg: '#E9EFE6', fg: '#5A7261' },
  consult: { bg: '#E9EFE6', fg: '#5A7261' },
  deciding: { bg: '#E2EBEE', fg: '#3D6470' },
  engaged: { bg: '#E2EBEE', fg: '#3D6470' },
  intervention: { bg: '#E2EBEE', fg: '#3D6470' },
  placed: { bg: '#DCEAE0', fg: '#1F5A49' },
  aftercare: { bg: '#DCEAE0', fg: '#1F5A49' },
  closed: { bg: '#F1EEEA', fg: '#73827D' },
  lost: { bg: '#F7E7E1', fg: '#B0603F' },
};

type CaseFormState = {
  title: string;
  status: CaseStatus;
  summary: string;
  leadSource: string;
  leadSourceDetail: string;
  contactName: string;
  contactRelationship: string;
  contactPhone: string;
  contactEmail: string;
};

function makeEmptyCaseForm(): CaseFormState {
  return {
    title: '',
    status: 'inquiry',
    summary: '',
    leadSource: 'Unspecified',
    leadSourceDetail: '',
    contactName: '',
    contactRelationship: '',
    contactPhone: '',
    contactEmail: '',
  };
}

type CaseContactFormState = {
  id: string | null; // null = adding a new contact
  name: string;
  relationship: string;
  phone: string;
  email: string;
  note: string;
  isPrimary: boolean;
};

function makeEmptyCaseContactForm(): CaseContactFormState {
  return { id: null, name: '', relationship: '', phone: '', email: '', note: '', isPrimary: false };
}

type CaseEditFormState = {
  title: string;
  summary: string;
};

type CaseBusinessFormState = {
  leadSource: string;
  leadSourceDetail: string;
  lostReason: string;
};

type CasePaymentFormState = {
  eventId: string;
  amount: string;
  note: string;
};

// "2:14 PM" in the device's local time.
function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  let hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, '0');
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${suffix}`;
}

function relativeActivity(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function caseEventIcon(kind: CaseEventKind): IconName {
  switch (kind) {
    case 'call': return 'call';
    case 'text': return 'chatbubble';
    case 'email': return 'mail';
    case 'meeting': return 'people';
    case 'voice_note': return 'mic';
    case 'status_change': return 'flag';
    case 'payment': return 'card';
    case 'referral': return 'paper-plane';
    case 'document': return 'document';
    case 'system': return 'cog';
    default: return 'create';
  }
}

function documentIcon(mimeType: string): IconName {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'document-text';
  return 'document';
}

function todayKindIcon(card: TodayCard): IconName {
  switch (card.kind) {
    case 'first_call': return 'call-outline';
    case 'promised_call': return 'call';
    case 'consult': return 'calendar';
    case 'waiting_on': return 'hourglass-outline';
    case 'touch': return 'hand-left-outline';
    case 'cadence': return 'repeat';
    default: return 'return-up-back';
  }
}

type PartnerForm = {
  name: string;
  organization: string;
  types: Partner['type'][];
  city: string;
  state: string;
  phone: string;
  email: string;
  website: string;
  monthlyCost: string;
  insurance: string[];
  insuranceNetworks: Partial<Record<string, InsuranceNetworkPreference[]>>;
  // The program takes no insurance. Stored as the 'Cash pay' insurance entry.
  privatePayOnly: boolean;
  therapies: string[];
  note: string;
  touchCadence: string;
  // Disclosed to families and shown on cards; never part of the ranking.
  financialRelationship: FinancialRelationship;
  financialRelationshipNote: string;
};

function localDateStamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function currentDateLabel() {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    .format(new Date())
    .toUpperCase();
}

function makeEmptyPartnerForm(): PartnerForm {
  return {
  name: '',
  organization: '',
  types: ['Inpatient'],
  city: '',
  state: '',
  phone: '',
  email: '',
  website: '',
  monthlyCost: '',
  insurance: [],
  insuranceNetworks: {},
  privatePayOnly: false,
  therapies: [],
  note: '',
  touchCadence: '',
  financialRelationship: 'none',
  financialRelationshipNote: '',
  };
}

// The workspace's own directory listing: the partner form's public fields
// (no cadence or private note) plus a public description.
type OrgProfileForm = {
  name: string;
  organization: string;
  types: Partner['type'][];
  city: string;
  state: string;
  phone: string;
  email: string;
  website: string;
  monthlyCost: string;
  insurance: string[];
  insuranceNetworks: Partial<Record<string, InsuranceNetworkPreference[]>>;
  therapies: string[];
  description: string;
};

function makeEmptyOrgProfileForm(): OrgProfileForm {
  return {
    name: '',
    organization: '',
    types: ['Interventionist'],
    city: '',
    state: '',
    phone: '',
    email: '',
    website: '',
    monthlyCost: '',
    insurance: [],
    insuranceNetworks: {},
    therapies: [],
    description: '',
  };
}

function orgProfileFormFromListing(profile: OrgDirectoryProfile): OrgProfileForm {
  return {
    name: profile.name,
    organization: profile.organization,
    types: profile.types.length ? profile.types : ['Interventionist'],
    city: profile.city,
    state: profile.state,
    phone: profile.phone,
    email: profile.email,
    website: profile.website || '',
    monthlyCost: profile.monthlyCost ? String(profile.monthlyCost) : '',
    insurance: profile.insurance,
    insuranceNetworks: profile.insuranceNetworks,
    therapies: profile.therapies,
    description: profile.description,
  };
}

// typesForPartner, monthlyCostForPartner and networkCapabilitiesForPartner
// live in src/lib/matching.ts so the ranking and the UI read one definition.
function partnerTypeLabel(partner: Partner) {
  return typesForPartner(partner).join(' · ');
}

// Neutral activity line for partner cards and profiles: when, how many
// received, how many sent. No tallies of who owes whom.
function partnerActivityLine(partner: Partner, lastReferralOn?: string): string {
  const parts = [
    lastReferralOn ? `Last referral ${shortDate(lastReferralOn)}` : 'No referrals yet',
    `${partner.inbound} received`,
    `${partner.outbound} sent`,
  ];
  return parts.join(' · ');
}

function partnerShareMessage(partner: Partner) {
  return [
    partner.organization,
    `Contact: ${partner.name}`,
    partner.phone ? `Phone: ${partner.phone}` : '',
    partner.website ? `Website: ${partner.website}` : '',
  ].filter(Boolean).join('\n');
}

function addDaysStamp(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} after ${timeoutMs / 1000} seconds.`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

const emptyReferral = {
  direction: 'Inbound' as ReferralDirection,
  partnerId: '',
  clientLabel: '',
  outcome: 'Introduced' as Referral['outcome'],
  note: '',
};

function AppIcon({ name, size = 20, color = COLORS.ink }: { name: IconName; size?: number; color?: string }) {
  return <Ionicons name={name} size={size} color={color} />;
}

function Pill({
  label,
  active = false,
  disabled = false,
  onPress,
  icon,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  icon?: IconName;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      activeOpacity={0.75}
      disabled={disabled}
      onPress={onPress}
      style={[styles.pill, active && styles.pillActive, disabled && { opacity: 0.5 }]}
    >
      {icon ? <AppIcon name={icon} size={14} color={active ? COLORS.white : COLORS.inkSoft} /> : null}
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function DropdownField({
  label,
  value,
  options,
  onChange,
  icon,
}: {
  label: string;
  value: string;
  options: { label: string; value: string; detail?: string }[];
  onChange: (value: string) => void;
  icon: IconName;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) || options[0];
  return (
    <View style={styles.dropdownField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TouchableOpacity
        accessibilityLabel={`${label}: ${selected?.label || value}`}
        accessibilityRole="button"
        activeOpacity={0.8}
        onPress={() => setOpen(true)}
        style={styles.dropdownButton}
      >
        <View style={styles.dropdownLeading}><AppIcon name={icon} size={18} color={COLORS.forest} /></View>
        <Text numberOfLines={1} style={styles.dropdownValue}>{selected?.label || value}</Text>
        <AppIcon name="chevron-down" size={18} color={COLORS.gray} />
      </TouchableOpacity>
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.dropdownOverlay} onPress={() => setOpen(false)}>
          <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownSheetHandle} />
            <View style={styles.dropdownSheetHeader}>
              <View>
                <Text style={styles.dropdownSheetEyebrow}>SELECT</Text>
                <Text style={styles.dropdownSheetTitle}>{label}</Text>
              </View>
              <TouchableOpacity accessibilityLabel={`Close ${label}`} onPress={() => setOpen(false)} style={styles.closeButton}><AppIcon name="close" size={21} /></TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.dropdownOptions}>
              {options.map((option) => {
                const active = option.value === value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => { onChange(option.value); setOpen(false); }}
                    style={[styles.dropdownOption, active && styles.dropdownOptionActive]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.dropdownOptionText, active && styles.dropdownOptionTextActive]}>{option.label}</Text>
                      {option.detail ? <Text style={styles.dropdownOptionDetail}>{option.detail}</Text> : null}
                    </View>
                    {active ? <AppIcon name="checkmark-circle" size={20} color={COLORS.forest} /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function MultiSelectDropdown({
  label,
  values,
  options,
  onChange,
  icon,
  emptyLabel = 'Any therapeutic need',
  selectedNoun = 'needs',
}: {
  label: string;
  values: string[];
  options: string[];
  onChange: (values: string[]) => void;
  icon: IconName;
  emptyLabel?: string;
  selectedNoun?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draftValues, setDraftValues] = useState<string[]>(values);
  const summary = values.length === 0
    ? emptyLabel
    : values.length === 1
      ? values[0]
      : `${values.length} ${selectedNoun} selected`;
  const toggle = (option: string) => setDraftValues((current) => current.includes(option)
    ? current.filter((item) => item !== option)
    : [...current, option]);
  const applySelections = () => {
    onChange(draftValues);
    setOpen(false);
  };

  return (
    <View style={styles.dropdownField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TouchableOpacity
        accessibilityLabel={`${label}: ${summary}`}
        accessibilityRole="button"
        activeOpacity={0.8}
        onPress={() => { setDraftValues(values); setOpen(true); }}
        style={styles.dropdownButton}
      >
        <View style={styles.dropdownLeading}><AppIcon name={icon} size={18} color={COLORS.forest} /></View>
        <Text numberOfLines={1} style={styles.dropdownValue}>{summary}</Text>
        {values.length ? <View style={styles.multiSelectCount}><Text style={styles.multiSelectCountText}>{values.length}</Text></View> : null}
        <AppIcon name="chevron-down" size={18} color={COLORS.gray} />
      </TouchableOpacity>
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.dropdownOverlay} onPress={() => setOpen(false)}>
          <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownSheetHandle} />
            <View style={styles.dropdownSheetHeader}>
              <View>
                <Text style={styles.dropdownSheetEyebrow}>SELECT MULTIPLE</Text>
                <Text style={styles.dropdownSheetTitle}>{label}</Text>
              </View>
              <TouchableOpacity onPress={applySelections} style={styles.multiSelectDone}><Text style={styles.multiSelectDoneText}>Done</Text></TouchableOpacity>
            </View>
            <View style={styles.multiSelectActions}>
              <Text style={styles.multiSelectSelectionText}>{draftValues.length ? `${draftValues.length} selected` : 'No filters selected'}</Text>
              {draftValues.length ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Clear all ${label} selections`} style={styles.multiSelectClearButton} onPress={() => setDraftValues([])}><Text style={styles.multiSelectClear}>Clear all</Text></TouchableOpacity> : null}
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.dropdownOptions}>
              {options.map((option) => {
                const active = draftValues.includes(option);
                return (
                  <TouchableOpacity key={option} accessibilityRole="checkbox" accessibilityState={{ checked: active }} onPress={() => toggle(option)} style={[styles.dropdownOption, active && styles.dropdownOptionActive]}>
                    <Text style={[styles.dropdownOptionText, styles.multiSelectOptionText, active && styles.dropdownOptionTextActive]}>{option}</Text>
                    <AppIcon name={active ? 'checkbox' : 'square-outline'} size={21} color={active ? COLORS.forest : COLORS.gray} />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function SectionTitle({ title, action, onPress }: { title: string; action?: string; onPress?: () => void }) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action ? (
        <TouchableOpacity onPress={onPress} style={styles.textAction}>
          <Text style={styles.textActionLabel}>{action}</Text>
          <AppIcon name="chevron-forward" size={14} color={COLORS.forest} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function Initials({ name, size = 48 }: { name: string; size?: number }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
  return (
    <View style={[styles.initials, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.initialsText, { fontSize: size * 0.32 }]}>{letters || 'R'}</Text>
    </View>
  );
}

function PartnerCard({
  partner,
  onPress,
  onShare,
  compact = false,
  lastReferralOn,
}: {
  partner: Partner;
  onPress: () => void;
  onShare?: () => void;
  compact?: boolean;
  lastReferralOn?: string;
}) {
  const insurancePlanCount = partner.insurance.filter((plan) => plan !== 'Cash pay').length;
  return (
    <View style={[styles.partnerCard, compact && styles.partnerCardCompact]}>
      <TouchableOpacity activeOpacity={0.84} onPress={onPress}>
        <View style={styles.partnerCardTop}>
          <Initials name={partner.organization} size={compact ? 44 : 50} />
          <View style={styles.partnerCardIdentity}>
            <Text style={styles.partnerOrg} numberOfLines={1}>{partner.organization}</Text>
            <Text style={styles.partnerName} numberOfLines={1}>{partner.name}</Text>
          </View>
          {partner.favorite ? <AppIcon name="heart" size={18} color={COLORS.coral} /> : <AppIcon name="chevron-forward" size={18} color={COLORS.gray} />}
        </View>
        <View style={styles.metaRow}>
          <View style={[styles.typeBadge, styles.partnerTypeBadge]}><Text numberOfLines={1} style={styles.typeBadgeText}>{partnerTypeLabel(partner)}</Text></View>
          <Text numberOfLines={1} style={styles.metaText}>{partner.city}, {partner.state}</Text>
        </View>
        {!compact ? (
          <View style={styles.tagRow}>
            {partner.therapies.slice(0, 3).map((therapy) => <View key={therapy} style={styles.miniTag}><Text style={styles.miniTagText}>{therapy}</Text></View>)}
            {partner.therapies.length > 3 ? <Text style={styles.moreTags}>+{partner.therapies.length - 3}</Text> : null}
          </View>
        ) : null}
      </TouchableOpacity>
      {!compact ? (
        <View style={styles.partnerFooter}>
            <View style={{ flex: 1, flexShrink: 1 }}>
              <Text style={styles.partnerFooterText}>{insurancePlanCount ? `${insurancePlanCount} insurance ${insurancePlanCount === 1 ? 'plan' : 'plans'}` : 'Cash pay only'} · {partnerActivityLine(partner, lastReferralOn)}</Text>
              {hasFinancialRelationship(partner) ? (
                <View style={[styles.disclosureBadge, { alignSelf: 'flex-start', marginTop: 6 }]}><AppIcon name="information-circle-outline" size={12} color={COLORS.coral} /><Text style={styles.disclosureBadgeText}>Disclosed relationship · {financialRelationshipLabel(partner.financialRelationship)}</Text></View>
              ) : null}
            </View>
            {onShare ? (
              <TouchableOpacity accessibilityLabel={`Share ${partner.organization}`} accessibilityRole="button" onPress={onShare} style={styles.cardShareButton}>
                <AppIcon name="share-outline" size={17} color={COLORS.forest} />
              </TouchableOpacity>
            ) : null}
        </View>
      ) : null}
    </View>
  );
}

function EmptyState({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}><AppIcon name={icon} size={25} color={COLORS.forest} /></View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

type TimePeriod = 'AM' | 'PM';

function formatTwelveHourInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  const hourLength = digits.length === 3 && !digits.startsWith('0') ? 1 : 2;
  return `${digits.slice(0, hourLength)}:${digits.slice(hourLength)}`;
}

function storedTimeToTwelveHour(value?: string): { time: string; timePeriod: TimePeriod } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  if (!match) return { time: '', timePeriod: 'AM' };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { time: '', timePeriod: 'AM' };
  return {
    time: `${hour % 12 || 12}:${String(minute).padStart(2, '0')}`,
    timePeriod: hour >= 12 ? 'PM' : 'AM',
  };
}

function twelveHourToStoredTime(value: string, period: TimePeriod): string | null {
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  const hourDigits = digits.length <= 2 ? digits : digits.slice(0, digits.length - 2);
  const minuteDigits = digits.length <= 2 ? '00' : digits.slice(-2);
  const hour = Number(hourDigits);
  const minute = Number(minuteDigits);
  if (!Number.isInteger(hour) || hour < 1 || hour > 12 || !Number.isInteger(minute) || minute > 59) return null;
  const hour24 = (hour % 12) + (period === 'PM' ? 12 : 0);
  return `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [partners, setPartners] = useState<Partner[]>(initialPartners);
  const [referrals, setReferrals] = useState<Referral[]>(initialReferrals);
  const [referralMatches, setReferralMatches] = useState<ReferralMatch[]>(initialReferralMatches);
  const [loaded, setLoaded] = useState(false);
  const [authResolved, setAuthResolved] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  // True while the app was opened from a password-recovery email link and the
  // user has not yet set (or declined to set) a new password.
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [offline, setOffline] = useState(false);
  const [queuedWrites, setQueuedWrites] = useState(0);
  const [touches, setTouches] = useState<Touch[]>([]);
  const [selectedPartner, setSelectedPartner] = useState<Partner | null>(null);
  const [showAddPartner, setShowAddPartner] = useState(false);
  const [editingPartnerId, setEditingPartnerId] = useState<string | null>(null);
  const [showAddReferral, setShowAddReferral] = useState(false);
  const [activeReferralMatchId, setActiveReferralMatchId] = useState<string | null>(null);
  const [touchPartner, setTouchPartner] = useState<Partner | null>(null);
  const [touchKind, setTouchKind] = useState<TouchKind>('call');
  const [touchNote, setTouchNote] = useState('');
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [scorecards, setScorecards] = useState<Record<string, PartnerScorecard>>({});
  // Case files (v3): the family file behind the ledger. Loaded after sign-in
  // from the cases tables; contacts/events/documents are per-case overlays
  // fetched when a case file is opened (kept server-side until then).
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  // Every contact in the workspace, loaded with the case list so each case
  // card can show the family's primary name and phone. The open file's own
  // contact list is derived below; edits replace that case's slice in here.
  const [allCaseContacts, setAllCaseContacts] = useState<CaseContact[]>([]);
  const caseContacts = useMemo(
    () => (activeCaseId ? allCaseContacts.filter((item) => item.caseId === activeCaseId) : []),
    [allCaseContacts, activeCaseId],
  );
  const setCaseContacts = useCallback((caseId: string, next: CaseContact[]) => {
    setAllCaseContacts((current) => [...current.filter((item) => item.caseId !== caseId), ...next]);
  }, []);
  const [caseEvents, setCaseEvents] = useState<CaseEvent[]>([]);
  const [caseDocuments, setCaseDocuments] = useState<CaseDocument[]>([]);
  const [caseListSource, setCaseListSource] = useState<CachedCopyState | null>(null);
  const [caseFileSource, setCaseFileSource] = useState<CachedCopyState | null>(null);
  // Pull-to-refresh on the Today, Cases, Directory and Referrals lists.
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState('');
  const lastServerRefreshAtRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<'ok' | 'offline'> | null>(null);
  const [showNewCase, setShowNewCase] = useState(false);
  const [showClosedCases, setShowClosedCases] = useState(false);
  const [caseSearch, setCaseSearch] = useState('');
  const [caseSearchResults, setCaseSearchResults] = useState<CaseSearchResult[] | null>(null);
  const [pendingCaseMatchId, setPendingCaseMatchId] = useState<string | null>(null);
  const [caseSearching, setCaseSearching] = useState(false);
  const [caseForm, setCaseForm] = useState(makeEmptyCaseForm);
  const [caseContactForm, setCaseContactForm] = useState<CaseContactFormState | null>(null);
  const [caseEditForm, setCaseEditForm] = useState<CaseEditFormState | null>(null);
  const [caseBusinessForm, setCaseBusinessForm] = useState<CaseBusinessFormState | null>(null);
  const [casePaymentForm, setCasePaymentForm] = useState<CasePaymentFormState | null>(null);
  const [timelineDraft, setTimelineDraft] = useState('');
  const [timelineKind, setTimelineKind] = useState<CaseEventKind>('note');
  const [quickNoteContact, setQuickNoteContact] = useState<{ contact: CaseContact; kind: 'call' | 'text' | 'email' } | null>(null);
  const [quickNoteText, setQuickNoteText] = useState('');
  const [docLabel, setDocLabel] = useState('');
  const [docUploading, setDocUploading] = useState(false);
  const [docView, setDocView] = useState<{ url: string; mimeType: string; label: string } | null>(null);
  // Match Packet compose state: which partner + which match profile the
  // packet is for, and whether the assign-on-send flow should run.
  const [packetTarget, setPacketTarget] = useState<{ partner: Partner; match: ReferralMatch; assignOnSend: boolean } | null>(null);
  const [packetAudience, setPacketAudience] = useState<PacketAudience>('family');
  const [packetText, setPacketText] = useState('');
  // One-tap confirm shown when Share.share can't tell us whether the user
  // actually sent (iOS reports dismiss and send identically in most cases).
  const [packetSendConfirm, setPacketSendConfirm] = useState(false);
  // Outcome capture sheet, opened when completing an admit-check follow-up.
  const [outcomeFollowUp, setOutcomeFollowUp] = useState<FollowUp | null>(null);
  const [outcomeAnswer, setOutcomeAnswer] = useState<'yes' | 'no' | null>(null);
  const [outcomeAdmittedOn, setOutcomeAdmittedOn] = useState('');
  const [outcomeStars, setOutcomeStars] = useState(0);
  const [outcomeNote, setOutcomeNote] = useState('');
  const [notifPrePromptVisible, setNotifPrePromptVisible] = useState(false);
  const [welcomeVisible, setWelcomeVisible] = useState(false);
  const [profilePromptVisible, setProfilePromptVisible] = useState(false);
  const [showOrgProfile, setShowOrgProfile] = useState(false);
  const [orgProfileForm, setOrgProfileForm] = useState<OrgProfileForm>(makeEmptyOrgProfileForm);
  const [orgProfileExisting, setOrgProfileExisting] = useState<OrgDirectoryProfile | null>(null);
  const [orgProfileSaving, setOrgProfileSaving] = useState(false);
  // Reopen the Workspace screen after the profile form when it launched from there.
  const orgProfileReturnToWorkspaceRef = useRef(false);
  // The first-run welcome goes before the notification pre-prompt; when both
  // are due, the notification prompt waits until the welcome is dismissed.
  const notifPromptDeferredRef = useRef(false);
  const [notificationPermissionState, setNotificationPermissionState] = useState<'authorized' | 'askable' | 'blocked' | 'unsupported'>('unsupported');
  const [pendingNotificationPartnerId, setPendingNotificationPartnerId] = useState<string | null>(null);
  const authGenerationRef = useRef(0);
  const mutationActiveRef = useRef<symbol | null>(null);
  // Today Command Center (v4)
  const [partnerSnoozes, setPartnerSnoozes] = useState<Record<string, string>>({});
  const [showHomeMore, setShowHomeMore] = useState(false);
  const [doneCard, setDoneCard] = useState<TodayCard | null>(null); // "Done — what's next?" sheet
  const [nextStepCard, setNextStepCard] = useState<TodayCard | null>(null); // Set-next-step sheet
  const [caseNextStepCaseId, setCaseNextStepCaseId] = useState<string | null>(null); // Case-file next-step editor
  const [doneStatusPicker, setDoneStatusPicker] = useState(false); // Close-the-loop case status picker
  const [caseCloseLoopSaving, setCaseCloseLoopSaving] = useState(false);
  const [stepForm, setStepForm] = useState<{ kind: FollowUpKind; when: WhenChoice; customDate: string; time: string; timePeriod: TimePeriod; waitingOn: string; note: string }>({ kind: 'follow_up', when: 'tomorrow', customDate: '', time: '', timePeriod: 'AM', waitingOn: '', note: '' });
  const [snoozeCard, setSnoozeCard] = useState<TodayCard | null>(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAddForm, setQuickAddForm] = useState<{ kind: FollowUpKind; title: string; targetType: 'none' | 'case' | 'partner'; targetId: string; targetSearch: string; when: WhenChoice; customDate: string; time: string; timePeriod: TimePeriod; waitingOn: string }>({ kind: 'follow_up', title: '', targetType: 'none', targetId: '', targetSearch: '', when: 'today', customDate: '', time: '', timePeriod: 'AM', waitingOn: '' });
  const [contactPick, setContactPick] = useState<{ card: TodayCard; action: 'call' | 'text'; contacts: CaseContact[] } | null>(null);
  const [todayQuickNote, setTodayQuickNote] = useState<{ card: TodayCard; action: 'call' | 'text'; contact?: CaseContact } | null>(null);
  const [partnerForm, setPartnerForm] = useState<PartnerForm>(makeEmptyPartnerForm);
  const [referralForm, setReferralForm] = useState(emptyReferral);
  const [referralSearch, setReferralSearch] = useState('');
  const [referralDirectionFilter, setReferralDirectionFilter] = useState<'All' | ReferralDirection>('All');
  const [showBusinessDashboard, setShowBusinessDashboard] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  // Lead capture: the "New lead" quick-add sheet, the workspace's first-call
  // target and intake token (advisory; defaults when offline), and a slow
  // tick that keeps the NEW LEADS waiting clocks moving.
  const [showNewLead, setShowNewLead] = useState(false);
  const [leadSettings, setLeadSettings] = useState<LeadSettings>(DEFAULT_LEAD_SETTINGS);
  // Team basics: who is in the workspace (names on timeline rows, the
  // assignee pickers, "Take this lead") and the Today scope. A scope of null
  // means "not chosen yet": the default follows the member count (Mine with
  // staff, Everyone solo). A solo workspace never shows any of this.
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [todayScopeChoice, setTodayScopeChoice] = useState<TodayScope | null>(null);
  const [pendingNotificationCaseId, setPendingNotificationCaseId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => new Date());
  const [entitlements, setEntitlements] = useState<EntitlementState>(NO_ENTITLEMENTS);
  const [showGlobalDirectory, setShowGlobalDirectory] = useState(false);
  const [directorySubmitBusy, setDirectorySubmitBusy] = useState(false);
  // Incremented after the account joins a different practice workspace, which
  // re-homes its rows server-side; bumping it re-runs the hydration effect.
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  const [businessData, setBusinessData] = useState<BusinessData>({ stages: [], integrations: [] });
  const [businessLoading, setBusinessLoading] = useState(false);
  const [businessError, setBusinessError] = useState('');
  const [search, setSearch] = useState('');
  const [directoryType, setDirectoryType] = useState('All');
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [matchClientLabel, setMatchClientLabel] = useState('');
  const [matchType, setMatchType] = useState('Any type');
  const [matchInsurance, setMatchInsurance] = useState('Cash pay');
  const [matchNetworkPreferences, setMatchNetworkPreferences] = useState<InsuranceNetworkPreference[]>(['In-network']);
  const [matchState, setMatchState] = useState('ANY');
  const [matchBudget, setMatchBudget] = useState('');
  const [matchTherapies, setMatchTherapies] = useState<string[]>([]);
  // Matching integrity: who the client is, where the family wants care, and
  // which selected needs are must-haves (hide a program) versus preferred
  // (score it). MAT is must-have by default when selected.
  const [matchPopulation, setMatchPopulation] = useState<ClientPopulation>('Any');
  const [matchLocationPreference, setMatchLocationPreference] = useState<LocationPreference>('No preference');
  const [matchMustHave, setMatchMustHave] = useState<string[]>([]);
  // "Has a bed for": off by default. When turned on, the client's population
  // picks men / women; the clinician can change it. Live counts come from
  // each linked directory listing (src/lib/beds.ts), never from the partner.
  const [bedFilterOn, setBedFilterOn] = useState(false);
  const [bedFor, setBedFor] = useState<BedFor>('any');
  const [listingBeds, setListingBeds] = useState<Record<string, ListingBedsStatus>>({});
  // The shortlist the clinician saw when they started an assignment, so the
  // placement record can say what was shown and at what rank the pick sat.
  const [pendingPlacement, setPendingPlacement] = useState<{ matchProfileId: string; rankedIds: string[]; candidates: PlacementCandidate[] } | null>(null);
  const [placementReason, setPlacementReason] = useState<PlacementReason | null>(null);
  const [placementReasonNote, setPlacementReasonNote] = useState('');
  const matchClientLabelRef = useRef<TextInput>(null);
  // Bind every mutation to the account from the render that initiated it. If
  // auth changes mid-flight, store.ts rejects the stale account ID.
  const activeUserId = session?.user?.id || '';
  const activeUserIdRef = useRef(activeUserId);
  const activeOrgIdRef = useRef('');
  const businessLoadGenerationRef = useRef(0);
  const caseLoadGenerationRef = useRef(0);
  activeUserIdRef.current = activeUserId;

  const refreshBusiness = useCallback(async () => {
    const userId = session?.user?.id;
    if (!userId) return;
    const requestGeneration = ++businessLoadGenerationRef.current;
    setBusinessLoading(true);
    setBusinessError('');
    try {
      const next = await fetchBusinessData();
      if (activeUserIdRef.current !== userId || requestGeneration !== businessLoadGenerationRef.current) return;
      setBusinessData(next);
    } catch (error) {
      if (activeUserIdRef.current !== userId || requestGeneration !== businessLoadGenerationRef.current) return;
      setBusinessError((error as Error).message);
    } finally {
      if (activeUserIdRef.current === userId && requestGeneration === businessLoadGenerationRef.current) {
        setBusinessLoading(false);
      }
    }
  }, [session?.user?.id]);

  // Push a snapshot of in-memory state to the offline cache, refresh the
  // offline indicator + queued-write count, and recompute notifications.
  // Cases are app-side state (not part of the store Snapshot) and are passed
  // separately to the briefing scheduler.
  const syncDerived = useCallback(async (snapshot?: Snapshot, caseList?: CaseRecord[]) => {
    const userId = session?.user?.id;
    if (!userId) throw new Error('The account changed before local data could be saved.');
    const generation = authGenerationRef.current;
    const accountIsCurrent = () => activeUserIdRef.current === userId && authGenerationRef.current === generation;
    const data = snapshot || { partners, referrals, referralMatches, touches, followUps, scorecards };
    const activeCases = caseList ?? cases;
    await persistCache(data, userId);
    if (!accountIsCurrent()) throw new Error('The account changed before local data could be saved.');
    const pending = await pendingWriteCount(userId);
    if (!accountIsCurrent()) throw new Error('The account changed before local data could be saved.');
    setQueuedWrites(pending);
    setOffline(pending > 0);
    await withTimeout(
      rescheduleNotifications({ ...data, cases: activeCases }, userId),
      6000,
      'Notification scheduling timed out',
    );
    if (!accountIsCurrent()) throw new Error('The account changed before notification scheduling completed.');
  }, [session?.user?.id, partners, referrals, referralMatches, touches, followUps, scorecards, cases]);

  async function settleOptimisticWrite(
    operation: () => Promise<void>,
    nextSnapshot: Snapshot,
    previousSnapshot: Snapshot,
    rollback: () => void,
    label: string,
    nextCaseList?: CaseRecord[],
    previousCaseList?: CaseRecord[],
  ): Promise<boolean> {
    const userId = activeUserIdRef.current;
    const generation = authGenerationRef.current;
    const accountIsCurrent = () => Boolean(userId && activeUserIdRef.current === userId && authGenerationRef.current === generation);
    if (mutationActiveRef.current) {
      rollback();
      Alert.alert('Save in progress', `Wait for the current save to finish, then retry ${label.toLowerCase()}.`);
      return false;
    }
    const mutationToken = Symbol(label);
    mutationActiveRef.current = mutationToken;
    let accepted = false;
    try {
      if (!accountIsCurrent()) return false;
      await operation();
      if (!accountIsCurrent()) return false;
      accepted = true; // Confirmed remotely or durably queued by store.ts.
      await syncDerived(nextSnapshot, nextCaseList);
      if (!accountIsCurrent()) return false;
      return true;
    } catch (error) {
      if (!accountIsCurrent()) return false;
      if (accepted) {
        Alert.alert('Local status unavailable', `${label} was accepted, but local status/notification refresh failed: ${(error as Error).message}`);
        return true;
      }
      rollback();
      try {
        await syncDerived(previousSnapshot, previousCaseList);
        Alert.alert('Not saved', `${label} was rejected and has been rolled back: ${(error as Error).message}`);
      } catch (persistenceError) {
        Alert.alert('Not safely saved', `${label} was rejected (${(error as Error).message}) and the rollback cache could not be persisted (${(persistenceError as Error).message}). Refresh before continuing.`);
      }
      return false;
    } finally {
      if (mutationActiveRef.current === mutationToken) mutationActiveRef.current = null;
    }
  }

  // Event handlers execute synchronously until their first await. Checking
  // immediately before optimistic state changes guarantees the settlement call
  // takes the slot before another user action can interleave.
  function mutationSlotAvailable(label: string): boolean {
    if (!mutationActiveRef.current) return true;
    Alert.alert('Save in progress', `Wait for the current save to finish, then retry ${label.toLowerCase()}.`);
    return false;
  }

  // Apply a freshly loaded snapshot to state, restoring the match-form
  // selection exactly like the previous AsyncStorage loader did.
  const applySnapshot = useCallback((snapshot: Snapshot) => {
    setPartners(snapshot.partners);
    setReferrals(snapshot.referrals);
    setTouches(snapshot.touches);
    setFollowUps(snapshot.followUps);
    setScorecards(snapshot.scorecards);
    setReferralMatches(snapshot.referralMatches);
    const firstMatch = snapshot.referralMatches.find((item) => item.status === 'Matching');
    setSelectedMatchId(firstMatch?.id || null);
    if (firstMatch) {
      setMatchClientLabel(firstMatch.clientLabel);
      setMatchType(firstMatch.levelOfCare);
      setMatchState(firstMatch.state);
      setMatchInsurance(firstMatch.insurance);
      setMatchNetworkPreferences(firstMatch.networkPreferences?.length ? firstMatch.networkPreferences : ['In-network']);
      setMatchBudget(firstMatch.maxBudget ? String(firstMatch.maxBudget) : '');
      setMatchTherapies(firstMatch.therapies);
    } else {
      setMatchClientLabel('');
      setMatchType('Any type');
      setMatchState('ANY');
      setMatchInsurance('Cash pay');
      setMatchNetworkPreferences(['In-network']);
      setMatchBudget('');
      setMatchTherapies([]);
    }
  }, []);

  const resetAccountState = useCallback(() => {
    setMembers([]);
    setTodayScopeChoice(null);
    setPendingNotificationCaseId(null);
    caseLoadGenerationRef.current += 1;
    businessLoadGenerationRef.current += 1;
    activeOrgIdRef.current = '';
    applySnapshot({ partners: [], referrals: [], referralMatches: [], touches: [], followUps: [], scorecards: {} });
    setEntitlements(NO_ENTITLEMENTS);
    setLeadSettings(DEFAULT_LEAD_SETTINGS);
    setCases([]);
    setAllCaseContacts([]);
    setCaseEvents([]);
    setCaseDocuments([]);
    setCaseListSource(null);
    setCaseFileSource(null);
    setPullRefreshing(false);
    setRefreshNotice('');
    lastServerRefreshAtRef.current = 0;
    refreshInFlightRef.current = null;
    setActiveCaseId(null);
    setSelectedPartner(null);
    setTouchPartner(null);
    setTouchNote('');
    setPartnerForm(makeEmptyPartnerForm());
    setReferralForm(emptyReferral);
    setCaseForm(makeEmptyCaseForm());
    setCaseContactForm(null);
    setCaseEditForm(null);
    setCaseBusinessForm(null);
    setCasePaymentForm(null);
    setReferralSearch('');
    setReferralDirectionFilter('All');
    setShowBusinessDashboard(false);
    setShowWorkspace(false);
    setShowGlobalDirectory(false);
    setBusinessData({ stages: [], integrations: [] });
    setBusinessLoading(false);
    setBusinessError('');
    setPacketTarget(null);
    setPacketText('');
    setDoneCard(null);
    setDoneStatusPicker(false);
    setCaseCloseLoopSaving(false);
    setNextStepCard(null);
    setSnoozeCard(null);
    setQuickNoteContact(null);
    setTodayQuickNote(null);
    setContactPick(null);
    setPartnerSnoozes({});
    setPendingNotificationPartnerId(null);
    setQueuedWrites(0);
    setOffline(false);
    setNotifPrePromptVisible(false);
    setNotificationPermissionState('unsupported');
    setTab('home');
  }, [applySnapshot]);

  // Resolve authentication separately from account hydration. The hydration
  // effect below runs on every user-id transition (including interactive sign
  // in) and generation-fences all async work against rapid account switching.
  // Auth session gate: resolve the current session; hydration is handled by
  // the user-id keyed effect below so interactive sign-in follows the same path.
  useEffect(() => {
    let mounted = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
      if (event === 'SIGNED_OUT') setPasswordRecovery(false);
      setSession(nextSession);
      setAuthResolved(true);
    });
    supabase.auth.getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setSession(data.session);
        setAuthResolved(true);
      })
      .catch(() => {
        if (mounted) setAuthResolved(true);
      });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  // Auth deep links (referralfit://auth/recovery, referralfit://auth/confirmed).
  // supabase.ts sets detectSessionInUrl: false, so the tokens in the link are
  // exchanged here explicitly. A recovery link then opens ResetPasswordScreen.
  useEffect(() => {
    let active = true;
    async function handleAuthUrl(url: string | null) {
      const redirect = parseAuthRedirect(url);
      if (!redirect || !active) return;
      if (redirect.kind === 'error') {
        Alert.alert('That link could not be used', `${redirect.description} Request a new one from the sign-in screen.`);
        return;
      }
      const result = redirect.kind === 'tokens'
        ? await supabase.auth.setSession({ access_token: redirect.accessToken, refresh_token: redirect.refreshToken })
        : await supabase.auth.exchangeCodeForSession(redirect.code);
      if (!active) return;
      if (result.error) {
        Alert.alert('That link has expired', 'Request a new one from the sign-in screen and open it on this device.');
        return;
      }
      if (isRecoveryRedirect(redirect)) setPasswordRecovery(true);
    }
    Linking.getInitialURL().then((url) => { void handleAuthUrl(url); }).catch(() => undefined);
    const listener = Linking.addEventListener('url', ({ url }) => { void handleAuthUrl(url); });
    return () => {
      active = false;
      listener.remove();
    };
  }, []);

  useEffect(() => {
    if (!authResolved) return undefined;
    const generation = ++authGenerationRef.current;
    mutationActiveRef.current = null;
    const userId = session?.user?.id;
    resetAccountState();

    if (!userId) {
      cancelReferralFitNotifications().catch(() => undefined);
      setLoaded(true);
      return undefined;
    }

    setLoaded(false);
    let active = true;
    (async () => {
      try {
        // With no signal the server cannot name the workspace; the caches are
        // read under the binding last verified on this device (never bound →
        // nothing cached → the original error surfaces).
        let orgId: string;
        try {
          orgId = await fetchCurrentOrgId();
        } catch (error) {
          if (!isNetworkError(error)) throw error;
          const bound = await readBoundWorkspace(userId);
          if (!bound) throw error;
          orgId = bound;
        }
        if (!active || generation !== authGenerationRef.current) return;
        await bindLocalWorkspace(userId, orgId);
        if (!active || generation !== authGenerationRef.current) return;
        activeOrgIdRef.current = orgId;
        await activateReferralFitNotificationOwner(userId);
        if (!active || generation !== authGenerationRef.current) return;
        const result = await hydrate(userId);
        if (!active || generation !== authGenerationRef.current) return;
        applySnapshot(result.snapshot);

        // The case list and its contacts load here (from the server, or the
        // saved copy when there is no signal); each file's timeline and
        // documents are fetched per case when it is opened.
        let activeCaseList: CaseRecord[] = [];
        let activeContacts: CaseContact[] = [];
        let caseListLoad: CachedCopyState | null = null;
        try {
          const load = await loadCaseList(userId);
          ({ cases: activeCaseList, contacts: activeContacts } = load.list);
          caseListLoad = { userId, source: load.source, savedAt: load.savedAt, truncated: false };
        } catch (error) {
          // Only when there is no saved copy at all (or a real server error).
          if (active && generation === authGenerationRef.current) {
            Alert.alert('Case files unavailable', `Case files could not be loaded: ${(error as Error).message}`);
          }
        }
        if (!active || generation !== authGenerationRef.current) return;
        setCases(activeCaseList);
        setAllCaseContacts(activeContacts);
        setCaseListSource(caseListLoad);

        try {
          const nextBusinessData = await fetchBusinessData();
          if (!active || generation !== authGenerationRef.current) return;
          setBusinessData(nextBusinessData);
          setBusinessError('');
        } catch (error) {
          if (active && generation === authGenerationRef.current) setBusinessError((error as Error).message);
        }

        // Subscription state is advisory UI context; failures fall back to
        // the free tier rather than blocking hydration.
        try {
          const nextEntitlements = await fetchEntitlements();
          if (!active || generation !== authGenerationRef.current) return;
          setEntitlements(nextEntitlements);
        } catch {
          if (active && generation === authGenerationRef.current) setEntitlements(NO_ENTITLEMENTS);
        }

        // Lead settings (first-call target, intake link) are advisory UI
        // context too; the defaults are fine offline.
        try {
          const nextLeadSettings = await fetchLeadSettings();
          if (!active || generation !== authGenerationRef.current) return;
          setLeadSettings(nextLeadSettings);
        } catch {
          if (active && generation === authGenerationRef.current) setLeadSettings(DEFAULT_LEAD_SETTINGS);
        }
        try {
          const nextMembers = await fetchWorkspaceMembers();
          if (!active || generation !== authGenerationRef.current) return;
          setMembers(nextMembers);
        } catch {
          if (active && generation === authGenerationRef.current) setMembers([]);
        }
        // A member who turned push on gets this device re-registered quietly;
        // this never prompts and never fails loudly.
        void refreshPushRegistration(userId);

        const pending = await pendingWriteCount(userId);
        if (!active || generation !== authGenerationRef.current) return;
        setQueuedWrites(pending);
        setOffline(result.source === 'cache' || caseListLoad?.source === 'cache' || pending > 0);
        if (result.source === 'remote') lastServerRefreshAtRef.current = Date.now();

        const welcomeSeen = await AsyncStorage.getItem(welcomeKey(userId));
        if (!active || generation !== authGenerationRef.current) return;
        const showWelcome = welcomeSeen !== 'seen';
        notifPromptDeferredRef.current = false;
        if (showWelcome) setWelcomeVisible(true);

        const permission = await getNotificationPermissionState();
        if (!active || generation !== authGenerationRef.current) return;
        setNotificationPermissionState(permission);
        if (permission === 'authorized') {
          const scheduling = await AsyncStorage.getItem(notificationScheduleKey(userId));
          if (!active || generation !== authGenerationRef.current) return;
          if (scheduling !== 'disabled') {
            rescheduleNotifications({ ...result.snapshot, cases: activeCaseList }, userId)
              .catch((error) => {
                if (active && generation === authGenerationRef.current) Alert.alert('Notifications unavailable', (error as Error).message);
              });
          }
        } else if (permission === 'askable') {
          const decision = await AsyncStorage.getItem(notificationPromptKey(userId));
          if (active && generation === authGenerationRef.current && decision !== 'dismissed') {
            if (showWelcome) notifPromptDeferredRef.current = true;
            else setNotifPrePromptVisible(true);
          }
        }
      } catch (error) {
        if (active && generation === authGenerationRef.current) {
          Alert.alert('Could not load account', (error as Error).message);
        }
      } finally {
        if (active && generation === authGenerationRef.current) setLoaded(true);
      }
    })();

    return () => {
      active = false;
      authGenerationRef.current += 1;
    };
  }, [authResolved, session?.user?.id, workspaceEpoch, applySnapshot, resetAccountState]);

  // Membership changes can happen from another owner's device. Realtime is the
  // fast path; the foreground check below is the durable fallback.
  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) return undefined;
    let active = true;
    const channel = supabase
      .channel(`workspace-membership-${userId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'org_members',
        filter: `user_id=eq.${userId}`,
      }, () => {
        void fetchCurrentOrgId().then(async (orgId) => {
          if (!active || activeUserIdRef.current !== userId || orgId === activeOrgIdRef.current) return;
          await bindLocalWorkspace(userId, orgId);
          if (!active || activeUserIdRef.current !== userId) return;
          activeOrgIdRef.current = orgId;
          setWorkspaceEpoch((epoch) => epoch + 1);
        }).catch(() => undefined);
      })
      .subscribe();
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [session?.user?.id]);

  // One refresh path for the foreground return and pull-to-refresh: flush
  // queued writes first, then re-read the snapshot, the case list and
  // contacts, business data, entitlements and the one open case file. Every
  // read is paged, so this is cheap enough to run unconditionally. Concurrent
  // calls share one run; a foreground return inside the debounce window is
  // skipped. Resolves 'offline' (nothing reached the server) instead of
  // throwing so callers can show a quiet notice rather than an alert.
  const refreshFromServer = useCallback(async (trigger: 'foreground' | 'pull'): Promise<'ok' | 'offline'> => {
    const userId = session?.user?.id;
    if (!userId) return 'ok';
    if (trigger === 'foreground' && Date.now() - lastServerRefreshAtRef.current < FOREGROUND_REFRESH_MIN_INTERVAL_MS) return 'ok';
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const generation = authGenerationRef.current;
    const stillCurrent = () => generation === authGenerationRef.current && activeUserIdRef.current === userId;
    const run = (async (): Promise<'ok' | 'offline'> => {
      try {
        // Keep the flush → refresh ordering: queued writes land before the
        // snapshot that would otherwise re-queue them is read back.
        await flushWriteQueue(userId);
      } catch (error) {
        if (isNetworkError(error)) return 'offline';
        throw error;
      }
      if (!stillCurrent()) return 'ok';
      const refreshed = await refreshSnapshot(userId);
      if (!stillCurrent()) return 'ok';
      if (!refreshed) return 'offline';
      lastServerRefreshAtRef.current = Date.now();
      applySnapshot(refreshed);
      // The case list and contacts reload; the timeline is re-read for the one
      // open case file (below), never for every case.
      const caseLoad = await loadCaseList(userId);
      if (!stillCurrent()) return 'ok';
      setCases(caseLoad.list.cases);
      setAllCaseContacts(caseLoad.list.contacts);
      setCaseListSource({ userId, source: caseLoad.source, savedAt: caseLoad.savedAt, truncated: false });
      try {
        const nextBusinessData = await fetchBusinessData();
        if (!stillCurrent()) return 'ok';
        setBusinessData(nextBusinessData);
        setBusinessError('');
      } catch (error) {
        if (stillCurrent()) setBusinessError((error as Error).message);
      }
      try {
        const nextEntitlements = await fetchEntitlements();
        if (!stillCurrent()) return 'ok';
        setEntitlements(nextEntitlements);
      } catch {
        // Preserve the last known entitlement state during a transient
        // foreground refresh failure; server-side gates remain authoritative.
      }
      try {
        const nextLeadSettings = await fetchLeadSettings();
        if (!stillCurrent()) return 'ok';
        setLeadSettings(nextLeadSettings);
      } catch {
        // Keep the last known target and intake link on a transient failure.
      }
      if (activeCaseId) {
        const fileLoad = await loadCaseFile(userId, activeCaseId);
        if (!stillCurrent()) return 'ok';
        setCaseEvents(fileLoad.file.events);
        setCaseDocuments(fileLoad.file.documents);
        setCaseFileSource({ userId, source: fileLoad.source, savedAt: fileLoad.savedAt, truncated: fileLoad.truncated });
      }
      try {
        const nextMembers = await fetchWorkspaceMembers();
        if (!stillCurrent()) return 'ok';
        setMembers(nextMembers);
      } catch {
        // Keep the last known member list.
      }
      await syncDerived(refreshed, caseLoad.list.cases);
      if (stillCurrent()) setRefreshNotice('');
      return 'ok';
    })();
    refreshInFlightRef.current = run;
    try {
      return await run;
    } finally {
      if (refreshInFlightRef.current === run) refreshInFlightRef.current = null;
    }
  }, [session?.user?.id, activeCaseId, applySnapshot, syncDerived]);

  // Pull-to-refresh: always runs, stops the spinner on failure, and reports
  // a lost connection inline instead of with an alert.
  async function pullToRefresh() {
    if (pullRefreshing) return;
    setPullRefreshing(true);
    try {
      const outcome = await refreshFromServer('pull');
      if (outcome === 'offline') setRefreshNotice('No connection — showing saved data.');
    } catch (error) {
      setRefreshNotice(isNetworkError(error) ? 'No connection — showing saved data.' : `Refresh failed: ${(error as Error).message}`);
    } finally {
      setPullRefreshing(false);
    }
  }

  // Flush queued offline writes and refresh when the app returns to the
  // foreground. The workspace check stays unconditional (it is the durable
  // fallback for a membership change made on another device).
  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) return undefined;
    const generation = authGenerationRef.current;
    let active = true;
    const stillCurrent = () => active
      && generation === authGenerationRef.current
      && activeUserIdRef.current === userId;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !stillCurrent()) return;
      (async () => {
        const currentOrgId = await fetchCurrentOrgId();
        if (!stillCurrent()) return;
        if (currentOrgId !== activeOrgIdRef.current) {
          await bindLocalWorkspace(userId, currentOrgId);
          if (!stillCurrent()) return;
          activeOrgIdRef.current = currentOrgId;
          setWorkspaceEpoch((epoch) => epoch + 1);
          return;
        }
        await refreshFromServer('foreground');
      })().catch((error) => {
        // Offline: the header badge already says so and the saved copies stay
        // on screen; alerting on every foreground return would be noise.
        if (stillCurrent() && !isNetworkError(error)) Alert.alert('Sync issue', (error as Error).message);
      });
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [session?.user?.id, refreshFromServer]);

  // Keep the saved offline copies in step with what is on screen. Case writes
  // are online-only, so an in-memory case list or open file that came from the
  // server (and any edit that then landed) is live data worth keeping; a copy
  // that itself came from the cache is never written back.
  useEffect(() => {
    if (!caseListSource || caseListSource.source !== 'remote') return;
    void persistCaseList({ cases, contacts: allCaseContacts }, caseListSource.userId).catch(() => undefined);
  }, [cases, allCaseContacts, caseListSource]);
  useEffect(() => {
    if (!activeCaseId || !caseFileSource || caseFileSource.source !== 'remote') return;
    void persistCaseFile(activeCaseId, { events: caseEvents, documents: caseDocuments }, caseFileSource.userId).catch(() => undefined);
  }, [activeCaseId, caseEvents, caseDocuments, caseFileSource]);

  // Tapping a notification jumps to the relevant tab and, for cadence nudges,
  // opens the named partner once that account's directory has hydrated.
  useEffect(() => {
    if (!session?.user?.id) return undefined;
    return subscribeToNotificationResponses((target, partnerId, caseId) => {
      // Server-sent pushes carry only ids; the item opens once it has loaded.
      if (target === 'case') {
        setTab('home');
        if (caseId) setPendingNotificationCaseId(caseId);
        return;
      }
      if (target === 'workspace') {
        setTab('home');
        setShowWorkspace(true);
        return;
      }
      setTab(target);
      if (partnerId) setPendingNotificationPartnerId(partnerId);
    });
  }, [session?.user?.id]);

  useEffect(() => {
    if (!pendingNotificationCaseId) return;
    if (!cases.some((item) => item.id === pendingNotificationCaseId)) return;
    openCaseById(pendingNotificationCaseId);
    setPendingNotificationCaseId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNotificationCaseId, cases]);

  useEffect(() => {
    if (!pendingNotificationPartnerId) return;
    const partner = partners.find((item) => item.id === pendingNotificationPartnerId);
    if (!partner) return;
    setSelectedPartner(partner);
    setPendingNotificationPartnerId(null);
  }, [pendingNotificationPartnerId, partners]);

  // Virtual cadence snoozes are namespaced by account. A global legacy snooze
  // blob is never imported because it has no trustworthy owner metadata.
  useEffect(() => {
    const userId = session?.user?.id;
    setPartnerSnoozes({});
    if (!userId) return undefined;
    let active = true;
    AsyncStorage.getItem(partnerSnoozeKey(userId))
      .then((raw) => {
        if (!active || !raw) return;
        const parsed = JSON.parse(raw) as Record<string, string>;
        setPartnerSnoozes(prunePartnerSnoozes(parsed, new Date()));
      })
      .catch((error) => {
        if (active) Alert.alert('Snoozes unavailable', `Saved snoozes could not be loaded: ${(error as Error).message}`);
      });
    return () => { active = false; };
  }, [session?.user?.id]);

  const totals = useMemo(() => ({
    inbound: partners.reduce((sum, partner) => sum + partner.inbound, 0),
    outbound: partners.reduce((sum, partner) => sum + partner.outbound, 0),
    active: partners.filter((partner) => partner.inbound + partner.outbound > 0).length,
  }), [partners]);

  // Most recent referral date per partner, either direction, for the neutral
  // activity line on cards and profiles.
  const lastReferralByPartner = useMemo(() => {
    const latest: Record<string, string> = {};
    for (const referral of referrals) {
      if (!latest[referral.partnerId] || referral.date > latest[referral.partnerId]) latest[referral.partnerId] = referral.date;
    }
    return latest;
  }, [referrals]);

  const directoryPartners = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return partners
      .filter((partner) => directoryType === 'All' || typesForPartner(partner).includes(directoryType as Partner['type']))
      .filter((partner) => !needle || `${partner.name} ${partner.organization} ${partner.city} ${partner.state} ${partnerTypeLabel(partner)} ${partner.therapies.join(' ')}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || a.organization.localeCompare(b.organization));
  }, [partners, directoryType, search]);

  const insuranceOptions = useMemo(() => insuranceProvidersForState(matchState), [matchState]);

  const insuranceDropdownOptions = useMemo(() => {
    const stateName = stateOptions.find((state) => state.code === matchState)?.name;
    return insuranceOptions.map((provider) => {
      let detail: string | undefined;
      if (provider !== 'Cash pay' && matchState === 'ANY' && nationalInsuranceProviders.includes(provider)) {
        detail = 'Major national provider';
      } else if (provider !== 'Cash pay' && matchState !== 'ANY' && medicaidPlansByState[matchState]?.includes(provider)) {
        detail = `Medicaid program or plan in ${stateName}`;
      } else if (provider !== 'Cash pay' && matchState !== 'ANY' && regionalInsuranceByState[matchState]?.includes(provider)) {
        detail = `Regional commercial plan in ${stateName}`;
      } else if (provider !== 'Cash pay' && nationalInsuranceProviders.includes(provider)) {
        detail = 'Major national provider';
      }
      return { label: provider, value: provider, detail };
    });
  }, [insuranceOptions, matchState]);

  const partnerInsuranceOptions = useMemo(() => {
    const stateCode = partnerForm.state.trim().toUpperCase();
    const validState = stateOptions.some((state) => state.code === stateCode);
    const plansForState = insuranceProvidersForState(validState ? stateCode : 'ANY').filter((plan) => plan !== 'Cash pay');
    return Array.from(new Set([...plansForState, ...partnerForm.insurance.filter((plan) => plan !== 'Cash pay')]));
  }, [partnerForm.state, partnerForm.insurance]);

  const orgProfileInsuranceOptions = useMemo(() => {
    const stateCode = orgProfileForm.state.trim().toUpperCase();
    const validState = stateOptions.some((state) => state.code === stateCode);
    const plansForState = insuranceProvidersForState(validState ? stateCode : 'ANY').filter((plan) => plan !== 'Cash pay');
    return Array.from(new Set([...plansForState, ...orgProfileForm.insurance.filter((plan) => plan !== 'Cash pay')]));
  }, [orgProfileForm.state, orgProfileForm.insurance]);

  // The criteria as they stand in the form, in the shape the ranker and the
  // packet read. A profile that is not saved yet ranks under a fixed draft
  // id, so its tie rotation is stable while the clinician edits.
  const draftMatchProfile = useMemo((): ReferralMatch => ({
    id: selectedMatchId || 'draft',
    clientLabel: matchClientLabel,
    levelOfCare: matchType as ReferralMatch['levelOfCare'],
    state: matchState,
    insurance: matchInsurance,
    networkPreferences: matchNetworkPreferences,
    maxBudget: matchInsurance === 'Cash pay' && matchBudget.trim() ? Number(matchBudget) || undefined : undefined,
    therapies: matchTherapies,
    mustHaveTherapies: matchMustHave,
    population: matchPopulation,
    locationPreference: matchLocationPreference,
    status: 'Matching',
    createdAt: '',
    updatedAt: '',
  }), [selectedMatchId, matchClientLabel, matchType, matchState, matchInsurance, matchNetworkPreferences, matchBudget, matchTherapies, matchMustHave, matchPopulation, matchLocationPreference]);

  // Live bed counts for partners linked to a directory listing, read from
  // the listing itself (fetch_listing_beds). Refreshed when the set of linked
  // partners changes or the clinician turns the bed filter on. Offline, or on
  // a server without the migration, every count is simply unknown.
  const linkedListingIds = useMemo(
    () => Array.from(new Set(partners.map((partner) => partner.globalPartnerId).filter((id): id is string => Boolean(id)))).sort().join(','),
    [partners],
  );
  useEffect(() => {
    if (!session?.user?.id || !linkedListingIds) { setListingBeds({}); return undefined; }
    let active = true;
    fetchListingBeds(linkedListingIds.split(','))
      .then((next) => { if (active) setListingBeds(Object.fromEntries(next)); })
      .catch(() => { /* unknown counts never hide a program */ });
    return () => { active = false; };
  }, [session?.user?.id, linkedListingIds, bedFilterOn]);

  const bedOptions = useMemo((): BedOptions => ({ bedFor: bedFilterOn ? bedFor : null, beds: listingBeds }), [bedFilterOn, bedFor, listingBeds]);

  function bedLineForPartner(partner: Partner): string {
    return partner.globalPartnerId ? bedsLine(listingBeds[partner.globalPartnerId]) : '';
  }

  // Hard requirements hide, the 0-100 score orders, cost then a seeded
  // rotation breaks ties (src/lib/matching.ts). Referral counts are not an
  // input: the ranker never reads inbound/outbound. With the bed filter on, a
  // confirmed 0 hides; an unknown count sorts below a confirmed open bed.
  const matches = useMemo(
    () => rankPrograms(draftMatchProfile, partners, scorecards, bedOptions),
    [draftMatchProfile, partners, scorecards, bedOptions],
  );

  const sortedReferrals = referrals
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));

  const recentReferrals = sortedReferrals.slice(0, 5);

  const filteredReferrals = useMemo(() => {
    const needle = referralSearch.trim().toLowerCase();
    return sortedReferrals.filter((referral) => {
      if (referralDirectionFilter !== 'All' && referral.direction !== referralDirectionFilter) return false;
      const partner = partners.find((item) => item.id === referral.partnerId);
      return !needle || [
        referral.clientLabel,
        referral.outcome,
        referral.note,
        partner?.name,
        partner?.organization,
      ].filter(Boolean).join(' ').toLowerCase().includes(needle);
    });
  }, [sortedReferrals, referralSearch, referralDirectionFilter, partners]);

  const activeReferralMatches = referralMatches.filter((item) => item.status === 'Matching' || item.status === 'Referred');

  function loadReferralMatch(referralMatch: ReferralMatch) {
    setSelectedMatchId(referralMatch.id);
    setMatchClientLabel(referralMatch.clientLabel);
    setMatchType(referralMatch.levelOfCare);
    setMatchState(referralMatch.state);
    setMatchInsurance(referralMatch.insurance);
    setMatchNetworkPreferences(referralMatch.networkPreferences?.length ? referralMatch.networkPreferences : ['In-network']);
    setMatchBudget(referralMatch.maxBudget ? String(referralMatch.maxBudget) : '');
    setMatchTherapies(referralMatch.therapies);
    setMatchMustHave(referralMatch.mustHaveTherapies ?? defaultMustHaveNeeds(referralMatch.therapies));
    setMatchPopulation(referralMatch.population || 'Any');
    setMatchLocationPreference(referralMatch.locationPreference || 'No preference');
  }

  // Needs and must-haves move together: a need that leaves the selection
  // leaves the must-have list, and a newly selected MAT starts as must-have.
  function updateMatchTherapies(next: string[]) {
    setMatchMustHave((current) => [
      ...current.filter((need) => next.includes(need)),
      ...defaultMustHaveNeeds(next.filter((need) => !matchTherapies.includes(need) && !current.includes(need))),
    ]);
    setMatchTherapies(next);
  }

  function toggleMustHave(need: string) {
    setMatchMustHave((current) => (current.includes(need) ? current.filter((item) => item !== need) : [...current, need]));
  }

  function toggleMatchNetworkPreference(preference: InsuranceNetworkPreference) {
    setMatchNetworkPreferences((current) => {
      if (!current.includes(preference)) return [...current, preference];
      if (current.length === 1) return current;
      return current.filter((item) => item !== preference);
    });
  }

  function startNewReferralMatch() {
    setSelectedMatchId(null);
    setMatchClientLabel('');
    setMatchType('Any type');
    setMatchState('ANY');
    setMatchInsurance('Cash pay');
    setMatchNetworkPreferences(['In-network']);
    setMatchBudget('');
    setMatchTherapies([]);
    setMatchMustHave([]);
    setMatchPopulation('Any');
    setMatchLocationPreference('No preference');
    requestAnimationFrame(() => matchClientLabelRef.current?.focus());
  }

  function removeReferralMatch(item: ReferralMatch) {
    Alert.alert(
      'Remove from active matches?',
      `This removes ${item.clientLabel}'s saved matching criteria. Existing case and referral records will not be deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            if (!mutationSlotAvailable('The match removal')) return;
            const previousMatches = referralMatches;
            const previousCases = cases;
            const previousReferrals = referrals;
            const previousSelectedMatchId = selectedMatchId;
            const nextMatches = previousMatches.filter((match) => match.id !== item.id);
            const nextCases = previousCases.map((record) => record.matchProfileId === item.id ? { ...record, matchProfileId: undefined } : record);
            const nextReferrals = previousReferrals.map((referral) => referral.matchProfileId === item.id ? { ...referral, matchProfileId: undefined } : referral);
            const nextActive = nextMatches.find((match) => match.status === 'Matching' || match.status === 'Referred');
            setReferralMatches(nextMatches);
            setCases(nextCases);
            setReferrals(nextReferrals);
            if (selectedMatchId === item.id) {
              if (nextActive) loadReferralMatch(nextActive);
              else startNewReferralMatch();
            }
            void settleOptimisticWrite(
              () => deleteMatchProfile(item.id, activeUserId),
              { partners, referrals: nextReferrals, referralMatches: nextMatches, touches, followUps, scorecards },
              { partners, referrals: previousReferrals, referralMatches: previousMatches, touches, followUps, scorecards },
              () => {
                setReferralMatches(previousMatches);
                setCases(previousCases);
                setReferrals(previousReferrals);
                setSelectedMatchId(previousSelectedMatchId);
                if (previousSelectedMatchId === item.id) loadReferralMatch(item);
              },
              'The match removal',
            );
          },
        },
      ],
    );
  }

  async function saveCurrentReferralMatch(): Promise<ReferralMatch | null> {
    if (!matchClientLabel.trim()) {
      Alert.alert('Name this match', 'Add a private client or family label so you can return to it later.');
      return null;
    }
    if (!mutationSlotAvailable('The match')) return null;
    const existing = referralMatches.find((item) => item.id === selectedMatchId);
    const now = new Date().toISOString();
    // A match started from a case file (Find placement) inherits its case.
    const linkedCaseId = pendingCaseMatchId || existing?.caseId;
    const referralMatch: ReferralMatch = {
      id: existing?.id || makeId('m'),
      clientLabel: matchClientLabel.trim(),
      levelOfCare: matchType as ReferralMatch['levelOfCare'],
      state: matchState,
      insurance: matchInsurance,
      networkPreferences: matchNetworkPreferences,
      maxBudget: matchInsurance === 'Cash pay' && matchBudget.trim() ? Number(matchBudget) || undefined : undefined,
      therapies: matchTherapies,
      mustHaveTherapies: matchMustHave.filter((need) => matchTherapies.includes(need)),
      population: matchPopulation,
      locationPreference: matchLocationPreference,
      status: existing?.status || 'Matching',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      assignedPartnerId: existing?.assignedPartnerId,
      referralId: existing?.referralId,
      caseId: linkedCaseId || undefined,
    };
    const previousMatches = referralMatches;
    const previousCases = cases;
    const previousSelectedMatchId = selectedMatchId;
    const previousPendingCaseMatchId = pendingCaseMatchId;
    const nextMatches = [referralMatch, ...previousMatches.filter((item) => item.id !== referralMatch.id)];
    const nextCases = linkedCaseId
      ? previousCases.map((item) => item.id === linkedCaseId ? { ...item, matchProfileId: referralMatch.id, updatedAt: now } : item)
      : previousCases;
    setReferralMatches(nextMatches);
    setCases(nextCases);
    setSelectedMatchId(referralMatch.id);
    setPendingCaseMatchId(null);
    const saved = await settleOptimisticWrite(
      () => linkedCaseId
        ? saveMatchWithCase(referralMatch, linkedCaseId, activeUserId)
        : (existing ? updateMatchProfile(referralMatch, activeUserId) : createMatchProfile(referralMatch, activeUserId)),
      { partners, referrals, referralMatches: nextMatches, touches, followUps, scorecards },
      { partners, referrals, referralMatches: previousMatches, touches, followUps, scorecards },
      () => {
        setReferralMatches(previousMatches);
        setCases(previousCases);
        setSelectedMatchId(previousSelectedMatchId);
        setPendingCaseMatchId(previousPendingCaseMatchId);
      },
      'The match',
    );
    return saved ? referralMatch : null;
  }

  async function openMatchedReferral(partnerId: string) {
    const referralMatch = await saveCurrentReferralMatch();
    if (!referralMatch) return;
    setPendingPlacement({ matchProfileId: referralMatch.id, rankedIds: matches.map((item) => item.partner.id), candidates: placementCandidates(matches) });
    setPlacementReason(null);
    setPlacementReasonNote('');
    setActiveReferralMatchId(referralMatch.id);
    setReferralForm({
      ...emptyReferral,
      direction: 'Outbound',
      partnerId,
      clientLabel: referralMatch.clientLabel,
      outcome: 'Introduced',
    });
    setSelectedPartner(null);
    setShowAddReferral(true);
  }

  function openReferral(direction: ReferralDirection, partnerId?: string) {
    if (!partners.length) {
      Alert.alert('Add a partner first', 'Create the person or program in your Directory before logging a referral.');
      setTab('directory');
      return;
    }
    setActiveReferralMatchId(null);
    setReferralForm({ ...emptyReferral, direction, partnerId: partnerId || partners[0]?.id || '' });
    setSelectedPartner(null);
    setShowAddReferral(true);
  }

  // ─── Match Packet ───────────────────────────────────────────────────────

  // Save the match profile as it currently stands (or reuse the saved one),
  // so the packet always reflects the same criteria the matcher used.
  async function currentOrSavedMatch(): Promise<ReferralMatch | null> {
    return saveCurrentReferralMatch();
  }

  // The packet's "why this fits" comes from the same scoring the ranker ran
  // (src/lib/matching.ts scoreProgram), so the two can never disagree.
  function fitInputForMatch(matchProfile: ReferralMatch, partner: Partner): PacketFitInput {
    const score = scoreProgram(matchProfile, partner, scorecards[partner.id], trackRecordPrior(scorecards));
    return packetFitInput(score, matchProfile);
  }

  // A program with a disclosed financial relationship needs one more tap
  // before it is assigned, in either flow. The wording is plain on purpose.
  function confirmDisclosedRelationship(partner: Partner, proceed: () => void) {
    if (!hasFinancialRelationship(partner)) {
      proceed();
      return;
    }
    Alert.alert(
      'Disclosed relationship',
      `${partner.organization} has a disclosed financial relationship with your practice (${financialRelationshipLabel(partner.financialRelationship).toLowerCase()}). It did not affect the ranking, and the family packet will say so. Continue with this program?`,
      [
        { text: 'Go back', style: 'cancel' },
        { text: 'Continue', onPress: proceed },
      ],
    );
  }

  // From a recommended match card: the profile only gets assigned (status →
  // Referred) if the packet is actually sent. The shortlist is captured now,
  // while the card order the clinician saw is still on screen.
  async function openPacketComposer(partner: Partner, score: ProgramScore) {
    const matchProfile = await currentOrSavedMatch();
    if (!matchProfile) return;
    setPendingPlacement({ matchProfileId: matchProfile.id, rankedIds: matches.map((item) => item.partner.id), candidates: placementCandidates(matches) });
    setPlacementReason(null);
    setPlacementReasonNote('');
    const reasons = buildFitReasons(matchProfile, partner, packetFitInput(score, matchProfile));
    setPacketTarget({ partner, match: matchProfile, assignOnSend: true });
    setPacketAudience('family');
    setPacketText(buildPacket(matchProfile, partner, reasons, 'family'));
    setSelectedPartner(null);
  }

  // From a Referred profile (assigned partner): the assignment already
  // exists, so sending only logs the packet + follow-up on that referral.
  function openPacketForAssigned(matchProfile: ReferralMatch) {
    const partner = partners.find((item) => item.id === matchProfile.assignedPartnerId);
    if (!partner) return;
    const reasons = buildFitReasons(matchProfile, partner, fitInputForMatch(matchProfile, partner));
    setPacketTarget({ partner, match: matchProfile, assignOnSend: false });
    setPacketAudience('family');
    setPacketText(buildPacket(matchProfile, partner, reasons, 'family'));
  }

  // Regenerate the editable text when the audience toggle flips. Edits made
  // in the textarea are replaced — same behavior as re-tapping a template.
  function switchPacketAudience(audience: PacketAudience) {
    if (!packetTarget) return;
    setPacketAudience(audience);
    const fitInput = fitInputForMatch(packetTarget.match, packetTarget.partner);
    setPacketText(buildPacket(packetTarget.match, packetTarget.partner, buildFitReasons(packetTarget.match, packetTarget.partner, fitInput), audience));
  }

  // The placement record for an assignment made from a match: what was
  // shown, what was picked, at what rank, and why when it was not the top.
  function buildPlacementDecision(matchProfile: ReferralMatch, partner: Partner, referralId: string, now: Date): PlacementDecision | null {
    const placement = pendingPlacement && pendingPlacement.matchProfileId === matchProfile.id
      ? pendingPlacement
      : { matchProfileId: matchProfile.id, rankedIds: matches.map((item) => item.partner.id), candidates: placementCandidates(matches) };
    const rank = rankOfPartner(placement.rankedIds.map((id) => ({ partner: { id } })), partner.id);
    if (rank > 1 && !placementReason) return null;
    return {
      id: makeId('pd'),
      matchProfileId: matchProfile.id,
      caseId: matchProfile.caseId,
      referralId,
      chosenPartnerId: partner.id,
      chosenRank: rank,
      reason: rank > 1 ? placementReason || undefined : undefined,
      reasonNote: rank > 1 ? placementReasonNote.trim() : '',
      candidates: placement.candidates,
      weights: scoringWeights(),
      decidedAt: now.toISOString(),
    };
  }

  function placementRankFor(matchProfileId: string, partnerId: string): number {
    const placement = pendingPlacement && pendingPlacement.matchProfileId === matchProfileId ? pendingPlacement : null;
    const rankedIds = placement ? placement.rankedIds : matches.map((item) => item.partner.id);
    return rankOfPartner(rankedIds.map((id) => ({ partner: { id } })), partnerId);
  }

  function clearPendingPlacement() {
    setPendingPlacement(null);
    setPlacementReason(null);
    setPlacementReasonNote('');
  }

  async function sharePacketText() {
    if (!packetTarget) return;
    try {
      const result = await Share.share({
        title: `Placement recommendation — ${packetTarget.match.clientLabel}`,
        message: packetText,
      });
      // Honest platform note: on iOS, UIActivityViewController does not
      // reliably distinguish "shared" from "dismissed" — dismissing the sheet
      // can resolve with activityType null and no error, and some share
      // extensions report success before the user confirms. Rather than guess,
      // we always ask the one-tap confirm before running post-send automation.
      if (result.action === Share.sharedAction || result.action === Share.dismissedAction) {
        setPacketSendConfirm(true);
      }
    } catch {
      Alert.alert('Unable to share', 'The share sheet could not be opened. Please try again.');
    }
  }

  function closePacketComposer() {
    setPacketTarget(null);
    setPacketSendConfirm(false);
    setPacketAudience('family');
    clearPendingPlacement();
  }

  // Post-send automation ("the loop"): referral + touch + follow-up, all
  // through the sync data layer so they queue offline like everything else.
  // If the profile wasn't assigned yet, this runs the SAME assignment code
  // path as the manual "Assign & refer" flow (assignMatchReferral: referral
  // insert first, then the match profile update) — not a duplicate of it.
  function finalizePacketSend(disclosureConfirmed = false) {
    if (!packetTarget) return;
    // Assigning from a packet: a pick below the top needs a reason, and a
    // program with a disclosed relationship needs one more tap.
    if (packetTarget.assignOnSend) {
      if (placementRankFor(packetTarget.match.id, packetTarget.partner.id) > 1 && !placementReason) {
        Alert.alert('One more thing', 'This program was not the top match. Choose the reason so the placement record is complete.');
        return;
      }
      if (!disclosureConfirmed && hasFinancialRelationship(packetTarget.partner)) {
        confirmDisclosedRelationship(packetTarget.partner, () => finalizePacketSend(true));
        return;
      }
    }
    if (!mutationSlotAvailable('The packet log')) return;
    const previousMatchUi = {
      selectedMatchId, matchClientLabel, matchType, matchInsurance,
      matchNetworkPreferences, matchState, matchBudget, matchTherapies,
      matchMustHave, matchPopulation, matchLocationPreference,
      tab, packetTarget, packetSendConfirm, packetAudience, packetText,
    };
    const { partner, match, assignOnSend } = packetTarget;
    const now = new Date();
    const todayStamp = localDateStamp();
    // A packet sent on a case-linked profile links everything it creates.
    const caseId = match.caseId;
    let nextMatches = referralMatches;
    let referral: Referral | null = null;
    let assignedMatch: ReferralMatch | null = null;

    if (assignOnSend) {
      // New outbound referral linked to the profile, packet fields set.
      referral = {
        id: makeId('r'),
        partnerId: partner.id,
        direction: 'Outbound',
        date: todayStamp,
        clientLabel: match.clientLabel,
        outcome: 'Introduced',
        note: 'Match packet sent',
        packetSentAt: now.toISOString(),
        matchProfileId: match.id,
        caseId,
      };
      assignedMatch = {
        ...match,
        status: 'Referred',
        assignedPartnerId: partner.id,
        referralId: referral.id,
        updatedAt: now.toISOString(),
      };
      nextMatches = referralMatches.map((item) => (item.id === match.id ? (assignedMatch as ReferralMatch) : item));
      setReferralMatches(nextMatches);
      if (selectedMatchId === match.id) {
        const nextActive = referralMatches.find((item) => item.status === 'Matching' && item.id !== match.id);
        if (nextActive) loadReferralMatch(nextActive);
        else startNewReferralMatch();
      }
    } else if (match.referralId) {
      // Already assigned: stamp the packet fields onto the existing referral.
      referral = referrals.find((item) => item.id === match.referralId) || null;
      if (referral) {
        referral = { ...referral, packetSentAt: now.toISOString(), matchProfileId: referral.matchProfileId || match.id, caseId: referral.caseId || caseId };
      }
    }
    if (!referral) {
      closePacketComposer();
      return;
    }
    const referralId = referral.id;

    const touch: Touch = {
      id: makeId('t'),
      partnerId: partner.id,
      kind: 'text',
      note: 'Sent match packet',
      occurredAt: now.toISOString(),
    };
    const followUp: FollowUp = {
      id: makeId('f'),
      partnerId: partner.id,
      referralId,
      caseId,
      title: 'Check in — did they admit?',
      dueOn: addDaysStamp(3),
      status: 'open',
      note: '',
    };

    const nextReferrals = [referral, ...referrals.filter((item) => item.id !== referralId)];
    const nextTouches = [touch, ...touches];
    const nextFollowUps = [followUp, ...followUps];
    // Activity-count + last-contact optimistic bumps mirror addReferral/saveTouch;
    // the server (counts view, touches trigger) stays canonical. These counts
    // are shown as activity only; the ranker never reads them.
    const nextPartners = partners.map((item) => item.id === partner.id
      ? {
          ...item,
          outbound: item.outbound + (assignOnSend ? 1 : 0),
          lastContact: todayStamp,
        }
      : item);
    setReferrals(nextReferrals);
    setTouches(nextTouches);
    setFollowUps(nextFollowUps);
    setPartners(nextPartners);
    closePacketComposer();

    const previousSnapshot: Snapshot = { partners, referrals, referralMatches, touches, followUps, scorecards };
    const snapshot: Snapshot = { partners: nextPartners, referrals: nextReferrals, referralMatches: nextMatches, touches: nextTouches, followUps: nextFollowUps, scorecards };
    let packetEvent: CaseEvent | null = null;
    if (caseId) {
      const eventId = makeId('e');
      packetEvent = {
        id: eventId,
        caseId,
        kind: 'referral',
        body: `Sent packet to ${partner.organization}`,
        referralId,
        occurredAt: now.toISOString(),
      };
      applyCaseEvent(packetEvent);
    }

    // The placement record is written after the assignment it describes.
    const decision = assignOnSend && assignedMatch ? buildPlacementDecision(assignedMatch, partner, referralId, now) : null;
    void settleOptimisticWrite(
      async () => {
        await finalizeMatchPacket(referral, assignedMatch, touch, followUp, packetEvent, activeUserId);
        if (decision) await recordPlacementDecision(decision, activeUserId);
      },
      snapshot,
      previousSnapshot,
      () => {
        setPartners(partners); setReferrals(referrals); setReferralMatches(referralMatches);
        setTouches(touches); setFollowUps(followUps);
        if (packetEvent) setCaseEvents((current) => current.filter((item) => item.id !== packetEvent?.id));
        setSelectedMatchId(previousMatchUi.selectedMatchId);
        setMatchClientLabel(previousMatchUi.matchClientLabel);
        setMatchType(previousMatchUi.matchType);
        setMatchInsurance(previousMatchUi.matchInsurance);
        setMatchNetworkPreferences(previousMatchUi.matchNetworkPreferences);
        setMatchState(previousMatchUi.matchState);
        setMatchBudget(previousMatchUi.matchBudget);
        setMatchTherapies(previousMatchUi.matchTherapies);
        setMatchMustHave(previousMatchUi.matchMustHave);
        setMatchPopulation(previousMatchUi.matchPopulation);
        setMatchLocationPreference(previousMatchUi.matchLocationPreference);
        setTab(previousMatchUi.tab);
        setPacketTarget(previousMatchUi.packetTarget);
        setPacketSendConfirm(previousMatchUi.packetSendConfirm);
        setPacketAudience(previousMatchUi.packetAudience);
        setPacketText(previousMatchUi.packetText);
      },
      'The packet log',
    ).then((saved) => {
      if (saved) Alert.alert('Packet logged', `Referral logged, touch recorded, and a follow-up was set for ${shortDate(followUp.dueOn)}.`);
    });
  }

  // ─── Case files ─────────────────────────────────────────────────────────
  // Every case mutation: optimistic local update first, then the server
  // write; on failure the local update is rolled back and an alert explains.
  // (Case data is deliberately not queued offline — see src/lib/cases.ts.)

  const activeCase = cases.find((item) => item.id === activeCaseId) || null;

  // Open a case file: refresh the list + contacts and fetch the timeline and
  // documents for just this case (those stay server-side until a file opens).
  // With no signal both fall back to their saved copies; the two loads are
  // independent so a list that cannot refresh never hides a saved timeline.
  function openCase(caseId: string) {
    const userId = activeUserId;
    const generation = ++caseLoadGenerationRef.current;
    const stillCurrent = () => Boolean(userId) && activeUserIdRef.current === userId && caseLoadGenerationRef.current === generation;
    setActiveCaseId(caseId);
    setCaseFileSource(null);
    setTimelineDraft('');
    setTimelineKind('note');
    setDocLabel('');
    loadCaseList(userId)
      .then((load) => {
        if (!stillCurrent()) return;
        setCases(load.list.cases);
        setAllCaseContacts(load.list.contacts);
        setCaseListSource({ userId, source: load.source, savedAt: load.savedAt, truncated: false });
      })
      .catch(() => undefined); // no server and no saved copy: keep the list already on screen
    loadCaseFile(userId, caseId)
      .then((load) => {
        if (!stillCurrent()) return;
        setCaseEvents(load.file.events);
        setCaseDocuments(load.file.documents);
        setCaseFileSource({ userId, source: load.source, savedAt: load.savedAt, truncated: load.truncated });
      })
      .catch(() => {
        if (!stillCurrent()) return;
        setCaseEvents([]);
        setCaseDocuments([]);
        setCaseFileSource({ userId, source: 'unavailable', savedAt: '', truncated: false });
      });
  }

  function closeCase() {
    caseLoadGenerationRef.current += 1;
    setActiveCaseId(null);
    setCaseEvents([]);
    setCaseDocuments([]);
    setCaseFileSource(null);
    setCaseContactForm(null);
    setCaseEditForm(null);
    setCaseBusinessForm(null);
    setCasePaymentForm(null);
    setCaseNextStepCaseId(null);
    setQuickNoteContact(null);
    setDocView(null);
  }

  // Insert or replace an event in the local timeline and reflect the
  // activity on the case's updated_at ordering.
  function applyCaseEvent(event: CaseEvent) {
    setCaseEvents((current) => [event, ...current.filter((item) => item.id !== event.id)]);
    // Mirror the server's first-touch trigger: the first logged call, text,
    // email, or meeting stamps first_touch_at once, which is what takes a
    // lead off NEW LEADS and feeds speed to lead. The next refresh re-reads
    // the authoritative value either way.
    const isTouch = event.kind === 'call' || event.kind === 'text' || event.kind === 'email' || event.kind === 'meeting';
    setCases((current) => current.map((item) => item.id === event.caseId
      ? { ...item, updatedAt: event.occurredAt, firstTouchAt: isTouch && !item.firstTouchAt ? event.occurredAt : item.firstTouchAt }
      : item));
  }

  function failCaseChange(message: string, rollback: () => void) {
    if (message.includes('Account changed before the case operation completed')) return;
    rollback();
    Alert.alert('Case file', message);
  }

  function saveNewCase() {
    if (!caseForm.title.trim()) {
      Alert.alert('Name the case', 'A title is required — the family name and who the case is about works well.');
      return;
    }
    if (!mutationSlotAvailable('The case')) return;
    const now = new Date().toISOString();
    const record: CaseRecord = {
      id: makeId('c'),
      title: caseForm.title.trim(),
      status: caseForm.status,
      summary: caseForm.summary.trim(),
      leadSource: caseForm.leadSource,
      leadSourceDetail: caseForm.leadSourceDetail.trim(),
      lostReason: '',
      stageChangedAt: now,
      paymentStatus: 'none',
      quotedAmount: null,
      paidAmount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const hasPrimaryContact = Boolean(caseForm.contactName.trim() || caseForm.contactPhone.trim() || caseForm.contactEmail.trim());
    const primaryContact: CaseContact | null = hasPrimaryContact ? {
      id: makeId('cc'),
      caseId: record.id,
      name: caseForm.contactName.trim(),
      relationship: caseForm.contactRelationship.trim(),
      phone: caseForm.contactPhone.trim(),
      email: caseForm.contactEmail.trim(),
      isPrimary: true,
      note: '',
    } : null;
    const previous = cases;
    setCases([record, ...cases]);
    setShowNewCase(false);
    setCaseForm(makeEmptyCaseForm());
    let nextFollowUps = followUps;
    let firstCall: FollowUp | null = null;
    if (record.status === 'inquiry') {
      // AUTO-CREATE (v4): a new inquiry is a new lead — the first call goes
      // on today's list automatically. Case-linked, due today.
      firstCall = {
        id: makeId('f'),
        caseId: record.id,
        kind: 'first_call',
        title: `First call — ${record.title}`,
        dueOn: localDateStamp(),
        status: 'open',
        note: '',
      };
      nextFollowUps = [firstCall, ...followUps];
      setFollowUps(nextFollowUps);
    }
    void settleOptimisticWrite(
      () => createCaseBundle(record, primaryContact, firstCall, activeUserId),
      { partners, referrals, referralMatches, touches, followUps: nextFollowUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => {
        setCases(previous);
        setFollowUps(followUps);
      },
      'The case',
      [record, ...previous],
      previous,
    ).then((saved) => { if (saved) openCase(record.id); });
  }

  function changeCaseStatus(record: CaseRecord, status: CaseStatus) {
    if (status === record.status) return;
    if (!mutationSlotAvailable('The case status change')) return;
    const changedAt = new Date().toISOString();
    const updated: CaseRecord = { ...record, status, stageChangedAt: changedAt, updatedAt: changedAt };
    const previous = cases;
    const next = previous.map((item) => (item.id === record.id ? updated : item));
    setCases(next);
    const eventId = makeId('e');
    const event: CaseEvent = {
      id: eventId,
      caseId: record.id,
      kind: 'status_change',
      body: `${record.status} → ${status}`,
      occurredAt: updated.updatedAt,
    };
    applyCaseEvent(event);
    void settleOptimisticWrite(
      () => updateCaseWithEvent(updated, event),
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => {
        setCases(previous);
        setCaseEvents((current) => current.filter((item) => item.id !== eventId));
      },
      'The case status change', next, previous,
    );
  }

  function saveCasePayment(record: CaseRecord, patch: { paymentStatus?: PaymentStatus; quotedAmount?: number | null; paidAmount?: number }) {
    if (!mutationSlotAvailable('The payment change')) return;
    const derivedStatus: PaymentStatus = patch.paymentStatus || (
      patch.paidAmount !== undefined || patch.quotedAmount !== undefined
        ? (() => {
          const paid = patch.paidAmount ?? record.paidAmount;
          const quoted = patch.quotedAmount !== undefined ? patch.quotedAmount : record.quotedAmount;
          if (paid === 0) return quoted == null ? 'none' : 'quoted';
          return quoted != null && paid >= quoted ? 'paid' : 'partial';
        })()
        : record.paymentStatus
    );
    const updated: CaseRecord = { ...record, ...patch, paymentStatus: derivedStatus, updatedAt: new Date().toISOString() };
    const previous = cases;
    const next = previous.map((item) => (item.id === record.id ? updated : item));
    setCases(next);
    const bits: string[] = [];
    if (patch.paymentStatus && patch.paymentStatus !== record.paymentStatus) bits.push(`Payment: ${record.paymentStatus} → ${patch.paymentStatus}`);
    if (patch.quotedAmount !== undefined && patch.quotedAmount !== record.quotedAmount) bits.push(`Quoted ${patch.quotedAmount != null ? formatMoney(patch.quotedAmount) : '—'}`);
    if (patch.paidAmount !== undefined && patch.paidAmount !== record.paidAmount) bits.push(`Paid ${formatMoney(patch.paidAmount)}`);
    const body = bits.join(' · ') || 'Payment updated';
    const eventId = makeId('e');
    const event: CaseEvent = { id: eventId, caseId: record.id, kind: 'payment', body, occurredAt: updated.updatedAt };
    let confirmedPayment: Awaited<ReturnType<typeof updateCasePaymentWithEvent>> | null = null;
    applyCaseEvent(event);
    void settleOptimisticWrite(
      async () => { confirmedPayment = await updateCasePaymentWithEvent(record.id, eventId, patch); },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => {
        setCases(previous);
        setCaseEvents((current) => current.filter((item) => item.id !== eventId));
      },
      'The payment change', next, previous,
    ).then((saved) => {
      if (!saved || !confirmedPayment) return;
      const confirmed = confirmedPayment as Awaited<ReturnType<typeof updateCasePaymentWithEvent>>;
      setCases((current) => current.map((item) => item.id === record.id ? {
        ...item,
        paidAmount: confirmed.paidAmount,
        paymentStatus: confirmed.paymentStatus,
        quotedAmount: confirmed.quotedAmount,
        updatedAt: confirmed.occurredAt,
      } : item));
      setCaseEvents((current) => current.map((item) => item.id === eventId ? {
        ...item,
        body: confirmed.eventBody,
        occurredAt: confirmed.occurredAt,
      } : item));
    });
  }

  function selectCasePaymentStatus(record: CaseRecord, status: PaymentStatus) {
    if (status === record.paymentStatus) return;

    if (status === 'quoted' && record.paidAmount === 0 && record.quotedAmount == null) {
      if (Platform.OS !== 'ios') {
        Alert.alert('Enter the quote first', 'Add the quoted amount. The payment status will change to quoted automatically.');
        return;
      }
      Alert.prompt(
        'Enter quoted amount',
        'A case can only be marked quoted when it has a quote. Enter the whole-dollar amount and both will be saved together.',
        (value) => {
          if (value == null || value.trim() === '') return;
          const normalized = value.trim();
          if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(normalized)) {
            Alert.alert('Enter a valid quote', 'Use a positive whole-dollar amount, such as 7500 or $7,500.');
            return;
          }
          const quotedAmount = Number(normalized.replace(/[$,]/g, ''));
          if (!Number.isSafeInteger(quotedAmount) || quotedAmount <= 0 || quotedAmount > 10000000) {
            Alert.alert('Enter a valid quote', 'The quote must be between $1 and $10,000,000.');
            return;
          }
          saveCasePayment(record, { paymentStatus: 'quoted', quotedAmount });
        },
        'plain-text',
        '',
        'number-pad',
      );
      return;
    }

    if (status === 'quoted' && record.paidAmount > 0) {
      Alert.alert('Payment already recorded', 'Quoted status requires a zero paid total. Correct the paid amount first, or keep the current payment status.');
      return;
    }
    if (status === 'none' && (record.paidAmount > 0 || record.quotedAmount != null)) {
      Alert.alert('Clear payment amounts first', 'None requires both the quoted amount and paid total to be empty or zero.');
      return;
    }
    if ((status === 'deposit' || status === 'partial') && record.paidAmount <= 0) {
      Alert.alert('Record a payment first', 'Deposit and partial statuses require a paid amount greater than zero.');
      return;
    }
    if (status === 'partial' && record.quotedAmount != null && record.paidAmount >= record.quotedAmount) {
      Alert.alert('Already fully paid', 'The paid total meets or exceeds the quote, so this case cannot be marked partial.');
      return;
    }
    if (status === 'paid' && (record.paidAmount <= 0 || (record.quotedAmount != null && record.paidAmount < record.quotedAmount))) {
      Alert.alert('Paid total is too low', 'Paid status requires a positive paid total that meets or exceeds the quote.');
      return;
    }

    saveCasePayment(record, { paymentStatus: status });
  }

  function saveCaseSummary(record: CaseRecord, summary: string) {
    if (!mutationSlotAvailable('The case summary')) return;
    const updated: CaseRecord = { ...record, summary: summary.trim(), updatedAt: new Date().toISOString() };
    const previous = cases;
    const next = previous.map((item) => (item.id === record.id ? updated : item));
    setCases(next);
    void settleOptimisticWrite(
      () => updateCase(updated),
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => setCases(previous),
      'The case summary', next, previous,
    );
  }

  function saveCaseDetails() {
    if (!activeCase || !caseEditForm) return;
    const title = caseEditForm.title.trim();
    const summary = caseEditForm.summary.trim();
    if (!title) {
      Alert.alert('Name the case', 'A case name is required.');
      return;
    }
    if (title === activeCase.title && summary === activeCase.summary) {
      setCaseEditForm(null);
      return;
    }
    if (!mutationSlotAvailable('The case details')) return;
    const detailsPatch: { title?: string; summary?: string } = {};
    if (title !== activeCase.title) detailsPatch.title = title;
    if (summary !== activeCase.summary) detailsPatch.summary = summary;
    const updated: CaseRecord = { ...activeCase, ...detailsPatch, updatedAt: new Date().toISOString() };
    const previous = cases;
    const next = previous.map((item) => (item.id === activeCase.id ? updated : item));
    const changes: string[] = [];
    if (detailsPatch.title !== undefined) changes.push(`Case name: ${activeCase.title} → ${title}`);
    if (detailsPatch.summary !== undefined) changes.push('Summary updated');
    const event: CaseEvent = {
      id: makeId('e'),
      caseId: activeCase.id,
      kind: 'system',
      body: changes.join(' · '),
      occurredAt: updated.updatedAt,
    };
    let confirmedDetails: Awaited<ReturnType<typeof updateCaseDetailsWithEvent>> | null = null;
    setCases(next);
    setCaseEditForm(null);
    applyCaseEvent(event);
    void settleOptimisticWrite(
      async () => {
        confirmedDetails = await updateCaseDetailsWithEvent(activeCase.id, event.id, detailsPatch, event.body);
      },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => {
        setCases(previous);
        setCaseEvents((current) => current.filter((item) => item.id !== event.id));
      },
      'The case details', next, previous,
    ).then((saved) => {
      if (!saved || !confirmedDetails) return;
      const confirmed = confirmedDetails as Awaited<ReturnType<typeof updateCaseDetailsWithEvent>>;
      setCases((current) => current.map((item) => item.id === activeCase.id ? {
        ...item,
        ...(detailsPatch.title !== undefined ? { title: confirmed.title } : {}),
        ...(detailsPatch.summary !== undefined ? { summary: confirmed.summary } : {}),
        updatedAt: confirmed.occurredAt,
      } : item));
      setCaseEvents((current) => current.map((item) => item.id === event.id ? {
        ...item,
        body: confirmed.eventBody,
        occurredAt: confirmed.occurredAt,
      } : item));
    });
  }

  function saveCaseBusinessDetails() {
    if (!activeCase || !caseBusinessForm) return;
    const leadSource = caseBusinessForm.leadSource.trim() || 'Unspecified';
    const leadSourceDetail = caseBusinessForm.leadSourceDetail.trim();
    const lostReason = caseBusinessForm.lostReason.trim();
    if (leadSource === activeCase.leadSource
      && leadSourceDetail === activeCase.leadSourceDetail
      && lostReason === activeCase.lostReason) {
      setCaseBusinessForm(null);
      return;
    }
    if (!mutationSlotAvailable('The case business details')) return;
    const updatedAt = new Date().toISOString();
    const updated: CaseRecord = { ...activeCase, leadSource, leadSourceDetail, lostReason, updatedAt };
    const previous = cases;
    const next = previous.map((item) => item.id === activeCase.id ? updated : item);
    const changes: string[] = [];
    if (leadSource !== activeCase.leadSource) changes.push(`Lead source: ${activeCase.leadSource} → ${leadSource}`);
    if (leadSourceDetail !== activeCase.leadSourceDetail) changes.push('Lead-source detail updated');
    if (lostReason !== activeCase.lostReason) changes.push(lostReason ? 'Lost reason updated' : 'Lost reason cleared');
    const event: CaseEvent = {
      id: makeId('e'),
      caseId: activeCase.id,
      kind: 'system',
      body: changes.join(' · ') || 'Business details updated',
      occurredAt: updatedAt,
    };
    let confirmed: Awaited<ReturnType<typeof updateCaseBusinessDetailsWithEvent>> | null = null;
    setCases(next);
    setCaseBusinessForm(null);
    applyCaseEvent(event);
    void settleOptimisticWrite(
      async () => {
        confirmed = await updateCaseBusinessDetailsWithEvent(activeCase.id, event.id, {
          leadSource,
          leadSourceDetail,
          lostReason,
        }, event.body);
      },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => {
        setCases(previous);
        setCaseEvents((current) => current.filter((item) => item.id !== event.id));
      },
      'The case business details', next, previous,
    ).then((saved) => {
      if (!saved || !confirmed) return;
      const result = confirmed as Awaited<ReturnType<typeof updateCaseBusinessDetailsWithEvent>>;
      setCases((current) => current.map((item) => item.id === activeCase.id ? {
        ...item,
        leadSource: result.leadSource,
        leadSourceDetail: result.leadSourceDetail,
        lostReason: result.lostReason,
        updatedAt: result.occurredAt,
      } : item));
      setCaseEvents((current) => current.map((item) => item.id === event.id ? {
        ...item,
        body: result.eventBody,
        occurredAt: result.occurredAt,
      } : item));
      void refreshBusiness();
    });
  }

  function addCasePayment() {
    if (!activeCase || !casePaymentForm) return;
    const paymentForm = casePaymentForm;
    const rawAmount = casePaymentForm.amount.replace(/[^\d]/g, '');
    const amount = rawAmount ? Number(rawAmount) : 0;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10000000) {
      Alert.alert('Enter a payment', 'Add the amount received in whole dollars, up to $10,000,000.');
      return;
    }
    if (!mutationSlotAvailable('The additional payment')) return;
    const paidAmount = activeCase.paidAmount + amount;
    const paymentStatus: PaymentStatus = activeCase.quotedAmount != null && paidAmount >= activeCase.quotedAmount ? 'paid' : 'partial';
    const updated: CaseRecord = { ...activeCase, paidAmount, paymentStatus, updatedAt: new Date().toISOString() };
    const note = paymentForm.note.trim();
    const event: CaseEvent = {
      id: paymentForm.eventId,
      caseId: activeCase.id,
      kind: 'payment',
      body: `Payment received: ${formatMoney(amount)}${note ? ` · ${note}` : ''} · Total paid: ${formatMoney(paidAmount)}`,
      occurredAt: updated.updatedAt,
    };
    const previous = cases;
    const next = previous.map((item) => (item.id === activeCase.id ? updated : item));
    let confirmedPayment: Awaited<ReturnType<typeof recordCasePayment>> | null = null;
    setCases(next);
    setCasePaymentForm(null);
    applyCaseEvent(event);
    void settleOptimisticWrite(
      async () => { confirmedPayment = await recordCasePayment(activeCase.id, event.id, amount, note); },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => {
        setCases(previous);
        setCasePaymentForm(paymentForm);
        setCaseEvents((current) => current.filter((item) => item.id !== event.id));
      },
      'The additional payment', next, previous,
    ).then((saved) => {
      if (!saved || !confirmedPayment) return;
      const confirmed = confirmedPayment as Awaited<ReturnType<typeof recordCasePayment>>;
      setCases((current) => current.map((item) => item.id === activeCase.id ? {
        ...item,
        paidAmount: confirmed.paidAmount,
        paymentStatus: confirmed.paymentStatus,
        updatedAt: confirmed.occurredAt,
      } : item));
      setCaseEvents((current) => current.map((item) => item.id === event.id ? {
        ...item,
        body: confirmed.eventBody,
        occurredAt: confirmed.occurredAt,
      } : item));
    });
  }

  function saveCaseContact() {
    if (!caseContactForm || !activeCase) return;
    if (!caseContactForm.name.trim()) {
      Alert.alert('Name the contact', 'Add at least a name so you know who this is later.');
      return;
    }
    if (!mutationSlotAvailable('The case contact')) return;
    const form = caseContactForm;
    const existing = caseContacts.find((item) => item.id === form.id) || null;
    const contact: CaseContact = {
      id: form.id || makeId('cc'),
      caseId: activeCase.id,
      name: form.name.trim(),
      relationship: form.relationship.trim(),
      phone: form.phone.trim(),
      email: form.email.trim(),
      note: form.note.trim(),
      isPrimary: form.isPrimary || (!existing && caseContacts.length === 0),
    };
    // Exactly one primary: the RPC demotes the old primary and upserts this
    // contact in one transaction; the same result is mirrored optimistically.
    const previousContacts = caseContacts;
    const baseContacts = contact.isPrimary
      ? caseContacts.map((item) => ({ ...item, isPrimary: false }))
      : caseContacts;
    const nextContacts = existing
      ? baseContacts.map((item) => item.id === contact.id ? contact : item)
      : [...baseContacts, contact];
    setCaseContacts(activeCase.id, nextContacts);
    setCaseContactForm(null);
    void settleOptimisticWrite(
      () => saveContactAtomic(contact),
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => setCaseContacts(activeCase.id, previousContacts),
      'The case contact', cases, cases,
    );
  }

  function removeCaseContact(contact: CaseContact) {
    Alert.alert('Remove contact?', `${contact.name} will be removed from this case file.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => {
        if (!mutationSlotAvailable('The contact removal')) return;
        const previousContacts = caseContacts;
        const nextContacts = caseContacts.filter((item) => item.id !== contact.id);
        setCaseContacts(contact.caseId, nextContacts);
        void settleOptimisticWrite(
          () => deleteContact(contact.id),
          { partners, referrals, referralMatches, touches, followUps, scorecards },
          { partners, referrals, referralMatches, touches, followUps, scorecards },
          () => setCaseContacts(contact.caseId, previousContacts),
          'The contact removal', cases, cases,
        );
      } },
    ]);
  }

  // One-tap contact action: open the dialer/messages/mail AND log the
  // timeline event, then offer the skippable quick note.
  async function contactAction(contact: CaseContact, kind: 'call' | 'text' | 'email') {
    if (!activeCase) return;
    const target = kind === 'call' ? contact.phone.replace(/[^\d+]/g, '') : kind === 'text' ? contact.phone.replace(/[^\d+]/g, '') : contact.email;
    if (!target) {
      Alert.alert('Nothing to send to', kind === 'email' ? 'This contact has no email address.' : 'This contact has no phone number.');
      return;
    }
    const url = kind === 'call' ? `tel:${target}` : kind === 'text' ? `sms:${target}` : `mailto:${target}`;
    try {
      const supported = await Linking.canOpenURL(url);
      if (!supported) throw new Error('Unsupported contact action');
      await Linking.openURL(url);
    } catch {
      Alert.alert('Unable to open', 'This device could not open that action. Nothing was logged.');
      return;
    }
    const verbs = { call: 'Called', text: 'Texted', email: 'Emailed' } as const;
    const eventId = makeId('e');
    const event: CaseEvent = {
      id: eventId,
      caseId: activeCase.id,
      kind,
      body: `${verbs[kind]} ${contact.name}${contact.relationship ? ` (${contact.relationship})` : ''}`,
      contactId: contact.id,
      occurredAt: new Date().toISOString(),
    };
    applyCaseEvent(event);
    logCaseEvent(activeCase.id, kind, event.body, { contactId: contact.id }, eventId)
      .catch((error) => failCaseChange(`The ${kind} could not be logged: ${error.message}`, () => {
        setCaseEvents((current) => current.filter((item) => item.id !== eventId));
      }));
    setQuickNoteContact({ contact, kind });
    setQuickNoteText('');
  }

  function saveQuickNote() {
    if (!quickNoteContact || !activeCase || !quickNoteText.trim()) {
      setQuickNoteContact(null);
      setQuickNoteText('');
      return;
    }
    const { contact } = quickNoteContact;
    const eventId = makeId('e');
    const event: CaseEvent = {
      id: eventId,
      caseId: activeCase.id,
      kind: 'note',
      body: quickNoteText.trim(),
      contactId: contact.id,
      occurredAt: new Date().toISOString(),
    };
    applyCaseEvent(event);
    setQuickNoteContact(null);
    setQuickNoteText('');
    logCaseEvent(activeCase.id, 'note', event.body, { contactId: contact.id }, eventId)
      .catch((error) => failCaseChange(`The note could not be saved: ${error.message}`, () => {
        setCaseEvents((current) => current.filter((item) => item.id !== eventId));
      }));
  }

  function addTimelineEntry() {
    if (!activeCase || !timelineDraft.trim()) return;
    const eventId = makeId('e');
    const event: CaseEvent = {
      id: eventId,
      caseId: activeCase.id,
      kind: timelineKind,
      body: timelineDraft.trim(),
      occurredAt: new Date().toISOString(),
    };
    applyCaseEvent(event);
    setTimelineDraft('');
    setTimelineKind('note');
    logCaseEvent(activeCase.id, event.kind, event.body, {}, eventId)
      .catch((error) => failCaseChange(`The entry could not be saved: ${error.message}`, () => {
        setCaseEvents((current) => current.filter((item) => item.id !== eventId));
      }));
  }

  // ─── Case documents (private bucket, signed URLs only) ───────────────────

  async function pickCaseDocument() {
    if (!activeCase || !session?.user?.id) return;
    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8, allowsMultipleSelection: false });
    } catch {
      Alert.alert('Photos unavailable', 'The photo library could not be opened. Case documents need a development build (expo-image-picker is a native module).');
      return;
    }
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const documentId = newDocumentId();
    const fileName = asset.fileName || `photo-${Date.now()}.jpg`;
    const mimeType = asset.mimeType || 'image/jpeg';
    const label = docLabel.trim() || fileName.replace(/\.[^.]+$/, '');
    setDocUploading(true);
    let uploadedPath: string | null = null;
    let metadataSaved = false;
    try {
      const { storagePath } = await uploadCaseFile({
        ownerId: session.user.id,
        caseId: activeCase.id,
        documentId,
        localUri: asset.uri,
        fileName,
        mimeType,
        sizeBytes: asset.fileSize ?? null,
      });
      uploadedPath = storagePath;
      const document: CaseDocument = {
        id: documentId,
        caseId: activeCase.id,
        label,
        storagePath,
        mimeType,
        sizeBytes: asset.fileSize ?? null,
        createdAt: new Date().toISOString(),
      };
      const eventId = makeId('e');
      const event: CaseEvent = {
        id: eventId,
        caseId: activeCase.id,
        kind: 'document',
        body: `Added document: ${label}`,
        documentId: document.id,
        occurredAt: new Date().toISOString(),
      };
      await saveDocumentWithEvent(document, event);
      metadataSaved = true;
      setCaseDocuments((current) => [...current, document]);
      setDocLabel('');
      applyCaseEvent(event);
    } catch (error) {
      let cleanupWarning = '';
      if (uploadedPath && !metadataSaved) {
        try {
          await removeCaseFile(uploadedPath);
        } catch (cleanupError) {
          cleanupWarning = ` The uploaded file also needs cleanup: ${(cleanupError as Error).message}`;
        }
      }
      Alert.alert('Upload failed', `The document could not be uploaded: ${(error as Error).message}.${cleanupWarning}`);
    } finally {
      setDocUploading(false);
    }
  }

  async function viewCaseDocument(document: CaseDocument) {
    try {
      const url = await createCaseFileSignedUrl(document.storagePath);
      if (document.mimeType.startsWith('image/')) {
        setDocView({ url, mimeType: document.mimeType, label: document.label });
      } else {
        Linking.openURL(url).catch(() => Alert.alert('Unable to open', 'This device could not open that document.'));
      }
    } catch (error) {
      // Documents open through a 60-second signed link, so unlike the saved
      // timeline they cannot be shown from the offline copy.
      if (isNetworkError(error)) {
        Alert.alert('Connection needed', 'Documents open through a short-lived signed link, so this one needs a connection. The saved copy lists it but cannot open it.');
        return;
      }
      Alert.alert('Could not open', (error as Error).message);
    }
  }

  function removeCaseDocument(document: CaseDocument) {
    Alert.alert('Delete document?', `"${document.label}" will be permanently removed.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        const previousDocs = caseDocuments;
        const linkedEventIds = caseEvents.filter((event) => event.documentId === document.id).map((event) => event.id);
        setCaseDocuments(caseDocuments.filter((item) => item.id !== document.id));
        try {
          await deleteDocumentRow(document.id);
          try {
            await removeCaseFile(document.storagePath);
          } catch (storageError) {
            try {
              await restoreDocumentRow(document, linkedEventIds);
            } catch (restoreError) {
              throw new Error(`File deletion failed (${(storageError as Error).message}) and document metadata recovery also failed (${(restoreError as Error).message}). Refresh the case before retrying.`);
            }
            throw storageError;
          }
        } catch (error) {
          failCaseChange(`The document could not be deleted: ${(error as Error).message}`, () => setCaseDocuments(previousDocs));
        }
      } },
    ]);
  }

  // ─── Case search ("the 14 months ago moment") ────────────────────────────

  useEffect(() => {
    const query = caseSearch.trim();
    if (!query) {
      setCaseSearchResults(null);
      setCaseSearching(false);
      return;
    }
    setCaseSearching(true);
    let cancelled = false;
    const userId = activeUserId;
    const timer = setTimeout(() => {
      searchCases(query)
        .then((results) => { if (!cancelled && userId && activeUserIdRef.current === userId) { setCaseSearchResults(results); setCaseSearching(false); } })
        .catch(() => { if (!cancelled && userId && activeUserIdRef.current === userId) { setCaseSearchResults([]); setCaseSearching(false); } });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [caseSearch, activeUserId]);

  // ─── Case → Match linkage ────────────────────────────────────────────────

  // "Find placement" on a case file: pre-fill the match form with hints from
  // the case summary (state code, insurance name, cash budget). When the new
  // profile is saved on the Match tab it is linked back to the case
  // (pendingCaseMatchId), and the case row points at the profile.
  function startMatchForCase(record: CaseRecord) {
    const existing = referralMatches.find((item) => item.id === record.matchProfileId);
    if (existing) {
      loadReferralMatch(existing);
      setTab('match');
      closeCase();
      return;
    }
    const text = `${record.title} ${record.summary}`;
    const stateHint = stateOptions.find((state) => new RegExp(`\\b${state.code}\\b`).test(text) || text.toLowerCase().includes(state.name.toLowerCase()));
    const insuranceHint = nationalInsuranceProviders.find((provider) => provider !== 'Cash pay' && text.toLowerCase().includes(provider.toLowerCase()));
    const budgetMatch = text.match(/\$\s?([\d,]{3,})/);
    const budgetHint = budgetMatch ? String(Number(budgetMatch[1].replace(/,/g, '')) || '') : '';
    setPendingCaseMatchId(record.id);
    setSelectedMatchId(null);
    setMatchClientLabel(record.title);
    setMatchType('Any type');
    setMatchState(stateHint?.code || 'ANY');
    setMatchInsurance(insuranceHint || 'Cash pay');
    setMatchNetworkPreferences(['In-network']);
    setMatchBudget(insuranceHint ? '' : budgetHint);
    setMatchTherapies([]);
    setTab('match');
    closeCase();
  }

  // ─── Today Command Center ───────────────────────────────────────────────
  // Home is a prioritized operating list built from open follow_ups (mirroring
  // the today_actions view semantics client-side) + virtual partner-cadence
  // cards. Every card action either logs work or forces a decision.

  function followUpContext(followUp: FollowUp) {
    const partner = partners.find((item) => item.id === followUp.partnerId);
    const linkedCase = cases.find((item) => item.id === followUp.caseId);
    const referral = referrals.find((item) => item.id === followUp.referralId);
    return {
      caseTitle: linkedCase?.title,
      partnerName: partner ? partner.organization : undefined,
      partnerPhone: partner?.phone || undefined,
      referralAwaitingAnswer: Boolean(referral?.packetSentAt && referral.admitted == null),
    };
  }

  const allTodaySections = useMemo(() => {
    const now = new Date();
    const leads = newLeadCards(cases, allCaseContacts, followUps, leadSettings.leadResponseTargetMinutes, now);
    return buildTodaySections(followUps, partnersDueToday(partners, now, partnerSnoozes), now, followUpContext, leads);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followUps, partners, cases, allCaseContacts, referrals, partnerSnoozes, leadSettings.leadResponseTargetMinutes]);

  // Mine / Everyone. Only a workspace with staff has the choice; "Mine"
  // keeps what is assigned to me and anything nobody has taken yet, so an
  // unowned item never disappears from everyone's list at once.
  const teamWorkspace = members.length > 1;
  const todayScope: TodayScope = teamWorkspace ? (todayScopeChoice ?? defaultTodayScope(members.length)) : 'everyone';
  const caseAssignee = (caseId: string) => cases.find((item) => item.id === caseId)?.assignedTo;
  const todaySections = useMemo(
    () => filterTodaySections(allTodaySections, todayScope, activeUserId, caseAssignee),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTodaySections, todayScope, activeUserId, cases],
  );

  function cardAssigneeLabel(card: TodayCard): string {
    if (!card.followUp) return '';
    const assignee = cardAssignee(card, caseAssignee);
    if (!assignee) return 'Unassigned';
    return assignee === activeUserId.toLowerCase() ? 'Yours' : `Assigned to ${memberDisplayName(members, assignee)}`;
  }

  // Assign a case, or take it. The server writes the timeline entry and
  // returns its wording so the optimistic row matches; a failure rolls the
  // case back and says so.
  async function assignCaseTo(caseId: string, assignedTo: string | null) {
    if (!cases.some((item) => item.id === caseId)) return;
    const previousCases = cases;
    setCases((current) => current.map((item) => (item.id === caseId ? { ...item, assignedTo: assignedTo || undefined } : item)));
    const eventId = makeId('e');
    try {
      const saved = await assignCase(caseId, assignedTo, eventId);
      if (activeCaseId === caseId) {
        applyCaseEvent({ id: eventId, caseId, kind: 'system', body: saved.eventBody, occurredAt: saved.occurredAt, actorId: activeUserId.toLowerCase() });
      }
    } catch (error) {
      setCases(previousCases);
      Alert.alert('Assignment not saved', (error as Error).message);
    }
  }

  function assigneeChoices(onPick: (userId: string | null) => void): { text: string; style?: 'cancel'; onPress?: () => void }[] {
    return [
      ...members.map((member) => ({
        text: member.userId === activeUserId.toLowerCase() ? `${member.displayName} (you)` : member.displayName,
        onPress: () => onPick(member.userId),
      })),
      { text: 'Unassigned', onPress: () => onPick(null) },
      { text: 'Cancel', style: 'cancel' as const },
    ];
  }

  function pickCaseAssignee(record: CaseRecord) {
    Alert.alert('Assigned to', 'Who is handling this case? Its follow-ups follow unless one is assigned on its own.', assigneeChoices((userId) => { void assignCaseTo(record.id, userId); }));
  }

  function pickFollowUpAssignee(followUp: FollowUp) {
    Alert.alert('Assigned to', 'Who is handling this follow-up?', assigneeChoices((userId) => {
      const updated: FollowUp = { ...followUp, assignedTo: userId };
      persistFollowUpChange(updated, followUps.map((item) => (item.id === followUp.id ? updated : item)));
    }));
  }

  function followUpAssigneeLabel(followUp: FollowUp, record: CaseRecord): string {
    if (followUp.assignedTo) return followUp.assignedTo === activeUserId.toLowerCase() ? 'You' : memberDisplayName(members, followUp.assignedTo);
    if (record.assignedTo) return `${record.assignedTo === activeUserId.toLowerCase() ? 'You' : memberDisplayName(members, record.assignedTo)} (case)`;
    return 'Assign';
  }

  // "note · Maria · by Mikayla · 2h ago"; a completed follow-up reads
  // "Done by Mikayla, 2:14 PM". Names only: who did what, never how much.
  function timelineMetaLine(event: CaseEvent, contactName?: string): string {
    const actor = teamWorkspace && event.actorId ? memberDisplayName(members, event.actorId) : '';
    if (actor && event.kind === 'system' && /^(Completed|Done)\b/.test(event.body)) {
      return `Done by ${actor}, ${clockTime(event.occurredAt)}`;
    }
    const bits = [event.kind.replace('_', ' ')];
    if (contactName) bits.push(contactName);
    if (actor) bits.push(`by ${actor}`);
    bits.push(relativeActivity(event.occurredAt));
    return bits.join(' · ');
  }

  // The NEW LEADS clocks tick every 30 seconds while a lead is waiting.
  useEffect(() => {
    if (!todaySections.newLeads.length) return undefined;
    setNowTick(new Date());
    const timer = setInterval(() => setNowTick(new Date()), 30000);
    return () => clearInterval(timer);
  }, [todaySections.newLeads.length]);

  async function reloadLeadSettings() {
    try {
      setLeadSettings(await fetchLeadSettings());
    } catch {
      // Keep what we have; the Workspace screen already reported the failure.
    }
  }

  // "New lead": the case, its primary contact, and the first-call follow-up
  // land together (create_lead). The first call is due today at now + target
  // when that stays inside today; past midnight it is simply due today.
  function saveNewLead(draft: NewLeadDraft) {
    if (!mutationSlotAvailable('The lead')) return;
    const now = new Date();
    const nowIso = now.toISOString();
    const title = leadCaseTitle(draft);
    const record: CaseRecord = {
      id: makeId('c'),
      title,
      status: 'inquiry',
      summary: draft.urgency === 'immediate_danger' ? 'Caller reported immediate danger when this lead arrived.' : '',
      leadSource: draft.leadSource,
      leadSourceDetail: '',
      lostReason: '',
      stageChangedAt: nowIso,
      paymentStatus: 'none',
      quotedAmount: null,
      paidAmount: 0,
      leadCapturedAt: nowIso,
      leadUrgency: draft.urgency,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const contact: CaseContact = {
      id: makeId('cc'),
      caseId: record.id,
      name: draft.callerName,
      relationship: draft.aboutRelationship,
      phone: draft.phone,
      email: draft.email,
      isPrimary: true,
      note: '',
    };
    const due = new Date(now.getTime() + leadSettings.leadResponseTargetMinutes * 60000);
    const dueOn = localDateStamp();
    const dueTime = due.getDate() === now.getDate()
      ? `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`
      : null;
    const firstCall: FollowUp = {
      id: makeId('f'),
      caseId: record.id,
      kind: 'first_call',
      title: leadFollowUpTitle(title),
      dueOn,
      dueTime: dueTime ?? undefined,
      status: 'open',
      note: '',
    };
    const previousCases = cases;
    const previousContacts = allCaseContacts;
    const previousFollowUps = followUps;
    const nextFollowUps = [firstCall, ...followUps];
    setCases([record, ...cases]);
    setAllCaseContacts([contact, ...allCaseContacts]);
    setFollowUps(nextFollowUps);
    setShowNewLead(false);
    void settleOptimisticWrite(
      () => createLead({
        caseId: record.id,
        contactId: contact.id,
        followUpId: firstCall.id,
        callerName: draft.callerName,
        phone: draft.phone,
        email: draft.email,
        aboutRelationship: draft.aboutRelationship,
        aboutFirstName: draft.aboutFirstName,
        leadSource: draft.leadSource,
        urgency: draft.urgency,
        dueOn,
        dueTime,
      }, activeUserId),
      { partners, referrals, referralMatches, touches, followUps: nextFollowUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps: previousFollowUps, scorecards },
      () => {
        setCases(previousCases);
        setAllCaseContacts(previousContacts);
        setFollowUps(previousFollowUps);
      },
      'The lead',
      [record, ...previousCases],
      previousCases,
    );
  }

  const todayCounts = useMemo(() => todayLoad(followUps, partners), [followUps, partners]);

  function openCaseById(caseId: string) {
    if (activeCaseId === caseId) return;
    openCase(caseId);
  }

  // THE RULE: completing anything requires an outcome. Backed items always
  // open the "Done — what's next?" sheet; only virtual partner cards and
  // unlinked standalone items may complete plainly (cadence self-reschedules).
  function validatedStepDueTime(): string | undefined | null {
    if (stepForm.kind !== 'consult' || !stepForm.time.trim()) return undefined;
    const dueTime = twelveHourToStoredTime(stepForm.time, stepForm.timePeriod);
    if (dueTime) return dueTime;
    Alert.alert('Check the time', 'Enter a time from 1:00 through 12:59, then choose AM or PM.');
    return null;
  }

  function openDoneSheet(card: TodayCard) {
    if (card.virtual || (!card.caseId && !card.referralId)) {
      if (card.virtual) openTouchLogger(partners.find((item) => item.id === card.partnerId) as Partner);
      else if (card.followUp) completePlainFollowUp(card.followUp);
      return;
    }
    setNextStepCard(null);
    setDoneStatusPicker(false);
    setStepForm({ kind: 'follow_up', when: 'tomorrow', customDate: '', time: '', timePeriod: 'AM', waitingOn: '', note: '' });
    setDoneCard(card);
  }

  function openDoneNextStepFlow(card: TodayCard) {
    // Keep the existing Done native Modal mounted and switch its inner
    // content. Presenting a second sibling Modal over it is unreliable on iOS.
    // Preselect a sensible kind so one tap can finish: first_call → Consult
    // (book it), waiting_on → keep waiting.
    const followUp = card.followUp;
    const suggested: FollowUpKind = followUp?.kind === 'first_call' ? 'consult' : followUp?.kind === 'waiting_on' ? 'waiting_on' : 'follow_up';
    setStepForm({
      kind: suggested,
      when: followUp?.kind === 'first_call' ? 'in3days' : 'tomorrow',
      customDate: '',
      time: '',
      timePeriod: 'AM',
      waitingOn: followUp?.waitingOn || '',
      note: '',
    });
    setNextStepCard(card);
  }

  function openNextStepSheet(card: TodayCard) {
    const followUp = card.followUp;
    const existingTime = storedTimeToTwelveHour(followUp?.dueTime);
    setStepForm({
      kind: followUp?.kind || (card.virtual ? 'touch' : 'follow_up'),
      when: 'tomorrow',
      customDate: '',
      time: existingTime.time,
      timePeriod: existingTime.timePeriod,
      waitingOn: followUp?.waitingOn || '',
      note: followUp?.note || '',
    });
    setNextStepCard(card);
  }

  // Complete with nothing after — allowed only for unlinked standalone items.
  function completePlainFollowUp(followUp: FollowUp) {
    const updated: FollowUp = { ...followUp, status: 'done', completedAt: new Date().toISOString(), snoozedUntil: undefined };
    persistFollowUpChange(updated, followUps.map((item) => (item.id === followUp.id ? updated : item)));
  }

  // Log a 'system' timeline event on a case-linked card action. Timeline
  // failures are visible and the optimistic event is removed.
  function logTodaySystemEvent(caseId: string, body: string) {
    const eventId = makeId('e');
    const event: CaseEvent = { id: eventId, caseId, kind: 'system', body, occurredAt: new Date().toISOString() };
    applyCaseEvent(event);
    logCaseEvent(caseId, 'system', body, {}, eventId).catch((error) => {
      setCaseEvents((current) => current.filter((item) => item.id !== eventId));
      Alert.alert('Timeline not saved', `The main action was saved, but its case timeline entry failed: ${error.message}`);
    });
  }

  // Done → "Next step…": complete the current item AND create the next
  // follow_up, carrying the case/partner links forward.
  function confirmDoneNextStep() {
    const card = doneCard;
    if (!card?.followUp) return;
    if (!mutationSlotAvailable('The completed step and its next step')) return;
    const followUp = card.followUp;
    const now = new Date().toISOString();
    const dueOn = nextStepDate(stepForm.when, new Date(), stepForm.customDate);
    const dueTime = validatedStepDueTime();
    if (dueTime === null) return;
    const completed: FollowUp = { ...followUp, status: 'done', completedAt: now, snoozedUntil: undefined };
    const next: FollowUp = {
      id: makeId('f'),
      partnerId: followUp.partnerId,
      referralId: followUp.referralId,
      caseId: followUp.caseId,
      kind: stepForm.kind,
      title: nextStepTitle(stepForm.kind, card),
      dueOn,
      dueTime,
      waitingOn: stepForm.kind === 'waiting_on' ? stepForm.waitingOn.trim() : undefined,
      note: stepForm.note.trim(),
      status: 'open',
    };
    const nextFollowUps = [next, ...followUps.map((item) => (item.id === followUp.id ? completed : item))];
    setFollowUps(nextFollowUps);
    setNextStepCard(null);
    setDoneCard(null);
    const event: CaseEvent | null = followUp.caseId ? {
      id: makeId('e'),
      caseId: followUp.caseId,
      kind: 'system',
      body: `Completed: ${followUp.title} — set next: ${next.title} (${shortDate(next.dueOn)}${next.dueTime ? ` ${next.dueTime}` : ''})`,
      occurredAt: now,
    } : null;
    if (event) applyCaseEvent(event);
    void settleOptimisticWrite(
      () => completeFollowUpWithNext(completed, next, event, activeUserId),
      { partners, referrals, referralMatches, touches, followUps: nextFollowUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => {
        setFollowUps(followUps);
        if (event) setCaseEvents((current) => current.filter((item) => item.id !== event.id));
      },
      'The completed step and its next step',
    );
  }

  function nextStepTitle(kind: FollowUpKind, card: TodayCard): string {
    const anchor = card.context.caseTitle || card.context.partnerName || card.title;
    switch (kind) {
      case 'promised_call': return `Call back — ${anchor}`;
      case 'consult': return `Consult — ${anchor}`;
      case 'waiting_on': return `Check — ${stepForm.waitingOn.trim() || anchor}`;
      case 'touch': return `Reach out — ${anchor}`;
      case 'first_call': return `First call — ${anchor}`;
      default: return `Follow up — ${anchor}`;
    }
  }

  // Done → "Close the loop": referral admit-checks route to the existing
  // outcome capture; case-linked items complete + optionally advance/close
  // the case; partner items complete plainly.
  function confirmDoneCloseLoop() {
    const card = doneCard;
    if (!card?.followUp || caseCloseLoopSaving) return;
    const followUp = card.followUp;
    if (card.referralId && card.context.referralAwaitingAnswer) {
      // Reuse the packet outcome sheet as-is (admitted? experience stars).
      setDoneCard(null);
      requestAnimationFrame(() => {
        setOutcomeFollowUp(followUp);
        setOutcomeAnswer(null);
        setOutcomeAdmittedOn(localDateStamp());
        setOutcomeStars(0);
        setOutcomeNote('');
      });
      return;
    }
    if (card.caseId) {
      // Keep the same native Modal mounted and change only its inner content.
      // Unmounting and immediately remounting this sheet could leave an
      // invisible iOS modal overlay intercepting every touch.
      setDoneStatusPicker(true);
      return;
    }
    setDoneCard(null);
    completePlainFollowUp(followUp);
  }

  // Case-linked close-the-loop: complete the item and set the case status
  // (status 'keep' = leave it where it is).
  function closeLoopWithStatus(status: CaseStatus | 'keep') {
    const card = doneCard;
    if (!card?.followUp || caseCloseLoopSaving) return;
    if (!mutationSlotAvailable('The follow-up and case status')) return;
    const followUp = card.followUp;
    const record = cases.find((item) => item.id === followUp.caseId);
    if (!record) {
      Alert.alert('Case file', 'The linked case could not be found. Refresh before closing this step.');
      return;
    }
    const now = new Date().toISOString();
    const completed: FollowUp = { ...followUp, status: 'done', completedAt: now, snoozedUntil: undefined };
    const updatedCase: CaseRecord = {
      ...record,
      status: status === 'keep' ? record.status : status,
      updatedAt: now,
    };
    const event: CaseEvent = {
      id: makeId('e'),
      caseId: record.id,
      kind: 'system',
      body: `Completed: ${followUp.title} — closed the loop${status !== 'keep' ? ` (case → ${status})` : ''}`,
      occurredAt: now,
    };
    const previousCases = cases;
    const previousFollowUps = followUps;
    const nextCases = cases.map((item) => item.id === record.id ? updatedCase : item);
    const nextFollowUps = followUps.map((item) => item.id === followUp.id ? completed : item);
    setCaseCloseLoopSaving(true);
    setCases(nextCases);
    setFollowUps(nextFollowUps);
    applyCaseEvent(event);
    void settleOptimisticWrite(
      () => completeFollowUpWithCase(completed, updatedCase, event, status !== 'keep'),
      { partners, referrals, referralMatches, touches, followUps: nextFollowUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps: previousFollowUps, scorecards },
      () => {
        setCases(previousCases);
        setFollowUps(previousFollowUps);
        setCaseEvents((current) => current.filter((item) => item.id !== event.id));
      },
      'The follow-up and case status',
      nextCases,
      previousCases,
    ).then((saved) => {
      if (!saved) return;
      // The original status-pill press has fully settled before dismissing the
      // native sheet, avoiding the stale transparent-overlay race on iOS.
      requestAnimationFrame(() => {
        setDoneCard((current) => current?.id === card.id ? null : current);
        setDoneStatusPicker(false);
      });
    }).finally(() => setCaseCloseLoopSaving(false));
  }

  // Set Next Step WITHOUT completing: retype/reschedule the current item
  // (kind/due_on/due_time/waiting_on/note), or MATERIALIZE a one-off
  // follow_up for a virtual cadence card (the only way a cadence card gets a
  // concrete next step — the cadence itself still self-heals on a touch).
  function confirmNextStep() {
    const card = nextStepCard;
    if (!card) return;
    if (!mutationSlotAvailable('The next step')) return;
    const dueOn = nextStepDate(stepForm.when, new Date(), stepForm.customDate);
    const dueTime = validatedStepDueTime();
    if (dueTime === null) return;
    const waitingOn = stepForm.kind === 'waiting_on' ? stepForm.waitingOn.trim() : undefined;
    setNextStepCard(null);
    if (card.virtual) {
      const created: FollowUp = {
        id: makeId('f'),
        partnerId: card.virtual.partnerId,
        kind: stepForm.kind,
        title: nextStepTitle(stepForm.kind, card),
        dueOn,
        dueTime,
        waitingOn,
        note: stepForm.note.trim(),
        status: 'open',
      };
      const nextFollowUps = [created, ...followUps];
      setFollowUps(nextFollowUps);
      void settleOptimisticWrite(
        () => createFollowUp(created, activeUserId),
        { partners, referrals, referralMatches, touches, followUps: nextFollowUps, scorecards },
        { partners, referrals, referralMatches, touches, followUps, scorecards },
        () => setFollowUps(followUps), 'The next step',
      );
      return;
    }
    const followUp = card.followUp as FollowUp;
    const updated: FollowUp = {
      ...followUp,
      kind: stepForm.kind,
      dueOn,
      dueTime,
      waitingOn,
      note: stepForm.note.trim(),
      snoozedUntil: undefined, // a fresh next step clears any snooze
    };
    if (followUp.caseId) logTodaySystemEvent(followUp.caseId, `Next step: ${followUp.title} → ${updated.title} (${shortDate(updated.dueOn)}${updated.dueTime ? ` ${updated.dueTime}` : ''})`);
    persistFollowUpChange(updated, followUps.map((item) => (item.id === followUp.id ? updated : item)));
  }

  function openCaseNextStep(record: CaseRecord) {
    setStepForm({ kind: 'follow_up', when: 'tomorrow', customDate: '', time: '', timePeriod: 'AM', waitingOn: '', note: '' });
    setCaseNextStepCaseId(record.id);
  }

  function saveCaseNextStep(record: CaseRecord) {
    if (!mutationSlotAvailable('The case next step')) return;
    const dueOn = nextStepDate(stepForm.when, new Date(), stepForm.customDate);
    const dueTime = validatedStepDueTime();
    if (dueTime === null) return;
    const waitingOn = stepForm.kind === 'waiting_on' ? stepForm.waitingOn.trim() : undefined;
    const titleAnchor = record.title;
    const title = stepForm.kind === 'promised_call' ? `Call back — ${titleAnchor}`
      : stepForm.kind === 'consult' ? `Consult — ${titleAnchor}`
        : stepForm.kind === 'waiting_on' ? `Check — ${waitingOn || titleAnchor}`
          : stepForm.kind === 'touch' ? `Reach out — ${titleAnchor}`
            : stepForm.kind === 'first_call' ? `First call — ${titleAnchor}`
              : `Follow up — ${titleAnchor}`;
    const followUp: FollowUp = {
      id: makeId('f'),
      caseId: record.id,
      kind: stepForm.kind,
      title,
      dueOn,
      dueTime,
      waitingOn,
      note: stepForm.note.trim(),
      status: 'open',
    };
    const previousFollowUps = followUps;
    const nextFollowUps = [followUp, ...previousFollowUps];
    setFollowUps(nextFollowUps);
    setCaseNextStepCaseId(null);
    void settleOptimisticWrite(
      () => createFollowUp(followUp, activeUserId),
      { partners, referrals, referralMatches, touches, followUps: nextFollowUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps: previousFollowUps, scorecards },
      () => setFollowUps(previousFollowUps),
      'The case next step',
    );
  }

  // Snooze: backed items write snoozed_until (today_actions hides them until
  // then); virtual partner cards use the local AsyncStorage snooze map and
  // materialize nothing.
  async function confirmSnooze(choice: 'plus1' | 'plus2' | 'nextweek') {
    const card = snoozeCard;
    if (!card) return;
    const until = snoozeDate(choice, new Date());
    setSnoozeCard(null);
    if (card.virtual) {
      const userId = session?.user?.id;
      const generation = authGenerationRef.current;
      if (!userId) {
        Alert.alert('Snooze not saved', 'Sign in again before snoozing this partner.');
        return;
      }
      const previous = partnerSnoozes;
      const next = prunePartnerSnoozes({ ...partnerSnoozes, [card.virtual.partnerId]: until }, new Date());
      setPartnerSnoozes(next);
      try {
        await AsyncStorage.setItem(partnerSnoozeKey(userId), JSON.stringify(next));
      } catch (error) {
        if (activeUserIdRef.current === userId && authGenerationRef.current === generation) {
          setPartnerSnoozes(previous);
          Alert.alert('Snooze not saved', `The on-device snooze could not be stored: ${(error as Error).message}`);
        }
      }
      return;
    }
    const followUp = card.followUp as FollowUp;
    const updated: FollowUp = { ...followUp, snoozedUntil: until };
    persistFollowUpChange(updated, followUps.map((item) => (item.id === followUp.id ? updated : item)));
  }

  // Call/Text from a card. Target resolution: case-linked → the case's
  // primary contact (action sheet when several have numbers); partner-linked
  // → the partner's phone. Every completed action logs (case_event and/or
  // partner touch) and offers the same quick-note prompt the case file uses.
  function cardContactAction(card: TodayCard, action: 'call' | 'text') {
    const launch = async (digits: string): Promise<boolean> => {
      const url = `${action === 'call' ? 'tel' : 'sms'}:${digits}`;
      try {
        const supported = await Linking.canOpenURL(url);
        if (!supported) throw new Error('Unsupported contact action');
        await Linking.openURL(url);
        return true;
      } catch {
        Alert.alert('Unable to open', 'This device could not open that action. Nothing was logged.');
        return false;
      }
    };
    const clean = (phone: string) => phone.replace(/[^\d+]/g, '');
    if (card.caseId) {
      const record = cases.find((item) => item.id === card.caseId);
      // Contacts are loaded for the whole workspace with the case list, so
      // this works from memory (and offline); foreground refresh keeps it fresh.
      const contacts = allCaseContacts.filter((item) => item.caseId === card.caseId && item.phone.trim());
      if (!contacts.length) {
        Alert.alert('No phone on file', `This case has no contact with a phone number.${record ? ' Add one in the case file.' : ''}`);
        return;
      }
      const primary = contacts.find((item) => item.isPrimary) || contacts[0];
      if (contacts.length > 1) {
        setContactPick({ card, action, contacts });
        return;
      }
      launch(clean(primary.phone)).then((opened) => {
        if (opened) logCardContact(card, action, primary);
      });
      return;
    }
    if (card.partnerId) {
      const partner = partners.find((item) => item.id === card.partnerId);
      const digits = partner ? clean(partner.phone) : '';
      if (!digits) {
        Alert.alert('No phone on file', `${partner?.organization || 'This partner'} has no phone number — add one in the Directory.`);
        return;
      }
      launch(digits).then((opened) => {
        if (opened) logCardContact(card, action, undefined);
      });
      return;
    }
    Alert.alert('No one to reach', 'Link this item to a case or partner to call or text from here.');
  }

  // The logging half of a card call/text. A case event and partner touch are
  // committed/queued as one owner-fenced operation after the OS handoff succeeds.
  function logCardContact(card: TodayCard, action: 'call' | 'text', contact?: CaseContact) {
    if (!mutationSlotAvailable('The contact log')) return;
    const now = new Date().toISOString();
    const verb = action === 'call' ? 'Called' : 'Texted';
    const previousCaseEvents = caseEvents;
    const previousTouches = touches;
    const previousPartners = partners;
    const event: CaseEvent | null = card.caseId && contact ? {
      id: makeId('e'),
      caseId: card.caseId,
      kind: action,
      body: `${verb} ${contact.name}${contact.relationship ? ` (${contact.relationship})` : ''} — ${card.title}`,
      contactId: contact.id,
      occurredAt: now,
    } : null;
    const touch: Touch | null = card.partnerId
      ? { id: makeId('t'), partnerId: card.partnerId, kind: action, note: card.title, occurredAt: now }
      : null;
    if (event) applyCaseEvent(event);
    const nextTouches = touch ? [touch, ...previousTouches] : previousTouches;
    const todayStamp = localDateStamp();
    const nextPartners = touch
      ? previousPartners.map((partner) => partner.id === touch.partnerId ? { ...partner, lastContact: todayStamp } : partner)
      : previousPartners;
    if (touch) {
      setTouches(nextTouches);
      setPartners(nextPartners);
    }
    setQuickNoteText('');
    setTodayQuickNote({ card, action, contact });
    if (!event && !touch) return;
    void settleOptimisticWrite(
      () => logContactActivity(event, touch, activeUserId),
      { partners: nextPartners, referrals, referralMatches, touches: nextTouches, followUps, scorecards },
      { partners: previousPartners, referrals, referralMatches, touches: previousTouches, followUps, scorecards },
      () => {
        setCaseEvents(previousCaseEvents);
        setTouches(previousTouches);
        setPartners(previousPartners);
      },
      'The contact log',
    );
  }

  function saveTodayQuickNote() {
    const note = quickNoteText.trim();
    const target = todayQuickNote;
    if (!note || !target) return;
    if (!mutationSlotAvailable('The contact note')) return;
    setTodayQuickNote(null);
    setQuickNoteText('');
    const now = new Date().toISOString();
    const previousCaseEvents = caseEvents;
    const previousTouches = touches;
    const event: CaseEvent | null = target.card.caseId && target.contact
      ? { id: makeId('e'), caseId: target.card.caseId, kind: 'note', body: note, contactId: target.contact.id, occurredAt: now }
      : null;
    const touch: Touch | null = target.card.partnerId
      ? { id: makeId('t'), partnerId: target.card.partnerId, kind: 'other', note, occurredAt: now }
      : null;
    if (event) applyCaseEvent(event);
    const nextTouches = touch ? [touch, ...previousTouches] : previousTouches;
    if (touch) setTouches(nextTouches);
    if (!event && !touch) return;
    void settleOptimisticWrite(
      () => logContactActivity(event, touch, activeUserId),
      { partners, referrals, referralMatches, touches: nextTouches, followUps, scorecards },
      { partners, referrals, referralMatches, touches: previousTouches, followUps, scorecards },
      () => {
        setCaseEvents(previousCaseEvents);
        setTouches(previousTouches);
      },
      'The contact note',
    );
  }

  // Quick-add ("I need to…"): the 5-second capture. kind + who + when →
  // a follow_up, optionally linked to a case or partner.
  function saveQuickAdd() {
    if (!quickAddForm.title.trim()) {
      Alert.alert('Say what it is', 'One line is enough — "I promised Sarah I\'d call Thursday".');
      return;
    }
    const quickDueTime = quickAddForm.kind === 'consult' && quickAddForm.time.trim()
      ? twelveHourToStoredTime(quickAddForm.time, quickAddForm.timePeriod)
      : undefined;
    if (quickAddForm.kind === 'consult' && quickAddForm.time.trim() && !quickDueTime) {
      Alert.alert('Check the time', 'Enter a time from 1:00 through 12:59, then choose AM or PM.');
      return;
    }
    if (!mutationSlotAvailable('The follow-up')) return;
    const linkedCase = quickAddForm.targetType === 'case' ? cases.find((item) => item.id === quickAddForm.targetId) : undefined;
    const linkedPartner = quickAddForm.targetType === 'partner' ? partners.find((item) => item.id === quickAddForm.targetId) : undefined;
    const followUp: FollowUp = {
      id: makeId('f'),
      caseId: linkedCase?.id,
      partnerId: linkedPartner?.id,
      kind: quickAddForm.kind,
      title: quickAddForm.title.trim(),
      dueOn: nextStepDate(quickAddForm.when, new Date(), quickAddForm.customDate),
      dueTime: quickDueTime || undefined,
      waitingOn: quickAddForm.kind === 'waiting_on' ? quickAddForm.waitingOn.trim() : undefined,
      status: 'open',
      note: '',
    };
    const nextFollowUps = [followUp, ...followUps];
    setFollowUps(nextFollowUps);
    setShowQuickAdd(false);
    setQuickAddForm({ kind: 'follow_up', title: '', targetType: 'none', targetId: '', targetSearch: '', when: 'today', customDate: '', time: '', timePeriod: 'AM', waitingOn: '' });
    void settleOptimisticWrite(
      () => createFollowUp(followUp, activeUserId),
      { partners, referrals, referralMatches, touches, followUps: nextFollowUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => setFollowUps(followUps), 'The follow-up',
    );
  }

  function persistFollowUpChange(updated: FollowUp, nextFollowUps: FollowUp[]) {
    if (!mutationSlotAvailable('The follow-up change')) return;
    const previousFollowUps = followUps;
    setFollowUps(nextFollowUps);
    void settleOptimisticWrite(
      () => updateFollowUp(updated, activeUserId),
      { partners, referrals, referralMatches, touches, followUps: nextFollowUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps: previousFollowUps, scorecards },
      () => setFollowUps(previousFollowUps), 'The follow-up change',
    );
  }

  function skipFollowUp(followUp: FollowUp) {
    const updated: FollowUp = { ...followUp, status: 'skipped', completedAt: new Date().toISOString() };
    persistFollowUpChange(updated, followUps.map((item) => (item.id === followUp.id ? updated : item)));
  }

  function snoozeFollowUp(followUp: FollowUp, days: number) {
    const updated: FollowUp = { ...followUp, dueOn: addDaysStamp(days) };
    persistFollowUpChange(updated, followUps.map((item) => (item.id === followUp.id ? updated : item)));
  }

  function closeOutcomeSheet() {
    setOutcomeFollowUp(null);
    setOutcomeAnswer(null);
    setOutcomeStars(0);
    setOutcomeNote('');
  }

  function saveOutcome() {
    const followUp = outcomeFollowUp;
    if (!followUp || !outcomeAnswer) return;
    if (!mutationSlotAvailable('The outcome')) return;
    const now = new Date().toISOString();
    const completed: FollowUp = { ...followUp, status: 'done', completedAt: now };
    const nextFollowUps = followUps.map((item) => (item.id === followUp.id ? completed : item));
    setFollowUps(nextFollowUps);
    let nextReferrals = referrals;
    let write: () => Promise<void>;
    if (followUp.referralId) {
      const stars = outcomeStars > 0 ? outcomeStars : null;
      const patch = outcomeAnswer === 'yes'
        ? { admitted: true, admittedOn: outcomeAdmittedOn || localDateStamp(), outcome: 'Placed' as Referral['outcome'], familyExperience: stars, outcomeNote: outcomeNote.trim() }
        : { admitted: false, outcomeNote: outcomeNote.trim() };
      nextReferrals = referrals.map((item) => (item.id === followUp.referralId ? { ...item, ...patch } : item));
      setReferrals(nextReferrals);
      write = () => completeFollowUpWithOutcome(completed, followUp.referralId!, patch, activeUserId);
    } else {
      write = () => updateFollowUp(completed, activeUserId);
    }
    closeOutcomeSheet();
    void settleOptimisticWrite(
      write,
      { partners, referrals: nextReferrals, referralMatches, touches, followUps: nextFollowUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => {
        setFollowUps(followUps);
        setReferrals(referrals);
      },
      'The outcome',
    );
  }

  function outcomeNotYet() {
    // "Not yet" isn't an outcome — snooze the check-in +4 days and keep it open.
    if (!outcomeFollowUp) return;
    snoozeFollowUp(outcomeFollowUp, 4);
    closeOutcomeSheet();
  }

  function openNewPartner() {
    setEditingPartnerId(null);
    setPartnerForm(makeEmptyPartnerForm());
    setShowAddPartner(true);
  }

  function openEditPartner(partner: Partner) {
    setEditingPartnerId(partner.id);
    setPartnerForm({
      name: partner.name,
      organization: partner.organization,
      types: typesForPartner(partner),
      city: partner.city === '—' ? '' : partner.city,
      state: partner.state === '—' ? '' : partner.state,
      phone: partner.phone,
      email: partner.email,
      website: partner.website || '',
      monthlyCost: monthlyCostForPartner(partner) ? String(monthlyCostForPartner(partner)) : '',
      insurance: partner.insurance.filter((plan) => plan !== 'Cash pay'),
      insuranceNetworks: Object.fromEntries(
        partner.insurance.filter((plan) => plan !== 'Cash pay').map((plan) => [plan, networkCapabilitiesForPartner(partner, plan)]),
      ),
      privatePayOnly: partner.insurance.length > 0 && partner.insurance.every((plan) => plan === PRIVATE_PAY_ONLY),
      therapies: partner.therapies,
      note: partner.note,
      touchCadence: partner.touchCadenceDays ? String(partner.touchCadenceDays) : '',
      financialRelationship: partner.financialRelationship || 'none',
      financialRelationshipNote: partner.financialRelationshipNote || '',
    });
    setSelectedPartner(null);
    setShowAddPartner(true);
  }

  function closePartnerForm() {
    setShowAddPartner(false);
    setEditingPartnerId(null);
    setPartnerForm(makeEmptyPartnerForm());
  }

  async function sharePartner(partner: Partner) {
    try {
      await Share.share({
        title: `${partner.organization} referral contact`,
        message: partnerShareMessage(partner),
      });
    } catch {
      Alert.alert('Unable to share', 'The share sheet could not be opened. Please try again.');
    }
  }

  function savePartner() {
    if (!partnerForm.name.trim() || !partnerForm.organization.trim()) {
      Alert.alert('A little more detail', 'Add a contact name and organization first.');
      return;
    }
    if (!partnerForm.types.length) {
      Alert.alert('Choose a partner type', 'Select at least one level of care or provider type.');
      return;
    }
    const unclassifiedInsurance = partnerForm.insurance.find((plan) => !partnerForm.insuranceNetworks[plan]?.length);
    if (unclassifiedInsurance) {
      Alert.alert('Choose IN or OON', `Mark ${unclassifiedInsurance} as in-network, out-of-network, or both.`);
      return;
    }
    if (!mutationSlotAvailable('The partner')) return;
    const existing = partners.find((partner) => partner.id === editingPartnerId);
    const cadence = partnerForm.touchCadence ? Number(partnerForm.touchCadence) : undefined;
    const partner: Partner = {
      id: existing?.id || makeId('p'),
      name: partnerForm.name.trim(),
      organization: partnerForm.organization.trim(),
      type: partnerForm.types[0],
      types: partnerForm.types,
      city: partnerForm.city.trim() || '—',
      state: partnerForm.state.trim().toUpperCase() || '—',
      regions: existing?.regions || ['Nationwide'],
      phone: partnerForm.phone.trim(),
      email: partnerForm.email.trim(),
      website: partnerForm.website.trim(),
      monthlyCost: Number(partnerForm.monthlyCost) || 0,
      cashMin: Number(partnerForm.monthlyCost) || 0,
      cashMax: Number(partnerForm.monthlyCost) || 0,
      insurance: partnerForm.insurance.length ? partnerForm.insurance : partnerForm.privatePayOnly ? [PRIVATE_PAY_ONLY] : [],
      insuranceNetworks: partnerForm.insuranceNetworks,
      therapies: partnerForm.therapies,
      populations: existing?.populations || ['Adults'],
      levels: partnerForm.types,
      note: partnerForm.note.trim(),
      inbound: existing?.inbound || 0,
      outbound: existing?.outbound || 0,
      lastContact: existing?.lastContact || localDateStamp(),
      favorite: existing?.favorite,
      touchCadenceDays: cadence && cadence > 0 ? cadence : undefined,
      financialRelationship: partnerForm.financialRelationship,
      financialRelationshipNote: partnerForm.financialRelationship === 'none' ? '' : partnerForm.financialRelationshipNote.trim(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      // Directory linkage is server-owned; an edit never changes it.
      globalPartnerId: existing?.globalPartnerId,
      globalListingStatus: existing?.globalListingStatus,
      directoryRejectedAt: existing?.directoryRejectedAt,
      directoryReviewNote: existing?.directoryReviewNote,
    };
    const nextPartners = existing
      ? partners.map((item) => item.id === partner.id ? partner : item)
      : [partner, ...partners];
    setPartners(nextPartners);
    setPartnerForm(makeEmptyPartnerForm());
    setShowAddPartner(false);
    setEditingPartnerId(null);
    setSelectedPartner(partner);
    void settleOptimisticWrite(
      () => existing ? updatePartner(partner, activeUserId) : createPartner(partner, activeUserId),
      { partners: nextPartners, referrals, referralMatches, touches, followUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => { setPartners(partners); setSelectedPartner(existing || null); },
      'The partner',
    );
  }

  // Send one of the practice's own partners — a program, an interventionist,
  // or a therapist — to ReferralFit for review. The server is the authority
  // on completeness (suggest_global_listing); the button only shows when the
  // mirrored rule says the partner is ready.
  async function submitPartnerForDirectory(partner: Partner) {
    if (directorySubmitBusy) return;
    // A save still in flight may be the very partner being submitted, and the
    // server reviews its own copy — so queued edits have to land first.
    if (!mutationSlotAvailable('The directory submission')) return;
    if (queuedWrites > 0) {
      Alert.alert('Still syncing', 'Your latest changes have not finished syncing yet. Submit this partner once they are saved.');
      return;
    }
    const userId = activeUserId;
    setDirectorySubmitBusy(true);
    try {
      const result = await submitPartnerToDirectory(partner.id);
      if (activeUserIdRef.current !== userId) return;
      if (!result.linked) {
        Alert.alert('Already in your list', 'Another entry in your list is already linked to this directory listing, so this one stays in your list only.');
        return;
      }
      const updated: Partner = {
        ...partner,
        globalPartnerId: result.listingId,
        globalListingStatus: result.status,
        directoryRejectedAt: undefined,
        directoryReviewNote: undefined,
      };
      const nextPartners = partners.map((item) => item.id === updated.id ? { ...item, ...updated } : item);
      setPartners(nextPartners);
      setSelectedPartner((current) => current?.id === updated.id ? updated : current);
      await syncDerived({ partners: nextPartners, referrals, referralMatches, touches, followUps, scorecards }).catch(() => undefined);
      if (activeUserIdRef.current !== userId) return;
      if (result.status === 'pending') {
        Alert.alert('Sent for review', 'ReferralFit will review this listing before it appears in the shared directory. It stays in your list either way, and your relationship notes are not shared.');
      } else {
        Alert.alert('Already in the directory', 'This one was already listed, so your entry is now linked to that listing.');
      }
    } catch (error) {
      if (activeUserIdRef.current === userId) {
        Alert.alert('Not submitted yet', isNetworkError(error)
          ? 'You appear to be offline. It is saved to your list; submit it once you are connected.'
          : (error as Error).message);
      }
    } finally {
      setDirectorySubmitBusy(false);
    }
  }

  function addReferral(disclosureConfirmed = false) {
    if (!referralForm.partnerId || !referralForm.clientLabel.trim()) {
      Alert.alert('A little more detail', 'Choose a partner and add a client or family label.');
      return;
    }
    const chosenPartner = partners.find((item) => item.id === referralForm.partnerId);
    if (activeReferralMatchId && chosenPartner) {
      // Assigning from a match: a pick below the top needs a reason, and a
      // program with a disclosed relationship needs one more tap.
      if (placementRankFor(activeReferralMatchId, chosenPartner.id) > 1 && !placementReason) {
        Alert.alert('One more thing', 'This program was not the top match. Choose the reason so the placement record is complete.');
        return;
      }
      if (!disclosureConfirmed && hasFinancialRelationship(chosenPartner)) {
        confirmDisclosedRelationship(chosenPartner, () => addReferral(true));
        return;
      }
    }
    if (!mutationSlotAvailable('The referral')) return;
    const previousReferralUi = {
      referralForm, showAddReferral, activeReferralMatchId, tab,
      selectedMatchId, matchClientLabel, matchType, matchInsurance,
      matchNetworkPreferences, matchState, matchBudget, matchTherapies,
      matchMustHave, matchPopulation, matchLocationPreference,
    };
    const referral: Referral = {
      id: makeId('r'),
      partnerId: referralForm.partnerId,
      direction: referralForm.direction,
      date: localDateStamp(),
      clientLabel: referralForm.clientLabel.trim(),
      outcome: referralForm.outcome,
      note: referralForm.note.trim(),
    };
    const nextReferrals = [referral, ...referrals];
    setReferrals(nextReferrals);
    let assignedMatch: ReferralMatch | null = null;
    let nextMatches = referralMatches;
    if (activeReferralMatchId) {
      const nextActiveMatch = referralMatches.find((item) => item.status === 'Matching' && item.id !== activeReferralMatchId);
      assignedMatch = referralMatches.find((item) => item.id === activeReferralMatchId) || null;
      nextMatches = referralMatches.map((item) => item.id === activeReferralMatchId
        ? {
            ...item,
            clientLabel: referral.clientLabel,
            status: 'Referred' as const,
            assignedPartnerId: referral.partnerId,
            referralId: referral.id,
            updatedAt: new Date().toISOString(),
          }
        : item);
      setReferralMatches(nextMatches);
      if (nextActiveMatch) loadReferralMatch(nextActiveMatch);
      else startNewReferralMatch();
    }
    const nextPartners = partners.map((partner) => partner.id === referral.partnerId
      ? {
          ...partner,
          inbound: partner.inbound + (referral.direction === 'Inbound' ? 1 : 0),
          outbound: partner.outbound + (referral.direction === 'Outbound' ? 1 : 0),
          lastContact: referral.date,
        }
      : partner);
    setPartners(nextPartners);
    setShowAddReferral(false);
    setReferralForm(emptyReferral);
    if (activeReferralMatchId) setTab('referrals');
    setActiveReferralMatchId(null);
    const snapshot: Snapshot = { partners: nextPartners, referrals: nextReferrals, referralMatches: nextMatches, touches, followUps, scorecards };
    // The placement record is written after the assignment it describes.
    const decision = assignedMatch && chosenPartner ? buildPlacementDecision(assignedMatch, chosenPartner, referral.id, new Date()) : null;
    clearPendingPlacement();
    // Assignment flow: referral first, then the match profile update.
    void settleOptimisticWrite(
      async () => {
        if (assignedMatch) {
          await assignMatchReferral(referral, { ...assignedMatch, clientLabel: referral.clientLabel, status: 'Referred', assignedPartnerId: referral.partnerId, referralId: referral.id, updatedAt: new Date().toISOString() }, activeUserId);
          if (decision) await recordPlacementDecision(decision, activeUserId);
        } else {
          await createReferral(referral, activeUserId);
        }
      },
      snapshot,
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => {
        setPartners(partners); setReferrals(referrals); setReferralMatches(referralMatches);
        setReferralForm(previousReferralUi.referralForm);
        setShowAddReferral(previousReferralUi.showAddReferral);
        setActiveReferralMatchId(previousReferralUi.activeReferralMatchId);
        setTab(previousReferralUi.tab);
        setSelectedMatchId(previousReferralUi.selectedMatchId);
        setMatchClientLabel(previousReferralUi.matchClientLabel);
        setMatchType(previousReferralUi.matchType);
        setMatchInsurance(previousReferralUi.matchInsurance);
        setMatchNetworkPreferences(previousReferralUi.matchNetworkPreferences);
        setMatchState(previousReferralUi.matchState);
        setMatchBudget(previousReferralUi.matchBudget);
        setMatchTherapies(previousReferralUi.matchTherapies);
        setMatchMustHave(previousReferralUi.matchMustHave);
        setMatchPopulation(previousReferralUi.matchPopulation);
        setMatchLocationPreference(previousReferralUi.matchLocationPreference);
      },
      'The referral',
    );
  }

  function openTouchLogger(partner: Partner) {
    setTouchPartner(partner);
    setTouchKind('call');
    setTouchNote('');
  }

  function saveTouch() {
    if (!touchPartner) return;
    if (!mutationSlotAvailable('The touch')) return;
    const now = new Date();
    const touch: Touch = {
      id: makeId('t'),
      partnerId: touchPartner.id,
      kind: touchKind,
      note: touchNote.trim(),
      occurredAt: now.toISOString(),
    };
    const nextTouches = [touch, ...touches];
    setTouches(nextTouches);
    // Reflect last contact locally right away; the server trigger keeps
    // partners.last_contact_at in sync for the canonical value.
    const todayStamp = localDateStamp();
    const nextPartners = partners.map((partner) => partner.id === touchPartner.id
      ? { ...partner, lastContact: todayStamp }
      : partner);
    setPartners(nextPartners);
    setSelectedPartner((current) => current?.id === touchPartner.id ? { ...current, lastContact: todayStamp } : current);
    setTouchPartner(null);
    setTouchNote('');
    setTouchKind('call');
    void settleOptimisticWrite(
      () => createTouch(touch, activeUserId),
      { partners: nextPartners, referrals, referralMatches, touches: nextTouches, followUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => { setTouches(touches); setPartners(partners); setSelectedPartner((current) => current?.id === touch.partnerId ? partners.find((item) => item.id === touch.partnerId) || current : current); },
      'The touch',
    );
  }

  function toggleFavorite(id: string) {
    const target = partners.find((partner) => partner.id === id);
    if (!target) return;
    if (!mutationSlotAvailable('The favorite change')) return;
    const updated = { ...target, favorite: !target.favorite };
    const nextPartners = partners.map((partner) => partner.id === id ? updated : partner);
    setPartners(nextPartners);
    setSelectedPartner((current) => current?.id === id ? { ...current, favorite: !current.favorite } : current);
    void settleOptimisticWrite(
      () => updatePartner(updated, activeUserId),
      { partners: nextPartners, referrals, referralMatches, touches, followUps, scorecards },
      { partners, referrals, referralMatches, touches, followUps, scorecards },
      () => { setPartners(partners); setSelectedPartner((current) => current?.id === id ? target : current); },
      'The favorite change',
    );
  }

  function confirmSignOut() {
    Alert.alert('Sign out?', 'Offline data remains in this account’s isolated on-device cache.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: async () => {
        try {
          await unregisterThisDevice();
          await cancelReferralFitNotifications();
          const { error } = await supabase.auth.signOut();
          if (error) throw error;
          resetAccountState();
        } catch (error) {
          Alert.alert('Could not sign out', (error as Error).message);
        }
      } },
    ]);
  }

  function renderHeader(title?: string) {
    return (
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <Image accessibilityLabel="ReferralFit partner network logo" source={require('./assets/icon-referent-symbiosis.png')} style={styles.brandMark} />
          <TouchableOpacity accessibilityLabel={title || 'ReferralFit'} activeOpacity={0.7} onLongPress={confirmSignOut} delayLongPress={1200}>
            <Text style={styles.brandName}>{title || 'ReferralFit'}</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Workspace and team"
            style={styles.headerIconButton}
            onPress={() => setShowWorkspace(true)}
          >
            <AppIcon name="people-outline" size={20} color={COLORS.gray} />
          </TouchableOpacity>
          {notificationPermissionState === 'blocked' ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Notifications are off. Open device settings"
              style={styles.headerIconButton}
              onPress={() => Linking.openSettings().catch((error) => Alert.alert('Settings unavailable', (error as Error).message))}
            >
              <AppIcon name="notifications-off-outline" size={20} color={COLORS.coral} />
            </TouchableOpacity>
          ) : null}
          {offline ? (
            <View style={styles.offlineBadge}>
              <AppIcon name="cloud-offline-outline" size={13} color={COLORS.gray} />
              <Text numberOfLines={2} style={styles.offlineBadgeText}>Offline — showing cached data{queuedWrites > 0 ? ` · ${queuedWrites} to sync` : ''}</Text>
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  // Pull-to-refresh control shared by the four list screens, plus the inline
  // notice a failed pull leaves behind (cleared by the next refresh that
  // reaches the server).
  function renderRefreshControl() {
    return <RefreshControl refreshing={pullRefreshing} onRefresh={() => { void pullToRefresh(); }} tintColor={COLORS.forest} colors={[COLORS.forest]} />;
  }

  function renderRefreshNotice() {
    if (!refreshNotice) return null;
    return (
      <View style={styles.refreshNotice}>
        <AppIcon name="cloud-offline-outline" size={14} color={COLORS.gray} />
        <Text style={styles.refreshNoticeText}>{refreshNotice}</Text>
      </View>
    );
  }

  // "Showing saved copy" line for a case list or case file that came from
  // the offline cache (or could not be loaded at all).
  function renderSavedCopyNotice(copy: CachedCopyState | null, what: 'case list' | 'case file') {
    if (!copy || copy.source === 'remote') return null;
    const body = copy.source === 'unavailable'
      ? `No connection and no saved copy of this ${what} yet. Reconnect and pull down to refresh.`
      : `Showing saved copy from ${relativeActivity(copy.savedAt) || 'earlier'}.${copy.truncated ? ` Latest ${MAX_CACHED_EVENTS_PER_FILE} timeline entries only.` : ''}${what === 'case file' ? ' Opening a document needs a connection.' : ''}`;
    return (
      <View style={styles.refreshNotice}>
        <AppIcon name="cloud-offline-outline" size={14} color={COLORS.gray} />
        <Text style={styles.refreshNoticeText}>{body}</Text>
      </View>
    );
  }

  // The visible speed-to-lead clock on a NEW LEADS card: time since the lead
  // arrived against the workspace target, plus the danger flag when the
  // caller reported someone in danger right now.
  function renderLeadClock(lead: NonNullable<TodayCard['lead']>) {
    const waited = minutesWaiting(lead.arrivedAt, nowTick);
    const late = waited > lead.targetMinutes;
    return (
      <View style={styles.todayLeadBadgeRow}>
        {lead.immediateDanger ? <Text style={styles.todayLeadDanger}>⚠️ Caller reported immediate danger</Text> : null}
        <Text style={[styles.todayLeadClock, late && styles.todayLeadClockLate]} accessibilityLabel={`Waiting ${formatWaiting(waited)}`}>
          ⏱ {formatWaiting(waited)} waiting{late ? ` · past the ${lead.targetMinutes} min target` : ` · target ${lead.targetMinutes} min`}
        </Text>
      </View>
    );
  }

  // Compact action row for the Today list. Primary row: Call / Text / Done;
  // the ⋯ overflow opens one sheet with Snooze + Set Next Step — all five
  // actions reachable in one tap + one sheet.
  function TodayCardRow({ card, overdue }: { card: TodayCard; overdue?: boolean }) {
    const openLinked = () => {
      if (card.caseId) openCaseById(card.caseId);
      else if (card.partnerId) {
        const partner = partners.find((item) => item.id === card.partnerId);
        if (partner) setSelectedPartner(partner);
      }
    };
    return (
      <View style={[styles.todayRow, overdue && styles.todayRowOverdue]}>
        <View style={[styles.todayKindIcon, overdue && styles.todayKindIconOverdue]}>
          <AppIcon name={todayKindIcon(card)} size={16} color={overdue ? COLORS.coral : COLORS.forest} />
        </View>
        <View style={styles.todayRowBody}>
          <TouchableOpacity activeOpacity={card.caseId || card.partnerId ? 0.7 : 1} onPress={openLinked}>
            <Text numberOfLines={2} style={styles.todayRowTitle}>{card.title}</Text>
            {card.subtitle ? <Text numberOfLines={1} style={styles.todayRowMeta}>{card.subtitle}</Text> : null}
            {overdue ? <Text style={styles.todayOverdueBadge}>{card.daysOverdue} {card.daysOverdue === 1 ? 'day' : 'days'} overdue</Text> : null}
            {card.lead ? renderLeadClock(card.lead) : null}
            {teamWorkspace && cardAssigneeLabel(card) ? <Text style={styles.todayRowMeta}>{cardAssigneeLabel(card)}</Text> : null}
          </TouchableOpacity>
          {teamWorkspace && card.lead && card.caseId && !caseAssignee(card.caseId) ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Take this lead — ${card.title}`} onPress={() => { void assignCaseTo(card.caseId as string, activeUserId); }} style={[styles.todayDoneButton, styles.todayTakeButton]}>
              <Text style={styles.todayDoneButtonText}>Take this lead</Text>
            </TouchableOpacity>
          ) : null}
          <View style={styles.todayActionRow}>
            <TouchableOpacity accessibilityLabel={`Call — ${card.title}`} onPress={() => cardContactAction(card, 'call')} style={styles.todayIconButton}>
              <AppIcon name="call" size={15} color={COLORS.forest} />
            </TouchableOpacity>
            <TouchableOpacity accessibilityLabel={`Text — ${card.title}`} onPress={() => cardContactAction(card, 'text')} style={styles.todayIconButton}>
              <AppIcon name="chatbubble" size={14} color={COLORS.forest} />
            </TouchableOpacity>
            <TouchableOpacity accessibilityLabel={`Done — ${card.title}`} onPress={() => openDoneSheet(card)} style={styles.todayDoneButton}>
              <Text style={styles.todayDoneButtonText}>Done</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityLabel={`More actions — ${card.title}`} onPress={() => setSnoozeCard(card)} style={styles.todayIconButton}>
              <AppIcon name="ellipsis-horizontal" size={16} color={COLORS.inkSoft} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  // Today Command Center — the prioritized daily operating list. The old
  // home told you what happened; this one tells you WHAT TO DO NEXT.
  function HomeScreen() {
    const loadLine = todayCounts.actions === 0
      ? 'Nothing on the list — enjoy the quiet, or add something below.'
      : `${todayCounts.actions} ${todayCounts.actions === 1 ? 'action' : 'actions'}${todayCounts.overdueCount > 0 ? ` · ${todayCounts.overdueCount} overdue` : ''}`;
    // Recent partner activity, newest referral first. No tallies of who owes
    // whom: placement follows fit, and relationships run on their cadence.
    const recentPartners = partners
      .filter((partner) => lastReferralByPartner[partner.id])
      .sort((a, b) => lastReferralByPartner[b.id].localeCompare(lastReferralByPartner[a.id]))
      .slice(0, 3);
    const openCases = cases.filter(isOpenCase).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return (
      <View style={{ flex: 1 }}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent} refreshControl={renderRefreshControl()}>
          {renderHeader()}
          {renderRefreshNotice()}
          <View style={styles.welcomeRow}>
            <Text style={styles.eyebrow}>{currentDateLabel()}</Text>
            <View style={styles.heroRow}>
              <Text style={[styles.heroTitle, styles.heroTitleGrow]}>Today</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="New lead" style={styles.addButton} onPress={() => setShowNewLead(true)}>
                <AppIcon name="call" size={18} color={COLORS.white} />
                <Text style={styles.addButtonText}>New lead</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.heroSubtitle}>{loadLine}</Text>
          </View>

          {teamWorkspace ? (
            <View style={styles.todayScopeBlock}>
              <View style={styles.segmented}>
                {(['mine', 'everyone'] as TodayScope[]).map((scope) => (
                  <TouchableOpacity key={scope} accessibilityRole="button" accessibilityState={{ selected: todayScope === scope }} onPress={() => setTodayScopeChoice(scope)} style={[styles.segment, todayScope === scope && styles.segmentActive]}>
                    <Text style={[styles.segmentText, todayScope === scope && styles.segmentTextActive]}>{scope === 'mine' ? 'Mine' : 'Everyone'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {todayScope === 'mine' ? <Text style={styles.todayRowMeta}>Mine shows what is assigned to you and anything nobody has taken yet.</Text> : null}
            </View>
          ) : null}

          {todaySections.newLeads.length ? (
            <View style={styles.todaySection}>
              <Text style={[styles.todaySectionHeader, styles.todaySectionHeaderLead]}>⚡ NEW LEADS</Text>
              {todaySections.newLeads.map((card) => <TodayCardRow key={card.id} card={card} />)}
            </View>
          ) : null}

          {todaySections.overdue.length ? (
            <View style={styles.todaySection}>
              <Text style={[styles.todaySectionHeader, styles.todaySectionHeaderOverdue]}>🔴 OVERDUE</Text>
              {todaySections.overdue.map((card) => <TodayCardRow key={card.id} card={card} overdue />)}
            </View>
          ) : null}

          {todaySections.today.length ? (
            <View style={styles.todaySection}>
              <Text style={styles.todaySectionHeader}>📞 TODAY</Text>
              {todaySections.today.map((card) => <TodayCardRow key={card.id} card={card} />)}
            </View>
          ) : null}

          {todaySections.partnersDue.length ? (
            <View style={styles.todaySection}>
              <Text style={styles.todaySectionHeader}>🤝 PARTNERS DUE</Text>
              {todaySections.partnersDue.map((card) => <TodayCardRow key={card.id} card={card} />)}
            </View>
          ) : null}

          {todayCounts.actions === 0 ? (
            <EmptyState icon="checkmark-circle-outline" title="List is clear" body="No actions due and no partners past cadence. Log a touch, or capture the next thing with + below." />
          ) : teamWorkspace && todayScope === 'mine' && !todaySections.newLeads.length && !todaySections.overdue.length && !todaySections.today.length && !todaySections.partnersDue.length ? (
            <EmptyState icon="checkmark-circle-outline" title="Nothing of yours is due" body="Everything due today belongs to a teammate. Switch to Everyone to see the whole practice." />
          ) : null}

          {/* The old home content lives down here, collapsed. */}
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="More network snapshot and recent activity" accessibilityState={{ expanded: showHomeMore }} style={styles.closedToggle} onPress={() => setShowHomeMore((current) => !current)}>
            <AppIcon name={showHomeMore ? 'chevron-down' : 'chevron-forward'} size={16} color={COLORS.gray} />
            <Text style={styles.closedToggleText}>More — network snapshot & recent activity</Text>
          </TouchableOpacity>
          {showHomeMore ? (
            <View>
              <View style={styles.statRow}>
                <View style={styles.statCard}>
                  <Text style={styles.statNumber}>{partners.length}</Text>
                  <Text style={styles.statLabel}>Network partners</Text>
                  <View style={styles.statDetail}><AppIcon name="people" size={13} color={COLORS.forest} /><Text style={styles.statDetailText}>{partnerTypes.length} categories</Text></View>
                </View>
                <View style={styles.statCard}>
                  <Text style={styles.statNumber}>{totals.inbound}</Text>
                  <Text style={styles.statLabel}>Inbound referrals</Text>
                  <View style={styles.statDetail}><AppIcon name="trending-up" size={13} color={COLORS.coral} /><Text style={styles.statDetailText}>Across your network</Text></View>
                </View>
              </View>

              {openCases.length ? (
                <>
                  <SectionTitle title="Active cases" action="View all" onPress={() => setTab('cases')} />
                  <View style={styles.followUpCard}>
                    {openCases.slice(0, 3).map((record, index) => {
                      const colors = CASE_STATUS_COLORS[record.status];
                      return (
                        <TouchableOpacity key={record.id} onPress={() => openCase(record.id)} style={[styles.followUpRow, index === Math.min(openCases.length, 3) - 1 && { borderBottomWidth: 0 }]}>
                          <View style={[styles.followUpIcon, { backgroundColor: colors.bg }]}><AppIcon name="folder" size={16} color={colors.fg} /></View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.followUpTitle} numberOfLines={1}>{record.title}</Text>
                            <Text style={styles.followUpMeta}>{record.status} · active {relativeActivity(record.updatedAt)}</Text>
                          </View>
                          <AppIcon name="chevron-forward" size={16} color={COLORS.gray} />
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              ) : null}

              <SectionTitle title="Partner activity" action="View all" onPress={() => setTab('referrals')} />
              <View style={styles.returnCard}>
                <View style={styles.returnIntro}>
                  <View style={styles.returnIcon}><AppIcon name="people" size={20} color={COLORS.forest} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.returnTitle}>{totals.active} {totals.active === 1 ? 'partner has' : 'partners have'} referral activity</Text>
                    <Text style={styles.returnBody}>Stay in touch on the cadence you set. Every placement follows the client's fit.</Text>
                  </View>
                </View>
                {recentPartners.map((partner, index) => (
                  <TouchableOpacity key={partner.id} onPress={() => setSelectedPartner(partner)} style={[styles.returnPartner, index === recentPartners.length - 1 && { borderBottomWidth: 0 }]}>
                    <Initials name={partner.organization} size={36} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.returnPartnerName}>{partner.organization}</Text>
                      <Text numberOfLines={1} style={styles.returnPartnerType}>{partnerActivityLine(partner, lastReferralByPartner[partner.id])}</Text>
                    </View>
                    <AppIcon name="chevron-forward" size={16} color={COLORS.gray} />
                  </TouchableOpacity>
                ))}
              </View>

              <SectionTitle title="Recent activity" action="Log referral" onPress={() => openReferral('Inbound')} />
              <View style={styles.activityCard}>
                {recentReferrals.length ? recentReferrals.slice(0, 3).map((referral, index) => {
                  const partner = partners.find((item) => item.id === referral.partnerId);
                  if (!partner) return null;
                  return (
                    <View key={referral.id} style={[styles.activityRow, index === 2 && { borderBottomWidth: 0 }]}>
                      <View style={[styles.directionIcon, referral.direction === 'Inbound' ? styles.inboundIcon : styles.outboundIcon]}>
                        <AppIcon name={referral.direction === 'Inbound' ? 'arrow-down' : 'arrow-up'} size={16} color={referral.direction === 'Inbound' ? COLORS.forest : COLORS.blue} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.activityTitle}>{referral.direction} · {referral.clientLabel}</Text>
                        <Text style={styles.activityBody} numberOfLines={1}>{partner.organization}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={styles.activityDate}>{shortDate(referral.date)}</Text>
                        <Text style={styles.activityOutcome}>{referral.outcome}</Text>
                      </View>
                    </View>
                  );
                }) : <EmptyState icon="swap-horizontal-outline" title="No referrals yet" body="Your inbound and outbound activity will appear here." />}
              </View>
            </View>
          ) : null}
        </ScrollView>
        <TouchableOpacity accessibilityLabel="Quick add — I need to" onPress={() => setShowQuickAdd(true)} style={styles.fab}>
          <AppIcon name="add" size={26} color={COLORS.white} />
        </TouchableOpacity>
      </View>
    );
  }

  function MatchScreen() {
    const activeMatch = activeReferralMatches.find((item) => item.id === selectedMatchId);
    return (
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {renderHeader('Placement match')}
        <View style={styles.screenIntro}>
          <Text style={styles.screenTitle}>Who fits this client?</Text>
          <Text style={styles.screenSubtitle}>Clinical and financial fit come first. Relationship history is used only when fit is equal.</Text>
        </View>

        <View style={styles.savedMatchesSection}>
          <View style={styles.savedMatchesHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>Active referral matches</Text>
              <Text style={styles.savedMatchesSubtitle}>Assigned referrals move to the Referrals tab.</Text>
            </View>
            <TouchableOpacity style={styles.newMatchButton} onPress={startNewReferralMatch}>
              <AppIcon name="add" size={18} color={COLORS.white} />
              <Text style={styles.newMatchButtonText}>New</Text>
            </TouchableOpacity>
          </View>
          {activeReferralMatches.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.savedMatchList}>
              {activeReferralMatches.map((item) => {
                const assignedPartner = partners.find((partner) => partner.id === item.assignedPartnerId);
                const selected = item.id === selectedMatchId;
                return (
                  <View key={item.id} style={[styles.savedMatchCard, selected && styles.savedMatchCardActive]}>
                    <TouchableOpacity
                      accessibilityLabel={`Select referral match for ${item.clientLabel}`}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      onPress={() => loadReferralMatch(item)}
                      style={styles.savedMatchSelectButton}
                    >
                      <View style={styles.savedMatchTop}>
                        <View style={[styles.savedMatchIcon, item.status === 'Referred' && styles.savedMatchIconComplete]}><AppIcon name={item.status === 'Referred' ? 'checkmark' : 'person-outline'} size={16} color={item.status === 'Referred' ? COLORS.white : COLORS.forest} /></View>
                        <Text numberOfLines={1} style={styles.savedMatchName}>{item.clientLabel}</Text>
                      </View>
                      <Text numberOfLines={1} style={styles.savedMatchMeta}>{item.levelOfCare === 'Any type' ? 'Any level' : item.levelOfCare} · {item.state === 'ANY' ? 'Any location' : item.state}</Text>
                      <Text style={[styles.savedMatchStatus, item.status === 'Referred' && styles.savedMatchStatusComplete]}>{assignedPartner ? `Referred to ${assignedPartner.organization}` : 'Matching in progress'}</Text>
                    </TouchableOpacity>
                    <View style={styles.savedMatchActions}>
                      {item.status === 'Referred' && assignedPartner ? (
                        <TouchableOpacity accessibilityLabel={`Send packet for ${item.clientLabel}`} accessibilityRole="button" style={styles.savedMatchPacketButton} onPress={() => openPacketForAssigned(item)}>
                          <AppIcon name="paper-plane-outline" size={13} color={COLORS.forest} />
                          <Text style={styles.savedMatchPacketButtonText}>Send packet</Text>
                        </TouchableOpacity>
                      ) : null}
                      <TouchableOpacity accessibilityLabel={`Remove ${item.clientLabel} from active referral matches`} accessibilityRole="button" style={styles.savedMatchRemoveButton} onPress={() => removeReferralMatch(item)}>
                        <AppIcon name="close-circle-outline" size={14} color={COLORS.coral} />
                        <Text style={styles.savedMatchRemoveButtonText}>Remove</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          ) : <Text style={styles.noSavedMatches}>No active matches. Create and save a client match now; add partners whenever you are ready.</Text>}
        </View>

        <View style={styles.filterCard}>
          <View style={styles.matchEditorHeader}>
            <View>
              <Text style={styles.matchEditorTitle}>{activeMatch ? 'Edit referral match' : 'New referral match'}</Text>
              <Text style={styles.matchEditorStatus}>{activeMatch?.status === 'Referred' ? 'Referred · update or reuse these criteria' : 'Matching criteria'}</Text>
            </View>
            <TouchableOpacity style={styles.saveMatchButton} onPress={saveCurrentReferralMatch}>
              <AppIcon name="bookmark" size={15} color={COLORS.forest} />
              <Text style={styles.saveMatchButtonText}>Save match</Text>
            </TouchableOpacity>
          </View>
          <FormField inputRef={matchClientLabelRef} label="CLIENT / FAMILY LABEL *" value={matchClientLabel} onChangeText={setMatchClientLabel} placeholder="Use initials or a private label" />
          <Text style={styles.privacyHint}><AppIcon name="lock-closed" size={13} color={COLORS.gray} /> Keep this de-identified; avoid protected health information.</Text>

          <DropdownField
            label="LEVEL OF CARE / PROVIDER"
            value={matchType}
            icon="business-outline"
            onChange={setMatchType}
            options={[{ label: 'Any level of care', value: 'Any type' }, ...partnerTypes.map((type) => ({ label: type, value: type }))]}
          />

          <DropdownField
            label="GEOGRAPHY"
            value={matchState}
            icon="location-outline"
            onChange={(state) => { setMatchState(state); setMatchInsurance('Cash pay'); }}
            options={[{ label: 'Any Location', value: 'ANY' }, ...stateOptions.map((state) => ({ label: state.name, value: state.code }))]}
          />

          <Text style={styles.fieldLabel}>INSURANCE NETWORK</Text>
          <View style={styles.networkPreferenceRow}>
            {(['In-network', 'Out-of-network'] as InsuranceNetworkPreference[]).map((preference) => {
              const selected = matchNetworkPreferences.includes(preference);
              return (
                <TouchableOpacity
                  key={preference}
                  accessibilityLabel={`${preference}: ${selected ? 'selected' : 'not selected'}`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected }}
                  activeOpacity={0.78}
                  onPress={() => toggleMatchNetworkPreference(preference)}
                  style={[styles.networkPreferenceOption, selected && styles.networkPreferenceOptionSelected]}
                >
                  <AppIcon name={selected ? 'checkbox' : 'square-outline'} size={21} color={selected ? COLORS.forest : COLORS.gray} />
                  <Text style={[styles.networkPreferenceText, selected && styles.networkPreferenceTextSelected]}>{preference}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.networkPreferenceHint}>{matchInsurance === 'Cash pay'
            ? 'This preference applies after you select an insurance provider.'
            : matchNetworkPreferences.length === 2
              ? 'Showing both contracted and out-of-network options. Verify benefits before placement.'
              : `Showing ${matchNetworkPreferences[0].toLowerCase()} options for ${matchInsurance}. Verify benefits before placement.`}</Text>

          <DropdownField
            label="PAYMENT / INSURANCE"
            value={matchInsurance}
            icon="card-outline"
            onChange={setMatchInsurance}
            options={insuranceDropdownOptions}
          />
          <Text style={styles.insuranceHint}>{matchState === 'ANY' ? 'Showing cash pay and major national providers.' : `Medicaid and regional ${stateOptions.find((state) => state.code === matchState)?.name} plans are listed first. Verify benefits and network status.`}</Text>
          {matchInsurance === 'Cash pay' ? (
            <View style={styles.budgetRow}>
              <View style={styles.budgetIcon}><AppIcon name="wallet-outline" size={18} color={COLORS.forest} /></View>
              <View style={{ flex: 1 }}><Text style={styles.inputCaption}>Maximum cash budget</Text><TextInput value={matchBudget} onChangeText={setMatchBudget} keyboardType="number-pad" placeholder="Optional" style={styles.inlineInput} /></View>
              <Text style={styles.budgetValue}>{matchBudget.trim() ? formatMoney(Number(matchBudget) || 0) : 'Any budget'}</Text>
            </View>
          ) : null}

          <Text style={styles.fieldLabel}>CLIENT</Text>
          <View style={styles.wrapPills}>
            {clientPopulations.map((population) => <Pill key={population} label={population === 'Any' ? 'Any adult or teen' : population} active={matchPopulation === population} onPress={() => setMatchPopulation(population)} />)}
          </View>
          <Text style={styles.matchFieldHint}>A requirement, not a preference: a client marked Women never sees a men-only program, and an adolescent never sees an adult-only one.</Text>

          <Text style={styles.fieldLabel}>HAS A BED FOR</Text>
          <View style={styles.wrapPills}>
            <Pill
              label={bedFilterOn ? 'Required' : 'Not required'}
              active={bedFilterOn}
              icon={bedFilterOn ? 'checkmark-circle' : undefined}
              onPress={() => {
                if (!bedFilterOn) setBedFor(bedForFromPopulation(matchPopulation));
                setBedFilterOn(!bedFilterOn);
              }}
            />
            {bedFilterOn ? (['men', 'women', 'any'] as BedFor[]).map((option) => (
              <Pill key={option} label={option === 'men' ? 'Men' : option === 'women' ? 'Women' : 'Anyone'} active={bedFor === option} onPress={() => setBedFor(option)} />
            )) : null}
          </View>
          <Text style={styles.matchFieldHint}>{bedFilterOn
            ? 'A program whose directory listing confirmed no bed today is hidden. A program that has not said stays, and sorts below confirmed openings among equal fit.'
            : 'Turn on to hide programs that confirmed they are full today. The client above pre-selects men or women; counts come live from the directory.'}</Text>

          <Text style={styles.fieldLabel}>LOCATION PREFERENCE</Text>
          <View style={styles.wrapPills}>
            {locationPreferences.map((preference) => <Pill key={preference} label={preference} active={matchLocationPreference === preference} onPress={() => setMatchLocationPreference(preference)} />)}
          </View>
          <Text style={styles.matchFieldHint}>{matchState === 'ANY' ? 'Choose a state above to score close-to-family or away-from-home.' : 'Close to family means in the same state; away from home means outside it.'}</Text>

          <MultiSelectDropdown
            label="THERAPEUTIC NEEDS"
            values={matchTherapies}
            options={therapyOptions}
            onChange={updateMatchTherapies}
            icon="medkit-outline"
          />
          {matchTherapies.length ? (
            <View style={styles.mustHaveBlock}>
              <Text style={styles.inputCaption}>Tap a need to make it a must-have. Must-haves hide programs that lack them; the rest shape the score.</Text>
              <View style={[styles.wrapPills, { marginTop: 8 }]}>
                {matchTherapies.map((need) => {
                  const required = isPopulationNeed(need) || matchMustHave.includes(need);
                  return (
                    <Pill
                      key={need}
                      label={required ? `${need} · must have` : need}
                      active={required}
                      disabled={isPopulationNeed(need)}
                      icon={required ? 'lock-closed' : undefined}
                      onPress={() => toggleMustHave(need)}
                    />
                  );
                })}
              </View>
            </View>
          ) : null}
        </View>

        <View style={styles.resultsHeading}>
          <View>
            <Text style={styles.sectionTitle}>Recommended matches</Text>
            <Text style={styles.resultsCount}>{matches.length} eligible {matches.length === 1 ? 'option' : 'options'}</Text>
          </View>
          <View style={styles.rankBadge}><AppIcon name="shield-checkmark" size={14} color={COLORS.forest} /><Text style={styles.rankBadgeText}>Fit ranked</Text></View>
        </View>

        {matches.length ? matches.slice(0, 8).map((match, index) => (
          <View key={match.partner.id} style={[styles.matchCard, index === 0 && styles.bestMatchCard]}>
            <TouchableOpacity onPress={() => setSelectedPartner(match.partner)} activeOpacity={0.85} style={styles.matchCardContent}>
              <View style={styles.matchRank}><Text style={[styles.matchRankText, index === 0 && { color: COLORS.white }]}>{index + 1}</Text></View>
              <View style={styles.matchMain}>
                <View style={styles.matchTopLine}>
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={2} style={styles.matchOrg}>{match.partner.organization}</Text>
                    <Text numberOfLines={1} style={styles.matchLocation}>{partnerTypeLabel(match.partner)} · {match.partner.city}, {match.partner.state}</Text>
                  </View>
                  <View style={styles.scoreBlock}><Text style={styles.scoreNumber}>{Math.round(match.total)}</Text><Text style={styles.scoreLabel}>FIT / 100</Text></View>
                </View>
                <View style={styles.matchReason}>
                  <AppIcon name="checkmark-circle" size={17} color={COLORS.forest} />
                  <Text style={styles.matchReasonText}>{[
                    match.requiredNeeds.length ? `Required: ${match.requiredNeeds.join(', ')}` : '',
                    match.matchedNeeds.length ? `Offers ${match.matchedNeeds.join(', ')}` : '',
                    match.missingNeeds.length ? `Not listed: ${match.missingNeeds.join(', ')}` : '',
                  ].filter(Boolean).join(' · ') || 'Meets every requirement'}</Text>
                </View>
                <View style={styles.matchDetails}>
                  <Text numberOfLines={1} style={[styles.matchDetailText, styles.matchInsuranceText]}>{matchInsurance === 'Cash pay'
                    ? match.partner.insurance.slice(0, 2).join(' · ') || 'Cash pay'
                    : `${match.networkStatus} · ${matchInsurance}`}</Text>
                  <Text numberOfLines={1} style={styles.matchPriceText}>{formatMoney(monthlyCostForPartner(match.partner))}/month</Text>
                </View>
                {bedLineForPartner(match.partner) ? (
                  <Text numberOfLines={1} style={bedLineForPartner(match.partner).endsWith('Unconfirmed') ? styles.bedLineUnconfirmed : styles.bedLineOpen}>{bedLineForPartner(match.partner)}</Text>
                ) : null}
                {match.verifyBenefits || match.disclosure ? (
                  <View style={styles.matchFlags}>
                    {match.verifyBenefits ? <View style={styles.verifyBadge}><AppIcon name="alert-circle-outline" size={12} color={COLORS.inkSoft} /><Text style={styles.verifyBadgeText}>Verify benefits</Text></View> : null}
                    {match.disclosure ? <View style={styles.disclosureBadge}><AppIcon name="information-circle-outline" size={12} color={COLORS.coral} /><Text style={styles.disclosureBadgeText}>Disclosed relationship · {financialRelationshipLabel(match.partner.financialRelationship)}</Text></View> : null}
                  </View>
                ) : null}
              </View>
            </TouchableOpacity>
            <View style={styles.matchActionRow}>
              <TouchableOpacity style={styles.packetButton} onPress={() => openPacketComposer(match.partner, match)}>
                <AppIcon name="document-text" size={16} color={COLORS.forest} />
                <Text style={styles.packetButtonText}>Send packet</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.assignReferralButton, styles.matchActionFlex]} onPress={() => openMatchedReferral(match.partner.id)}>
                <AppIcon name="paper-plane" size={16} color={COLORS.white} />
                <Text style={styles.assignReferralButtonText}>Assign & refer {matchClientLabel.trim() || 'this client'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )) : <EmptyState icon="search-outline" title="No eligible matches yet" body="Broaden one of the filters or add another partner to the directory." />}
      </ScrollView>
    );
  }

  // Case list row shared by the main list and search results. The primary
  // contact shown on the card comes from the workspace-wide contact list
  // loaded with the cases, so it shows without opening the file.
  function CaseRow({ record, lastInGroup }: { record: CaseRecord; lastInGroup?: boolean }) {
    const colors = CASE_STATUS_COLORS[record.status];
    const primary = allCaseContacts.find((item) => item.caseId === record.id && item.isPrimary);
    return (
      <TouchableOpacity onPress={() => openCase(record.id)} style={[styles.caseRow, lastInGroup && { borderBottomWidth: 0 }]}>
        <View style={[styles.caseRowIcon, { backgroundColor: colors.bg }]}><AppIcon name="folder" size={17} color={colors.fg} /></View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={styles.caseRowTitle}>{record.title}</Text>
          <View style={styles.caseRowMetaLine}>
            <View style={[styles.caseChip, { backgroundColor: colors.bg }]}><Text style={[styles.caseChipText, { color: colors.fg }]}>{record.status}</Text></View>
            <View style={[styles.caseChip, { backgroundColor: COLORS.mintPale }]}><Text style={[styles.caseChipText, { color: COLORS.forest }]}>{record.paidAmount > 0 ? `${formatMoney(record.paidAmount)} paid` : record.paymentStatus === 'none' ? 'no payment' : record.paymentStatus}</Text></View>
          </View>
          <Text numberOfLines={1} style={styles.caseRowMeta}>
            {primary ? `${primary.name}${primary.phone ? ` · ${primary.phone}` : ''} · ` : ''}active {relativeActivity(record.updatedAt)}
          </Text>
        </View>
        <AppIcon name="chevron-forward" size={16} color={COLORS.gray} />
      </TouchableOpacity>
    );
  }

  function CasesScreen() {
    const openCases = cases.filter(isOpenCase).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const closedCases = cases.filter((item) => !isOpenCase(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const totalRevenue = cases.reduce((sum, record) => sum + record.paidAmount, 0);
    const openBalance = openCases.reduce((sum, record) => sum + Math.max((record.quotedAmount ?? record.paidAmount) - record.paidAmount, 0), 0);
    const searching = caseSearch.trim().length > 0;
    const resultCases = searching && caseSearchResults
      ? caseSearchResults.map((result) => cases.find((item) => item.id === result.caseId)).filter((item): item is CaseRecord => Boolean(item))
      : [];
    return (
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" refreshControl={renderRefreshControl()}>
        {renderHeader('Cases')}
        {renderRefreshNotice()}
        {renderSavedCopyNotice(caseListSource, 'case list')}
        <View style={styles.directoryTitleRow}>
          <View style={styles.directoryTitleCopy}><Text style={styles.screenTitle}>Case files</Text><Text style={styles.screenSubtitle}>One family, one place — contacts, notes, documents, and the timeline.</Text></View>
          <View style={styles.caseHeaderActions}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Open business dashboard"
              style={styles.businessButton}
              onPress={() => {
                if (!entitlements.loadedAt) {
                  Alert.alert('Subscription status unavailable', 'Reconnect and try again before opening paid business analytics.');
                  return;
                }
                if (!entitlements.entitlements.pro) {
                  Alert.alert('Pro plan required', 'Full business analytics are available on the Pro plan.');
                  return;
                }
                setShowBusinessDashboard(true);
                void refreshBusiness();
              }}
            >
              <AppIcon name="bar-chart-outline" size={18} color={COLORS.forest} />
              <Text style={styles.businessButtonText}>Business</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.addButton} onPress={() => { setCaseForm(makeEmptyCaseForm()); setShowNewCase(true); }}><AppIcon name="add" size={22} color={COLORS.white} /><Text style={styles.addButtonText}>New case</Text></TouchableOpacity>
          </View>
        </View>
        <View style={styles.caseRevenueCard}>
          <View style={styles.caseRevenueMetric}>
            <Text style={styles.caseRevenueLabel}>TOTAL PAID REVENUE</Text>
            <Text style={styles.caseRevenueValue}>{formatMoney(totalRevenue)}</Text>
          </View>
          <View style={styles.caseRevenueDivider} />
          <View style={styles.caseRevenueMetric}>
            <Text style={styles.caseRevenueLabel}>OPEN QUOTED BALANCE</Text>
            <Text style={styles.caseRevenueValue}>{formatMoney(openBalance)}</Text>
          </View>
        </View>
        <View style={styles.searchBox}>
          <AppIcon name="search" size={19} color={COLORS.gray} />
          <TextInput
            value={caseSearch}
            onChangeText={setCaseSearch}
            placeholder="Case title, contact name, or phone number"
            placeholderTextColor="#91A09B"
            style={styles.searchInput}
          />
          {caseSearch ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear case search" style={styles.searchClearButton} onPress={() => setCaseSearch('')}><AppIcon name="close-circle" size={18} color={COLORS.gray} /></TouchableOpacity> : null}
        </View>

        {searching ? (
          <View style={[styles.followUpCard, { marginTop: 14 }]}>
            {caseSearching ? <Text style={styles.caseSearchHint}>Searching…</Text> : null}
            {!caseSearching && resultCases.length === 0 ? (
              <Text style={styles.caseSearchHint}>No cases match "{caseSearch.trim()}". Phone search matches on the last digits, so a local number still finds a +1 contact.</Text>
            ) : null}
            {resultCases.map((record, index) => (
              <TouchableOpacity key={record.id} onPress={() => openCase(record.id)} style={[styles.caseRow, index === resultCases.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={[styles.caseRowIcon, { backgroundColor: CASE_STATUS_COLORS[record.status].bg }]}><AppIcon name="folder" size={17} color={CASE_STATUS_COLORS[record.status].fg} /></View>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={styles.caseRowTitle}>{record.title}</Text>
                  <Text numberOfLines={1} style={styles.caseRowMeta}>{record.status} · last activity {relativeActivity(record.updatedAt)}</Text>
                </View>
                <AppIcon name="chevron-forward" size={16} color={COLORS.gray} />
              </TouchableOpacity>
            ))}
          </View>
        ) : (
          <>
            <Text style={styles.directoryCount}>{openCases.length} OPEN {openCases.length === 1 ? 'CASE' : 'CASES'}</Text>
            {openCases.length ? (
              <View style={styles.followUpCard}>
                {openCases.map((record, index) => <CaseRow key={record.id} record={record} lastInGroup={index === openCases.length - 1} />)}
              </View>
            ) : (
              <EmptyState icon="folder-open-outline" title="No cases yet" body="A case file keeps one family's contacts, notes, documents, and timeline in a single place. Start one from the first call." />
            )}
            {closedCases.length ? (
              <View style={{ marginTop: 18 }}>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${showClosedCases ? 'Collapse' : 'Expand'} closed cases`} accessibilityState={{ expanded: showClosedCases }} style={styles.closedToggle} onPress={() => setShowClosedCases((current) => !current)}>
                  <AppIcon name={showClosedCases ? 'chevron-down' : 'chevron-forward'} size={16} color={COLORS.gray} />
                  <Text style={styles.closedToggleText}>Closed ({closedCases.length})</Text>
                </TouchableOpacity>
                {showClosedCases ? (
                  <View style={styles.followUpCard}>
                    {closedCases.map((record, index) => <CaseRow key={record.id} record={record} lastInGroup={index === closedCases.length - 1} />)}
                  </View>
                ) : null}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    );
  }

  function DirectoryScreen() {
    return (
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" refreshControl={renderRefreshControl()}>
        {renderHeader('Directory')}
        {renderRefreshNotice()}
        <View style={styles.directoryTitleRow}>
          <View style={styles.directoryTitleCopy}><Text style={styles.screenTitle}>Your network</Text><Text style={styles.screenSubtitle}>{partners.length} people and programs</Text></View>
          <TouchableOpacity style={styles.addButton} onPress={openNewPartner}><AppIcon name="add" size={22} color={COLORS.white} /><Text style={styles.addButtonText}>Add</Text></TouchableOpacity>
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Browse the ReferralFit directory"
          style={styles.globalDirectoryBanner}
          onPress={() => setShowGlobalDirectory(true)}
        >
          <AppIcon name="globe-outline" size={20} color={COLORS.blue} />
          <View style={styles.globalDirectoryCopy}>
            <Text style={styles.globalDirectoryTitle}>ReferralFit Directory</Text>
            <Text style={styles.globalDirectorySubtitle}>Verified programs and professionals, ready to add to your network</Text>
          </View>
          <AppIcon name="chevron-forward" size={18} color={COLORS.gray} />
        </TouchableOpacity>
        <View style={styles.searchBox}>
          <AppIcon name="search" size={19} color={COLORS.gray} />
          <TextInput value={search} onChangeText={setSearch} placeholder="Name, program, location, specialty" placeholderTextColor="#91A09B" style={styles.searchInput} />
          {search ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear directory search" style={styles.searchClearButton} onPress={() => setSearch('')}><AppIcon name="close-circle" size={18} color={COLORS.gray} /></TouchableOpacity> : null}
        </View>
        <View style={styles.directoryDropdown}>
          <DropdownField
            label="CATEGORY"
            value={directoryType}
            icon="layers-outline"
            onChange={setDirectoryType}
            options={[{ label: 'All categories', value: 'All' }, ...partnerTypes.map((type) => ({ label: type, value: type }))]}
          />
        </View>
        <View style={styles.directoryCountRow}><Text style={styles.directoryCount}>{directoryPartners.length} RESULTS</Text><AppIcon name="options-outline" size={18} color={COLORS.gray} /></View>
        {directoryPartners.map((partner) => <PartnerCard key={partner.id} partner={partner} lastReferralOn={lastReferralByPartner[partner.id]} onPress={() => setSelectedPartner(partner)} onShare={() => sharePartner(partner)} />)}
        {!directoryPartners.length ? <EmptyState icon="people-outline" title="No partners found" body="Try another search or add a new relationship." /> : null}
      </ScrollView>
    );
  }

  function ReferralsScreen() {
    return (
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent} refreshControl={renderRefreshControl()}>
        {renderHeader('Referral ledger')}
        {renderRefreshNotice()}
        <View style={styles.directoryTitleRow}>
          <View><Text style={styles.screenTitle}>Referrals</Text><Text style={styles.screenSubtitle}>Referral history at a glance</Text></View>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Add inbound referral" style={styles.roundAdd} onPress={() => openReferral('Inbound')}><AppIcon name="add" size={24} color={COLORS.white} /></TouchableOpacity>
        </View>

        <View style={styles.ledgerSummary}>
          <View style={styles.ledgerMetric}>
            <View style={[styles.ledgerIcon, { backgroundColor: COLORS.mint }]}><AppIcon name="arrow-down" size={18} color={COLORS.forest} /></View>
            <Text style={styles.ledgerNumber}>{totals.inbound}</Text><Text style={styles.ledgerLabel}>Inbound</Text>
          </View>
          <View style={styles.ledgerDivider} />
          <View style={styles.ledgerMetric}>
            <View style={[styles.ledgerIcon, { backgroundColor: '#E2EBEE' }]}><AppIcon name="arrow-up" size={18} color={COLORS.blue} /></View>
            <Text style={styles.ledgerNumber}>{totals.outbound}</Text><Text style={styles.ledgerLabel}>Outbound</Text>
          </View>
          <View style={styles.ledgerDivider} />
          <View style={styles.ledgerMetric}>
            <View style={[styles.ledgerIcon, { backgroundColor: COLORS.coralPale }]}><AppIcon name="people" size={18} color={COLORS.coral} /></View>
            <Text style={styles.ledgerNumber}>{totals.active}</Text><Text style={styles.ledgerLabel}>Active partners</Text>
          </View>
        </View>

        <View style={styles.quickLogRow}>
          <TouchableOpacity style={styles.quickLogButton} onPress={() => openReferral('Inbound')}><AppIcon name="arrow-down-circle" size={20} color={COLORS.forest} /><Text style={styles.quickLogText}>Log inbound</Text></TouchableOpacity>
          <TouchableOpacity style={styles.quickLogButton} onPress={() => openReferral('Outbound')}><AppIcon name="arrow-up-circle" size={20} color={COLORS.blue} /><Text style={styles.quickLogText}>Log outbound</Text></TouchableOpacity>
        </View>

        <SectionTitle title="Referral history" />
        <View style={styles.searchBox}>
          <AppIcon name="search" size={19} color={COLORS.gray} />
          <TextInput
            value={referralSearch}
            onChangeText={setReferralSearch}
            placeholder="Client label, partner, outcome, or note"
            placeholderTextColor="#91A09B"
            style={styles.searchInput}
          />
          {referralSearch ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear referral search" style={styles.searchClearButton} onPress={() => setReferralSearch('')}><AppIcon name="close-circle" size={18} color={COLORS.gray} /></TouchableOpacity> : null}
        </View>
        <View style={styles.referralFilterRow}>
          {(['All', 'Inbound', 'Outbound'] as const).map((direction) => (
            <TouchableOpacity
              key={direction}
              accessibilityRole="button"
              accessibilityState={{ selected: referralDirectionFilter === direction }}
              onPress={() => setReferralDirectionFilter(direction)}
              style={[styles.referralFilterButton, referralDirectionFilter === direction && styles.referralFilterButtonActive]}
            >
              <Text style={[styles.referralFilterText, referralDirectionFilter === direction && styles.referralFilterTextActive]}>{direction}</Text>
            </TouchableOpacity>
          ))}
          <Text style={styles.referralFilterCount}>{filteredReferrals.length} records</Text>
        </View>
        {filteredReferrals.length ? <View style={styles.referralList}>
          {filteredReferrals.map((referral, index) => {
            const partner = partners.find((item) => item.id === referral.partnerId);
            if (!partner) return null;
            return (
              <TouchableOpacity key={referral.id} onPress={() => setSelectedPartner(partner)} style={[styles.referralRow, index === filteredReferrals.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={[styles.referralDirectionLine, { backgroundColor: referral.direction === 'Inbound' ? COLORS.forest : COLORS.blue }]} />
                <View style={{ flex: 1 }}>
                  <View style={styles.referralTop}><Text style={styles.referralClient}>{referral.clientLabel}</Text><Text style={styles.referralDate}>{shortDate(referral.date)}</Text></View>
                  <Text style={styles.referralPartner}>{referral.direction === 'Inbound' ? 'From' : 'To'} {partner.organization}</Text>
                  <View style={styles.referralOutcome}><Text style={styles.referralOutcomeText}>{referral.outcome}</Text></View>
                </View>
              </TouchableOpacity>
            );
          })}
        </View> : <EmptyState icon="swap-horizontal-outline" title="No matching referrals" body={referrals.length ? 'Try another search or direction filter.' : 'Add a partner, then log your first inbound or outbound referral.'} />}

        <SectionTitle title="Partner activity" />
        {partners.length ? partners.slice().sort((a, b) => (lastReferralByPartner[b.id] || '').localeCompare(lastReferralByPartner[a.id] || '') || a.organization.localeCompare(b.organization)).slice(0, 5).map((partner) => (
          <TouchableOpacity key={partner.id} onPress={() => setSelectedPartner(partner)} style={styles.balanceRow}>
            <View style={styles.balanceNameRow}><Text style={styles.balanceName} numberOfLines={1}>{partner.organization}</Text></View>
            <Text style={styles.balanceNumbers}>{partnerActivityLine(partner, lastReferralByPartner[partner.id])}</Text>
          </TouchableOpacity>
        )) : <EmptyState icon="people-outline" title="No partners yet" body="Referral activity will appear here after you add referral partners." />}
      </ScrollView>
    );
  }

  function BottomNav() {
    const items: { key: Tab; label: string; icon: IconName; activeIcon: IconName }[] = [
      { key: 'home', label: 'Home', icon: 'home-outline', activeIcon: 'home' },
      { key: 'match', label: 'Match', icon: 'sparkles-outline', activeIcon: 'sparkles' },
      { key: 'cases', label: 'Cases', icon: 'folder-outline', activeIcon: 'folder' },
      { key: 'directory', label: 'Directory', icon: 'people-outline', activeIcon: 'people' },
      { key: 'referrals', label: 'Referrals', icon: 'swap-horizontal-outline', activeIcon: 'swap-horizontal' },
    ];
    return (
      <View style={styles.bottomNav}>
        {items.map((item) => {
          const active = tab === item.key;
          return (
            <TouchableOpacity key={item.key} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={`${item.label} tab`} onPress={() => setTab(item.key)} style={styles.navItem}>
              <View style={[styles.navIconWrap, active && styles.navIconActive]}><AppIcon name={active ? item.activeIcon : item.icon} size={21} color={active ? COLORS.white : COLORS.gray} /></View>
              <Text style={[styles.navLabel, active && styles.navLabelActive]}>{item.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  }

  // ─── Case file modals ────────────────────────────────────────────────────

  // The file itself: header (status + payment), contacts with one-tap
  // actions, the timeline, documents, and linked business objects.
  function CaseDetailModal() {
    if (!activeCase) return null;
    // iOS cannot reliably present a second sibling React Native <Modal> while
    // the case pageSheet is already on screen. Keep one native modal mounted
    // and swap its contents for every case-specific editor/sheet.
    if (caseEditForm) return EditCaseModal();
    if (caseBusinessForm) return CaseBusinessDetailsModal();
    if (casePaymentForm) return AddCasePaymentModal();
    if (caseNextStepCaseId === activeCase.id) return CaseNextStepModal(activeCase);
    if (caseContactForm) return CaseContactModal();
    if (quickNoteContact) return QuickNoteModal();
    if (docView) return DocViewModal();
    const record = activeCase;
    const colors = CASE_STATUS_COLORS[record.status];
    const linkedMatch = referralMatches.find((item) => item.id === record.matchProfileId)
      || referralMatches.find((item) => item.caseId === record.id)
      || null;
    const linkedReferrals = referrals.filter((item) => item.caseId === record.id || (linkedMatch ? item.matchProfileId === linkedMatch.id : false));
    const linkedFollowUps = followUps
      .filter((item) => item.caseId === record.id && item.status === 'open')
      .sort((a, b) => `${a.dueOn} ${a.dueTime || ''}`.localeCompare(`${b.dueOn} ${b.dueTime || ''}`));
    const timeline = caseEvents.slice().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    return (
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={closeCase}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close case file" onPress={closeCase} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>Case file</Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Edit case name and summary"
                style={styles.modalHeaderAction}
                onPress={() => setCaseEditForm({ title: record.title, summary: record.summary })}
              >
                <Text style={styles.saveText}>Edit</Text>
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">

              {/* Header: title, status picker chip, payment row, summary */}
              <View style={styles.profileHero}>
                <Text style={styles.profileOrg}>{record.title}</Text>
                <View style={styles.profileMeta}>
                  <TouchableOpacity
                    accessibilityLabel={`Status: ${record.status}. Tap to change.`}
                    onPress={() => Alert.alert('Case status', 'Every change is written to the timeline.', [...CASE_STATUSES.map((status): { text: string; onPress: () => void } => ({ text: status, onPress: () => changeCaseStatus(record, status) })), { text: 'Cancel', style: 'cancel' }])}
                    style={[styles.caseChip, styles.caseChipLarge, { backgroundColor: colors.bg }]}
                  >
                    <Text style={[styles.caseChipText, styles.caseChipLargeText, { color: colors.fg }]}>{record.status}</Text>
                    <AppIcon name="chevron-down" size={12} color={colors.fg} />
                  </TouchableOpacity>
                  {teamWorkspace ? (
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={`Assigned to ${record.assignedTo ? memberDisplayName(members, record.assignedTo) : 'nobody'}. Tap to change.`}
                      onPress={() => pickCaseAssignee(record)}
                      style={[styles.caseChip, styles.caseChipLarge, { backgroundColor: COLORS.mintPale }]}
                    >
                      <AppIcon name="person-outline" size={12} color={COLORS.forest} />
                      <Text style={[styles.caseChipText, styles.caseChipLargeText, { color: COLORS.forest }]}>{record.assignedTo ? (record.assignedTo === activeUserId.toLowerCase() ? 'Yours' : memberDisplayName(members, record.assignedTo)) : 'Unassigned'}</Text>
                      <AppIcon name="chevron-down" size={12} color={COLORS.forest} />
                    </TouchableOpacity>
                  ) : null}
                </View>
                <Text style={styles.profileName}>Opened {shortDate(record.createdAt.slice(0, 10))} · active {relativeActivity(record.updatedAt)}</Text>
              </View>
              {renderSavedCopyNotice(caseFileSource, 'case file')}

              <View style={styles.infoCard}>
                <View style={styles.caseSectionHeader}>
                  <View>
                    <Text style={styles.infoTitle}>Next steps</Text>
                    <Text style={styles.caseSectionHint}>Scheduled here also appears on Today when it is due.</Text>
                  </View>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`Schedule a next step for ${record.title}`}
                    onPress={() => openCaseNextStep(record)}
                    style={styles.caseSectionAction}
                  >
                    <AppIcon name="calendar-outline" size={15} color={COLORS.forest} /><Text style={styles.caseSectionActionText}>Schedule</Text>
                  </TouchableOpacity>
                </View>
                {linkedFollowUps.length ? linkedFollowUps.map((followUp) => (
                  <View key={followUp.id} style={styles.caseNextStepRow}>
                    <View style={[styles.followUpIcon, { width: 30, height: 30 }]}><AppIcon name="arrow-forward-circle-outline" size={15} color={COLORS.coral} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.touchLogTitle}>{followUp.title}</Text>
                      <Text style={styles.touchLogNote}>Due {shortDate(followUp.dueOn)}{followUp.dueTime ? ` at ${followUp.dueTime}` : ''}{followUp.waitingOn ? ` · Waiting on ${followUp.waitingOn}` : ''}</Text>
                    </View>
                    {teamWorkspace ? (
                      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Assigned to: ${followUpAssigneeLabel(followUp, record)}. Tap to change.`} onPress={() => pickFollowUpAssignee(followUp)} style={[styles.caseChip, { backgroundColor: COLORS.mintPale }]}>
                        <Text style={[styles.caseChipText, { color: COLORS.forest }]}>{followUpAssigneeLabel(followUp, record)}</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                )) : <Text style={styles.caseEmptyNote}>No next step scheduled. Add one so this case does not fall through the cracks.</Text>}
              </View>

              <View style={styles.infoCard}>
                <View style={styles.caseSectionHeader}>
                  <Text style={styles.infoTitle}>Attribution</Text>
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => setCaseBusinessForm({
                      leadSource: record.leadSource,
                      leadSourceDetail: record.leadSourceDetail,
                      lostReason: record.lostReason,
                    })}
                    style={styles.caseSectionAction}
                  >
                    <AppIcon name="create-outline" size={14} color={COLORS.forest} /><Text style={styles.caseSectionActionText}>Edit</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.businessDetailRow}>
                  <View style={styles.businessDetailMetric}>
                    <Text style={styles.infoLabel}>LEAD SOURCE</Text>
                    <Text style={styles.businessDetailValue}>{record.leadSource || 'Unspecified'}</Text>
                  </View>
                  <View style={styles.businessDetailMetric}>
                    <Text style={styles.infoLabel}>SOURCE DETAIL</Text>
                    <Text style={styles.businessDetailValue}>{record.leadSourceDetail || '—'}</Text>
                  </View>
                </View>
                {record.lostReason ? <Text style={styles.businessLostReason}>Lost reason: {record.lostReason}</Text> : null}
              </View>

              <View style={styles.infoCard}>
                <View style={styles.caseSectionHeader}>
                  <Text style={styles.infoTitle}>Payments</Text>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Add another payment"
                    onPress={() => setCasePaymentForm({ eventId: makeId('evt'), amount: '', note: '' })}
                    style={styles.caseSectionAction}
                  >
                    <AppIcon name="add" size={15} color={COLORS.forest} /><Text style={styles.caseSectionActionText}>Add payment</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.casePaymentRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.infoLabel}>Status</Text>
                    <TouchableOpacity
                      onPress={() => Alert.alert('Payment status', undefined, [...PAYMENT_STATUSES.map((status): { text: string; onPress: () => void } => ({ text: status, onPress: () => selectCasePaymentStatus(record, status) })), { text: 'Cancel', style: 'cancel' }])}
                      style={styles.casePaymentPicker}
                    >
                      <Text style={styles.casePaymentPickerText}>{record.paymentStatus}</Text>
                      <AppIcon name="chevron-down" size={14} color={COLORS.gray} />
                    </TouchableOpacity>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.infoLabel}>Quoted</Text>
                    <TextInput
                      key={`quoted-${record.quotedAmount ?? 'none'}`}
                      defaultValue={record.quotedAmount != null ? String(record.quotedAmount) : ''}
                      onEndEditing={(event) => {
                        const raw = event.nativeEvent.text.replace(/[^\d]/g, '');
                        const amount = raw ? Number(raw) : null;
                        if (amount !== record.quotedAmount) saveCasePayment(record, { quotedAmount: amount });
                      }}
                      keyboardType="number-pad"
                      placeholder="$0"
                      placeholderTextColor="#99A6A1"
                      style={styles.caseAmountInput}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.infoLabel}>Paid</Text>
                    <TextInput
                      key={`paid-${record.paidAmount}`}
                      defaultValue={record.paidAmount ? String(record.paidAmount) : ''}
                      onEndEditing={(event) => {
                        const raw = event.nativeEvent.text.replace(/[^\d]/g, '');
                        const amount = raw ? Number(raw) : 0;
                        if (amount !== record.paidAmount) saveCasePayment(record, { paidAmount: amount });
                      }}
                      keyboardType="number-pad"
                      placeholder="$0"
                      placeholderTextColor="#99A6A1"
                      style={styles.caseAmountInput}
                    />
                  </View>
                </View>
                <TouchableOpacity
                  accessibilityRole="button"
                  style={styles.caseAddPaymentButton}
                  onPress={() => setCasePaymentForm({ eventId: makeId('evt'), amount: '', note: '' })}
                >
                  <AppIcon name="card" size={17} color={COLORS.white} />
                  <Text style={styles.caseAddPaymentButtonText}>Record another payment</Text>
                </TouchableOpacity>
                <Text style={styles.casePaymentHint}>Enter a quote to mark the case quoted automatically. Use “Record another payment” for each coaching session or installment. Every change lands on the timeline.</Text>
              </View>

              <CaseIntegrationPanel record={record} integrations={businessData.integrations} onChanged={refreshBusiness} />

              <View style={[styles.infoCard, { marginTop: 12 }]}>
                <Text style={styles.infoTitle}>Summary</Text>
                <TextInput
                  key={`${record.id}:${record.summary}`}
                  defaultValue={record.summary}
                  onEndEditing={(event) => { if (event.nativeEvent.text.trim() !== record.summary) saveCaseSummary(record, event.nativeEvent.text); }}
                  placeholder="The situation in a few lines — who, what, where things stand."
                  placeholderTextColor="#99A6A1"
                  multiline
                  style={[styles.formInput, styles.multilineInput, { minHeight: 70 }]}
                />
              </View>

              {/* Contacts */}
              <View style={styles.caseSectionHeader}>
                <View>
                  <Text style={styles.infoTitleStandalone}>Contacts</Text>
                  <Text style={styles.caseSectionHint}>Tap a contact or Edit to change name, phone, or email.</Text>
                </View>
                <TouchableOpacity onPress={() => setCaseContactForm(makeEmptyCaseContactForm())} style={styles.caseSectionAction}>
                  <AppIcon name="add" size={15} color={COLORS.forest} /><Text style={styles.caseSectionActionText}>Add</Text>
                </TouchableOpacity>
              </View>
              {caseContacts.length ? (
                <View style={styles.followUpCard}>
                  {caseContacts.map((contact, index) => (
                    <View key={contact.id} style={[styles.caseContactRow, index === caseContacts.length - 1 && { borderBottomWidth: 0 }]}>
                      <View style={{ flex: 1 }}>
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel={`Edit contact information for ${contact.name}`}
                          onPress={() => setCaseContactForm({ id: contact.id, name: contact.name, relationship: contact.relationship, phone: contact.phone, email: contact.email, note: contact.note, isPrimary: contact.isPrimary })}
                          style={styles.caseContactEditTarget}
                        >
                          <View style={styles.caseContactNameLine}>
                            <Text style={styles.caseContactName}>{contact.name}</Text>
                            {contact.isPrimary ? <View style={[styles.caseChip, { backgroundColor: COLORS.mint }]}><Text style={[styles.caseChipText, { color: COLORS.forest }]}>primary</Text></View> : null}
                            <AppIcon name="create-outline" size={15} color={COLORS.gray} />
                          </View>
                          <Text style={styles.caseContactMeta}>{[contact.relationship, contact.phone, contact.email].filter(Boolean).join(' · ') || 'No details yet'}</Text>
                        </TouchableOpacity>
                        <View style={styles.caseContactActions}>
                          <TouchableOpacity accessibilityLabel={`Call ${contact.name}`} onPress={() => contactAction(contact, 'call')} style={styles.caseContactAction}><AppIcon name="call" size={15} color={COLORS.forest} /><Text style={styles.caseContactActionText}>Call</Text></TouchableOpacity>
                          <TouchableOpacity accessibilityLabel={`Text ${contact.name}`} onPress={() => contactAction(contact, 'text')} style={styles.caseContactAction}><AppIcon name="chatbubble" size={14} color={COLORS.forest} /><Text style={styles.caseContactActionText}>Text</Text></TouchableOpacity>
                          <TouchableOpacity accessibilityLabel={`Email ${contact.name}`} onPress={() => contactAction(contact, 'email')} style={styles.caseContactAction}><AppIcon name="mail" size={15} color={COLORS.forest} /><Text style={styles.caseContactActionText}>Email</Text></TouchableOpacity>
                          <TouchableOpacity accessibilityLabel={`Edit ${contact.name}`} onPress={() => setCaseContactForm({ id: contact.id, name: contact.name, relationship: contact.relationship, phone: contact.phone, email: contact.email, note: contact.note, isPrimary: contact.isPrimary })} style={styles.caseContactAction}><AppIcon name="create" size={14} color={COLORS.gray} /><Text style={[styles.caseContactActionText, { color: COLORS.gray }]}>Edit</Text></TouchableOpacity>
                          <TouchableOpacity accessibilityLabel={`Remove ${contact.name}`} onPress={() => removeCaseContact(contact)} style={styles.caseContactAction}><AppIcon name="trash" size={14} color={COLORS.coral} /></TouchableOpacity>
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              ) : <Text style={styles.caseEmptyNote}>No contacts yet — add the mother, the stepdad, the referent. Calls, texts, and emails from here log straight to the timeline.</Text>}

              {/* Timeline */}
              <Text style={styles.infoTitleStandalone}>Timeline</Text>
              <View style={styles.caseComposer}>
                <View style={styles.caseComposerKinds}>
                  {(['note', 'call', 'text', 'email', 'meeting'] as CaseEventKind[]).map((kind) => (
                    <TouchableOpacity key={kind} accessibilityRole="button" accessibilityState={{ selected: timelineKind === kind }} onPress={() => setTimelineKind(kind)} style={[styles.caseKindPill, timelineKind === kind && styles.caseKindPillActive]}>
                      <AppIcon name={caseEventIcon(kind)} size={12} color={timelineKind === kind ? COLORS.white : COLORS.inkSoft} />
                      <Text style={[styles.caseKindPillText, timelineKind === kind && styles.caseKindPillTextActive]}>{kind}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.caseComposerRow}>
                  <TextInput
                    value={timelineDraft}
                    onChangeText={setTimelineDraft}
                    placeholder="Quick note about this case…"
                    placeholderTextColor="#99A6A1"
                    style={[styles.formInput, { flex: 1, minHeight: 44 }]}
                  />
                  <TouchableOpacity accessibilityLabel="Add timeline entry" onPress={addTimelineEntry} style={[styles.caseComposerSend, !timelineDraft.trim() && { opacity: 0.45 }]} disabled={!timelineDraft.trim()}>
                    <AppIcon name="arrow-up" size={18} color={COLORS.white} />
                  </TouchableOpacity>
                </View>
              </View>
              {timeline.length ? (
                <View style={styles.followUpCard}>
                  {timeline.map((event, index) => {
                    const contact = event.contactId ? caseContacts.find((item) => item.id === event.contactId) : undefined;
                    return (
                      <View key={event.id} style={[styles.followUpRow, index === timeline.length - 1 && { borderBottomWidth: 0 }]}>
                        <View style={styles.touchLogIcon}><AppIcon name={caseEventIcon(event.kind)} size={14} color={COLORS.forest} /></View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.touchLogTitle}>{event.body || event.kind.replace('_', ' ')}</Text>
                          <Text style={styles.touchLogNote}>{timelineMetaLine(event, contact?.name)}</Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              ) : <Text style={styles.caseEmptyNote}>Nothing on the timeline yet — notes, calls, status changes, payments, documents, and referrals all land here automatically.</Text>}

              {/* Documents */}
              <View style={styles.caseSectionHeader}>
                <Text style={styles.infoTitleStandalone}>Documents</Text>
              </View>
              <View style={styles.caseDocAddRow}>
                <TextInput
                  value={docLabel}
                  onChangeText={setDocLabel}
                  placeholder="Label (e.g. Insurance card front)"
                  placeholderTextColor="#99A6A1"
                  style={[styles.formInput, { flex: 1, minHeight: 44 }]}
                />
                <TouchableOpacity accessibilityLabel="Add document from photos" onPress={pickCaseDocument} disabled={docUploading} style={[styles.caseComposerSend, docUploading && { opacity: 0.45 }]}>
                  <AppIcon name={docUploading ? 'hourglass' : 'image'} size={17} color={COLORS.white} />
                </TouchableOpacity>
              </View>
              <Text style={styles.casePaymentHint}>Photos only in v1 — stored in the private case-documents bucket, viewed through 60-second signed links. Never a public URL.</Text>
              {caseDocuments.length ? (
                <View style={styles.caseDocGrid}>
                  {caseDocuments.map((document) => (
                    <View key={document.id} style={styles.caseDocTile}>
                      <TouchableOpacity onPress={() => viewCaseDocument(document)} style={styles.caseDocTileBody}>
                        <AppIcon name={documentIcon(document.mimeType)} size={22} color={COLORS.forest} />
                        <Text numberOfLines={2} style={styles.caseDocLabel}>{document.label}</Text>
                        {document.sizeBytes ? <Text style={styles.caseDocSize}>{Math.max(1, Math.round(document.sizeBytes / 1024))} KB</Text> : null}
                      </TouchableOpacity>
                      <TouchableOpacity accessibilityLabel={`Delete ${document.label}`} onPress={() => removeCaseDocument(document)} style={styles.caseDocDelete}>
                        <AppIcon name="trash" size={13} color={COLORS.coral} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              ) : <Text style={styles.caseEmptyNote}>No documents yet — a photo of the insurance card is usually the first one.</Text>}

              {/* Linked business objects */}
              <Text style={styles.infoTitleStandalone}>Placement & referrals</Text>
              <View style={styles.followUpCard}>
                {linkedMatch ? (
                  <TouchableOpacity onPress={() => { loadReferralMatch(linkedMatch); setTab('match'); closeCase(); }} style={styles.caseLinkedRow}>
                    <View style={styles.touchLogIcon}><AppIcon name="sparkles" size={14} color={COLORS.forest} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.touchLogTitle}>Match profile: {linkedMatch.clientLabel}</Text>
                      <Text style={styles.touchLogNote}>{linkedMatch.status}{linkedMatch.assignedPartnerId ? ` · ${partners.find((item) => item.id === linkedMatch.assignedPartnerId)?.organization || ''}` : ''}</Text>
                    </View>
                    <Text style={styles.caseOpenInMatch}>Open in Match</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity onPress={() => startMatchForCase(record)} style={styles.caseLinkedRow}>
                    <View style={styles.touchLogIcon}><AppIcon name="sparkles-outline" size={14} color={COLORS.forest} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.touchLogTitle}>Find placement</Text>
                      <Text style={styles.touchLogNote}>Start a match profile pre-filled from this case — packet sends will link back here.</Text>
                    </View>
                    <AppIcon name="chevron-forward" size={15} color={COLORS.gray} />
                  </TouchableOpacity>
                )}
                {linkedReferrals.map((referral) => {
                  const partner = partners.find((item) => item.id === referral.partnerId);
                  return (
                    <View key={referral.id} style={styles.caseLinkedRow}>
                      <View style={styles.touchLogIcon}><AppIcon name="paper-plane" size={14} color={COLORS.blue} /></View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.touchLogTitle}>{referral.direction} referral · {referral.clientLabel}</Text>
                        <Text style={styles.touchLogNote}>{partner ? `${partner.organization} · ` : ''}{referral.outcome} · {shortDate(referral.date)}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  function NewCaseModal() {
    return (
      <Modal visible={showNewCase} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowNewCase(false)}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close new case form" onPress={() => setShowNewCase(false)} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>New case</Text>
              <TouchableOpacity accessibilityRole="button" style={styles.modalHeaderAction} onPress={saveNewCase}><Text style={styles.saveText}>Save</Text></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.formIntro}>One family, one file. Everything else — more contacts, notes, documents, payments — gets added from the case file itself.</Text>
              <FormField label="CASE TITLE *" value={caseForm.title} onChangeText={(title) => setCaseForm((current) => ({ ...current, title }))} placeholder="Henderson family — son Jake, 24" />
              <DropdownField
                label="STATUS"
                value={caseForm.status}
                icon="flag-outline"
                onChange={(status) => setCaseForm((current) => ({ ...current, status: status as CaseStatus }))}
                options={CASE_STATUSES.map((status) => ({ label: status, value: status }))}
              />
              <DropdownField
                label="LEAD SOURCE"
                value={caseForm.leadSource}
                icon="trending-up-outline"
                onChange={(leadSource) => setCaseForm((current) => ({ ...current, leadSource }))}
                options={LEAD_SOURCES.map((source) => ({ label: source, value: source }))}
              />
              <FormField label="SOURCE DETAIL (OPTIONAL)" value={caseForm.leadSourceDetail} onChangeText={(leadSourceDetail) => setCaseForm((current) => ({ ...current, leadSourceDetail }))} placeholder="Person, organization, campaign, or event" />
              <FormField label="SUMMARY (OPTIONAL)" value={caseForm.summary} onChangeText={(summary) => setCaseForm((current) => ({ ...current, summary }))} placeholder="The situation in a few lines" multiline />
              <Text style={styles.fieldLabel}>PRIMARY CONTACT</Text>
              <FormField label="NAME" value={caseForm.contactName} onChangeText={(contactName) => setCaseForm((current) => ({ ...current, contactName }))} placeholder="Mom, dad, referent…" />
              <FormField label="RELATIONSHIP" value={caseForm.contactRelationship} onChangeText={(contactRelationship) => setCaseForm((current) => ({ ...current, contactRelationship }))} placeholder="mother, stepdad, referent" />
              <FormField label="PHONE" value={caseForm.contactPhone} onChangeText={(contactPhone) => setCaseForm((current) => ({ ...current, contactPhone }))} placeholder="(541) 555-0142" keyboardType="phone-pad" />
              <FormField label="EMAIL" value={caseForm.contactEmail} onChangeText={(contactEmail) => setCaseForm((current) => ({ ...current, contactEmail }))} placeholder="name@email.com" keyboardType="email-address" />
              <TouchableOpacity style={styles.primaryButton} onPress={saveNewCase}><Text style={styles.primaryButtonText}>Create case file</Text></TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  function EditCaseModal() {
    if (!caseEditForm || !activeCase) return null;
    const close = () => setCaseEditForm(null);
    return (
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close edit case form" onPress={close} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>Edit case</Text>
              <TouchableOpacity accessibilityRole="button" style={styles.modalHeaderAction} onPress={saveCaseDetails}><Text style={styles.saveText}>Save</Text></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.formIntro}>Update the case name or summary. Contact names, phones, and emails can be edited from the Contacts section.</Text>
              <FormField label="CASE NAME *" value={caseEditForm.title} onChangeText={(title) => setCaseEditForm((current) => (current ? { ...current, title } : current))} placeholder="Henderson family — son Jake, 24" />
              <FormField label="SUMMARY" value={caseEditForm.summary} onChangeText={(summary) => setCaseEditForm((current) => (current ? { ...current, summary } : current))} placeholder="The situation in a few lines" multiline />
              <TouchableOpacity style={styles.primaryButton} onPress={saveCaseDetails}><Text style={styles.primaryButtonText}>Save case changes</Text></TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  function CaseBusinessDetailsModal() {
    if (!caseBusinessForm || !activeCase) return null;
    const close = () => setCaseBusinessForm(null);
    return (
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close business details form" onPress={close} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>Business details</Text>
              <TouchableOpacity accessibilityRole="button" style={styles.modalHeaderAction} onPress={saveCaseBusinessDetails}><Text style={styles.saveText}>Save</Text></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.formIntro}>Attribution and loss reasons feed the Business dashboard. Keep PHI out of these reporting fields.</Text>
              <DropdownField
                label="LEAD SOURCE"
                value={caseBusinessForm.leadSource}
                icon="trending-up-outline"
                onChange={(leadSource) => setCaseBusinessForm((current) => current ? { ...current, leadSource } : current)}
                options={LEAD_SOURCES.map((source) => ({ label: source, value: source }))}
              />
              <FormField label="SOURCE DETAIL" value={caseBusinessForm.leadSourceDetail} onChangeText={(leadSourceDetail) => setCaseBusinessForm((current) => current ? { ...current, leadSourceDetail } : current)} placeholder="Specific person, organization, campaign, or event" />
              <FormField label="LOST REASON" value={caseBusinessForm.lostReason} onChangeText={(lostReason) => setCaseBusinessForm((current) => current ? { ...current, lostReason } : current)} placeholder="No response, price, chose another provider…" multiline />
              <TouchableOpacity style={styles.primaryButton} onPress={saveCaseBusinessDetails}><Text style={styles.primaryButtonText}>Save business details</Text></TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  function AddCasePaymentModal() {
    if (!casePaymentForm || !activeCase) return null;
    const close = () => setCasePaymentForm(null);
    const amount = Number(casePaymentForm.amount.replace(/[^\d]/g, '')) || 0;
    return (
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close payment form" onPress={close} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>Add payment</Text>
              <TouchableOpacity accessibilityRole="button" style={styles.modalHeaderAction} onPress={addCasePayment}><Text style={styles.saveText}>Save</Text></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.formIntro}>Record each new coaching session or installment separately so the case timeline and total revenue stay current.</Text>
              <View style={styles.paymentTotalCard}>
                <Text style={styles.infoLabel}>CURRENTLY PAID</Text>
                <Text style={styles.paymentTotalValue}>{formatMoney(activeCase.paidAmount)}</Text>
                {amount > 0 ? <Text style={styles.paymentTotalPreview}>New total: {formatMoney(activeCase.paidAmount + amount)}</Text> : null}
              </View>
              <FormField label="PAYMENT AMOUNT *" value={casePaymentForm.amount} onChangeText={(amountText) => setCasePaymentForm((current) => (current ? { ...current, amount: amountText.replace(/[^\d]/g, '') } : current))} placeholder="$150" keyboardType="number-pad" />
              <FormField label="WHAT WAS THIS FOR? (OPTIONAL)" value={casePaymentForm.note} onChangeText={(note) => setCasePaymentForm((current) => (current ? { ...current, note } : current))} placeholder="Coaching session 2, second installment…" />
              <TouchableOpacity style={styles.primaryButton} onPress={addCasePayment}><Text style={styles.primaryButtonText}>Add {amount > 0 ? formatMoney(amount) : 'payment'}</Text></TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  function CaseContactModal() {
    if (!caseContactForm) return null;
    const isEditing = Boolean(caseContactForm.id);
    const close = () => setCaseContactForm(null);
    return (
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close contact form" onPress={close} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>{isEditing ? 'Edit contact' : 'Add contact'}</Text>
              <TouchableOpacity accessibilityRole="button" style={styles.modalHeaderAction} onPress={saveCaseContact}><Text style={styles.saveText}>Save</Text></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <FormField label="NAME *" value={caseContactForm.name} onChangeText={(name) => setCaseContactForm((current) => (current ? { ...current, name } : current))} placeholder="Contact name" />
              <FormField label="RELATIONSHIP" value={caseContactForm.relationship} onChangeText={(relationship) => setCaseContactForm((current) => (current ? { ...current, relationship } : current))} placeholder="mother, stepdad, subject, referent" />
              <FormField label="PHONE" value={caseContactForm.phone} onChangeText={(phone) => setCaseContactForm((current) => (current ? { ...current, phone } : current))} placeholder="(541) 555-0142" keyboardType="phone-pad" />
              <FormField label="EMAIL" value={caseContactForm.email} onChangeText={(email) => setCaseContactForm((current) => (current ? { ...current, email } : current))} placeholder="name@email.com" keyboardType="email-address" />
              <FormField label="NOTE (OPTIONAL)" value={caseContactForm.note} onChangeText={(note) => setCaseContactForm((current) => (current ? { ...current, note } : current))} placeholder="Best times to call, who to loop in…" multiline />
              <TouchableOpacity
                accessibilityRole="checkbox"
                accessibilityState={{ checked: caseContactForm.isPrimary }}
                onPress={() => setCaseContactForm((current) => (current ? { ...current, isPrimary: !current.isPrimary } : current))}
                style={[styles.networkPreferenceOption, caseContactForm.isPrimary && styles.networkPreferenceOptionSelected, { marginBottom: 18 }]}
              >
                <AppIcon name={caseContactForm.isPrimary ? 'checkbox' : 'square-outline'} size={21} color={caseContactForm.isPrimary ? COLORS.forest : COLORS.gray} />
                <Text style={[styles.networkPreferenceText, caseContactForm.isPrimary && styles.networkPreferenceTextSelected]}>Primary contact — replaces any current primary</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primaryButton} onPress={saveCaseContact}><Text style={styles.primaryButtonText}>{isEditing ? 'Update contact' : 'Save contact'}</Text></TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  // Skippable quick note after a one-tap call/text/email action.
  function QuickNoteModal() {
    if (!quickNoteContact) return null;
    const { contact, kind } = quickNoteContact;
    const skip = () => { setQuickNoteContact(null); setQuickNoteText(''); };
    return (
      <Modal visible transparent animationType="fade" onRequestClose={skip}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <Pressable style={styles.dropdownOverlay} onPress={skip}>
            <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
              <View style={styles.dropdownSheetHandle} />
              <ScrollView style={styles.keyboardSheetScroll} contentContainerStyle={styles.prePromptBody} keyboardShouldPersistTaps="handled">
                <View style={styles.prePromptIcon}><AppIcon name={caseEventIcon(kind)} size={24} color={COLORS.forest} /></View>
                <Text style={styles.prePromptTitle}>Add a note about this {kind}?</Text>
                <TextInput
                  value={quickNoteText}
                  onChangeText={setQuickNoteText}
                  placeholder={`What came out of the ${kind} with ${contact.name}?`}
                  placeholderTextColor="#99A6A1"
                  multiline
                  style={[styles.formInput, styles.multilineInput, { minHeight: 80 }]}
                />
                <TouchableOpacity style={styles.primaryButton} onPress={saveQuickNote}><Text style={styles.primaryButtonText}>Save note</Text></TouchableOpacity>
                <TouchableOpacity onPress={skip} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Skip</Text></TouchableOpacity>
              </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    );
  }

  // In-app viewer for image documents (signed URL, 60s expiry).
  function DocViewModal() {
    if (!docView) return null;
    return (
      <Modal visible transparent animationType="fade" onRequestClose={() => setDocView(null)}>
        <Pressable style={styles.docViewOverlay} onPress={() => setDocView(null)}>
          <View style={styles.docViewHeader}>
            <Text style={styles.docViewTitle} numberOfLines={1}>{docView.label}</Text>
            <TouchableOpacity accessibilityLabel="Close document" onPress={() => setDocView(null)} style={styles.closeButton}><AppIcon name="close" size={24} color={COLORS.white} /></TouchableOpacity>
          </View>
          <Image source={{ uri: docView.url }} style={styles.docViewImage} resizeMode="contain" />
        </Pressable>
      </Modal>
    );
  }

  function PartnerDetailModal() {
    if (!selectedPartner) return null;
    return (
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSelectedPartner(null)}>
        <SafeAreaView style={styles.modalPage}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <TouchableOpacity accessibilityLabel="Close partner profile" onPress={() => setSelectedPartner(null)} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
            <Text style={styles.modalHeaderTitle}>Partner profile</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={selectedPartner.favorite ? 'Remove partner from favorites' : 'Add partner to favorites'} accessibilityState={{ selected: selectedPartner.favorite }} onPress={() => toggleFavorite(selectedPartner.id)} style={styles.closeButton}><AppIcon name={selectedPartner.favorite ? 'heart' : 'heart-outline'} size={21} color={selectedPartner.favorite ? COLORS.coral : COLORS.ink} /></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.modalContent}>
            <View style={styles.profileHero}>
              <Initials name={selectedPartner.organization} size={68} />
              <Text style={styles.profileOrg}>{selectedPartner.organization}</Text>
              <Text style={styles.profileName}>{selectedPartner.name}</Text>
              <View style={styles.profileMeta}><View style={[styles.typeBadge, styles.partnerTypeBadge]}><Text numberOfLines={2} style={styles.typeBadgeText}>{partnerTypeLabel(selectedPartner)}</Text></View><Text style={styles.metaText}>{selectedPartner.city}, {selectedPartner.state}</Text></View>
            </View>

            <View style={styles.profileActions}>
              <TouchableOpacity style={styles.profileAction} onPress={() => selectedPartner.phone && Linking.openURL(`tel:${selectedPartner.phone.replace(/[^\d+]/g, '')}`)}><AppIcon name="call" size={20} color={COLORS.forest} /><Text style={styles.profileActionText}>Call</Text></TouchableOpacity>
              <TouchableOpacity style={styles.profileAction} onPress={() => selectedPartner.email && Linking.openURL(`mailto:${selectedPartner.email}`)}><AppIcon name="mail" size={20} color={COLORS.forest} /><Text style={styles.profileActionText}>Email</Text></TouchableOpacity>
              <TouchableOpacity style={styles.profileAction} onPress={() => openReferral('Outbound', selectedPartner.id)}><AppIcon name="paper-plane" size={20} color={COLORS.forest} /><Text style={styles.profileActionText}>Refer</Text></TouchableOpacity>
              <TouchableOpacity style={styles.profileAction} onPress={() => openTouchLogger(selectedPartner)}><AppIcon name="chatbox-ellipses" size={20} color={COLORS.forest} /><Text style={styles.profileActionText}>Log touch</Text></TouchableOpacity>
              <TouchableOpacity style={styles.profileAction} onPress={() => sharePartner(selectedPartner)}><AppIcon name="share-social" size={20} color={COLORS.forest} /><Text style={styles.profileActionText}>Share</Text></TouchableOpacity>
              <TouchableOpacity style={styles.profileAction} onPress={() => openEditPartner(selectedPartner)}><AppIcon name="create" size={20} color={COLORS.forest} /><Text style={styles.profileActionText}>Edit</Text></TouchableOpacity>
            </View>

            <View style={styles.profileBalanceCard}>
              <View><Text style={styles.fieldLabel}>REFERRAL ACTIVITY</Text><Text style={styles.profileBalanceTitle}>{lastReferralByPartner[selectedPartner.id] ? `Last referral ${shortDate(lastReferralByPartner[selectedPartner.id])}` : 'No referrals yet'}</Text></View>
              <View style={styles.profileCounts}><Text style={styles.profileCount}><Text style={{ color: COLORS.forest }}>{selectedPartner.inbound}</Text> received</Text><Text style={styles.profileCount}><Text style={{ color: COLORS.blue }}>{selectedPartner.outbound}</Text> sent</Text></View>
            </View>
            {hasFinancialRelationship(selectedPartner) ? (
              <View style={[styles.infoCard, { marginBottom: 12 }]}>
                <Text style={styles.infoTitle}>Disclosed relationship</Text>
                <View style={[styles.infoLine, { borderBottomWidth: 0 }]}>
                  <AppIcon name="information-circle-outline" size={18} color={COLORS.coral} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.infoValue}>{financialRelationshipLabel(selectedPartner.financialRelationship)}{selectedPartner.financialRelationshipNote ? ` · ${selectedPartner.financialRelationshipNote}` : ''}</Text>
                    <Text style={styles.infoLabel}>Shown to families in every packet. Never part of the ranking.</Text>
                  </View>
                </View>
              </View>
            ) : null}

            {(() => {
              // Live from the linked directory listing; programs only.
              const status = selectedPartner.globalPartnerId ? listingBeds[selectedPartner.globalPartnerId] : undefined;
              if (!status?.program) return null;
              const line = bedsLine(status);
              const cadence = bedsCadenceLine(status);
              const contact = [status.admissionsContactName, status.admissionsContactPhone].filter(Boolean).join(' · ');
              return (
                <View style={[styles.infoCard, { marginBottom: 12 }]}>
                  <Text style={styles.infoTitle}>Beds today</Text>
                  <View style={[styles.infoLine, { borderBottomWidth: 0 }]}>
                    <AppIcon name="information-circle-outline" size={18} color={COLORS.gray} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.infoValue}>{line ? line.replace('Beds today: ', '') : 'Not confirmed yet'}</Text>
                      {cadence ? <Text style={styles.infoLabel}>{cadence}</Text> : null}
                      {contact ? <Text style={styles.infoLabel}>Admissions: {contact}</Text> : null}
                      <Text style={styles.infoLabel}>Confirmed by the program in its directory listing. A count older than seven days reads as Unconfirmed.</Text>
                    </View>
                  </View>
                </View>
              );
            })()}
            <View style={styles.infoCard}>
              <Text style={styles.infoTitle}>Staying in touch</Text>
              <View style={styles.infoLine}><AppIcon name="calendar-outline" size={18} color={COLORS.gray} /><View style={{ flex: 1 }}><Text style={styles.infoLabel}>Cadence</Text><Text style={styles.infoValue}>{selectedPartner.touchCadenceDays ? `Every ${selectedPartner.touchCadenceDays} days` : 'No cadence set'}</Text></View></View>
              <View style={[styles.infoLine, { borderBottomWidth: 0 }]}><AppIcon name="time-outline" size={18} color={COLORS.gray} /><View style={{ flex: 1 }}><Text style={styles.infoLabel}>Last contact</Text><Text style={styles.infoValue}>{selectedPartner.lastContact ? shortDate(selectedPartner.lastContact) : 'Not recorded'}</Text></View></View>
            </View>
            {(() => {
              // Track record from the partner_scorecard view — hidden until
              // the partner has actually received at least one referral.
              const scorecard = scorecards[selectedPartner.id];
              if (!scorecard || scorecard.referralsSent === 0) return null;
              return (
                <View style={[styles.infoCard, { marginTop: 12 }]}>
                  <Text style={styles.infoTitle}>Track record</Text>
                  <View style={[styles.infoLine, { borderBottomWidth: 0 }]}>
                    <AppIcon name="ribbon-outline" size={18} color={COLORS.gray} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.infoValue}>
                        {scorecard.referralsSent} sent · {scorecard.admits} admitted{scorecard.avgFamilyExperience != null ? ` · ${scorecard.avgFamilyExperience}★ family experience` : ''}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })()}
            {(() => {
              const partnerTouches = touches.filter((touch) => touch.partnerId === selectedPartner.id).slice(0, 5);
              return partnerTouches.length ? (
                <View style={styles.touchLogList}>
                  {partnerTouches.map((touch) => (
                    <View key={touch.id} style={styles.touchLogRow}>
                      <View style={styles.touchLogIcon}><AppIcon name={touch.kind === 'call' ? 'call' : touch.kind === 'text' ? 'chatbubble' : touch.kind === 'email' ? 'mail' : touch.kind === 'meeting' ? 'people' : 'ellipsis-horizontal'} size={14} color={COLORS.forest} /></View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.touchLogTitle}>{touch.kind.charAt(0).toUpperCase() + touch.kind.slice(1)}</Text>
                        {touch.note ? <Text numberOfLines={1} style={styles.touchLogNote}>{touch.note}</Text> : null}
                      </View>
                      <Text style={styles.touchLogDate}>{shortDate(touch.occurredAt.slice(0, 10))}</Text>
                    </View>
                  ))}
                </View>
              ) : null;
            })()}

            <View style={styles.infoCard}>
              <Text style={styles.infoTitle}>Placement details</Text>
              <View style={styles.infoLine}><AppIcon name="wallet-outline" size={18} color={COLORS.gray} /><View style={{ flex: 1 }}><Text style={styles.infoLabel}>{directoryCostLabel(typesForPartner(selectedPartner))}</Text><Text style={styles.infoValue}>{formatMoney(monthlyCostForPartner(selectedPartner))}</Text></View></View>
              <View style={styles.infoLine}><AppIcon name="shield-checkmark-outline" size={18} color={COLORS.gray} /><View style={{ flex: 1 }}><Text style={styles.infoLabel}>Insurance</Text><Text style={styles.infoValue}>{selectedPartner.insurance.filter((plan) => plan !== PRIVATE_PAY_ONLY).map((plan) => `${plan} (${networkCapabilitiesForPartner(selectedPartner, plan).map((status) => status === 'In-network' ? 'IN' : 'OON').join(' + ')})`).join(' · ') || (selectedPartner.insurance.includes(PRIVATE_PAY_ONLY) ? 'Private pay only' : 'Not recorded')}</Text></View></View>
              <View style={styles.infoLine}><AppIcon name="location-outline" size={18} color={COLORS.gray} /><View style={{ flex: 1 }}><Text style={styles.infoLabel}>Service area</Text><Text style={styles.infoValue}>{selectedPartner.regions.join(' · ')}</Text></View></View>
            </View>

            <Text style={styles.infoTitleStandalone}>Therapeutic specialties</Text>
            <View style={styles.tagRow}>{selectedPartner.therapies.map((therapy) => <View key={therapy} style={styles.specialtyTag}><Text style={styles.specialtyText}>{therapy}</Text></View>)}</View>

            <Text style={styles.infoTitleStandalone}>Relationship notes</Text>
            <View style={styles.noteCard}><Text style={styles.noteText}>{selectedPartner.note || 'No notes yet.'}</Text></View>

            <Text style={styles.infoTitleStandalone}>Shared directory</Text>
            {(() => {
              // Linked to a listing: imported, already approved, or waiting for review.
              if (selectedPartner.globalPartnerId) {
                const status = selectedPartner.globalListingStatus;
                return (
                  <View style={styles.noteCard}>
                    <View style={styles.directoryStatusRow}>
                      <View style={styles.typeBadge}><Text style={styles.typeBadgeText}>{status === 'pending' ? 'Pending review' : status === 'archived' ? 'Not currently listed' : 'In the shared directory'}</Text></View>
                    </View>
                    <Text style={styles.noteText}>
                      {status === 'pending'
                        ? 'ReferralFit is reviewing this listing. It will appear in the shared directory once it is approved, and it stays in your list either way.'
                        : status === 'archived'
                          ? 'This directory listing is not active right now. It stays in your list.'
                          : 'Other practices can find this listing in the Directory.'}
                    </Text>
                  </View>
                );
              }
              // The server checks the row's own types, so an untyped partner is not ready.
              const missing = directoryMissingFields({
                organization: selectedPartner.organization,
                name: selectedPartner.name,
                types: selectedPartner.types || [],
                city: selectedPartner.city,
                state: selectedPartner.state,
                phone: selectedPartner.phone,
                email: selectedPartner.email,
                website: selectedPartner.website,
                monthlyCost: monthlyCostForPartner(selectedPartner),
                insurance: selectedPartner.insurance,
                insuranceNetworks: selectedPartner.insuranceNetworks,
              });
              const declined = Boolean(selectedPartner.directoryRejectedAt);
              return (
                <View style={styles.noteCard}>
                  {declined ? (
                    <>
                      <View style={styles.directoryStatusRow}>
                        <View style={[styles.typeBadge, styles.directoryDeclinedBadge]}><Text style={[styles.typeBadgeText, styles.directoryDeclinedText]}>Not added to the directory</Text></View>
                      </View>
                      {selectedPartner.directoryReviewNote ? (
                        <Text style={styles.noteText}>Note from ReferralFit: {selectedPartner.directoryReviewNote}</Text>
                      ) : null}
                      <Text style={[styles.noteText, styles.directoryHint]}>It is still saved to your list. You can update it and submit it again. Your relationship notes stay private.</Text>
                    </>
                  ) : null}
                  {missing.length === 0 ? (
                    <>
                      {!declined ? <Text style={styles.noteText}>Saved to your list. ReferralFit reviews each submission before it appears in the shared directory. Your relationship notes stay private.</Text> : null}
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={declined ? 'Submit to directory again' : 'Submit to directory'}
                        accessibilityState={{ disabled: directorySubmitBusy, busy: directorySubmitBusy }}
                        disabled={directorySubmitBusy}
                        style={[styles.primaryButton, directorySubmitBusy && styles.directoryButtonBusy]}
                        onPress={() => { void submitPartnerForDirectory(selectedPartner); }}
                      >
                        {directorySubmitBusy ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.primaryButtonText}>{declined ? 'Submit again' : 'Submit to directory'}</Text>}
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      {!declined ? (
                        <View style={styles.directoryStatusRow}>
                          <View style={styles.typeBadge}><Text style={styles.typeBadgeText}>Saved to your list only</Text></View>
                        </View>
                      ) : null}
                      <Text style={[styles.noteText, declined && styles.directoryHint]}>
                        {directoryMissingFieldsMessage(missing)}
                      </Text>
                    </>
                  )}
                </View>
              );
            })()}

            <View style={styles.contactCard}>
              <View style={styles.contactLine}><AppIcon name="call-outline" size={17} color={COLORS.gray} /><Text style={styles.contactText}>{selectedPartner.phone || 'No phone recorded'}</Text></View>
              <View style={styles.contactLine}><AppIcon name="mail-outline" size={17} color={COLORS.gray} /><Text style={styles.contactText}>{selectedPartner.email || 'No email recorded'}</Text></View>
              <View style={styles.contactLine}><AppIcon name="globe-outline" size={17} color={COLORS.gray} /><Text style={styles.contactText}>{selectedPartner.website || 'No website recorded'}</Text></View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    );
  }

  // ─── Workspace directory profile ──────────────────────────────────────────

  // Show the one-time "build your profile" prompt only to a workspace owner
  // who has no profile and no open claim request. Any failure means no prompt.
  async function shouldShowProfilePrompt(userId: string): Promise<boolean> {
    try {
      if ((await AsyncStorage.getItem(profilePromptKey(userId))) === 'decided') return false;
      const state = await fetchOrgDirectoryProfile();
      return state.canEdit && !state.profile && !state.pendingClaim;
    } catch {
      return false;
    }
  }

  function showDeferredNotificationPrompt() {
    if (notifPromptDeferredRef.current) {
      notifPromptDeferredRef.current = false;
      setNotifPrePromptVisible(true);
    }
  }

  async function openOrgProfileForm(fromWorkspace: boolean) {
    const userId = activeUserIdRef.current;
    let existing: OrgDirectoryProfile | null = null;
    try {
      existing = (await fetchOrgDirectoryProfile()).profile;
    } catch (error) {
      Alert.alert('Could not load your profile', (error as Error).message);
      return;
    }
    if (activeUserIdRef.current !== userId) return;
    setOrgProfileExisting(existing);
    setOrgProfileForm(existing ? orgProfileFormFromListing(existing) : makeEmptyOrgProfileForm());
    orgProfileReturnToWorkspaceRef.current = fromWorkspace;
    if (fromWorkspace) {
      // Let the Workspace sheet finish dismissing before presenting another.
      setShowWorkspace(false);
      setTimeout(() => { if (activeUserIdRef.current === userId) setShowOrgProfile(true); }, 400);
    } else {
      setShowOrgProfile(true);
    }
  }

  function closeOrgProfileForm() {
    setShowOrgProfile(false);
    if (orgProfileReturnToWorkspaceRef.current) {
      orgProfileReturnToWorkspaceRef.current = false;
      setTimeout(() => setShowWorkspace(true), 400);
    } else {
      showDeferredNotificationPrompt();
    }
  }

  async function saveOrgProfile() {
    if (orgProfileSaving) return;
    if (!orgProfileForm.name.trim() || !orgProfileForm.organization.trim()) {
      Alert.alert('A little more detail', 'Add a contact name and your practice or program name first.');
      return;
    }
    if (!orgProfileForm.types.length) {
      Alert.alert('Choose a listing type', 'Select at least one level of care or provider type.');
      return;
    }
    const unclassifiedInsurance = orgProfileForm.insurance.find((plan) => !orgProfileForm.insuranceNetworks[plan]?.length);
    if (unclassifiedInsurance) {
      Alert.alert('Choose IN or OON', `Mark ${unclassifiedInsurance} as in-network, out-of-network, or both.`);
      return;
    }
    const userId = activeUserIdRef.current;
    setOrgProfileSaving(true);
    try {
      const result = await upsertOrgDirectoryProfile({
        name: orgProfileForm.name,
        organization: orgProfileForm.organization,
        types: orgProfileForm.types,
        city: orgProfileForm.city,
        state: orgProfileForm.state,
        regions: orgProfileExisting?.regions ?? [],
        phone: orgProfileForm.phone,
        email: orgProfileForm.email,
        website: orgProfileForm.website,
        monthlyCost: Number(orgProfileForm.monthlyCost) || 0,
        insurance: orgProfileForm.insurance,
        insuranceNetworks: orgProfileForm.insuranceNetworks,
        therapies: orgProfileForm.therapies,
        populations: orgProfileExisting?.populations?.length ? orgProfileExisting.populations : ['Adults'],
        levels: orgProfileForm.types,
        description: orgProfileForm.description,
      });
      if (activeUserIdRef.current !== userId) return;
      closeOrgProfileForm();
      if (result.status === 'claim_requested') {
        Alert.alert(
          'We found an existing listing',
          'A directory listing already matches your phone number or website. ReferralFit will confirm you own it, and then it becomes your profile. Nothing else is needed from you.',
        );
      } else if (result.status === 'claimed') {
        Alert.alert('Profile published', 'An existing listing for your practice is now yours. It is live, verified, and updated with what you entered.');
      } else {
        Alert.alert('Profile published', result.status === 'created'
          ? 'Your verified profile is live in the Directory. Other practices can now find you and add you to their network.'
          : 'Your changes are live and your listing stays verified.');
      }
    } catch (error) {
      if (activeUserIdRef.current === userId) Alert.alert('Could not publish your profile', (error as Error).message);
    } finally {
      if (activeUserIdRef.current === userId) setOrgProfileSaving(false);
    }
  }

  function OrgProfileModal() {
    const isEditing = Boolean(orgProfileExisting);
    return (
      <Modal visible={showOrgProfile} animationType="slide" presentationStyle="pageSheet" onRequestClose={closeOrgProfileForm}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close directory profile form" onPress={closeOrgProfileForm} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>{isEditing ? 'Edit your profile' : 'Your directory profile'}</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: orgProfileSaving, busy: orgProfileSaving }} disabled={orgProfileSaving} style={styles.modalHeaderAction} onPress={() => { void saveOrgProfile(); }}><Text style={styles.saveText}>{isEditing ? 'Update' : 'Publish'}</Text></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.formIntro}>{isEditing ? 'Your edits publish immediately and keep your listing verified.' : 'This is what other practices see in the Directory. It is public, verified, and yours to keep current.'}</Text>
              <FormField label="CONTACT NAME *" value={orgProfileForm.name} onChangeText={(name) => setOrgProfileForm((current) => ({ ...current, name }))} placeholder="Who should practices ask for?" />
              <FormField label="PRACTICE OR PROGRAM *" value={orgProfileForm.organization} onChangeText={(organization) => setOrgProfileForm((current) => ({ ...current, organization }))} placeholder="Program or practice" />
              <MultiSelectDropdown
                label="LISTING TYPES *"
                values={orgProfileForm.types}
                options={partnerTypes}
                icon="layers-outline"
                onChange={(types) => setOrgProfileForm((current) => ({ ...current, types: types as Partner['type'][] }))}
                emptyLabel="Select listing types"
                selectedNoun="types"
              />
              <View style={styles.formRow}><View style={{ flex: 2 }}><FormField label="CITY" value={orgProfileForm.city} onChangeText={(city) => setOrgProfileForm((current) => ({ ...current, city }))} placeholder="City" /></View><View style={{ flex: 1 }}><FormField label="STATE" value={orgProfileForm.state} onChangeText={(state) => setOrgProfileForm((current) => ({ ...current, state }))} placeholder="CA" /></View></View>
              <FormField label="PHONE" value={orgProfileForm.phone} onChangeText={(phone) => setOrgProfileForm((current) => ({ ...current, phone }))} placeholder="Phone number" keyboardType="phone-pad" />
              <FormField label="EMAIL" value={orgProfileForm.email} onChangeText={(email) => setOrgProfileForm((current) => ({ ...current, email }))} placeholder="name@practice.com" keyboardType="email-address" />
              <FormField label="WEBSITE" value={orgProfileForm.website} onChangeText={(website) => setOrgProfileForm((current) => ({ ...current, website }))} placeholder="https://practice.com" keyboardType="url" />
              <FormField label={directoryCostLabel(orgProfileForm.types).toUpperCase()} value={orgProfileForm.monthlyCost} onChangeText={(monthlyCost) => setOrgProfileForm((current) => ({ ...current, monthlyCost }))} placeholder={isIndividualProfessional(orgProfileForm.types) ? '$0' : '$0 per month'} keyboardType="number-pad" />
              <MultiSelectDropdown
                label="INSURANCES ACCEPTED"
                values={orgProfileForm.insurance}
                options={orgProfileInsuranceOptions}
                onChange={(insurance) => setOrgProfileForm((current) => ({
                  ...current,
                  insurance,
                  insuranceNetworks: Object.fromEntries(insurance.map((plan) => [plan, current.insuranceNetworks[plan]?.length ? current.insuranceNetworks[plan] : ['In-network']])),
                }))}
                icon="shield-checkmark-outline"
                emptyLabel="Select accepted insurance plans"
                selectedNoun="plans"
              />
              {orgProfileForm.insurance.map((plan) => (
                <View key={plan} style={styles.networkPlanRow}>
                  <Text style={styles.networkPlanName}>{plan}</Text>
                  {(['In-network', 'Out-of-network'] as InsuranceNetworkPreference[]).map((status) => {
                    const checked = orgProfileForm.insuranceNetworks[plan]?.includes(status) ?? false;
                    return (
                      <TouchableOpacity
                        key={status}
                        accessibilityRole="checkbox"
                        accessibilityLabel={`${plan} ${status}`}
                        accessibilityState={{ checked }}
                        style={[styles.networkCheck, checked && styles.networkCheckActive]}
                        onPress={() => setOrgProfileForm((current) => {
                          const statuses = current.insuranceNetworks[plan] || [];
                          const nextStatuses = statuses.includes(status) ? statuses.filter((item) => item !== status) : [...statuses, status];
                          return { ...current, insuranceNetworks: { ...current.insuranceNetworks, [plan]: nextStatuses } };
                        })}
                      >
                        <AppIcon name={checked ? 'checkbox' : 'square-outline'} size={18} color={checked ? COLORS.forest : COLORS.gray} />
                        <Text style={[styles.networkCheckText, checked && styles.networkCheckTextActive]}>{status === 'In-network' ? 'IN' : 'OON'}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ))}
              <MultiSelectDropdown
                label="THERAPEUTIC NEEDS SERVED"
                values={orgProfileForm.therapies}
                options={therapyOptions}
                onChange={(therapies) => setOrgProfileForm((current) => ({ ...current, therapies }))}
                icon="medkit-outline"
                emptyLabel="Select therapeutic needs"
              />
              <FormField label="PUBLIC DESCRIPTION" value={orgProfileForm.description} onChangeText={(description) => setOrgProfileForm((current) => ({ ...current, description }))} placeholder="Who you serve, how you work, and what makes a good referral" multiline />
              <Text style={styles.privacyHint}><AppIcon name="lock-closed" size={13} color={COLORS.gray} /> Everything here is public. Keep client details out of it.</Text>
              <TouchableOpacity style={styles.primaryButton} disabled={orgProfileSaving} onPress={() => { void saveOrgProfile(); }}>
                {orgProfileSaving ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.primaryButtonText}>{isEditing ? 'Update profile' : 'Publish verified profile'}</Text>}
              </TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  function ProfilePromptModal() {
    if (!profilePromptVisible || !session) return null;
    const userId = session.user.id;
    const generation = authGenerationRef.current;
    const accountIsCurrent = () => activeUserIdRef.current === userId && authGenerationRef.current === generation;
    const finish = async (buildNow: boolean) => {
      setProfilePromptVisible(false);
      if (!accountIsCurrent()) return;
      try {
        await AsyncStorage.setItem(profilePromptKey(userId), 'decided');
      } catch {
        // Best effort: the prompt simply shows again after the next welcome.
      }
      if (!accountIsCurrent()) return;
      if (buildNow) {
        void openOrgProfileForm(false);
      } else {
        showDeferredNotificationPrompt();
      }
    };
    return (
      <Modal visible transparent animationType="fade" onRequestClose={() => { void finish(false); }}>
        <Pressable style={styles.dropdownOverlay} onPress={() => { void finish(false); }}>
          <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownSheetHandle} />
            <ScrollView style={styles.keyboardSheetScroll} contentContainerStyle={styles.prePromptBody} keyboardShouldPersistTaps="handled">
              <View style={styles.prePromptIcon}><AppIcon name="ribbon-outline" size={24} color={COLORS.forest} /></View>
              <Text style={styles.prePromptTitle}>Let other practices find you</Text>
              <Text style={styles.prePromptText}>Build a verified profile for your practice in the shared Directory. It takes a minute, you control every word, and you can edit it any time from Workspace.</Text>
              <TouchableOpacity style={styles.primaryButton} onPress={() => { void finish(true); }}><Text style={styles.primaryButtonText}>Build my profile</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => { void finish(false); }} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Maybe later</Text></TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  function AddPartnerModal() {
    const isEditing = Boolean(editingPartnerId);
    return (
      <Modal visible={showAddPartner} animationType="slide" presentationStyle="pageSheet" onRequestClose={closePartnerForm}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close partner form" onPress={closePartnerForm} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>{isEditing ? 'Edit partner' : 'Add a partner'}</Text>
              <TouchableOpacity accessibilityRole="button" style={styles.modalHeaderAction} onPress={savePartner}><Text style={styles.saveText}>{isEditing ? 'Update' : 'Save'}</Text></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.formIntro}>{isEditing ? 'Update this record so future searches use the latest program details.' : 'Build a useful relationship record now. You can fill in more details as you learn them.'}</Text>
              <FormField label="CONTACT NAME *" value={partnerForm.name} onChangeText={(name) => setPartnerForm((current) => ({ ...current, name }))} placeholder="Contact name" />
              <FormField label="ORGANIZATION *" value={partnerForm.organization} onChangeText={(organization) => setPartnerForm((current) => ({ ...current, organization }))} placeholder="Program or practice" />
              <MultiSelectDropdown
                label="PARTNER TYPES *"
                values={partnerForm.types}
                options={partnerTypes}
                icon="layers-outline"
                onChange={(types) => setPartnerForm((current) => ({ ...current, types: types as Partner['type'][] }))}
                emptyLabel="Select partner types"
                selectedNoun="types"
              />
              <View style={styles.formRow}><View style={{ flex: 2 }}><FormField label="CITY" value={partnerForm.city} onChangeText={(city) => setPartnerForm((current) => ({ ...current, city }))} placeholder="City" /></View><View style={{ flex: 1 }}><FormField label="STATE" value={partnerForm.state} onChangeText={(state) => setPartnerForm((current) => ({ ...current, state }))} placeholder="CA" /></View></View>
              <FormField label="PHONE" value={partnerForm.phone} onChangeText={(phone) => setPartnerForm((current) => ({ ...current, phone }))} placeholder="Phone number" keyboardType="phone-pad" />
              <FormField label="EMAIL" value={partnerForm.email} onChangeText={(email) => setPartnerForm((current) => ({ ...current, email }))} placeholder="name@program.com" keyboardType="email-address" />
              <FormField label="WEBSITE" value={partnerForm.website} onChangeText={(website) => setPartnerForm((current) => ({ ...current, website }))} placeholder="https://program.com" keyboardType="url" />
              <FormField label={directoryCostLabel(partnerForm.types).toUpperCase()} value={partnerForm.monthlyCost} onChangeText={(monthlyCost) => setPartnerForm((current) => ({ ...current, monthlyCost }))} placeholder={isIndividualProfessional(partnerForm.types) ? '$0' : '$0 per month'} keyboardType="number-pad" />
              <MultiSelectDropdown
                label="INSURANCES ACCEPTED"
                values={partnerForm.insurance}
                options={partnerInsuranceOptions}
                onChange={(insurance) => setPartnerForm((current) => ({
                  ...current,
                  insurance,
                  insuranceNetworks: Object.fromEntries(insurance.map((plan) => [plan, current.insuranceNetworks[plan]?.length ? current.insuranceNetworks[plan] : ['In-network']])),
                  privatePayOnly: insurance.length ? false : current.privatePayOnly,
                }))}
                icon="shield-checkmark-outline"
                emptyLabel="Select accepted insurance plans"
                selectedNoun="plans"
              />
              {partnerForm.insurance.map((plan) => (
                <View key={plan} style={styles.networkPlanRow}>
                  <Text style={styles.networkPlanName}>{plan}</Text>
                  {(['In-network', 'Out-of-network'] as InsuranceNetworkPreference[]).map((status) => {
                    const checked = partnerForm.insuranceNetworks[plan]?.includes(status) ?? false;
                    return (
                      <TouchableOpacity
                        key={status}
                        accessibilityRole="checkbox"
                        accessibilityLabel={`${plan} ${status}`}
                        accessibilityState={{ checked }}
                        style={[styles.networkCheck, checked && styles.networkCheckActive]}
                        onPress={() => setPartnerForm((current) => {
                          const statuses = current.insuranceNetworks[plan] || [];
                          const nextStatuses = statuses.includes(status) ? statuses.filter((item) => item !== status) : [...statuses, status];
                          return { ...current, insuranceNetworks: { ...current.insuranceNetworks, [plan]: nextStatuses } };
                        })}
                      >
                        <AppIcon name={checked ? 'checkbox' : 'square-outline'} size={18} color={checked ? COLORS.forest : COLORS.gray} />
                        <Text style={[styles.networkCheckText, checked && styles.networkCheckTextActive]}>{status === 'In-network' ? 'IN' : 'OON'}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ))}
              {partnerForm.insurance.length === 0 ? (
                <TouchableOpacity
                  accessibilityRole="checkbox"
                  accessibilityLabel="Private pay only, no insurance accepted"
                  accessibilityState={{ checked: partnerForm.privatePayOnly }}
                  style={styles.networkPlanRow}
                  onPress={() => setPartnerForm((current) => ({ ...current, privatePayOnly: !current.privatePayOnly }))}
                >
                  <AppIcon name={partnerForm.privatePayOnly ? 'checkbox' : 'square-outline'} size={18} color={partnerForm.privatePayOnly ? COLORS.forest : COLORS.gray} />
                  <Text style={styles.networkPlanName}>Private pay only — no insurance accepted</Text>
                </TouchableOpacity>
              ) : null}
              <MultiSelectDropdown
                label="THERAPEUTIC NEEDS"
                values={partnerForm.therapies}
                options={therapyOptions}
                onChange={(therapies) => setPartnerForm((current) => ({ ...current, therapies }))}
                icon="medkit-outline"
                emptyLabel="Select therapeutic needs"
              />
              <FormField label="NOTES" value={partnerForm.note} onChangeText={(note) => setPartnerForm((current) => ({ ...current, note }))} placeholder="Relationship and program notes" multiline />
              <Text style={styles.fieldLabel}>FINANCIAL RELATIONSHIP</Text>
              <View style={[styles.wrapPills, { marginBottom: 8 }]}>
                {financialRelationshipOptions.map((option) => (
                  <Pill key={option.value} label={option.label} active={partnerForm.financialRelationship === option.value} onPress={() => setPartnerForm((current) => ({ ...current, financialRelationship: option.value }))} />
                ))}
              </View>
              <Text style={styles.matchFieldHint}>Any money that moves between your practice and this program. It is disclosed on cards and in every family packet, stays private to your workspace, and never changes a match.</Text>
              {partnerForm.financialRelationship !== 'none' ? (
                <FormField label="DISCLOSURE NOTE (OPTIONAL)" value={partnerForm.financialRelationshipNote} onChangeText={(financialRelationshipNote) => setPartnerForm((current) => ({ ...current, financialRelationshipNote }))} placeholder="A few words families will see" />
              ) : null}
              <Text style={styles.fieldLabel}>STAY IN TOUCH EVERY ___ DAYS</Text>
              <View style={styles.cadenceRow}>
                {['7', '30', '60', '90'].map((preset) => (
                  <Pill key={preset} label={preset} active={partnerForm.touchCadence === preset} onPress={() => setPartnerForm((current) => ({ ...current, touchCadence: preset }))} />
                ))}
                <Pill label="None" active={partnerForm.touchCadence === ''} onPress={() => setPartnerForm((current) => ({ ...current, touchCadence: '' }))} />
              </View>
              <TextInput
                value={partnerForm.touchCadence}
                onChangeText={(touchCadence) => setPartnerForm((current) => ({ ...current, touchCadence: touchCadence.replace(/[^\d]/g, '').slice(0, 3) }))}
                keyboardType="number-pad"
                placeholder="Custom days (optional)"
                placeholderTextColor="#99A6A1"
                style={[styles.formInput, { marginBottom: 15 }]}
              />
              <TouchableOpacity style={styles.primaryButton} onPress={savePartner}><Text style={styles.primaryButtonText}>{isEditing ? 'Update partner' : 'Save partner'}</Text></TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  function AddReferralModal() {
    const matchedReferral = referralMatches.find((item) => item.id === activeReferralMatchId);
    const closeReferralModal = () => {
      setShowAddReferral(false);
      setActiveReferralMatchId(null);
    };
    return (
      <Modal visible={showAddReferral} animationType="slide" presentationStyle="pageSheet" onRequestClose={closeReferralModal}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close referral form" onPress={closeReferralModal} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>{matchedReferral ? 'Assign referral' : 'Log a referral'}</Text>
              <TouchableOpacity accessibilityRole="button" style={styles.modalHeaderAction} onPress={() => addReferral()}><Text style={styles.saveText}>Save</Text></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              {matchedReferral ? (
                <View style={styles.matchedReferralBanner}>
                  <View style={styles.matchedReferralIcon}><AppIcon name="paper-plane" size={18} color={COLORS.forest} /></View>
                  <View style={{ flex: 1 }}><Text style={styles.matchedReferralTitle}>Outbound referral for {matchedReferral.clientLabel}</Text><Text style={styles.matchedReferralBody}>Choose the referent receiving this client, then save it to the Referrals tab.</Text></View>
                </View>
              ) : (
                <>
                  <Text style={styles.fieldLabel}>DIRECTION</Text>
                  <View style={styles.segmented}>
                    {(['Inbound', 'Outbound'] as ReferralDirection[]).map((direction) => <TouchableOpacity key={direction} accessibilityRole="button" accessibilityState={{ selected: referralForm.direction === direction }} onPress={() => setReferralForm({ ...referralForm, direction })} style={[styles.segment, referralForm.direction === direction && styles.segmentActive]}><AppIcon name={direction === 'Inbound' ? 'arrow-down' : 'arrow-up'} size={16} color={referralForm.direction === direction ? COLORS.white : COLORS.inkSoft} /><Text style={[styles.segmentText, referralForm.direction === direction && styles.segmentTextActive]}>{direction}</Text></TouchableOpacity>)}
                  </View>
                  <Text style={styles.directionExplainer}>{referralForm.direction === 'Inbound' ? 'A professional or program sent a family to you.' : 'You sent a client or family to a professional or program.'}</Text>
                </>
              )}
              <Text style={styles.fieldLabel}>{matchedReferral ? 'ASSIGN REFERENT' : 'PARTNER'}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.partnerPicker}>
                {partners.slice().sort((a, b) => Number(b.id === referralForm.partnerId) - Number(a.id === referralForm.partnerId)).map((partner) => <TouchableOpacity key={partner.id} onPress={() => setReferralForm({ ...referralForm, partnerId: partner.id })} style={[styles.partnerPick, referralForm.partnerId === partner.id && styles.partnerPickActive]}><Initials name={partner.organization} size={34} /><Text numberOfLines={2} style={[styles.partnerPickText, referralForm.partnerId === partner.id && styles.partnerPickTextActive]}>{partner.organization}</Text></TouchableOpacity>)}
              </ScrollView>
              {matchedReferral && referralForm.partnerId ? (() => {
                const chosen = partners.find((item) => item.id === referralForm.partnerId);
                const rank = placementRankFor(matchedReferral.id, referralForm.partnerId);
                return (
                  <>
                    {chosen && hasFinancialRelationship(chosen) ? (
                      <View style={[styles.disclosureBadge, { alignSelf: 'flex-start', marginBottom: 12 }]}><AppIcon name="information-circle-outline" size={12} color={COLORS.coral} /><Text style={styles.disclosureBadgeText}>Disclosed relationship · {financialRelationshipLabel(chosen.financialRelationship)} · one more confirmation on save</Text></View>
                    ) : null}
                    {rank > 1 ? (
                      <View style={styles.placementReasonBlock}>
                        <Text style={styles.fieldLabel}>WHY THIS PROGRAM?</Text>
                        <Text style={styles.placementReasonHint}>{rank <= (pendingPlacement?.rankedIds.length ?? 0) ? `It ranked #${rank} on the match.` : 'It was not on the match list.'} The reason goes on the placement record, not to the family.</Text>
                        <View style={styles.wrapPills}>{placementReasonOptions.map((option) => <Pill key={option.value} label={option.label} active={placementReason === option.value} onPress={() => setPlacementReason(option.value)} />)}</View>
                        {placementReason === 'other' ? (
                          <TextInput value={placementReasonNote} onChangeText={setPlacementReasonNote} placeholder="A few words" placeholderTextColor="#99A6A1" style={[styles.formInput, { marginTop: 10 }]} />
                        ) : null}
                      </View>
                    ) : null}
                  </>
                );
              })() : null}
              <FormField label="CLIENT / FAMILY LABEL *" value={referralForm.clientLabel} onChangeText={(clientLabel) => setReferralForm({ ...referralForm, clientLabel })} placeholder="Use initials or a private label" />
              <Text style={styles.privacyHint}><AppIcon name="lock-closed" size={13} color={COLORS.gray} /> Keep this de-identified; avoid clinical details or protected health information.</Text>
              <Text style={styles.fieldLabel}>OUTCOME</Text>
              <View style={styles.wrapPills}>{(['Introduced', 'Consulted', 'Placed', 'Pending'] as Referral['outcome'][]).map((outcome) => <Pill key={outcome} label={outcome} active={referralForm.outcome === outcome} onPress={() => setReferralForm({ ...referralForm, outcome })} />)}</View>
              <FormField label="NOTE" value={referralForm.note} onChangeText={(note) => setReferralForm({ ...referralForm, note })} placeholder="Optional relationship note" multiline />
              <TouchableOpacity style={styles.primaryButton} onPress={() => addReferral()}><Text style={styles.primaryButtonText}>{matchedReferral ? 'Save to referrals' : 'Save referral'}</Text></TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  function LogTouchModal() {
    if (!touchPartner) return null;
    return (
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setTouchPartner(null)}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close touch logger" onPress={() => setTouchPartner(null)} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>Log a touch</Text>
              <TouchableOpacity accessibilityRole="button" style={styles.modalHeaderAction} onPress={saveTouch}><Text style={styles.saveText}>Save</Text></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.formIntro}>Record contact with {touchPartner.name} at {touchPartner.organization}. This updates their last-contact date and resets the cadence clock.</Text>
              <Text style={styles.fieldLabel}>KIND</Text>
              <View style={styles.cadenceRow}>
                {(['call', 'text', 'email', 'meeting'] as TouchKind[]).map((kind) => (
                  <Pill key={kind} label={kind.charAt(0).toUpperCase() + kind.slice(1)} active={touchKind === kind} onPress={() => setTouchKind(kind)} />
                ))}
              </View>
              <FormField label="NOTE (OPTIONAL)" value={touchNote} onChangeText={setTouchNote} placeholder="Quick note about the conversation" multiline />
              <TouchableOpacity style={styles.primaryButton} onPress={saveTouch}><Text style={styles.primaryButtonText}>Save touch</Text></TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  function WelcomeModal() {
    if (!welcomeVisible || !session) return null;
    const userId = session.user.id;
    const generation = authGenerationRef.current;
    const accountIsCurrent = () => activeUserIdRef.current === userId && authGenerationRef.current === generation;
    const dismiss = async () => {
      setWelcomeVisible(false);
      if (!accountIsCurrent()) return;
      try {
        await AsyncStorage.setItem(welcomeKey(userId), 'seen');
      } catch {
        // Best effort: the welcome simply shows again next launch.
      }
      // One-time offer to build the workspace's directory profile; the
      // deferred notification prompt follows whichever way it is answered.
      const offerProfile = await shouldShowProfilePrompt(userId);
      if (!accountIsCurrent()) return;
      if (offerProfile) setProfilePromptVisible(true);
      else showDeferredNotificationPrompt();
    };
    return (
      <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
        <Pressable style={styles.dropdownOverlay} onPress={dismiss}>
          <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownSheetHandle} />
            <ScrollView style={styles.keyboardSheetScroll} contentContainerStyle={styles.prePromptBody} keyboardShouldPersistTaps="handled">
              <View style={styles.prePromptIcon}><AppIcon name="lock-closed-outline" size={24} color={COLORS.forest} /></View>
              <Text style={styles.prePromptTitle}>Welcome to your private workspace</Text>
              <Text style={styles.prePromptText}>
                Everything you add here — partners, cases, referrals, notes, and documents — belongs to your practice alone. Other practices using ReferralFit cannot see it, and it is never shared or sold.
              </Text>
              <Text style={styles.prePromptText}>
                The only shared space is the Directory of programs and professionals, and one of your partners appears there only if you choose to submit it and ReferralFit approves it. Benchmarks use anonymized totals that never identify a practice.
              </Text>
              <Text style={styles.prePromptText}>
                ReferralFit is free to use. There is nothing to buy in this app and no charge to your practice.
              </Text>
              <TouchableOpacity style={styles.primaryButton} onPress={dismiss}><Text style={styles.primaryButtonText}>Got it</Text></TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  function NotifPrePromptModal() {
    if (!notifPrePromptVisible || !session) return null;
    const userId = session.user.id;
    const generation = authGenerationRef.current;
    const accountIsCurrent = () => activeUserIdRef.current === userId && authGenerationRef.current === generation;
    const dismiss = async () => {
      setNotifPrePromptVisible(false);
      try {
        if (!accountIsCurrent()) return;
        await AsyncStorage.setItem(notificationPromptKey(userId), 'dismissed');
        if (!accountIsCurrent()) return;
      } catch (error) {
        if (accountIsCurrent()) Alert.alert('Preference not saved', `Notification preference could not be saved: ${(error as Error).message}`);
      }
    };
    const enable = async () => {
      setNotifPrePromptVisible(false);
      if (!accountIsCurrent()) return;
      const granted = await requestNotificationPermission();
      if (!accountIsCurrent()) return;
      if (!granted) {
        const permission = await getNotificationPermissionState();
        if (!accountIsCurrent()) return;
        if (permission === 'blocked') {
          Alert.alert('Notifications are off', 'You can enable ReferralFit notifications in your device settings.', [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings().catch((error) => Alert.alert('Settings unavailable', (error as Error).message)) },
          ]);
        }
        return;
      }
      try {
        if (!accountIsCurrent()) return;
        await AsyncStorage.setItem(notificationScheduleKey(userId), 'enabled');
        if (!accountIsCurrent()) return;
        await rescheduleNotifications({ partners, referrals, referralMatches, followUps, cases }, userId);
        if (!accountIsCurrent()) return;
      } catch (error) {
        if (accountIsCurrent()) Alert.alert('Notifications not scheduled', (error as Error).message);
      }
    };
    return (
      <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
        <Pressable style={styles.dropdownOverlay} onPress={dismiss}>
          <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownSheetHandle} />
            <ScrollView style={styles.keyboardSheetScroll} contentContainerStyle={styles.prePromptBody} keyboardShouldPersistTaps="handled">
              <View style={styles.prePromptIcon}><AppIcon name="notifications-outline" size={24} color={COLORS.forest} /></View>
              <Text style={styles.prePromptTitle}>Stay ahead of cold relationships</Text>
              <Text style={styles.prePromptText}>ReferralFit can send a 7 AM briefing and a nudge when a partner passes their stay-in-touch cadence. Everything is scheduled on this device — no data leaves your phone.</Text>
              <TouchableOpacity style={styles.primaryButton} onPress={enable}><Text style={styles.primaryButtonText}>Enable notifications</Text></TouchableOpacity>
              <TouchableOpacity onPress={dismiss} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Not now</Text></TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  function PacketComposeModal() {
    if (!packetTarget) return null;
    const labelWarning = labelLooksLikeFullName(packetTarget.match.clientLabel);
    return (
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={closePacketComposer}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close match packet" onPress={closePacketComposer} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>Match packet</Text>
              <View style={styles.closeButton} />
            </View>
            <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.formIntro}>
                A de-identified recommendation for {packetTarget.partner.organization}. Sending logs the referral, updates last contact, and sets a check-in follow-up.
              </Text>
              <Text style={styles.fieldLabel}>SENDING TO</Text>
              <View style={styles.segmented}>
                {(['family', 'partner'] as PacketAudience[]).map((audience) => (
                  <TouchableOpacity key={audience} onPress={() => switchPacketAudience(audience)} style={[styles.segment, packetAudience === audience && styles.segmentActive]}>
                    <AppIcon name={audience === 'family' ? 'people' : 'business'} size={16} color={packetAudience === audience ? COLORS.white : COLORS.inkSoft} />
                    <Text style={[styles.segmentText, packetAudience === audience && styles.segmentTextActive]}>{audience === 'family' ? 'Sending to family' : 'Sending to partner'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {labelWarning ? (
                <Text style={styles.packetReminder}><AppIcon name="lock-closed" size={13} color={COLORS.coral} /> Reminder: keep labels de-identified</Text>
              ) : null}
              <Text style={styles.fieldLabel}>PACKET TEXT</Text>
              <TextInput
                value={packetText}
                onChangeText={setPacketText}
                multiline
                placeholderTextColor="#99A6A1"
                style={[styles.formInput, styles.packetEditor]}
              />
              <TouchableOpacity style={styles.primaryButton} onPress={sharePacketText}>
                <Text style={styles.primaryButtonText}>Share packet…</Text>
              </TouchableOpacity>
              <Text style={styles.packetShareHint}>Opens the native share sheet — Messages, Mail, or anything else. After it closes we'll confirm it went out, then log everything.</Text>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  // One-tap confirm shown after the share sheet closes. iOS's share sheet
  // can't reliably tell us whether the user actually sent, so we ask instead
  // of logging phantom referrals.
  function PacketSendConfirmModal() {
    if (!packetSendConfirm || !packetTarget) return null;
    return (
      <Modal visible transparent animationType="fade" onRequestClose={() => setPacketSendConfirm(false)}>
        <Pressable style={styles.dropdownOverlay} onPress={() => setPacketSendConfirm(false)}>
          <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownSheetHandle} />
            <ScrollView style={styles.keyboardSheetScroll} contentContainerStyle={styles.prePromptBody} keyboardShouldPersistTaps="handled">
              <View style={styles.prePromptIcon}><AppIcon name="paper-plane" size={24} color={COLORS.forest} /></View>
              <Text style={styles.prePromptTitle}>Did you send it?</Text>
              <Text style={styles.prePromptText}>iOS can't always tell us whether the packet actually went out. Confirming logs the referral, records the touch, and sets the check-in follow-up.</Text>
              {packetTarget.assignOnSend && placementRankFor(packetTarget.match.id, packetTarget.partner.id) > 1 ? (
                <View style={styles.placementReasonBlock}>
                  <Text style={styles.fieldLabel}>WHY THIS PROGRAM?</Text>
                  <Text style={styles.placementReasonHint}>It was not the top match. The reason goes on the placement record, not to the family.</Text>
                  <View style={styles.wrapPills}>{placementReasonOptions.map((option) => <Pill key={option.value} label={option.label} active={placementReason === option.value} onPress={() => setPlacementReason(option.value)} />)}</View>
                  {placementReason === 'other' ? (
                    <TextInput value={placementReasonNote} onChangeText={setPlacementReasonNote} placeholder="A few words" placeholderTextColor="#99A6A1" style={[styles.formInput, { marginTop: 10 }]} />
                  ) : null}
                </View>
              ) : null}
              <TouchableOpacity style={styles.primaryButton} onPress={() => finalizePacketSend()}><Text style={styles.primaryButtonText}>Sent — log it</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => setPacketSendConfirm(false)} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Cancel — don't log</Text></TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  function OutcomeCaptureModal() {
    if (!outcomeFollowUp) return null;
    const referral = referrals.find((item) => item.id === outcomeFollowUp.referralId);
    return (
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={closeOutcomeSheet}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close outcome capture" onPress={closeOutcomeSheet} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>Outcome check-in</Text>
              <View style={styles.closeButton} />
            </View>
            <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.formIntro}>
                {outcomeFollowUp.title}{referral ? ` — ${referral.clientLabel}` : ''}
              </Text>
              <Text style={styles.fieldLabel}>DID THEY ADMIT?</Text>
              <View style={styles.segmented}>
                {([['yes', 'Yes'], ['no', 'No']] as const).map(([answer, label]) => (
                  <TouchableOpacity key={answer} accessibilityRole="radio" accessibilityLabel={`${label}, admitted`} accessibilityState={{ selected: outcomeAnswer === answer, checked: outcomeAnswer === answer }} onPress={() => setOutcomeAnswer(answer)} style={[styles.segment, outcomeAnswer === answer && styles.segmentActive]}>
                    <AppIcon name={answer === 'yes' ? 'checkmark-circle' : 'close-circle'} size={16} color={outcomeAnswer === answer ? COLORS.white : COLORS.inkSoft} />
                    <Text style={[styles.segmentText, outcomeAnswer === answer && styles.segmentTextActive]}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity onPress={outcomeNotYet} style={styles.outcomeNotYet}>
                <AppIcon name="time-outline" size={15} color={COLORS.blue} />
                <Text style={styles.outcomeNotYetText}>Not yet — snooze this check-in 4 days</Text>
              </TouchableOpacity>

              {outcomeAnswer === 'yes' ? (
                <>
                  <DropdownField
                    label="ADMITTED ON"
                    value={outcomeAdmittedOn}
                    icon="calendar-outline"
                    onChange={setOutcomeAdmittedOn}
                    options={Array.from({ length: 15 }, (_, index) => {
                      const date = new Date();
                      date.setDate(date.getDate() - index);
                      const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                      return { label: index === 0 ? `Today (${shortDate(stamp)})` : shortDate(stamp), value: stamp };
                    })}
                  />
                  <Text style={styles.fieldLabel}>HOW WAS THE FAMILY'S EXPERIENCE SO FAR? (OPTIONAL)</Text>
                  <View style={styles.starRow}>
                    {[1, 2, 3, 4, 5].map((star) => (
                      <TouchableOpacity key={star} accessibilityLabel={`${star} star${star === 1 ? '' : 's'}`} onPress={() => setOutcomeStars(star === outcomeStars ? 0 : star)} style={styles.starButton}>
                        <AppIcon name={star <= outcomeStars ? 'star' : 'star-outline'} size={30} color={star <= outcomeStars ? COLORS.gold : COLORS.gray} />
                      </TouchableOpacity>
                    ))}
                  </View>
                  <FormField label="NOTE (OPTIONAL)" value={outcomeNote} onChangeText={setOutcomeNote} placeholder="Anything worth remembering for next time" multiline />
                </>
              ) : null}
              {outcomeAnswer === 'no' ? (
                <FormField label="NOTE (OPTIONAL)" value={outcomeNote} onChangeText={setOutcomeNote} placeholder="What happened instead?" multiline />
              ) : null}

              <TouchableOpacity style={[styles.primaryButton, !outcomeAnswer && { opacity: 0.45 }]} disabled={!outcomeAnswer} onPress={saveOutcome}>
                <Text style={styles.primaryButtonText}>Save outcome</Text>
              </TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  // ─── Today Command Center sheets ─────────────────────────────────────────

  const WHEN_OPTIONS: { label: string; value: WhenChoice }[] = [
    { label: 'Today', value: 'today' },
    { label: 'Tomorrow', value: 'tomorrow' },
    { label: 'In 3 days', value: 'in3days' },
    { label: 'Next week', value: 'nextweek' },
    { label: 'Pick a date', value: 'custom' },
  ];
  const STEP_KIND_OPTIONS: { label: string; value: FollowUpKind; hint: string }[] = [
    { label: 'Call them back', value: 'promised_call', hint: 'You owe them a call' },
    { label: 'Consult', value: 'consult', hint: 'A scheduled sit-down — set a time' },
    { label: 'Waiting on them', value: 'waiting_on', hint: 'The ball is in their court' },
    { label: 'Follow up', value: 'follow_up', hint: 'General check-in' },
    { label: 'Partner touch', value: 'touch', hint: 'Keep the relationship warm' },
  ];
  // "Pick a date" without a calendar dependency: the next 21 days.
  const customDateOptions = Array.from({ length: 21 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() + index + 1);
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { label: shortDate(value), value };
  });

  // Kind + when + (waiting-on text / consult time) + optional note. Shared by
  // Done → "Next step…" (completes current, creates next) and Set Next Step
  // (reschedules/retypes current without completing).
  function StepFormFields() {
    return (
      <>
        <Text style={styles.fieldLabel}>WHAT'S THE NEXT STEP?</Text>
        <View style={styles.dropdownOptions}>
          {STEP_KIND_OPTIONS.map((option) => {
            const active = stepForm.kind === option.value;
            return (
              <TouchableOpacity key={option.value} onPress={() => setStepForm((current) => ({ ...current, kind: option.value }))} style={[styles.dropdownOption, active && styles.dropdownOptionActive]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.dropdownOptionText, active && styles.dropdownOptionTextActive]}>{option.label}</Text>
                  <Text style={styles.dropdownOptionDetail}>{option.hint}</Text>
                </View>
                {active ? <AppIcon name="checkmark-circle" size={20} color={COLORS.forest} /> : null}
              </TouchableOpacity>
            );
          })}
        </View>
        {stepForm.kind === 'waiting_on' ? (
          <FormField label="WAITING ON" value={stepForm.waitingOn} onChangeText={(waitingOn) => setStepForm((current) => ({ ...current, waitingOn }))} placeholder="insurance verification, the wife's answer…" />
        ) : null}
        <Text style={styles.fieldLabel}>WHEN</Text>
        <View style={styles.cadenceRow}>
          {WHEN_OPTIONS.map((option) => (
            <Pill key={option.value} label={option.label} active={stepForm.when === option.value} onPress={() => setStepForm((current) => ({ ...current, when: option.value }))} />
          ))}
        </View>
        {stepForm.when === 'custom' ? (
          <DropdownField label="DATE" value={stepForm.customDate || customDateOptions[0]?.value || ''} icon="calendar-outline" onChange={(customDate) => setStepForm((current) => ({ ...current, customDate }))} options={customDateOptions} />
        ) : null}
        {stepForm.kind === 'consult' ? (
          <View style={styles.timeEntryRow}>
            <View style={styles.timeInputField}>
              <FormField label="TIME (OPTIONAL)" value={stepForm.time} onChangeText={(time) => setStepForm((current) => ({ ...current, time: formatTwelveHourInput(time) }))} placeholder="9:00" keyboardType="number-pad" />
            </View>
            <View style={styles.timePeriodField}>
              <Text style={styles.fieldLabel}>AM OR PM</Text>
              <View style={styles.timePeriodRow}>
                {(['AM', 'PM'] as TimePeriod[]).map((period) => (
                  <Pill key={period} label={period} active={stepForm.timePeriod === period} onPress={() => setStepForm((current) => ({ ...current, timePeriod: period }))} />
                ))}
              </View>
            </View>
          </View>
        ) : null}
        <FormField label="NOTE (OPTIONAL)" value={stepForm.note} onChangeText={(note) => setStepForm((current) => ({ ...current, note }))} placeholder="Anything to remember when this comes due" multiline />
      </>
    );
  }

  function CaseNextStepModal(record: CaseRecord) {
    const close = () => setCaseNextStepCaseId(null);
    return (
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back to case file" onPress={close} style={styles.closeButton}><AppIcon name="arrow-back" size={21} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>Schedule next step</Text>
              <TouchableOpacity accessibilityRole="button" style={styles.modalHeaderAction} onPress={() => saveCaseNextStep(record)}><Text style={styles.saveText}>Save</Text></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.formIntro}>Set the next action for {record.title}. It will appear on Today when due.</Text>
              {StepFormFields()}
              <TouchableOpacity accessibilityRole="button" style={styles.primaryButton} onPress={() => saveCaseNextStep(record)}>
                <Text style={styles.primaryButtonText}>Schedule next step</Text>
              </TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  }

  // "Done — what's next?" — completing anything forces a decision:
  // (a) Next step… / (b) Close the loop. No bare done for linked items.
  function DoneSheet() {
    if (!doneCard) return null;
    const close = () => {
      if (caseCloseLoopSaving) return;
      setNextStepCard(null);
      setDoneCard(null);
      setDoneStatusPicker(false);
    };
    const referralAwaiting = Boolean(doneCard.referralId && doneCard.context.referralAwaitingAnswer);
    const linkedCase = doneCard.caseId ? cases.find((item) => item.id === doneCard.caseId) : undefined;
    const showingDoneNextStep = nextStepCard?.id === doneCard.id;
    return (
      <Modal visible transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.dropdownOverlay} onPress={close}>
          <Pressable style={[styles.dropdownSheet, showingDoneNextStep && styles.stepFormSheet]} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownSheetHandle} />
            <ScrollView
              style={[styles.keyboardSheetScroll, showingDoneNextStep && styles.stepFormScroll]}
              contentContainerStyle={[styles.prePromptBody, showingDoneNextStep && styles.stepFormContent]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={showingDoneNextStep}
            >
              {showingDoneNextStep ? (
                <>
                  <Text style={styles.prePromptTitle}>Done — set the next step</Text>
                  <Text style={styles.prePromptText}>{doneCard.title} — completing this and creating what comes after.</Text>
                  <Text style={styles.stepFormScrollHint}>Choose the next step, then scroll to set when it should happen and save.</Text>
                  {StepFormFields()}
                  <TouchableOpacity style={styles.primaryButton} onPress={confirmDoneNextStep}>
                    <Text style={styles.primaryButtonText}>Complete & schedule next</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setNextStepCard(null)} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Back</Text></TouchableOpacity>
                </>
              ) : doneStatusPicker && linkedCase ? (
                <>
                <Text style={styles.prePromptTitle}>Close the loop — {linkedCase.title}</Text>
                <Text style={styles.prePromptText}>Complete this item{doneCard.title ? ` (“${doneCard.title}”)` : ''} and set the case status. The change lands on the case timeline.</Text>
                <View style={[styles.cadenceRow, caseCloseLoopSaving && { opacity: 0.55 }]}>
                  {CASE_STATUSES.map((status) => (
                    <Pill key={status} label={status} active={status === linkedCase.status} disabled={caseCloseLoopSaving} onPress={() => closeLoopWithStatus(status)} />
                  ))}
                </View>
                <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: caseCloseLoopSaving, busy: caseCloseLoopSaving }} disabled={caseCloseLoopSaving} style={[styles.modalHeaderAction, caseCloseLoopSaving && { opacity: 0.55 }]} onPress={() => closeLoopWithStatus('keep')}>
                  <Text style={styles.saveText}>{caseCloseLoopSaving ? 'Saving…' : `Just complete — keep “${linkedCase.status}”`}</Text>
                </TouchableOpacity>
                {caseCloseLoopSaving ? <Text accessibilityLiveRegion="polite" style={[styles.prePromptText, { textAlign: 'center', marginTop: 8 }]}>Saving the follow-up and case status…</Text> : null}
                </>
              ) : (
                <>
              <View style={styles.prePromptIcon}><AppIcon name="checkmark-done" size={24} color={COLORS.forest} /></View>
              <Text style={styles.prePromptTitle}>Done — what's next?</Text>
              <Text style={styles.prePromptText}>{doneCard.title}{doneCard.context.caseTitle ? ` — ${doneCard.context.caseTitle}` : doneCard.context.partnerName ? ` — ${doneCard.context.partnerName}` : ''}</Text>
              <TouchableOpacity style={styles.primaryButton} onPress={() => openDoneNextStepFlow(doneCard)}>
                <Text style={styles.primaryButtonText}>Next step…</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.sheetSecondaryButton} onPress={confirmDoneCloseLoop}>
                <Text style={styles.sheetSecondaryButtonText}>{referralAwaiting ? 'Close the loop — record the outcome' : doneCard.caseId ? 'Close the loop — complete & set case status' : 'Close the loop — just complete'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={close} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Not yet</Text></TouchableOpacity>
                </>
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  // Set Next Step — reschedule/retype WITHOUT completing the current item.
  // Done → Next step is rendered inside DoneSheet so iOS never has to present
  // this native Modal over another native Modal.
  function NextStepSheet() {
    if (!nextStepCard || doneCard) return null;
    const close = () => setNextStepCard(null);
    return (
      <Modal visible transparent animationType="fade" onRequestClose={close}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <Pressable style={styles.dropdownOverlay} onPress={close}>
            <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownSheetHandle} />
            <ScrollView style={styles.keyboardSheetScroll} contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.prePromptTitle}>Set next step</Text>
              <Text style={styles.prePromptText}>{nextStepCard.title} — rescheduling without completing it.</Text>
              {StepFormFields()}
              <TouchableOpacity style={styles.primaryButton} onPress={confirmNextStep}>
                <Text style={styles.primaryButtonText}>Save next step</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={close} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Cancel</Text></TouchableOpacity>
            </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    );
  }

  // The ⋯ overflow: Snooze (+1/+2/next week) and Set Next Step.
  function SnoozeSheet() {
    if (!snoozeCard) return null;
    const close = () => setSnoozeCard(null);
    return (
      <Modal visible transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.dropdownOverlay} onPress={close}>
          <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownSheetHandle} />
            <ScrollView style={styles.keyboardSheetScroll} contentContainerStyle={styles.prePromptBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.prePromptTitle}>{snoozeCard.title}</Text>
              <Text style={styles.prePromptText}>{snoozeCard.virtual ? 'Partner cadence — snoozing only affects this device; logging a touch resets it everywhere.' : 'Snooze hides it from Today until then.'}</Text>
              <View style={styles.cadenceRow}>
                <Pill label="+1 day" onPress={() => confirmSnooze('plus1')} />
                <Pill label="+2 days" onPress={() => confirmSnooze('plus2')} />
                <Pill label="Next week" onPress={() => confirmSnooze('nextweek')} />
              </View>
              {teamWorkspace && snoozeCard.followUp ? (
                <TouchableOpacity style={styles.sheetSecondaryButton} onPress={() => { const followUp = snoozeCard.followUp as FollowUp; setSnoozeCard(null); pickFollowUpAssignee(followUp); }}>
                  <Text style={styles.sheetSecondaryButtonText}>Assign to…</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={styles.sheetSecondaryButton} onPress={() => { const card = snoozeCard; setSnoozeCard(null); openNextStepSheet(card); }}>
                <Text style={styles.sheetSecondaryButtonText}>Set next step…</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={close} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Cancel</Text></TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  // "I need to…" — the 5-second capture.
  function QuickAddSheet() {
    if (!showQuickAdd) return null;
    const close = () => setShowQuickAdd(false);
    const needle = quickAddForm.targetSearch.trim().toLowerCase();
    const caseOptions = cases.filter(isOpenCase).filter((record) => !needle || record.title.toLowerCase().includes(needle)).slice(0, 4);
    const partnerOptions = partners.filter((partner) => !needle || `${partner.organization} ${partner.name}`.toLowerCase().includes(needle)).slice(0, 4);
    return (
      <Modal visible transparent animationType="fade" onRequestClose={close}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <Pressable style={styles.dropdownOverlay} onPress={close}>
            <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownSheetHandle} />
            <ScrollView style={styles.keyboardSheetScroll} contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.prePromptTitle}>I need to…</Text>
              <FormField label="WHAT *" value={quickAddForm.title} onChangeText={(title) => setQuickAddForm((current) => ({ ...current, title }))} placeholder="I promised Sarah I'd call Thursday" />
              <Text style={styles.fieldLabel}>KIND</Text>
              <View style={styles.cadenceRow}>
                {STEP_KIND_OPTIONS.map((option) => (
                  <Pill key={option.value} label={option.label} active={quickAddForm.kind === option.value} onPress={() => setQuickAddForm((current) => ({ ...current, kind: option.value }))} />
                ))}
              </View>
              {quickAddForm.kind === 'waiting_on' ? (
                <FormField label="WAITING ON" value={quickAddForm.waitingOn} onChangeText={(waitingOn) => setQuickAddForm((current) => ({ ...current, waitingOn }))} placeholder="insurance verification…" />
              ) : null}
              <Text style={styles.fieldLabel}>WHO (OPTIONAL)</Text>
              <View style={styles.cadenceRow}>
                {(['none', 'case', 'partner'] as const).map((targetType) => (
                  <Pill key={targetType} label={targetType === 'none' ? 'No one' : targetType === 'case' ? 'A case' : 'A partner'} active={quickAddForm.targetType === targetType} onPress={() => setQuickAddForm((current) => ({ ...current, targetType, targetId: '', targetSearch: '' }))} />
                ))}
              </View>
              {quickAddForm.targetType !== 'none' ? (
                <>
                  <View style={styles.searchBox}>
                    <AppIcon name="search" size={17} color={COLORS.gray} />
                    <TextInput value={quickAddForm.targetSearch} onChangeText={(targetSearch) => setQuickAddForm((current) => ({ ...current, targetSearch }))} placeholder={quickAddForm.targetType === 'case' ? 'Search cases' : 'Search partners'} placeholderTextColor="#91A09B" style={styles.searchInput} />
                  </View>
                  <View style={{ marginTop: 8, marginBottom: 8 }}>
                    {(quickAddForm.targetType === 'case' ? caseOptions : partnerOptions).map((option) => {
                      const id = (option as CaseRecord).id;
                      const label = quickAddForm.targetType === 'case' ? (option as CaseRecord).title : `${(option as Partner).organization} — ${(option as Partner).name}`;
                      const active = quickAddForm.targetId === id;
                      return (
                        <TouchableOpacity key={id} onPress={() => setQuickAddForm((current) => ({ ...current, targetId: id }))} style={[styles.dropdownOption, active && styles.dropdownOptionActive]}>
                          <Text numberOfLines={1} style={[styles.dropdownOptionText, active && styles.dropdownOptionTextActive, { flex: 1 }]}>{label}</Text>
                          {active ? <AppIcon name="checkmark-circle" size={18} color={COLORS.forest} /> : null}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              ) : null}
              <Text style={styles.fieldLabel}>WHEN</Text>
              <View style={styles.cadenceRow}>
                {WHEN_OPTIONS.map((option) => (
                  <Pill key={option.value} label={option.label} active={quickAddForm.when === option.value} onPress={() => setQuickAddForm((current) => ({ ...current, when: option.value }))} />
                ))}
              </View>
              {quickAddForm.when === 'custom' ? (
                <DropdownField label="DATE" value={quickAddForm.customDate || customDateOptions[0]?.value || ''} icon="calendar-outline" onChange={(customDate) => setQuickAddForm((current) => ({ ...current, customDate }))} options={customDateOptions} />
              ) : null}
              {quickAddForm.kind === 'consult' ? (
                <View style={styles.timeEntryRow}>
                  <View style={styles.timeInputField}>
                    <FormField label="TIME (OPTIONAL)" value={quickAddForm.time} onChangeText={(time) => setQuickAddForm((current) => ({ ...current, time: formatTwelveHourInput(time) }))} placeholder="9:00" keyboardType="number-pad" />
                  </View>
                  <View style={styles.timePeriodField}>
                    <Text style={styles.fieldLabel}>AM OR PM</Text>
                    <View style={styles.timePeriodRow}>
                      {(['AM', 'PM'] as TimePeriod[]).map((period) => (
                        <Pill key={period} label={period} active={quickAddForm.timePeriod === period} onPress={() => setQuickAddForm((current) => ({ ...current, timePeriod: period }))} />
                      ))}
                    </View>
                  </View>
                </View>
              ) : null}
              <TouchableOpacity style={styles.primaryButton} onPress={saveQuickAdd}><Text style={styles.primaryButtonText}>Add to the list</Text></TouchableOpacity>
              <TouchableOpacity onPress={close} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Cancel</Text></TouchableOpacity>
            </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    );
  }

  // Several contacts have numbers — pick who to reach.
  function ContactPickSheet() {
    if (!contactPick) return null;
    const close = () => setContactPick(null);
    return (
      <Modal visible transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.dropdownOverlay} onPress={close}>
          <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownSheetHandle} />
            <ScrollView style={styles.keyboardSheetScroll} contentContainerStyle={styles.prePromptBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.prePromptTitle}>{contactPick.action === 'call' ? 'Call' : 'Text'} who?</Text>
              {contactPick.contacts.map((contact) => (
                <TouchableOpacity key={contact.id} style={styles.contactPickRow} onPress={async () => {
                  const pick = contactPick;
                  setContactPick(null);
                  const url = `${pick.action === 'call' ? 'tel' : 'sms'}:${contact.phone.replace(/[^\d+]/g, '')}`;
                  try {
                    const supported = await Linking.canOpenURL(url);
                    if (!supported) throw new Error('Unsupported contact action');
                    await Linking.openURL(url);
                    logCardContact(pick.card, pick.action, contact);
                  } catch {
                    Alert.alert('Unable to open', 'This device could not open that action. Nothing was logged.');
                  }
                }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.contactPickName}>{contact.name}{contact.isPrimary ? ' · primary' : ''}</Text>
                    <Text style={styles.contactPickMeta}>{[contact.relationship, contact.phone].filter(Boolean).join(' · ')}</Text>
                  </View>
                  <AppIcon name={contactPick.action === 'call' ? 'call' : 'chatbubble'} size={18} color={COLORS.forest} />
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={close} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Cancel</Text></TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  // Same skippable quick-note the case file offers after a call/text.
  function TodayQuickNoteSheet() {
    if (!todayQuickNote) return null;
    const close = () => { setTodayQuickNote(null); setQuickNoteText(''); };
    return (
      <Modal visible transparent animationType="fade" onRequestClose={close}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <Pressable style={styles.dropdownOverlay} onPress={close}>
            <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
              <View style={styles.dropdownSheetHandle} />
              <ScrollView style={styles.keyboardSheetScroll} contentContainerStyle={styles.prePromptBody} keyboardShouldPersistTaps="handled">
                <View style={styles.prePromptIcon}><AppIcon name={todayQuickNote.action === 'call' ? 'call' : 'chatbubble'} size={24} color={COLORS.forest} /></View>
                <Text style={styles.prePromptTitle}>Add a note about this {todayQuickNote.action}?</Text>
                <TextInput
                  value={quickNoteText}
                  onChangeText={setQuickNoteText}
                  placeholder={`What came out of it?${todayQuickNote.contact ? ` (${todayQuickNote.contact.name})` : ''}`}
                  placeholderTextColor="#99A6A1"
                  multiline
                  style={[styles.formInput, styles.multilineInput, { minHeight: 80 }]}
                />
                <TouchableOpacity style={styles.primaryButton} onPress={saveTodayQuickNote}><Text style={styles.primaryButtonText}>Save note</Text></TouchableOpacity>
                <TouchableOpacity onPress={close} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Skip</Text></TouchableOpacity>
              </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    );
  }

  if (!loaded) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <>
        <StatusBar style="dark" />
        <LoginScreen onSignedIn={() => {}} />
      </>
    );
  }

  if (passwordRecovery) {
    return (
      <>
        <StatusBar style="dark" />
        <ResetPasswordScreen email={session.user?.email ?? null} onDone={() => setPasswordRecovery(false)} />
      </>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.appShell}>
        <View style={styles.screen}>{tab === 'home' ? HomeScreen() : tab === 'match' ? MatchScreen() : tab === 'cases' ? CasesScreen() : tab === 'directory' ? DirectoryScreen() : ReferralsScreen()}</View>
        {BottomNav()}
      </View>
      {PartnerDetailModal()}
      {AddPartnerModal()}
      {OrgProfileModal()}
      {AddReferralModal()}
      {LogTouchModal()}
      {WelcomeModal()}
      {ProfilePromptModal()}
      {NotifPrePromptModal()}
      {PacketComposeModal()}
      {PacketSendConfirmModal()}
      {OutcomeCaptureModal()}
      {CaseDetailModal()}
      {NewCaseModal()}
      <NewLeadSheet
        visible={showNewLead}
        targetMinutes={leadSettings.leadResponseTargetMinutes}
        onClose={() => setShowNewLead(false)}
        onSave={saveNewLead}
      />
      <BusinessDashboard
        visible={showBusinessDashboard}
        cases={cases}
        referrals={referrals}
        data={businessData}
        loading={businessLoading}
        error={businessError}
        benchmarksEntitled={entitlements.entitlements.benchmarks}
        leadResponseTargetMinutes={leadSettings.leadResponseTargetMinutes}
        onClose={() => setShowBusinessDashboard(false)}
        onRefresh={() => { void refreshBusiness(); }}
        onOpenCase={(caseId) => {
          setShowBusinessDashboard(false);
          setTimeout(() => openCase(caseId), 350);
        }}
      />
      <GlobalDirectoryScreen
        visible={showGlobalDirectory}
        entitled={entitlements.entitlements.directory}
        entitlementKnown={Boolean(entitlements.loadedAt)}
        userId={activeUserId}
        importedGlobalIds={new Set(partners.map((partner) => partner.globalPartnerId).filter((id): id is string => Boolean(id)))}
        onClose={() => setShowGlobalDirectory(false)}
        onImported={(_partner, _globalId, initiatingUserId) => {
          if (activeUserIdRef.current !== initiatingUserId) return;
          void refreshSnapshot(initiatingUserId)
            .then((snapshot) => {
              if (snapshot && activeUserIdRef.current === initiatingUserId) applySnapshot(snapshot);
            })
            .catch((error) => {
              if (activeUserIdRef.current === initiatingUserId) {
                Alert.alert('Program added; refresh needed', (error as Error).message);
              }
            });
        }}
      />
      <WorkspaceScreen
        visible={showWorkspace}
        userId={activeUserId}
        entitlements={entitlements}
        onClose={() => setShowWorkspace(false)}
        onWorkspaceChanged={() => {
          setShowWorkspace(false);
          setWorkspaceEpoch((epoch) => epoch + 1);
        }}
        onEditDirectoryProfile={() => { void openOrgProfileForm(true); }}
        onLeadSettingsChanged={() => { void reloadLeadSettings(); }}
        onAccountDeleted={() => {
          setShowWorkspace(false);
          cancelReferralFitNotifications().catch(() => undefined);
          resetAccountState();
        }}
      />
      {DoneSheet()}
      {NextStepSheet()}
      {SnoozeSheet()}
      {QuickAddSheet()}
      {ContactPickSheet()}
      {TodayQuickNoteSheet()}
    </SafeAreaView>
  );
}

function FormField({ label, value, onChangeText, placeholder, keyboardType, multiline, inputRef }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'number-pad' | 'url'; multiline?: boolean; inputRef?: React.Ref<TextInput> }) {
  return (
    <View style={styles.formField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#99A6A1"
        keyboardType={keyboardType}
        multiline={multiline}
        autoCapitalize={keyboardType === 'email-address' || keyboardType === 'url' ? 'none' : 'sentences'}
        style={[styles.formInput, multiline && styles.multilineInput]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.cream },
  appShell: { flex: 1, alignSelf: 'center', width: '100%', maxWidth: 520, backgroundColor: COLORS.cream, overflow: 'hidden' },
  screen: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: Platform.OS === 'android' ? 18 : 8, paddingBottom: 28 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 10, marginBottom: 22 },
  headerActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexShrink: 1 },
  headerIconButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  brandRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: { width: 36, height: 36, borderRadius: 12 },
  brandName: { fontSize: 19, fontWeight: '800', color: COLORS.ink, letterSpacing: -0.4 },
  welcomeRow: { marginBottom: 22 },
  eyebrow: { color: COLORS.gray, fontSize: 11, fontWeight: '800', letterSpacing: 1.25, marginBottom: 7 },
  heroTitle: { fontSize: 29, lineHeight: 35, color: COLORS.ink, fontWeight: '800', letterSpacing: -0.9 },
  heroSubtitle: { fontSize: 15, color: COLORS.gray, marginTop: 5 },
  statRow: { flexDirection: 'row', gap: 12, marginBottom: 28 },
  statCard: { flex: 1, backgroundColor: COLORS.white, borderRadius: 20, padding: 17, borderWidth: 1, borderColor: '#E6E9E4' },
  statNumber: { fontSize: 28, fontWeight: '800', color: COLORS.ink, letterSpacing: -0.8 },
  statLabel: { fontSize: 12, color: COLORS.inkSoft, fontWeight: '700', marginTop: 1 },
  statDetail: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 11 },
  statDetailText: { fontSize: 10, color: COLORS.gray, fontWeight: '600' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, marginTop: 2 },
  sectionTitle: { color: COLORS.ink, fontSize: 18, fontWeight: '800', letterSpacing: -0.35 },
  textAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 4 },
  textActionLabel: { color: COLORS.forest, fontSize: 12, fontWeight: '800' },
  returnCard: { backgroundColor: COLORS.white, borderRadius: 22, padding: 16, borderWidth: 1, borderColor: '#E5E8E3', marginBottom: 27 },
  returnIntro: { flexDirection: 'row', gap: 12, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  returnIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: COLORS.coralPale, alignItems: 'center', justifyContent: 'center' },
  returnTitle: { color: COLORS.ink, fontSize: 13, lineHeight: 18, fontWeight: '800' },
  returnBody: { color: COLORS.gray, fontSize: 11, lineHeight: 16, marginTop: 4 },
  returnPartner: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  returnPartnerName: { color: COLORS.ink, fontSize: 13, fontWeight: '700' },
  returnPartnerType: { color: COLORS.gray, fontSize: 11, marginTop: 2 },
  activityCard: { backgroundColor: COLORS.white, borderRadius: 22, paddingHorizontal: 16, borderWidth: 1, borderColor: '#E5E8E3' },
  activityRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  directionIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  inboundIcon: { backgroundColor: COLORS.mint },
  outboundIcon: { backgroundColor: '#E2EBEE' },
  activityTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '700' },
  activityBody: { color: COLORS.gray, fontSize: 11, marginTop: 3 },
  activityDate: { color: COLORS.gray, fontSize: 10 },
  activityOutcome: { color: COLORS.forest, fontSize: 10, fontWeight: '800', marginTop: 4 },
  screenIntro: { marginBottom: 20 },
  screenTitle: { color: COLORS.ink, fontSize: 28, lineHeight: 34, fontWeight: '800', letterSpacing: -0.8 },
  screenSubtitle: { color: COLORS.gray, fontSize: 14, lineHeight: 20, marginTop: 5, maxWidth: 390 },
  savedMatchesSection: { marginBottom: 18 },
  savedMatchesHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  savedMatchesSubtitle: { color: COLORS.gray, fontSize: 10, lineHeight: 14, marginTop: 3 },
  newMatchButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.forest, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9 },
  newMatchButtonText: { color: COLORS.white, fontSize: 11, fontWeight: '800' },
  savedMatchList: { gap: 9, paddingRight: 20 },
  savedMatchCard: { width: 225, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, borderRadius: 17, padding: 12 },
  savedMatchCardActive: { borderColor: COLORS.forest, borderWidth: 2, backgroundColor: COLORS.mintPale },
  savedMatchSelectButton: { minHeight: 72 },
  savedMatchTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  savedMatchIcon: { width: 28, height: 28, borderRadius: 9, backgroundColor: COLORS.mint, alignItems: 'center', justifyContent: 'center' },
  savedMatchIconComplete: { backgroundColor: COLORS.forest },
  savedMatchName: { flex: 1, color: COLORS.ink, fontSize: 13, fontWeight: '800' },
  savedMatchMeta: { color: COLORS.gray, fontSize: 10, marginTop: 9 },
  savedMatchStatus: { minHeight: 28, color: COLORS.coral, fontSize: 10, lineHeight: 14, fontWeight: '700', marginTop: 5 },
  savedMatchStatusComplete: { color: COLORS.forest },
  savedMatchActions: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  savedMatchRemoveButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 7 },
  savedMatchRemoveButtonText: { color: COLORS.coral, fontSize: 10, fontWeight: '800' },
  noSavedMatches: { color: COLORS.gray, fontSize: 11, lineHeight: 16, backgroundColor: COLORS.white, borderRadius: 15, borderWidth: 1, borderColor: COLORS.line, padding: 13 },
  filterCard: { backgroundColor: COLORS.white, borderRadius: 24, padding: 18, borderWidth: 1, borderColor: '#E5E8E3', marginBottom: 26 },
  matchEditorHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  matchEditorTitle: { color: COLORS.ink, fontSize: 16, fontWeight: '800' },
  matchEditorStatus: { color: COLORS.gray, fontSize: 10, marginTop: 3 },
  saveMatchButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: COLORS.mint, borderRadius: 13, paddingHorizontal: 11, paddingVertical: 9 },
  saveMatchButtonText: { color: COLORS.forest, fontSize: 10, fontWeight: '800' },
  fieldLabel: { color: COLORS.gray, fontSize: 10, fontWeight: '800', letterSpacing: 1.05, marginBottom: 9, marginTop: 5 },
  dropdownField: { marginBottom: 15 },
  dropdownButton: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: COLORS.mintPale, borderWidth: 1, borderColor: COLORS.line, borderRadius: 15, paddingHorizontal: 12 },
  dropdownLeading: { width: 34, height: 34, borderRadius: 10, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center' },
  dropdownValue: { flex: 1, flexShrink: 1, color: COLORS.ink, fontSize: 13, fontWeight: '700' },
  dropdownOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(11, 32, 27, 0.42)', paddingBottom: Platform.OS === 'ios' ? 16 : 0 },
  dropdownSheet: { maxHeight: '82%', backgroundColor: COLORS.cream, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingBottom: Platform.OS === 'ios' ? 26 : 22, shadowColor: COLORS.ink, shadowOpacity: 0.18, shadowRadius: 20, shadowOffset: { width: 0, height: -5 }, elevation: 12 },
  dropdownSheetHandle: { width: 42, height: 5, borderRadius: 3, backgroundColor: '#C4CEC9', alignSelf: 'center', marginTop: 9 },
  dropdownSheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  dropdownSheetEyebrow: { color: COLORS.gray, fontSize: 9, fontWeight: '800', letterSpacing: 1.1, marginBottom: 3 },
  dropdownSheetTitle: { color: COLORS.ink, fontSize: 18, fontWeight: '800' },
  dropdownOptions: { padding: 12, paddingBottom: 28 },
  dropdownOption: { minHeight: 50, flexDirection: 'row', alignItems: 'center', borderRadius: 13, paddingHorizontal: 13, paddingVertical: 9, marginBottom: 4 },
  dropdownOptionActive: { backgroundColor: COLORS.mint },
  dropdownOptionText: { color: COLORS.inkSoft, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  dropdownOptionTextActive: { color: COLORS.forest, fontWeight: '800' },
  dropdownOptionDetail: { color: COLORS.gray, fontSize: 9, marginTop: 2 },
  multiSelectCount: { minWidth: 23, height: 23, borderRadius: 12, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  multiSelectCountText: { color: COLORS.white, fontSize: 10, fontWeight: '800' },
  multiSelectDone: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.forest, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 8 },
  multiSelectDoneText: { color: COLORS.white, fontSize: 11, fontWeight: '800' },
  multiSelectActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 13 },
  multiSelectSelectionText: { color: COLORS.gray, fontSize: 10, fontWeight: '700' },
  multiSelectClearButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginVertical: -12 },
  multiSelectClear: { color: COLORS.coral, fontSize: 10, fontWeight: '800' },
  multiSelectOptionText: { flex: 1 },
  insuranceHint: { color: COLORS.gray, fontSize: 10, lineHeight: 15, marginTop: -8, marginBottom: 14, paddingHorizontal: 2 },
  networkPreferenceRow: { flexDirection: 'row', gap: 9, marginBottom: 7 },
  networkPreferenceOption: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.mintPale, paddingHorizontal: 12 },
  networkPreferenceOptionSelected: { borderColor: COLORS.sage, backgroundColor: COLORS.mint },
  networkPreferenceText: { flex: 1, color: COLORS.inkSoft, fontSize: 11, fontWeight: '700' },
  networkPreferenceTextSelected: { color: COLORS.forest, fontWeight: '800' },
  networkPreferenceHint: { color: COLORS.gray, fontSize: 10, lineHeight: 15, marginBottom: 14, paddingHorizontal: 2 },
  wrapPills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 20, paddingHorizontal: 13, paddingVertical: 9, backgroundColor: COLORS.mintPale, borderWidth: 1, borderColor: COLORS.line },
  pillActive: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  pillText: { color: COLORS.inkSoft, fontSize: 12, fontWeight: '700' },
  pillTextActive: { color: COLORS.white },
  budgetRow: { flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: COLORS.mintPale, borderRadius: 15, padding: 12, marginBottom: 18 },
  budgetIcon: { width: 36, height: 36, borderRadius: 11, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center' },
  inputCaption: { color: COLORS.gray, fontSize: 10, fontWeight: '700' },
  inlineInput: { color: COLORS.ink, fontSize: 14, fontWeight: '700', paddingVertical: 2 },
  budgetValue: { color: COLORS.forest, fontSize: 14, fontWeight: '800' },
  resultsHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  resultsCount: { color: COLORS.gray, fontSize: 11, marginTop: 2 },
  rankBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: COLORS.mint, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 14 },
  rankBadgeText: { color: COLORS.forest, fontSize: 10, fontWeight: '800' },
  matchCard: { backgroundColor: COLORS.white, borderRadius: 22, padding: 15, marginBottom: 12, borderWidth: 1, borderColor: '#E2E7E3' },
  bestMatchCard: { borderColor: COLORS.sage, borderWidth: 1.5 },
  matchCardContent: { flexDirection: 'row' },
  matchRank: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.forest, marginRight: 11 },
  matchRankText: { color: COLORS.white, fontSize: 12, fontWeight: '800' },
  matchMain: { flex: 1 },
  matchTopLine: { flexDirection: 'row', alignItems: 'flex-start' },
  matchOrg: { color: COLORS.ink, fontSize: 15, fontWeight: '800' },
  matchLocation: { color: COLORS.gray, fontSize: 11, marginTop: 3 },
  scoreBlock: { alignItems: 'flex-end', marginLeft: 7 },
  scoreNumber: { color: COLORS.forest, fontSize: 18, fontWeight: '900' },
  scoreLabel: { color: COLORS.gray, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  matchReason: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', marginTop: 12, backgroundColor: COLORS.mintPale, borderRadius: 11, padding: 9 },
  matchReasonText: { flex: 1, color: COLORS.inkSoft, fontSize: 11, lineHeight: 15, fontWeight: '600' },
  matchDetails: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  matchDetailText: { color: COLORS.gray, fontSize: 10, fontWeight: '600' },
  matchInsuranceText: { flex: 1, flexShrink: 1, marginRight: 8 },
  matchPriceText: { flexShrink: 0, color: COLORS.gray, fontSize: 10, fontWeight: '600', textAlign: 'right' },
  matchFlags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 9 },
  bedLineOpen: { color: COLORS.forest, fontSize: 11, fontWeight: '700', marginTop: 7 },
  bedLineUnconfirmed: { color: COLORS.gray, fontSize: 11, fontWeight: '700', marginTop: 7 },
  verifyBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#F3F3EF', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 5 },
  verifyBadgeText: { color: COLORS.inkSoft, fontSize: 9, fontWeight: '800' },
  disclosureBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.coralPale, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 5, flexShrink: 1 },
  disclosureBadgeText: { color: COLORS.coral, fontSize: 9, fontWeight: '800', flexShrink: 1 },
  matchFieldHint: { color: COLORS.gray, fontSize: 10, lineHeight: 15, marginTop: 8, marginBottom: 14, paddingHorizontal: 2 },
  mustHaveBlock: { marginTop: -4, marginBottom: 12 },
  placementReasonBlock: { marginTop: 4, marginBottom: 16 },
  placementReasonHint: { color: COLORS.gray, fontSize: 11, lineHeight: 16, marginTop: -4, marginBottom: 10 },
  assignReferralButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: COLORS.forest, borderRadius: 13, marginTop: 13 },
  assignReferralButtonText: { color: COLORS.white, fontSize: 11, fontWeight: '800' },
  directoryTitleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 18 },
  globalDirectoryBanner: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#EFF4FF', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 16 },
  globalDirectoryCopy: { flex: 1 },
  globalDirectoryTitle: { fontSize: 15, fontWeight: '700', color: '#175CD3' },
  globalDirectorySubtitle: { fontSize: 12.5, color: '#667085', marginTop: 1 },
  directoryTitleCopy: { flex: 1, minWidth: 0 },
  addButton: { minHeight: 44, flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.forest, borderRadius: 15, paddingHorizontal: 12, paddingVertical: 10 },
  addButtonText: { color: COLORS.white, fontSize: 12, fontWeight: '800' },
  caseHeaderActions: { flexShrink: 0, alignItems: 'stretch', gap: 6 },
  businessButton: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, paddingHorizontal: 10 },
  businessButtonText: { color: COLORS.forest, fontSize: 10, fontWeight: '800' },
  roundAdd: { width: 44, height: 44, borderRadius: 15, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center' },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: COLORS.white, borderRadius: 16, paddingHorizontal: 14, height: 50, borderWidth: 1, borderColor: COLORS.line },
  searchInput: { flex: 1, color: COLORS.ink, fontSize: 13, outlineStyle: 'none' } as any,
  searchClearButton: { width: 44, height: 44, marginRight: -12, alignItems: 'center', justifyContent: 'center' },
  directoryDropdown: { marginTop: 14 },
  directoryCountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9, paddingHorizontal: 2 },
  directoryCount: { color: COLORS.gray, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  partnerCard: { backgroundColor: COLORS.white, borderRadius: 20, padding: 15, marginBottom: 12, borderWidth: 1, borderColor: '#E3E7E3' },
  partnerCardCompact: { padding: 12 },
  partnerCardTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  partnerCardIdentity: { flex: 1 },
  partnerOrg: { color: COLORS.ink, fontSize: 15, fontWeight: '800' },
  partnerName: { color: COLORS.gray, fontSize: 11, marginTop: 3 },
  initials: { backgroundColor: COLORS.mint, alignItems: 'center', justifyContent: 'center' },
  initialsText: { color: COLORS.forest, fontWeight: '900', letterSpacing: -0.5 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 12 },
  typeBadge: { backgroundColor: COLORS.mintPale, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 5 },
  partnerTypeBadge: { flexShrink: 1, maxWidth: '74%' },
  typeBadgeText: { color: COLORS.forest, fontSize: 10, fontWeight: '800' },
  metaText: { color: COLORS.gray, fontSize: 11 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  miniTag: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4, backgroundColor: '#F3F3EF' },
  miniTagText: { color: COLORS.inkSoft, fontSize: 9, fontWeight: '600' },
  moreTags: { color: COLORS.gray, fontSize: 10, alignSelf: 'center', fontWeight: '700' },
  partnerFooter: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#EFF1EF' },
  partnerFooterText: { flex: 1, flexShrink: 1, color: COLORS.gray, fontSize: 10, fontWeight: '600' },
  cardShareButton: { width: 44, height: 44, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.mint },
  emptyState: { alignItems: 'center', paddingVertical: 36, paddingHorizontal: 28 },
  emptyIcon: { width: 52, height: 52, borderRadius: 18, backgroundColor: COLORS.mint, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  emptyTitle: { color: COLORS.ink, fontSize: 16, fontWeight: '800' },
  emptyBody: { color: COLORS.gray, fontSize: 12, textAlign: 'center', lineHeight: 18, marginTop: 6 },
  ledgerSummary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', backgroundColor: COLORS.white, borderRadius: 22, paddingVertical: 19, borderWidth: 1, borderColor: COLORS.line, marginBottom: 12 },
  ledgerMetric: { flex: 1, alignItems: 'center' },
  ledgerIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginBottom: 7 },
  ledgerNumber: { color: COLORS.ink, fontSize: 22, fontWeight: '800' },
  ledgerLabel: { color: COLORS.gray, fontSize: 10, fontWeight: '600', marginTop: 2 },
  ledgerDivider: { width: 1, height: 52, backgroundColor: COLORS.line },
  quickLogRow: { flexDirection: 'row', gap: 10, marginBottom: 26 },
  quickLogButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 15, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, paddingVertical: 12 },
  quickLogText: { color: COLORS.inkSoft, fontSize: 12, fontWeight: '700' },
  referralFilterRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 10, marginBottom: 10 },
  referralFilterButton: { minHeight: 38, justifyContent: 'center', borderRadius: 11, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, paddingHorizontal: 11 },
  referralFilterButtonActive: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  referralFilterText: { color: COLORS.inkSoft, fontSize: 10, fontWeight: '800' },
  referralFilterTextActive: { color: COLORS.white },
  referralFilterCount: { flex: 1, minWidth: 70, color: COLORS.gray, fontSize: 9, textAlign: 'right', paddingRight: 2 },
  referralList: { backgroundColor: COLORS.white, borderRadius: 22, paddingHorizontal: 15, borderWidth: 1, borderColor: COLORS.line, marginBottom: 27 },
  referralRow: { flexDirection: 'row', gap: 11, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  referralDirectionLine: { width: 3, borderRadius: 2 },
  referralTop: { flexDirection: 'row', justifyContent: 'space-between' },
  referralClient: { color: COLORS.ink, fontSize: 13, fontWeight: '800' },
  referralDate: { color: COLORS.gray, fontSize: 10 },
  referralPartner: { color: COLORS.gray, fontSize: 11, marginTop: 4 },
  referralOutcome: { alignSelf: 'flex-start', backgroundColor: COLORS.mintPale, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4, marginTop: 8 },
  referralOutcomeText: { color: COLORS.forest, fontSize: 9, fontWeight: '800' },
  balanceRow: { marginBottom: 16 },
  balanceNameRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginBottom: 7 },
  balanceName: { flex: 1, color: COLORS.ink, fontSize: 12, fontWeight: '700' },
  balanceNumbers: { color: COLORS.gray, fontSize: 10 },
  bottomNav: { flexDirection: 'row', paddingTop: 8, paddingBottom: Platform.OS === 'ios' ? 7 : 10, backgroundColor: COLORS.white, borderTopWidth: 1, borderTopColor: COLORS.line, shadowColor: COLORS.ink, shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: -4 } },
  navItem: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 3 },
  navIconWrap: { width: 40, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  navIconActive: { backgroundColor: COLORS.forest },
  navLabel: { color: COLORS.gray, fontSize: 9, fontWeight: '600' },
  navLabelActive: { color: COLORS.forest, fontWeight: '800' },
  modalPage: { flex: 1, backgroundColor: COLORS.cream },
  modalHandle: { width: 42, height: 5, borderRadius: 3, backgroundColor: '#C8D0CC', alignSelf: 'center', marginTop: 8 },
  modalHeader: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 14, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  modalHeaderTitle: { flex: 1, flexShrink: 1, textAlign: 'center', color: COLORS.ink, fontSize: 15, fontWeight: '800' },
  closeButton: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  modalHeaderAction: { minWidth: 44, minHeight: 44, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  saveText: { color: COLORS.forest, fontSize: 14, fontWeight: '800' },
  modalContent: { paddingHorizontal: 20, paddingBottom: 34 },
  profileHero: { alignItems: 'center', paddingVertical: 24 },
  profileOrg: { color: COLORS.ink, fontSize: 22, fontWeight: '800', letterSpacing: -0.5, marginTop: 12 },
  profileName: { color: COLORS.gray, fontSize: 13, marginTop: 4 },
  profileMeta: { flexDirection: 'row', gap: 9, alignItems: 'center', marginTop: 11 },
  profileActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
  profileAction: { flexGrow: 1, flexBasis: '30%', minWidth: 80, minHeight: 64, alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: COLORS.white, borderRadius: 16, paddingHorizontal: 6, paddingVertical: 10, borderWidth: 1, borderColor: COLORS.line },
  profileActionText: { color: COLORS.inkSoft, fontSize: 11, lineHeight: 15, textAlign: 'center', fontWeight: '700' },
  profileBalanceCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: COLORS.coralPale, borderRadius: 18, padding: 16, marginBottom: 18 },
  profileBalanceTitle: { color: COLORS.ink, fontSize: 14, fontWeight: '800' },
  profileCounts: { alignItems: 'flex-end', gap: 3 },
  profileCount: { color: COLORS.gray, fontSize: 11, fontWeight: '700' },
  infoCard: { backgroundColor: COLORS.white, borderRadius: 20, padding: 16, borderWidth: 1, borderColor: COLORS.line },
  infoTitle: { color: COLORS.ink, fontSize: 14, fontWeight: '800', marginBottom: 4 },
  infoLine: { flexDirection: 'row', gap: 11, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#EEF0EE' },
  infoLabel: { color: COLORS.gray, fontSize: 10, marginBottom: 3 },
  infoValue: { color: COLORS.inkSoft, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  infoTitleStandalone: { color: COLORS.ink, fontSize: 14, fontWeight: '800', marginTop: 21 },
  specialtyTag: { backgroundColor: COLORS.mint, borderRadius: 11, paddingHorizontal: 10, paddingVertical: 7 },
  specialtyText: { color: COLORS.forest, fontSize: 10, fontWeight: '700' },
  noteCard: { backgroundColor: COLORS.white, borderRadius: 17, padding: 15, marginTop: 9, borderWidth: 1, borderColor: COLORS.line },
  noteText: { color: COLORS.inkSoft, fontSize: 12, lineHeight: 19 },
  directoryStatusRow: { flexDirection: 'row', marginBottom: 9 },
  directoryDeclinedBadge: { backgroundColor: COLORS.coralPale },
  directoryDeclinedText: { color: COLORS.ink },
  directoryHint: { marginTop: 8 },
  directoryButtonBusy: { opacity: 0.7 },
  contactCard: { marginTop: 18, backgroundColor: COLORS.white, borderRadius: 17, padding: 14, gap: 11, borderWidth: 1, borderColor: COLORS.line },
  contactLine: { flexDirection: 'row', gap: 9, alignItems: 'center' },
  contactText: { color: COLORS.inkSoft, fontSize: 12 },
  formContent: { padding: 20, paddingBottom: 42 },
  formIntro: { color: COLORS.gray, fontSize: 13, lineHeight: 19, marginBottom: 20 },
  formField: { marginBottom: 15 },
  formInput: { backgroundColor: COLORS.white, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 14, color: COLORS.ink, fontSize: 13, outlineStyle: 'none' } as any,
  timeEntryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  timeInputField: { flex: 1, minWidth: 0 },
  timePeriodField: { width: 132 },
  timePeriodRow: { flexDirection: 'row', gap: 6 },
  multilineInput: { minHeight: 94, paddingTop: 13, textAlignVertical: 'top' },
  formRow: { flexDirection: 'row', gap: 10 },
  networkPlanRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: COLORS.mintPale, borderWidth: 1, borderColor: COLORS.line, borderRadius: 14, paddingHorizontal: 12, marginTop: -7, marginBottom: 15 },
  networkPlanName: { flex: 1, color: COLORS.ink, fontSize: 12, fontWeight: '700' },
  networkCheck: { minWidth: 54, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 11, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, paddingHorizontal: 8 },
  networkCheckActive: { borderColor: COLORS.forest, backgroundColor: COLORS.mint },
  networkCheckText: { color: COLORS.gray, fontSize: 11, fontWeight: '800' },
  networkCheckTextActive: { color: COLORS.forest },
  primaryButton: { backgroundColor: COLORS.forest, borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  primaryButtonText: { color: COLORS.white, fontSize: 14, fontWeight: '800' },
  matchedReferralBanner: { flexDirection: 'row', gap: 11, alignItems: 'center', backgroundColor: COLORS.mint, borderRadius: 17, padding: 14, marginBottom: 20 },
  matchedReferralIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center' },
  matchedReferralTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '800' },
  matchedReferralBody: { color: COLORS.gray, fontSize: 10, lineHeight: 15, marginTop: 3 },
  segmented: { flexDirection: 'row', backgroundColor: COLORS.mintPale, borderRadius: 15, padding: 4, marginBottom: 9 },
  segment: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: 12 },
  segmentActive: { backgroundColor: COLORS.forest },
  segmentText: { color: COLORS.inkSoft, fontSize: 12, fontWeight: '700' },
  segmentTextActive: { color: COLORS.white },
  directionExplainer: { color: COLORS.gray, fontSize: 11, lineHeight: 16, marginBottom: 20 },
  partnerPicker: { gap: 9, paddingBottom: 20 },
  partnerPick: { width: 102, minHeight: 88, backgroundColor: COLORS.white, borderRadius: 16, alignItems: 'center', justifyContent: 'center', padding: 9, borderWidth: 1, borderColor: COLORS.line },
  partnerPickActive: { borderColor: COLORS.forest, borderWidth: 2, backgroundColor: COLORS.mintPale },
  partnerPickText: { color: COLORS.inkSoft, fontSize: 9, lineHeight: 12, textAlign: 'center', fontWeight: '600', marginTop: 6 },
  partnerPickTextActive: { color: COLORS.forest, fontWeight: '800' },
  privacyHint: { color: COLORS.gray, fontSize: 10, lineHeight: 15, marginTop: -6, marginBottom: 18 },
  offlineBadge: { maxWidth: '58%', flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.mintPale, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 5, borderWidth: 1, borderColor: COLORS.line },
  offlineBadgeText: { flexShrink: 1, color: COLORS.gray, fontSize: 9, lineHeight: 12, fontWeight: '700' },
  refreshNotice: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: COLORS.mintPale, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 12 },
  refreshNoticeText: { flex: 1, color: COLORS.gray, fontSize: 12, lineHeight: 16, fontWeight: '600' },
  cadenceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  touchLogList: { marginTop: 12, backgroundColor: COLORS.white, borderRadius: 17, paddingHorizontal: 14, borderWidth: 1, borderColor: COLORS.line },
  touchLogRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#EEF0EE' },
  touchLogIcon: { width: 28, height: 28, borderRadius: 9, backgroundColor: COLORS.mint, alignItems: 'center', justifyContent: 'center' },
  touchLogTitle: { color: COLORS.ink, fontSize: 12, fontWeight: '700' },
  touchLogNote: { color: COLORS.gray, fontSize: 10, marginTop: 2 },
  touchLogDate: { color: COLORS.gray, fontSize: 10 },
  prePromptBody: { padding: 20, paddingBottom: 26 },
  keyboardSheetScroll: { flexShrink: 1 },
  stepFormSheet: { height: '92%', maxHeight: '92%' },
  stepFormScroll: { flex: 1 },
  stepFormContent: { paddingBottom: 44 },
  stepFormScrollHint: { color: COLORS.forest, fontSize: 12, fontWeight: '700', lineHeight: 18, marginTop: -8, marginBottom: 12 },
  prePromptIcon: { width: 52, height: 52, borderRadius: 18, backgroundColor: COLORS.mint, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  prePromptTitle: { color: COLORS.ink, fontSize: 18, fontWeight: '800', letterSpacing: -0.35, marginBottom: 8 },
  prePromptText: { color: COLORS.gray, fontSize: 13, lineHeight: 19, marginBottom: 20 },
  prePromptNotNow: { alignItems: 'center', paddingVertical: 12 },
  prePromptNotNowText: { color: COLORS.gray, fontSize: 12, fontWeight: '700' },
  // Match Packet
  matchActionRow: { flexDirection: 'row', gap: 8, marginTop: 13 },
  matchActionFlex: { flex: 1, marginTop: 0 },
  packetButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: COLORS.mint, borderRadius: 13, paddingHorizontal: 13 },
  packetButtonText: { color: COLORS.forest, fontSize: 11, fontWeight: '800' },
  savedMatchPacketButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 9, backgroundColor: COLORS.mint, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 6, alignSelf: 'flex-start' },
  savedMatchPacketButtonText: { color: COLORS.forest, fontSize: 10, fontWeight: '800' },
  packetReminder: { color: COLORS.coral, fontSize: 10, lineHeight: 15, marginTop: -4, marginBottom: 14, fontWeight: '700' },
  packetEditor: { minHeight: 260, paddingTop: 13, textAlignVertical: 'top', lineHeight: 19 },
  packetShareHint: { color: COLORS.gray, fontSize: 10, lineHeight: 15, marginTop: 12, textAlign: 'center' },
  // Follow-ups
  followUpCard: { backgroundColor: COLORS.white, borderRadius: 22, paddingHorizontal: 16, borderWidth: 1, borderColor: '#E5E8E3', marginBottom: 27 },
  followUpRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  followUpIcon: { width: 34, height: 34, borderRadius: 11, backgroundColor: COLORS.coralPale, alignItems: 'center', justifyContent: 'center' },
  followUpTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '700' },
  followUpMeta: { color: COLORS.gray, fontSize: 11, marginTop: 3 },
  followUpActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 9 },
  followUpActionDone: { minHeight: 44, justifyContent: 'center', backgroundColor: COLORS.forest, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  followUpActionDoneText: { color: COLORS.white, fontSize: 10, fontWeight: '800' },
  followUpAction: { minHeight: 44, justifyContent: 'center', backgroundColor: COLORS.mintPale, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: COLORS.line },
  followUpActionText: { color: COLORS.inkSoft, fontSize: 10, fontWeight: '700' },
  // Outcome capture
  outcomeNotYet: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, marginBottom: 10 },
  outcomeNotYetText: { color: COLORS.blue, fontSize: 12, fontWeight: '700' },
  starRow: { flexDirection: 'row', gap: 8, marginBottom: 18 },
  starButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', padding: 4 },
  // Case files
  caseRevenueCard: { flexDirection: 'row', alignItems: 'stretch', backgroundColor: COLORS.white, borderRadius: 17, borderWidth: 1, borderColor: COLORS.line, marginBottom: 14, paddingVertical: 14, paddingHorizontal: 12 },
  caseRevenueMetric: { flex: 1, minWidth: 0, paddingHorizontal: 6 },
  caseRevenueLabel: { color: COLORS.gray, fontSize: 8, lineHeight: 11, fontWeight: '800', letterSpacing: 0.4 },
  caseRevenueValue: { color: COLORS.forest, fontSize: 20, fontWeight: '900', marginTop: 4 },
  caseRevenueDivider: { width: 1, backgroundColor: COLORS.line, marginHorizontal: 8 },
  businessDetailRow: { flexDirection: 'row', gap: 12, marginTop: 6 },
  businessDetailMetric: { flex: 1, minWidth: 0 },
  businessDetailValue: { color: COLORS.inkSoft, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  businessLostReason: { color: COLORS.coral, fontSize: 10, lineHeight: 15, marginTop: 11 },
  caseRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  caseRowIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  caseRowTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '700' },
  caseRowMetaLine: { flexDirection: 'row', gap: 6, marginTop: 5 },
  caseRowMeta: { color: COLORS.gray, fontSize: 10, marginTop: 5 },
  caseChip: { flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4, alignSelf: 'flex-start' },
  caseChipText: { fontSize: 9, fontWeight: '800' },
  caseChipLarge: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, justifyContent: 'center' },
  caseChipLargeText: { fontSize: 12, textTransform: 'capitalize' },
  caseSearchHint: { color: COLORS.gray, fontSize: 12, lineHeight: 18, padding: 14 },
  closedToggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 2, marginBottom: 8 },
  closedToggleText: { color: COLORS.gray, fontSize: 12, fontWeight: '800' },
  caseSectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  caseSectionAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 6 },
  caseSectionActionText: { color: COLORS.forest, fontSize: 12, fontWeight: '800' },
  caseSectionHint: { color: COLORS.gray, fontSize: 9, lineHeight: 13, marginTop: 2, maxWidth: 250 },
  caseNextStepRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  caseEmptyNote: { color: COLORS.gray, fontSize: 11, lineHeight: 17, backgroundColor: COLORS.white, borderRadius: 15, borderWidth: 1, borderColor: COLORS.line, padding: 13, marginTop: 9 },
  caseContactRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  caseContactEditTarget: { minHeight: 44, justifyContent: 'center' },
  caseContactNameLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  caseContactName: { color: COLORS.ink, fontSize: 13, fontWeight: '800' },
  caseContactMeta: { color: COLORS.gray, fontSize: 10, marginTop: 3 },
  caseContactActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 9 },
  caseContactAction: { minWidth: 44, minHeight: 44, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  caseContactActionText: { color: COLORS.forest, fontSize: 10, fontWeight: '800' },
  caseComposer: { backgroundColor: COLORS.white, borderRadius: 17, padding: 10, borderWidth: 1, borderColor: COLORS.line, marginTop: 9, marginBottom: 4 },
  caseComposerKinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 9 },
  caseKindPill: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: COLORS.mintPale, borderWidth: 1, borderColor: COLORS.line },
  caseKindPillActive: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  caseKindPillText: { color: COLORS.inkSoft, fontSize: 10, fontWeight: '700' },
  caseKindPillTextActive: { color: COLORS.white },
  caseComposerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  caseComposerSend: { width: 44, height: 44, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center' },
  casePaymentRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  casePaymentPicker: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: COLORS.mintPale, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 10, minHeight: 44, marginTop: 4 },
  casePaymentPickerText: { color: COLORS.ink, fontSize: 12, fontWeight: '700', textTransform: 'capitalize' },
  caseAmountInput: { backgroundColor: COLORS.mintPale, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 10, minHeight: 44, marginTop: 4, color: COLORS.ink, fontSize: 12, fontWeight: '700' },
  caseAddPaymentButton: { minHeight: 46, borderRadius: 13, backgroundColor: COLORS.forest, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 12 },
  caseAddPaymentButtonText: { color: COLORS.white, fontSize: 12, fontWeight: '800' },
  casePaymentHint: { color: COLORS.gray, fontSize: 9, lineHeight: 14, marginTop: 9 },
  paymentTotalCard: { backgroundColor: COLORS.mintPale, borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, padding: 16, marginBottom: 18 },
  paymentTotalValue: { color: COLORS.forest, fontSize: 28, fontWeight: '900', marginTop: 4 },
  paymentTotalPreview: { color: COLORS.inkSoft, fontSize: 12, fontWeight: '700', marginTop: 6 },
  caseDocAddRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 9 },
  caseDocGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 11 },
  caseDocTile: { width: '31%', backgroundColor: COLORS.white, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, padding: 10 },
  caseDocTileBody: { alignItems: 'center', gap: 6, minHeight: 74 },
  caseDocLabel: { color: COLORS.ink, fontSize: 10, fontWeight: '700', textAlign: 'center' },
  caseDocSize: { color: COLORS.gray, fontSize: 9 },
  caseDocDelete: { position: 'absolute', top: -8, right: -8, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  caseLinkedRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  caseOpenInMatch: { color: COLORS.forest, fontSize: 11, fontWeight: '800' },
  docViewOverlay: { flex: 1, backgroundColor: 'rgba(11, 32, 27, 0.94)' },
  docViewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 54, paddingBottom: 10 },
  docViewTitle: { flex: 1, color: COLORS.white, fontSize: 15, fontWeight: '800' },
  docViewImage: { flex: 1, marginBottom: 30 },
  // Today Command Center
  todaySection: { marginBottom: 16 },
  todayScopeBlock: { marginBottom: 10 },
  todaySectionHeader: { color: COLORS.gray, fontSize: 11, fontWeight: '800', letterSpacing: 1.1, marginBottom: 7, marginTop: 2 },
  todaySectionHeaderOverdue: { color: COLORS.coral },
  todayRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: COLORS.white, borderRadius: 15, padding: 11, marginBottom: 7, borderWidth: 1, borderColor: '#E5E8E3' },
  todayRowOverdue: { borderLeftWidth: 3, borderLeftColor: COLORS.coral },
  todayKindIcon: { width: 30, height: 30, borderRadius: 9, backgroundColor: COLORS.mint, alignItems: 'center', justifyContent: 'center' },
  todayKindIconOverdue: { backgroundColor: COLORS.coralPale },
  todayRowBody: { flex: 1 },
  todayRowTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '700', lineHeight: 17 },
  todayRowMeta: { color: COLORS.gray, fontSize: 10, marginTop: 2 },
  todayOverdueBadge: { color: COLORS.coral, fontSize: 10, fontWeight: '800', marginTop: 3 },
  todayLeadBadgeRow: { marginTop: 4, gap: 2 },
  todayLeadClock: { color: COLORS.forest, fontSize: 11, fontWeight: '800' },
  todayLeadClockLate: { color: COLORS.coral },
  todayLeadDanger: { color: COLORS.coral, fontSize: 11, fontWeight: '800' },
  todaySectionHeaderLead: { color: COLORS.forest },
  heroRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  heroTitleGrow: { flex: 1 },
  todayActionRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  todayIconButton: { width: 44, height: 44, borderRadius: 12, backgroundColor: COLORS.mintPale, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  todayTakeButton: { marginTop: 8, flex: 0 },
  todayDoneButton: { flex: 1, minHeight: 44, borderRadius: 12, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center' },
  todayDoneButtonText: { color: COLORS.white, fontSize: 11, fontWeight: '800' },
  fab: { position: 'absolute', right: 18, bottom: 18, width: 54, height: 54, borderRadius: 19, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', shadowColor: COLORS.ink, shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8 },
  sheetSecondaryButton: { minHeight: 46, borderRadius: 14, backgroundColor: COLORS.mint, alignItems: 'center', justifyContent: 'center', marginTop: 10, paddingHorizontal: 12 },
  sheetSecondaryButtonText: { color: COLORS.forest, fontSize: 12, fontWeight: '800', textAlign: 'center' },
  contactPickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: COLORS.white, borderRadius: 13, borderWidth: 1, borderColor: COLORS.line, padding: 12, marginBottom: 7 },
  contactPickName: { color: COLORS.ink, fontSize: 13, fontWeight: '800' },
  contactPickMeta: { color: COLORS.gray, fontSize: 10, marginTop: 2 },
});
