import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
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
  formatMoney,
  initialPartners,
  initialReferralMatches,
  initialReferrals,
  InsuranceNetworkPreference,
  insuranceProvidersForState,
  medicaidPlansByState,
  nationalInsuranceProviders,
  Partner,
  partnerTypes,
  Referral,
  ReferralDirection,
  ReferralMatch,
  regionalInsuranceByState,
  shortDate,
  stateOptions,
  therapyOptions,
} from './src/data';
import { supabase } from './src/lib/supabase';
import LoginScreen from './src/lib/LoginScreen';
import {
  assignMatchReferral,
  createFollowUp,
  createMatchProfile,
  createPartner,
  createReferral,
  createTouch,
  flushWriteQueue,
  FollowUp,
  hydrate,
  PartnerScorecard,
  pendingWriteCount,
  persistCache,
  refreshSnapshot,
  Snapshot,
  Touch,
  TouchKind,
  updateFollowUp,
  updateMatchProfile,
  updatePartner,
  updateReferralOutcome,
  updateReferralPacketStamp,
} from './src/lib/store';
import {
  followUpsDue,
  partnersGoingCold,
  rescheduleNotifications,
  subscribeToNotificationResponses,
} from './src/lib/notifications';
import {
  buildFitReasons,
  buildPacket,
  labelLooksLikeFullName,
  PacketAudience,
  PacketFitInput,
} from './src/lib/packet';

type Tab = 'home' | 'match' | 'directory' | 'referrals';
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

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
  cashMin: string;
  cashMax: string;
  insurance: string[];
  therapies: string[];
  note: string;
  touchCadence: string;
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

function currentGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning.';
  if (hour < 17) return 'Good afternoon.';
  return 'Good evening.';
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
  cashMin: '',
  cashMax: '',
  insurance: [],
  therapies: [],
  note: '',
  touchCadence: '',
  };
}

function typesForPartner(partner: Partner): Partner['type'][] {
  if (partner.types?.length) return partner.types;
  const legacyTypes = (partner.levels || []).filter((level): level is Partner['type'] => partnerTypes.includes(level as Partner['type']));
  return legacyTypes.length ? legacyTypes : [partner.type];
}

function partnerTypeLabel(partner: Partner) {
  return typesForPartner(partner).join(' · ');
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
  onPress,
  icon,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  icon?: IconName;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={onPress}
      style={[styles.pill, active && styles.pillActive]}
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
              {draftValues.length ? <TouchableOpacity onPress={() => setDraftValues([])}><Text style={styles.multiSelectClear}>Clear all</Text></TouchableOpacity> : null}
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.dropdownOptions}>
              {options.map((option) => {
                const active = draftValues.includes(option);
                return (
                  <TouchableOpacity key={option} onPress={() => toggle(option)} style={[styles.dropdownOption, active && styles.dropdownOptionActive]}>
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
}: {
  partner: Partner;
  onPress: () => void;
  onShare?: () => void;
  compact?: boolean;
}) {
  const balance = partner.inbound - partner.outbound;
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
            <Text style={styles.partnerFooterText}>{insurancePlanCount ? `${insurancePlanCount} insurance ${insurancePlanCount === 1 ? 'plan' : 'plans'}` : 'Cash pay only'}</Text>
            <View style={[styles.balanceBadge, balance > 0 && styles.balanceBadgeWarm]}>
              <AppIcon name={balance > 0 ? 'arrow-undo' : 'swap-horizontal'} size={13} color={balance > 0 ? COLORS.coral : COLORS.forest} />
              <Text style={[styles.balanceText, balance > 0 && styles.balanceTextWarm]}>{balance > 0 ? `${balance} to return` : 'Balanced'}</Text>
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

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [partners, setPartners] = useState<Partner[]>(initialPartners);
  const [referrals, setReferrals] = useState<Referral[]>(initialReferrals);
  const [referralMatches, setReferralMatches] = useState<ReferralMatch[]>(initialReferralMatches);
  const [loaded, setLoaded] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
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
  const [partnerForm, setPartnerForm] = useState<PartnerForm>(makeEmptyPartnerForm);
  const [referralForm, setReferralForm] = useState(emptyReferral);
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
  const matchClientLabelRef = useRef<TextInput>(null);

  // Push a snapshot of in-memory state to the offline cache, refresh the
  // offline indicator + queued-write count, and recompute notifications.
  const syncDerived = useCallback(async (snapshot?: Snapshot) => {
    const data = snapshot || { partners, referrals, referralMatches, touches, followUps, scorecards };
    const pending = await pendingWriteCount();
    setQueuedWrites(pending);
    setOffline(pending > 0);
    await persistCache(data);
    rescheduleNotifications(data).catch(() => undefined);
  }, [partners, referrals, referralMatches, touches, followUps, scorecards]);

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

  // Auth session gate: restore the persisted session, then hydrate data.
  useEffect(() => {
    let mounted = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (mounted) setSession(nextSession);
    });
    supabase.auth.getSession().then(async ({ data }) => {
      let active = data.session;
      if (!active) {
        const { data: refreshed } = await supabase.auth.refreshSession();
        active = refreshed.session;
      }
      if (!mounted) return;
      setSession(active);
      if (active) {
        const result = await hydrate();
        if (!mounted) return;
        applySnapshot(result.snapshot);
        const pending = await pendingWriteCount();
        setQueuedWrites(pending);
        setOffline(result.source === 'cache' || pending > 0);
        rescheduleNotifications(result.snapshot).catch(() => undefined);
        setNotifPrePromptVisible(true);
      }
      if (mounted) setLoaded(true);
    }).catch(() => {
      if (mounted) setLoaded(true);
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [applySnapshot]);

  // Flush queued offline writes when the app returns to the foreground.
  useEffect(() => {
    if (!session) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      (async () => {
        const flushed = await flushWriteQueue();
        if (flushed > 0) {
          const fresh = await refreshSnapshot();
          if (fresh) applySnapshot(fresh);
        }
        syncDerived();
      })();
    });
    return () => subscription.remove();
  }, [session, applySnapshot, syncDerived]);

  // Tapping a notification jumps to the relevant tab (no router in this app).
  useEffect(() => {
    if (!session) return undefined;
    return subscribeToNotificationResponses((target) => setTab(target));
  }, [session]);

  const totals = useMemo(() => ({
    inbound: partners.reduce((sum, partner) => sum + partner.inbound, 0),
    outbound: partners.reduce((sum, partner) => sum + partner.outbound, 0),
    reciprocal: partners.filter((partner) => partner.inbound > partner.outbound).length,
  }), [partners]);

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

  const matches = useMemo(() => {
    const budget = Number(matchBudget) || Infinity;
    return partners
      .map((partner) => {
        const typeFit = matchType === 'Any type' || typesForPartner(partner).includes(matchType as Partner['type']);
        const isInNetwork = matchInsurance !== 'Cash pay' && partner.insurance.includes(matchInsurance);
        const paymentFit = matchInsurance === 'Cash pay'
          ? partner.cashMin <= budget
          : (matchNetworkPreferences.includes('In-network') && isInNetwork)
            || (matchNetworkPreferences.includes('Out-of-network') && !isInNetwork);
        const matchNetworkStatus: InsuranceNetworkPreference | null = matchInsurance === 'Cash pay'
          ? null
          : isInNetwork ? 'In-network' : 'Out-of-network';
        const regionFit = matchState === 'ANY' || partner.state === matchState || partner.regions.includes('Nationwide');
        const matchesNeed = (need: string) => {
          if (need === 'Men only') return partner.therapies.includes(need) || (partner.populations.includes('Men') && !partner.populations.includes('Women'));
          if (need === 'Women only') return partner.therapies.includes(need) || (partner.populations.includes('Women') && !partner.populations.includes('Men'));
          if (need === 'LGBTQ+') return partner.therapies.includes(need) || partner.populations.includes('LGBTQ+');
          if (need === 'Adolescent') return partner.therapies.includes(need) || partner.populations.some((population) => ['Adolescent', 'Adolescents', 'Teens'].includes(population));
          return partner.therapies.includes(need);
        };
        const matchedTherapies = matchTherapies.filter(matchesNeed);
        const clinicalCoverage = matchTherapies.length ? matchedTherapies.length / matchTherapies.length : 1;
        const eligible = typeFit && paymentFit && regionFit && (matchTherapies.length === 0 || matchedTherapies.length > 0);
        const clinicalScore = Math.round(62 + clinicalCoverage * 30 + (paymentFit ? 4 : 0) + (regionFit ? 4 : 0));
        const reciprocity = partner.inbound - partner.outbound;
        // The exact fit signals the Match Packet's "why this fits" section is
        // generated from — same dimensions this memo already computes.
        const fitInput: PacketFitInput = { networkStatus: matchNetworkStatus, matchedTherapies, regionFit, paymentFit };
        const scorecard = scorecards[partner.id];
        const avgFamilyExperience = scorecard?.avgFamilyExperience ?? null;
        const decided = (scorecard?.admits || 0) + (scorecard?.nonAdmits || 0);
        const admitRate = decided > 0 ? (scorecard?.admits || 0) / decided : null;
        return { partner, matchedTherapies, clinicalScore: Math.min(clinicalScore, 100), reciprocity, eligible, networkStatus: matchNetworkStatus, fitInput, avgFamilyExperience, admitRate };
      })
      .filter((match) => match.eligible)
      // Tie-break order after fit score (v1 scorecard change): average family
      // experience, then admit rate, then the pre-existing reciprocity
      // tie-breaker. Reciprocity stays — it just now comes after outcomes.
      // nulls sort last within each tier.
      .sort((a, b) =>
        b.clinicalScore - a.clinicalScore
        || (b.avgFamilyExperience ?? -1) - (a.avgFamilyExperience ?? -1)
        || (b.admitRate ?? -1) - (a.admitRate ?? -1)
        || b.reciprocity - a.reciprocity
        || a.partner.cashMin - b.partner.cashMin);
  }, [partners, matchType, matchInsurance, matchNetworkPreferences, matchState, matchBudget, matchTherapies, scorecards]);

  const recentReferrals = referrals
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);

  const activeReferralMatches = referralMatches.filter((item) => item.status === 'Matching');

  function loadReferralMatch(referralMatch: ReferralMatch) {
    setSelectedMatchId(referralMatch.id);
    setMatchClientLabel(referralMatch.clientLabel);
    setMatchType(referralMatch.levelOfCare);
    setMatchState(referralMatch.state);
    setMatchInsurance(referralMatch.insurance);
    setMatchNetworkPreferences(referralMatch.networkPreferences?.length ? referralMatch.networkPreferences : ['In-network']);
    setMatchBudget(referralMatch.maxBudget ? String(referralMatch.maxBudget) : '');
    setMatchTherapies(referralMatch.therapies);
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
    requestAnimationFrame(() => matchClientLabelRef.current?.focus());
  }

  function saveCurrentReferralMatch() {
    if (!matchClientLabel.trim()) {
      Alert.alert('Name this match', 'Add a private client or family label so you can return to it later.');
      return null;
    }
    const existing = referralMatches.find((item) => item.id === selectedMatchId);
    const now = new Date().toISOString();
    const referralMatch: ReferralMatch = {
      id: existing?.id || makeId('m'),
      clientLabel: matchClientLabel.trim(),
      levelOfCare: matchType as ReferralMatch['levelOfCare'],
      state: matchState,
      insurance: matchInsurance,
      networkPreferences: matchNetworkPreferences,
      maxBudget: matchInsurance === 'Cash pay' && matchBudget.trim() ? Number(matchBudget) || undefined : undefined,
      therapies: matchTherapies,
      status: existing?.status || 'Matching',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      assignedPartnerId: existing?.assignedPartnerId,
      referralId: existing?.referralId,
    };
    const nextMatches = [referralMatch, ...referralMatches.filter((item) => item.id !== referralMatch.id)];
    setReferralMatches(nextMatches);
    setSelectedMatchId(referralMatch.id);
    (existing ? updateMatchProfile(referralMatch) : createMatchProfile(referralMatch))
      .then(() => syncDerived({ partners, referrals, referralMatches: nextMatches, touches, followUps, scorecards }))
      .catch((error) => {
        Alert.alert('Sync issue', `This match was saved on this device but could not sync: ${error.message}`);
        syncDerived();
      });
    return referralMatch;
  }

  function openMatchedReferral(partnerId: string) {
    const referralMatch = saveCurrentReferralMatch();
    if (!referralMatch) return;
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
  function currentOrSavedMatch(): ReferralMatch | null {
    const existing = referralMatches.find((item) => item.id === selectedMatchId);
    if (existing) return existing;
    return saveCurrentReferralMatch();
  }

  // Build the PacketFitInput the pure generator expects, using the same
  // formulas as the matches memo (they share PacketFitInput field names).
  function fitInputForMatch(matchProfile: ReferralMatch, partner: Partner): PacketFitInput {
    const isInNetwork = matchProfile.insurance !== 'Cash pay' && partner.insurance.includes(matchProfile.insurance);
    const preferences = matchProfile.networkPreferences?.length ? matchProfile.networkPreferences : (['In-network'] as InsuranceNetworkPreference[]);
    const paymentFit = matchProfile.insurance === 'Cash pay'
      ? partner.cashMin <= (matchProfile.maxBudget ?? Infinity)
      : (preferences.includes('In-network') && isInNetwork)
        || (preferences.includes('Out-of-network') && !isInNetwork);
    const networkStatus: InsuranceNetworkPreference | null = matchProfile.insurance === 'Cash pay'
      ? null
      : isInNetwork ? 'In-network' : 'Out-of-network';
    const regionFit = !matchProfile.state || matchProfile.state === 'ANY' || partner.state === matchProfile.state || partner.regions.includes('Nationwide');
    const matchesNeed = (need: string) => {
      if (need === 'Men only') return partner.therapies.includes(need) || (partner.populations.includes('Men') && !partner.populations.includes('Women'));
      if (need === 'Women only') return partner.therapies.includes(need) || (partner.populations.includes('Women') && !partner.populations.includes('Men'));
      if (need === 'LGBTQ+') return partner.therapies.includes(need) || partner.populations.includes('LGBTQ+');
      if (need === 'Adolescent') return partner.therapies.includes(need) || partner.populations.some((population) => ['Adolescent', 'Adolescents', 'Teens'].includes(population));
      return partner.therapies.includes(need);
    };
    return { networkStatus, matchedTherapies: matchProfile.therapies.filter(matchesNeed), regionFit, paymentFit };
  }

  // From a recommended match card: the profile only gets assigned (status →
  // Referred) if the packet is actually sent.
  function openPacketComposer(partner: Partner, fitInput: PacketFitInput) {
    const matchProfile = currentOrSavedMatch();
    if (!matchProfile) return;
    const reasons = buildFitReasons(matchProfile, partner, fitInput);
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
    const fitInput = packetTarget.match.status === 'Referred'
      ? fitInputForMatch(packetTarget.match, packetTarget.partner)
      : matches.find((item) => item.partner.id === packetTarget.partner.id)?.fitInput || fitInputForMatch(packetTarget.match, packetTarget.partner);
    setPacketText(buildPacket(packetTarget.match, packetTarget.partner, buildFitReasons(packetTarget.match, packetTarget.partner, fitInput), audience));
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
  }

  // Post-send automation ("the loop"): referral + touch + follow-up, all
  // through the sync data layer so they queue offline like everything else.
  // If the profile wasn't assigned yet, this runs the SAME assignment code
  // path as the manual "Assign & refer" flow (assignMatchReferral: referral
  // insert first, then the match profile update) — not a duplicate of it.
  function finalizePacketSend() {
    if (!packetTarget) return;
    const { partner, match, assignOnSend } = packetTarget;
    const now = new Date();
    const todayStamp = localDateStamp();
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
        referral = { ...referral, packetSentAt: now.toISOString(), matchProfileId: referral.matchProfileId || match.id };
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
      title: 'Check in — did they admit?',
      dueOn: addDaysStamp(3),
      status: 'open',
      note: '',
    };

    const nextReferrals = [referral, ...referrals.filter((item) => item.id !== referralId)];
    const nextTouches = [touch, ...touches];
    const nextFollowUps = [followUp, ...followUps];
    // Balance + last-contact optimistic bumps mirror addReferral/saveTouch;
    // the server (balances view, touches trigger) stays canonical.
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

    const snapshot: Snapshot = { partners: nextPartners, referrals: nextReferrals, referralMatches: nextMatches, touches: nextTouches, followUps: nextFollowUps, scorecards };
    const referralAtSend = referral;
    const writes: Promise<void>[] = [];
    if (assignOnSend && assignedMatch) {
      // Same code path as the manual assign flow: referral insert first,
      // then the match profile update (assignMatchReferral in the store).
      writes.push(assignMatchReferral(referralAtSend, assignedMatch));
    } else {
      // Already assigned: stamp packet_sent_at / match_profile_id onto the
      // existing referral via a targeted update op.
      writes.push(updateReferralPacketStamp(referralId, now.toISOString(), match.id));
    }
    writes.push(createTouch(touch), createFollowUp(followUp));

    Promise.all(writes)
      .then(() => {
        syncDerived(snapshot);
        Alert.alert('Packet logged', `Referral logged, touch recorded, and a follow-up was set for ${shortDate(followUp.dueOn)}.`);
      })
      .catch((error) => {
        Alert.alert('Sync issue', `The packet was logged on this device but could not fully sync: ${error.message}`);
        syncDerived();
      });
  }

  // ─── Follow-ups ─────────────────────────────────────────────────────────

  function persistFollowUpChange(updated: FollowUp, nextFollowUps: FollowUp[]) {
    setFollowUps(nextFollowUps);
    updateFollowUp(updated)
      .then(() => syncDerived({ partners, referrals, referralMatches, touches, followUps: nextFollowUps, scorecards }))
      .catch((error) => {
        Alert.alert('Sync issue', `This follow-up was updated on this device but could not sync: ${error.message}`);
        syncDerived();
      });
  }

  function skipFollowUp(followUp: FollowUp) {
    const updated: FollowUp = { ...followUp, status: 'skipped', completedAt: new Date().toISOString() };
    persistFollowUpChange(updated, followUps.map((item) => (item.id === followUp.id ? updated : item)));
  }

  function snoozeFollowUp(followUp: FollowUp, days: number) {
    const updated: FollowUp = { ...followUp, dueOn: addDaysStamp(days) };
    persistFollowUpChange(updated, followUps.map((item) => (item.id === followUp.id ? updated : item)));
  }

  // Done on an admit-check opens the outcome capture sheet; Done on any
  // other follow-up just completes it.
  function completeFollowUp(followUp: FollowUp) {
    if (followUp.referralId) {
      setOutcomeFollowUp(followUp);
      setOutcomeAnswer(null);
      setOutcomeAdmittedOn(localDateStamp());
      setOutcomeStars(0);
      setOutcomeNote('');
      return;
    }
    const updated: FollowUp = { ...followUp, status: 'done', completedAt: new Date().toISOString() };
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
    const now = new Date().toISOString();
    const completed: FollowUp = { ...followUp, status: 'done', completedAt: now };
    const nextFollowUps = followUps.map((item) => (item.id === followUp.id ? completed : item));
    setFollowUps(nextFollowUps);
    const writes: Promise<void>[] = [updateFollowUp(completed)];
    let nextReferrals = referrals;
    if (followUp.referralId) {
      const stars = outcomeStars > 0 ? outcomeStars : null;
      const patch = outcomeAnswer === 'yes'
        ? { admitted: true, admittedOn: outcomeAdmittedOn || localDateStamp(), outcome: 'Placed' as Referral['outcome'], familyExperience: stars, outcomeNote: outcomeNote.trim() }
        : { admitted: false, outcomeNote: outcomeNote.trim() };
      nextReferrals = referrals.map((item) => (item.id === followUp.referralId ? { ...item, ...patch } : item));
      setReferrals(nextReferrals);
      writes.push(updateReferralOutcome(followUp.referralId, patch));
    }
    closeOutcomeSheet();
    Promise.all(writes)
      .then(() => syncDerived({ partners, referrals: nextReferrals, referralMatches, touches, followUps: nextFollowUps, scorecards }))
      .catch((error) => {
        Alert.alert('Sync issue', `This outcome was saved on this device but could not sync: ${error.message}`);
        syncDerived();
      });
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
      cashMin: partner.cashMin ? String(partner.cashMin) : '',
      cashMax: partner.cashMax ? String(partner.cashMax) : '',
      insurance: partner.insurance.filter((plan) => plan !== 'Cash pay'),
      therapies: partner.therapies,
      note: partner.note,
      touchCadence: partner.touchCadenceDays ? String(partner.touchCadenceDays) : '',
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
      cashMin: Number(partnerForm.cashMin) || 0,
      cashMax: Number(partnerForm.cashMax) || Number(partnerForm.cashMin) || 0,
      insurance: partnerForm.insurance,
      therapies: partnerForm.therapies,
      populations: existing?.populations || ['Adults'],
      levels: partnerForm.types,
      note: partnerForm.note.trim(),
      inbound: existing?.inbound || 0,
      outbound: existing?.outbound || 0,
      lastContact: existing?.lastContact || localDateStamp(),
      favorite: existing?.favorite,
      touchCadenceDays: cadence && cadence > 0 ? cadence : undefined,
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    const nextPartners = existing
      ? partners.map((item) => item.id === partner.id ? partner : item)
      : [partner, ...partners];
    setPartners(nextPartners);
    setPartnerForm(makeEmptyPartnerForm());
    setShowAddPartner(false);
    setEditingPartnerId(null);
    setSelectedPartner(partner);
    (existing ? updatePartner(partner) : createPartner(partner))
      .then(() => syncDerived({ partners: nextPartners, referrals, referralMatches, touches, followUps, scorecards }))
      .catch((error) => {
        Alert.alert('Sync issue', `This partner was saved on this device but could not sync: ${error.message}`);
        syncDerived();
      });
  }

  function addReferral() {
    if (!referralForm.partnerId || !referralForm.clientLabel.trim()) {
      Alert.alert('A little more detail', 'Choose a partner and add a client or family label.');
      return;
    }
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
    // Assignment flow: referral first, then the match profile update.
    const write = assignedMatch
      ? assignMatchReferral(referral, { ...assignedMatch, clientLabel: referral.clientLabel, status: 'Referred', assignedPartnerId: referral.partnerId, referralId: referral.id, updatedAt: new Date().toISOString() })
      : createReferral(referral);
    write
      .then(() => syncDerived(snapshot))
      .catch((error) => {
        Alert.alert('Sync issue', `This referral was saved on this device but could not sync: ${error.message}`);
        syncDerived();
      });
  }

  function openTouchLogger(partner: Partner) {
    setTouchPartner(partner);
    setTouchKind('call');
    setTouchNote('');
  }

  function saveTouch() {
    if (!touchPartner) return;
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
    createTouch(touch)
      .then(() => syncDerived({ partners: nextPartners, referrals, referralMatches, touches: nextTouches, followUps, scorecards }))
      .catch((error) => {
        Alert.alert('Sync issue', `This touch was logged on this device but could not sync: ${error.message}`);
        syncDerived();
      });
  }

  function toggleFavorite(id: string) {
    const target = partners.find((partner) => partner.id === id);
    if (!target) return;
    const updated = { ...target, favorite: !target.favorite };
    const nextPartners = partners.map((partner) => partner.id === id ? updated : partner);
    setPartners(nextPartners);
    setSelectedPartner((current) => current?.id === id ? { ...current, favorite: !current.favorite } : current);
    updatePartner(updated)
      .then(() => syncDerived({ partners: nextPartners, referrals, referralMatches, touches, followUps, scorecards }))
      .catch((error) => {
        Alert.alert('Sync issue', `This change was saved on this device but could not sync: ${error.message}`);
        syncDerived();
      });
  }

  function confirmSignOut() {
    Alert.alert('Sign out?', 'Cached data stays on this device and syncs again on the next sign-in.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: async () => {
        await supabase.auth.signOut();
        setPartners(initialPartners);
        setReferrals(initialReferrals);
        setReferralMatches(initialReferralMatches);
        setTouches([]);
        setSelectedPartner(null);
        setTab('home');
      } },
    ]);
  }

  function renderHeader(title?: string) {
    return (
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <Image accessibilityLabel="ReferralFit Fit Point logo" source={require('./assets/icon-fit-point.png')} style={styles.brandMark} />
          <TouchableOpacity accessibilityLabel={title || 'ReferralFit'} activeOpacity={0.7} onLongPress={confirmSignOut} delayLongPress={1200}>
            <Text style={styles.brandName}>{title || 'ReferralFit'}</Text>
          </TouchableOpacity>
        </View>
        {offline ? (
          <View style={styles.offlineBadge}>
            <AppIcon name="cloud-offline-outline" size={13} color={COLORS.gray} />
            <Text style={styles.offlineBadgeText}>Offline — showing cached data{queuedWrites > 0 ? ` · ${queuedWrites} to sync` : ''}</Text>
          </View>
        ) : null}
      </View>
    );
  }

  function HomeScreen() {
    const giveBack = partners
      .filter((partner) => partner.inbound > partner.outbound)
      .sort((a, b) => (b.inbound - b.outbound) - (a.inbound - a.outbound))
      .slice(0, 3);
    const dueFollowUps = followUpsDue(followUps);
    const todayStamp = localDateStamp();
    const overdueDays = (dueOn: string) => {
      const parsed = new Date(`${dueOn}T12:00:00`);
      const dueDay = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
      const today = new Date(`${todayStamp}T12:00:00`);
      return Math.max(0, Math.round((today.getTime() - dueDay.getTime()) / 86400000));
    };
    return (
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {renderHeader()}
        <View style={styles.welcomeRow}>
          <View>
            <Text style={styles.eyebrow}>{currentDateLabel()}</Text>
            <Text style={styles.heroTitle}>{currentGreeting()}</Text>
            <Text style={styles.heroSubtitle}>{partners.length ? 'Your referral network, in balance.' : 'Add your trusted referral partners to get started.'}</Text>
          </View>
        </View>

        {dueFollowUps.length ? (
          <>
            <SectionTitle title="Follow-ups" />
            <View style={styles.followUpCard}>
              {dueFollowUps.map((followUp, index) => {
                const partner = partners.find((item) => item.id === followUp.partnerId);
                const overdueBy = overdueDays(followUp.dueOn);
                return (
                  <View key={followUp.id} style={[styles.followUpRow, index === dueFollowUps.length - 1 && { borderBottomWidth: 0 }]}>
                    <View style={styles.followUpIcon}><AppIcon name="alarm-outline" size={17} color={COLORS.coral} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.followUpTitle}>{followUp.title}</Text>
                      <Text style={styles.followUpMeta}>
                        {partner ? `${partner.organization} · ` : ''}{overdueBy > 0 ? `${overdueBy} ${overdueBy === 1 ? 'day' : 'days'} overdue` : 'Due today'}
                      </Text>
                      <View style={styles.followUpActions}>
                        <TouchableOpacity style={styles.followUpActionDone} onPress={() => completeFollowUp(followUp)}><Text style={styles.followUpActionDoneText}>Done</Text></TouchableOpacity>
                        <TouchableOpacity style={styles.followUpAction} onPress={() => skipFollowUp(followUp)}><Text style={styles.followUpActionText}>Skip</Text></TouchableOpacity>
                        <TouchableOpacity style={styles.followUpAction} onPress={() => snoozeFollowUp(followUp, 2)}><Text style={styles.followUpActionText}>+2 days</Text></TouchableOpacity>
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          </>
        ) : null}

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

        <SectionTitle title="Relationships to return" action="View all" onPress={() => setTab('referrals')} />
        <View style={styles.returnCard}>
          <View style={styles.returnIntro}>
            <View style={styles.returnIcon}><AppIcon name="heart-half" size={20} color={COLORS.coral} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.returnTitle}>{totals.reciprocal} partners have sent more than they’ve received</Text>
              <Text style={styles.returnBody}>Keep these relationships in mind only after client-fit factors are satisfied.</Text>
            </View>
          </View>
          {giveBack.map((partner, index) => (
            <TouchableOpacity key={partner.id} onPress={() => setSelectedPartner(partner)} style={[styles.returnPartner, index === giveBack.length - 1 && { borderBottomWidth: 0 }]}>
              <Initials name={partner.organization} size={36} />
              <View style={{ flex: 1 }}>
                <Text style={styles.returnPartnerName}>{partner.organization}</Text>
                <Text numberOfLines={1} style={styles.returnPartnerType}>{partnerTypeLabel(partner)} · {partner.city}</Text>
              </View>
              <Text style={styles.returnCount}>+{partner.inbound - partner.outbound}</Text>
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
      </ScrollView>
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
                  <TouchableOpacity key={item.id} onPress={() => loadReferralMatch(item)} style={[styles.savedMatchCard, selected && styles.savedMatchCardActive]}>
                    <View style={styles.savedMatchTop}>
                      <View style={[styles.savedMatchIcon, item.status === 'Referred' && styles.savedMatchIconComplete]}><AppIcon name={item.status === 'Referred' ? 'checkmark' : 'person-outline'} size={16} color={item.status === 'Referred' ? COLORS.white : COLORS.forest} /></View>
                      <Text numberOfLines={1} style={styles.savedMatchName}>{item.clientLabel}</Text>
                    </View>
                    <Text numberOfLines={1} style={styles.savedMatchMeta}>{item.levelOfCare === 'Any type' ? 'Any level' : item.levelOfCare} · {item.state === 'ANY' ? 'Any location' : item.state}</Text>
                    <Text style={[styles.savedMatchStatus, item.status === 'Referred' && styles.savedMatchStatusComplete]}>{assignedPartner ? `Referred to ${assignedPartner.organization}` : 'Matching in progress'}</Text>
                    {item.status === 'Referred' && assignedPartner ? (
                      <TouchableOpacity style={styles.savedMatchPacketButton} onPress={() => openPacketForAssigned(item)}>
                        <AppIcon name="paper-plane-outline" size={13} color={COLORS.forest} />
                        <Text style={styles.savedMatchPacketButtonText}>Send packet</Text>
                      </TouchableOpacity>
                    ) : null}
                  </TouchableOpacity>
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

          <MultiSelectDropdown
            label="THERAPEUTIC NEEDS"
            values={matchTherapies}
            options={therapyOptions}
            onChange={setMatchTherapies}
            icon="medkit-outline"
          />
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
                  <View style={styles.scoreBlock}><Text style={styles.scoreNumber}>{match.clinicalScore}%</Text><Text style={styles.scoreLabel}>FIT</Text></View>
                </View>
                <View style={styles.matchReason}>
                  <AppIcon name="checkmark-circle" size={17} color={COLORS.forest} />
                  <Text style={styles.matchReasonText}>{match.matchedTherapies.length ? `Matches ${match.matchedTherapies.join(', ')}` : 'Matches selected eligibility filters'}</Text>
                </View>
                <View style={styles.matchDetails}>
                  <Text numberOfLines={1} style={[styles.matchDetailText, styles.matchInsuranceText]}>{matchInsurance === 'Cash pay'
                    ? match.partner.insurance.slice(0, 2).join(' · ') || 'Cash pay'
                    : `${match.networkStatus} · ${matchInsurance}`}</Text>
                  <Text numberOfLines={1} style={styles.matchPriceText}>{formatMoney(match.partner.cashMin)}–{formatMoney(match.partner.cashMax)}</Text>
                </View>
                {match.reciprocity > 0 ? (
                  <View style={styles.reciprocityNote}><AppIcon name="heart" size={13} color={COLORS.coral} /><Text style={styles.reciprocityNoteText}>Tie-breaker: sent you {match.reciprocity} more than received</Text></View>
                ) : null}
              </View>
            </TouchableOpacity>
            <View style={styles.matchActionRow}>
              <TouchableOpacity style={styles.packetButton} onPress={() => openPacketComposer(match.partner, match.fitInput)}>
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

  function DirectoryScreen() {
    return (
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {renderHeader('Directory')}
        <View style={styles.directoryTitleRow}>
          <View><Text style={styles.screenTitle}>Your network</Text><Text style={styles.screenSubtitle}>{partners.length} people and programs</Text></View>
          <TouchableOpacity style={styles.addButton} onPress={openNewPartner}><AppIcon name="add" size={22} color={COLORS.white} /><Text style={styles.addButtonText}>Add</Text></TouchableOpacity>
        </View>
        <View style={styles.searchBox}>
          <AppIcon name="search" size={19} color={COLORS.gray} />
          <TextInput value={search} onChangeText={setSearch} placeholder="Name, program, location, specialty" placeholderTextColor="#91A09B" style={styles.searchInput} />
          {search ? <TouchableOpacity onPress={() => setSearch('')}><AppIcon name="close-circle" size={18} color={COLORS.gray} /></TouchableOpacity> : null}
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
        {directoryPartners.map((partner) => <PartnerCard key={partner.id} partner={partner} onPress={() => setSelectedPartner(partner)} onShare={() => sharePartner(partner)} />)}
        {!directoryPartners.length ? <EmptyState icon="people-outline" title="No partners found" body="Try another search or add a new relationship." /> : null}
      </ScrollView>
    );
  }

  function ReferralsScreen() {
    return (
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {renderHeader('Referral ledger')}
        <View style={styles.directoryTitleRow}>
          <View><Text style={styles.screenTitle}>Give & receive</Text><Text style={styles.screenSubtitle}>Relationship history at a glance</Text></View>
          <TouchableOpacity style={styles.roundAdd} onPress={() => openReferral('Inbound')}><AppIcon name="add" size={24} color={COLORS.white} /></TouchableOpacity>
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
            <View style={[styles.ledgerIcon, { backgroundColor: COLORS.coralPale }]}><AppIcon name="heart" size={18} color={COLORS.coral} /></View>
            <Text style={styles.ledgerNumber}>{totals.reciprocal}</Text><Text style={styles.ledgerLabel}>To return</Text>
          </View>
        </View>

        <View style={styles.quickLogRow}>
          <TouchableOpacity style={styles.quickLogButton} onPress={() => openReferral('Inbound')}><AppIcon name="arrow-down-circle" size={20} color={COLORS.forest} /><Text style={styles.quickLogText}>Log inbound</Text></TouchableOpacity>
          <TouchableOpacity style={styles.quickLogButton} onPress={() => openReferral('Outbound')}><AppIcon name="arrow-up-circle" size={20} color={COLORS.blue} /><Text style={styles.quickLogText}>Log outbound</Text></TouchableOpacity>
        </View>

        <SectionTitle title="Referral history" />
        {recentReferrals.length ? <View style={styles.referralList}>
          {recentReferrals.map((referral, index) => {
            const partner = partners.find((item) => item.id === referral.partnerId);
            if (!partner) return null;
            return (
              <TouchableOpacity key={referral.id} onPress={() => setSelectedPartner(partner)} style={[styles.referralRow, index === recentReferrals.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={[styles.referralDirectionLine, { backgroundColor: referral.direction === 'Inbound' ? COLORS.forest : COLORS.blue }]} />
                <View style={{ flex: 1 }}>
                  <View style={styles.referralTop}><Text style={styles.referralClient}>{referral.clientLabel}</Text><Text style={styles.referralDate}>{shortDate(referral.date)}</Text></View>
                  <Text style={styles.referralPartner}>{referral.direction === 'Inbound' ? 'From' : 'To'} {partner.organization}</Text>
                  <View style={styles.referralOutcome}><Text style={styles.referralOutcomeText}>{referral.outcome}</Text></View>
                </View>
              </TouchableOpacity>
            );
          })}
        </View> : <EmptyState icon="swap-horizontal-outline" title="No referral history" body="Add a partner, then log your first inbound or outbound referral." />}

        <SectionTitle title="Relationship balance" />
        {partners.length ? partners.slice().sort((a, b) => (b.inbound - b.outbound) - (a.inbound - a.outbound)).slice(0, 5).map((partner) => {
          const total = Math.max(partner.inbound + partner.outbound, 1);
          const inboundWidth = `${Math.round((partner.inbound / total) * 100)}%` as `${number}%`;
          return (
            <TouchableOpacity key={partner.id} onPress={() => setSelectedPartner(partner)} style={styles.balanceRow}>
              <View style={styles.balanceNameRow}><Text style={styles.balanceName} numberOfLines={1}>{partner.organization}</Text><Text style={styles.balanceNumbers}>{partner.inbound} in · {partner.outbound} out</Text></View>
              <View style={styles.balanceTrack}><View style={[styles.balanceInbound, { width: inboundWidth }]} /></View>
            </TouchableOpacity>
          );
        }) : <EmptyState icon="people-outline" title="No relationships yet" body="Your give-and-receive balance will appear after you add referral partners." />}
      </ScrollView>
    );
  }

  function BottomNav() {
    const items: { key: Tab; label: string; icon: IconName; activeIcon: IconName }[] = [
      { key: 'home', label: 'Home', icon: 'home-outline', activeIcon: 'home' },
      { key: 'match', label: 'Match', icon: 'sparkles-outline', activeIcon: 'sparkles' },
      { key: 'directory', label: 'Directory', icon: 'people-outline', activeIcon: 'people' },
      { key: 'referrals', label: 'Referrals', icon: 'swap-horizontal-outline', activeIcon: 'swap-horizontal' },
    ];
    return (
      <View style={styles.bottomNav}>
        {items.map((item) => {
          const active = tab === item.key;
          return (
            <TouchableOpacity key={item.key} accessibilityLabel={`${item.label} tab`} onPress={() => setTab(item.key)} style={styles.navItem}>
              <View style={[styles.navIconWrap, active && styles.navIconActive]}><AppIcon name={active ? item.activeIcon : item.icon} size={21} color={active ? COLORS.white : COLORS.gray} /></View>
              <Text style={[styles.navLabel, active && styles.navLabelActive]}>{item.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  }

  function PartnerDetailModal() {
    if (!selectedPartner) return null;
    const balance = selectedPartner.inbound - selectedPartner.outbound;
    return (
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSelectedPartner(null)}>
        <SafeAreaView style={styles.modalPage}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <TouchableOpacity accessibilityLabel="Close partner profile" onPress={() => setSelectedPartner(null)} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
            <Text style={styles.modalHeaderTitle}>Partner profile</Text>
            <TouchableOpacity onPress={() => toggleFavorite(selectedPartner.id)} style={styles.closeButton}><AppIcon name={selectedPartner.favorite ? 'heart' : 'heart-outline'} size={21} color={selectedPartner.favorite ? COLORS.coral : COLORS.ink} /></TouchableOpacity>
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
              <View><Text style={styles.fieldLabel}>RELATIONSHIP BALANCE</Text><Text style={styles.profileBalanceTitle}>{balance > 0 ? `They’ve sent ${balance} more` : balance < 0 ? `You’ve sent ${Math.abs(balance)} more` : 'Perfectly balanced'}</Text></View>
              <View style={styles.profileCounts}><Text style={styles.profileCount}><Text style={{ color: COLORS.forest }}>{selectedPartner.inbound}</Text> in</Text><Text style={styles.profileCount}><Text style={{ color: COLORS.blue }}>{selectedPartner.outbound}</Text> out</Text></View>
            </View>

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
              <View style={styles.infoLine}><AppIcon name="wallet-outline" size={18} color={COLORS.gray} /><View style={{ flex: 1 }}><Text style={styles.infoLabel}>Cash range</Text><Text style={styles.infoValue}>{formatMoney(selectedPartner.cashMin)}–{formatMoney(selectedPartner.cashMax)}</Text></View></View>
              <View style={styles.infoLine}><AppIcon name="shield-checkmark-outline" size={18} color={COLORS.gray} /><View style={{ flex: 1 }}><Text style={styles.infoLabel}>Insurance</Text><Text style={styles.infoValue}>{selectedPartner.insurance.join(' · ') || 'Not recorded'}</Text></View></View>
              <View style={styles.infoLine}><AppIcon name="location-outline" size={18} color={COLORS.gray} /><View style={{ flex: 1 }}><Text style={styles.infoLabel}>Service area</Text><Text style={styles.infoValue}>{selectedPartner.regions.join(' · ')}</Text></View></View>
            </View>

            <Text style={styles.infoTitleStandalone}>Therapeutic specialties</Text>
            <View style={styles.tagRow}>{selectedPartner.therapies.map((therapy) => <View key={therapy} style={styles.specialtyTag}><Text style={styles.specialtyText}>{therapy}</Text></View>)}</View>

            <Text style={styles.infoTitleStandalone}>Relationship notes</Text>
            <View style={styles.noteCard}><Text style={styles.noteText}>{selectedPartner.note || 'No notes yet.'}</Text></View>

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

  function AddPartnerModal() {
    const isEditing = Boolean(editingPartnerId);
    return (
      <Modal visible={showAddPartner} animationType="slide" presentationStyle="pageSheet" onRequestClose={closePartnerForm}>
        <SafeAreaView style={styles.modalPage}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalHeader}>
              <TouchableOpacity accessibilityLabel="Close partner form" onPress={closePartnerForm} style={styles.closeButton}><AppIcon name="close" size={22} /></TouchableOpacity>
              <Text style={styles.modalHeaderTitle}>{isEditing ? 'Edit partner' : 'Add a partner'}</Text>
              <TouchableOpacity onPress={savePartner}><Text style={styles.saveText}>{isEditing ? 'Update' : 'Save'}</Text></TouchableOpacity>
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
              <View style={styles.formRow}><View style={{ flex: 1 }}><FormField label="CASH MIN" value={partnerForm.cashMin} onChangeText={(cashMin) => setPartnerForm((current) => ({ ...current, cashMin }))} placeholder="$0" keyboardType="number-pad" /></View><View style={{ flex: 1 }}><FormField label="CASH MAX" value={partnerForm.cashMax} onChangeText={(cashMax) => setPartnerForm((current) => ({ ...current, cashMax }))} placeholder="$0" keyboardType="number-pad" /></View></View>
              <MultiSelectDropdown
                label="INSURANCES ACCEPTED"
                values={partnerForm.insurance}
                options={partnerInsuranceOptions}
                onChange={(insurance) => setPartnerForm((current) => ({ ...current, insurance }))}
                icon="shield-checkmark-outline"
                emptyLabel="Select accepted insurance plans"
                selectedNoun="plans"
              />
              <MultiSelectDropdown
                label="THERAPEUTIC NEEDS"
                values={partnerForm.therapies}
                options={therapyOptions}
                onChange={(therapies) => setPartnerForm((current) => ({ ...current, therapies }))}
                icon="medkit-outline"
                emptyLabel="Select therapeutic needs"
              />
              <FormField label="NOTES" value={partnerForm.note} onChangeText={(note) => setPartnerForm((current) => ({ ...current, note }))} placeholder="Relationship and program notes" multiline />
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
              <TouchableOpacity onPress={addReferral}><Text style={styles.saveText}>Save</Text></TouchableOpacity>
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
                    {(['Inbound', 'Outbound'] as ReferralDirection[]).map((direction) => <TouchableOpacity key={direction} onPress={() => setReferralForm({ ...referralForm, direction })} style={[styles.segment, referralForm.direction === direction && styles.segmentActive]}><AppIcon name={direction === 'Inbound' ? 'arrow-down' : 'arrow-up'} size={16} color={referralForm.direction === direction ? COLORS.white : COLORS.inkSoft} /><Text style={[styles.segmentText, referralForm.direction === direction && styles.segmentTextActive]}>{direction}</Text></TouchableOpacity>)}
                  </View>
                  <Text style={styles.directionExplainer}>{referralForm.direction === 'Inbound' ? 'A professional or program sent a family to you.' : 'You sent a client or family to a professional or program.'}</Text>
                </>
              )}
              <Text style={styles.fieldLabel}>{matchedReferral ? 'ASSIGN REFERENT' : 'PARTNER'}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.partnerPicker}>
                {partners.slice().sort((a, b) => Number(b.id === referralForm.partnerId) - Number(a.id === referralForm.partnerId)).map((partner) => <TouchableOpacity key={partner.id} onPress={() => setReferralForm({ ...referralForm, partnerId: partner.id })} style={[styles.partnerPick, referralForm.partnerId === partner.id && styles.partnerPickActive]}><Initials name={partner.organization} size={34} /><Text numberOfLines={2} style={[styles.partnerPickText, referralForm.partnerId === partner.id && styles.partnerPickTextActive]}>{partner.organization}</Text></TouchableOpacity>)}
              </ScrollView>
              <FormField label="CLIENT / FAMILY LABEL *" value={referralForm.clientLabel} onChangeText={(clientLabel) => setReferralForm({ ...referralForm, clientLabel })} placeholder="Use initials or a private label" />
              <Text style={styles.privacyHint}><AppIcon name="lock-closed" size={13} color={COLORS.gray} /> Keep this de-identified; avoid clinical details or protected health information.</Text>
              <Text style={styles.fieldLabel}>OUTCOME</Text>
              <View style={styles.wrapPills}>{(['Introduced', 'Consulted', 'Placed', 'Pending'] as Referral['outcome'][]).map((outcome) => <Pill key={outcome} label={outcome} active={referralForm.outcome === outcome} onPress={() => setReferralForm({ ...referralForm, outcome })} />)}</View>
              <FormField label="NOTE" value={referralForm.note} onChangeText={(note) => setReferralForm({ ...referralForm, note })} placeholder="Optional relationship note" multiline />
              <TouchableOpacity style={styles.primaryButton} onPress={addReferral}><Text style={styles.primaryButtonText}>{matchedReferral ? 'Save to referrals' : 'Save referral'}</Text></TouchableOpacity>
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
              <TouchableOpacity onPress={saveTouch}><Text style={styles.saveText}>Save</Text></TouchableOpacity>
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

  function NotifPrePromptModal() {
    if (!notifPrePromptVisible || !session) return null;
    const dismiss = () => setNotifPrePromptVisible(false);
    const enable = async () => {
      dismiss();
      await rescheduleNotifications({ partners, referrals, referralMatches, followUps });
    };
    return (
      <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
        <Pressable style={styles.dropdownOverlay} onPress={dismiss}>
          <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownSheetHandle} />
            <View style={styles.prePromptBody}>
              <View style={styles.prePromptIcon}><AppIcon name="notifications-outline" size={24} color={COLORS.forest} /></View>
              <Text style={styles.prePromptTitle}>Stay ahead of cold relationships</Text>
              <Text style={styles.prePromptText}>ReferralFit can send a 7 AM briefing and a nudge when a partner passes their stay-in-touch cadence. Everything is scheduled on this device — no data leaves your phone.</Text>
              <TouchableOpacity style={styles.primaryButton} onPress={enable}><Text style={styles.primaryButtonText}>Enable notifications</Text></TouchableOpacity>
              <TouchableOpacity onPress={dismiss} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Not now</Text></TouchableOpacity>
            </View>
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
            <View style={styles.prePromptBody}>
              <View style={styles.prePromptIcon}><AppIcon name="paper-plane" size={24} color={COLORS.forest} /></View>
              <Text style={styles.prePromptTitle}>Did you send it?</Text>
              <Text style={styles.prePromptText}>iOS can't always tell us whether the packet actually went out. Confirming logs the referral, records the touch, and sets the check-in follow-up.</Text>
              <TouchableOpacity style={styles.primaryButton} onPress={finalizePacketSend}><Text style={styles.primaryButtonText}>Sent — log it</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => setPacketSendConfirm(false)} style={styles.prePromptNotNow}><Text style={styles.prePromptNotNowText}>Cancel — don't log</Text></TouchableOpacity>
            </View>
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
                  <TouchableOpacity key={answer} onPress={() => setOutcomeAnswer(answer)} style={[styles.segment, outcomeAnswer === answer && styles.segmentActive]}>
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.appShell}>
        <View style={styles.screen}>{tab === 'home' ? HomeScreen() : tab === 'match' ? MatchScreen() : tab === 'directory' ? DirectoryScreen() : ReferralsScreen()}</View>
        {BottomNav()}
      </View>
      {PartnerDetailModal()}
      {AddPartnerModal()}
      {AddReferralModal()}
      {LogTouchModal()}
      {NotifPrePromptModal()}
      {PacketComposeModal()}
      {PacketSendConfirmModal()}
      {OutcomeCaptureModal()}
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
  scrollContent: { paddingHorizontal: 20, paddingTop: Platform.OS === 'android' ? 18 : 8, paddingBottom: 28 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, marginBottom: 22 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
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
  textAction: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 4 },
  textActionLabel: { color: COLORS.forest, fontSize: 12, fontWeight: '800' },
  returnCard: { backgroundColor: COLORS.white, borderRadius: 22, padding: 16, borderWidth: 1, borderColor: '#E5E8E3', marginBottom: 27 },
  returnIntro: { flexDirection: 'row', gap: 12, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  returnIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: COLORS.coralPale, alignItems: 'center', justifyContent: 'center' },
  returnTitle: { color: COLORS.ink, fontSize: 13, lineHeight: 18, fontWeight: '800' },
  returnBody: { color: COLORS.gray, fontSize: 11, lineHeight: 16, marginTop: 4 },
  returnPartner: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  returnPartnerName: { color: COLORS.ink, fontSize: 13, fontWeight: '700' },
  returnPartnerType: { color: COLORS.gray, fontSize: 11, marginTop: 2 },
  returnCount: { color: COLORS.coral, fontSize: 13, fontWeight: '800' },
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
  newMatchButton: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.forest, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9 },
  newMatchButtonText: { color: COLORS.white, fontSize: 11, fontWeight: '800' },
  savedMatchList: { gap: 9, paddingRight: 20 },
  savedMatchCard: { width: 225, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, borderRadius: 17, padding: 12 },
  savedMatchCardActive: { borderColor: COLORS.forest, borderWidth: 2, backgroundColor: COLORS.mintPale },
  savedMatchTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  savedMatchIcon: { width: 28, height: 28, borderRadius: 9, backgroundColor: COLORS.mint, alignItems: 'center', justifyContent: 'center' },
  savedMatchIconComplete: { backgroundColor: COLORS.forest },
  savedMatchName: { flex: 1, color: COLORS.ink, fontSize: 13, fontWeight: '800' },
  savedMatchMeta: { color: COLORS.gray, fontSize: 10, marginTop: 9 },
  savedMatchStatus: { minHeight: 28, color: COLORS.coral, fontSize: 10, lineHeight: 14, fontWeight: '700', marginTop: 5 },
  savedMatchStatusComplete: { color: COLORS.forest },
  noSavedMatches: { color: COLORS.gray, fontSize: 11, lineHeight: 16, backgroundColor: COLORS.white, borderRadius: 15, borderWidth: 1, borderColor: COLORS.line, padding: 13 },
  filterCard: { backgroundColor: COLORS.white, borderRadius: 24, padding: 18, borderWidth: 1, borderColor: '#E5E8E3', marginBottom: 26 },
  matchEditorHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  matchEditorTitle: { color: COLORS.ink, fontSize: 16, fontWeight: '800' },
  matchEditorStatus: { color: COLORS.gray, fontSize: 10, marginTop: 3 },
  saveMatchButton: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: COLORS.mint, borderRadius: 13, paddingHorizontal: 11, paddingVertical: 9 },
  saveMatchButtonText: { color: COLORS.forest, fontSize: 10, fontWeight: '800' },
  fieldLabel: { color: COLORS.gray, fontSize: 10, fontWeight: '800', letterSpacing: 1.05, marginBottom: 9, marginTop: 5 },
  dropdownField: { marginBottom: 15 },
  dropdownButton: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: COLORS.mintPale, borderWidth: 1, borderColor: COLORS.line, borderRadius: 15, paddingHorizontal: 12 },
  dropdownLeading: { width: 34, height: 34, borderRadius: 10, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center' },
  dropdownValue: { flex: 1, flexShrink: 1, color: COLORS.ink, fontSize: 13, fontWeight: '700' },
  dropdownOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(11, 32, 27, 0.42)' },
  dropdownSheet: { maxHeight: '82%', backgroundColor: COLORS.cream, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingBottom: 22, shadowColor: COLORS.ink, shadowOpacity: 0.18, shadowRadius: 20, shadowOffset: { width: 0, height: -5 }, elevation: 12 },
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
  multiSelectDone: { backgroundColor: COLORS.forest, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 8 },
  multiSelectDoneText: { color: COLORS.white, fontSize: 11, fontWeight: '800' },
  multiSelectActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 13 },
  multiSelectSelectionText: { color: COLORS.gray, fontSize: 10, fontWeight: '700' },
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
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 20, paddingHorizontal: 13, paddingVertical: 9, backgroundColor: COLORS.mintPale, borderWidth: 1, borderColor: COLORS.line },
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
  reciprocityNote: { flexDirection: 'row', gap: 5, alignItems: 'center', marginTop: 9 },
  reciprocityNoteText: { flex: 1, flexShrink: 1, color: COLORS.coral, fontSize: 10, lineHeight: 14, fontWeight: '700' },
  assignReferralButton: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: COLORS.forest, borderRadius: 13, marginTop: 13 },
  assignReferralButtonText: { color: COLORS.white, fontSize: 11, fontWeight: '800' },
  directoryTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  addButton: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.forest, borderRadius: 15, paddingHorizontal: 14, paddingVertical: 10 },
  addButtonText: { color: COLORS.white, fontSize: 12, fontWeight: '800' },
  roundAdd: { width: 42, height: 42, borderRadius: 15, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center' },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: COLORS.white, borderRadius: 16, paddingHorizontal: 14, height: 50, borderWidth: 1, borderColor: COLORS.line },
  searchInput: { flex: 1, color: COLORS.ink, fontSize: 13, outlineStyle: 'none' } as any,
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
  balanceBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.mintPale, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 5 },
  balanceBadgeWarm: { backgroundColor: COLORS.coralPale },
  balanceText: { color: COLORS.forest, fontSize: 9, fontWeight: '800' },
  balanceTextWarm: { color: COLORS.coral },
  cardShareButton: { width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.mint },
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
  balanceTrack: { height: 7, borderRadius: 4, backgroundColor: '#DCE7EA', overflow: 'hidden' },
  balanceInbound: { height: '100%', borderRadius: 4, backgroundColor: COLORS.sage },
  bottomNav: { flexDirection: 'row', paddingTop: 8, paddingBottom: Platform.OS === 'ios' ? 7 : 10, backgroundColor: COLORS.white, borderTopWidth: 1, borderTopColor: COLORS.line, shadowColor: COLORS.ink, shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: -4 } },
  navItem: { flex: 1, alignItems: 'center', gap: 3 },
  navIconWrap: { width: 36, height: 28, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  navIconActive: { backgroundColor: COLORS.forest },
  navLabel: { color: COLORS.gray, fontSize: 9, fontWeight: '600' },
  navLabelActive: { color: COLORS.forest, fontWeight: '800' },
  modalPage: { flex: 1, backgroundColor: COLORS.cream },
  modalHandle: { width: 42, height: 5, borderRadius: 3, backgroundColor: '#C8D0CC', alignSelf: 'center', marginTop: 8 },
  modalHeader: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  modalHeaderTitle: { color: COLORS.ink, fontSize: 15, fontWeight: '800' },
  closeButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  saveText: { color: COLORS.forest, fontSize: 14, fontWeight: '800' },
  modalContent: { paddingHorizontal: 20, paddingBottom: 34 },
  profileHero: { alignItems: 'center', paddingVertical: 24 },
  profileOrg: { color: COLORS.ink, fontSize: 22, fontWeight: '800', letterSpacing: -0.5, marginTop: 12 },
  profileName: { color: COLORS.gray, fontSize: 13, marginTop: 4 },
  profileMeta: { flexDirection: 'row', gap: 9, alignItems: 'center', marginTop: 11 },
  profileActions: { flexDirection: 'row', gap: 6, marginBottom: 18 },
  profileAction: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: COLORS.white, borderRadius: 16, paddingVertical: 12, borderWidth: 1, borderColor: COLORS.line },
  profileActionText: { color: COLORS.inkSoft, fontSize: 9, fontWeight: '700' },
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
  contactCard: { marginTop: 18, backgroundColor: COLORS.white, borderRadius: 17, padding: 14, gap: 11, borderWidth: 1, borderColor: COLORS.line },
  contactLine: { flexDirection: 'row', gap: 9, alignItems: 'center' },
  contactText: { color: COLORS.inkSoft, fontSize: 12 },
  formContent: { padding: 20, paddingBottom: 42 },
  formIntro: { color: COLORS.gray, fontSize: 13, lineHeight: 19, marginBottom: 20 },
  formField: { marginBottom: 15 },
  formInput: { backgroundColor: COLORS.white, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 14, color: COLORS.ink, fontSize: 13, outlineStyle: 'none' } as any,
  multilineInput: { minHeight: 94, paddingTop: 13, textAlignVertical: 'top' },
  formRow: { flexDirection: 'row', gap: 10 },
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
  offlineBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.mintPale, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 5, borderWidth: 1, borderColor: COLORS.line },
  offlineBadgeText: { color: COLORS.gray, fontSize: 9, fontWeight: '700' },
  cadenceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  touchLogList: { marginTop: 12, backgroundColor: COLORS.white, borderRadius: 17, paddingHorizontal: 14, borderWidth: 1, borderColor: COLORS.line },
  touchLogRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#EEF0EE' },
  touchLogIcon: { width: 28, height: 28, borderRadius: 9, backgroundColor: COLORS.mint, alignItems: 'center', justifyContent: 'center' },
  touchLogTitle: { color: COLORS.ink, fontSize: 12, fontWeight: '700' },
  touchLogNote: { color: COLORS.gray, fontSize: 10, marginTop: 2 },
  touchLogDate: { color: COLORS.gray, fontSize: 10 },
  prePromptBody: { padding: 20, paddingBottom: 26 },
  prePromptIcon: { width: 52, height: 52, borderRadius: 18, backgroundColor: COLORS.mint, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  prePromptTitle: { color: COLORS.ink, fontSize: 18, fontWeight: '800', letterSpacing: -0.35, marginBottom: 8 },
  prePromptText: { color: COLORS.gray, fontSize: 13, lineHeight: 19, marginBottom: 20 },
  prePromptNotNow: { alignItems: 'center', paddingVertical: 12 },
  prePromptNotNowText: { color: COLORS.gray, fontSize: 12, fontWeight: '700' },
  // Match Packet
  matchActionRow: { flexDirection: 'row', gap: 8, marginTop: 13 },
  matchActionFlex: { flex: 1, marginTop: 0 },
  packetButton: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: COLORS.mint, borderRadius: 13, paddingHorizontal: 13 },
  packetButtonText: { color: COLORS.forest, fontSize: 11, fontWeight: '800' },
  savedMatchPacketButton: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 9, backgroundColor: COLORS.mint, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 6, alignSelf: 'flex-start' },
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
  followUpActions: { flexDirection: 'row', gap: 7, marginTop: 9 },
  followUpActionDone: { backgroundColor: COLORS.forest, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  followUpActionDoneText: { color: COLORS.white, fontSize: 10, fontWeight: '800' },
  followUpAction: { backgroundColor: COLORS.mintPale, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: COLORS.line },
  followUpActionText: { color: COLORS.inkSoft, fontSize: 10, fontWeight: '700' },
  // Outcome capture
  outcomeNotYet: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, marginBottom: 10 },
  outcomeNotYetText: { color: COLORS.blue, fontSize: 12, fontWeight: '700' },
  starRow: { flexDirection: 'row', gap: 8, marginBottom: 18 },
  starButton: { padding: 4 },
});
