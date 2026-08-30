import React, { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'react-native-qrcode-svg';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Modal,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import type { Partner, Referral } from '../data';
import type { CaseRecord } from './cases';
import {
  buildRelationshipRecommendations,
  createReferralHandoff,
  createReferralSource,
  fetchReferralGrowth,
  GrowthError,
  nextHandoffStatus,
  referralPortalBase,
  referralSourceUrl,
  revokeReferralHandoff,
  rotateReferralSource,
  setReferralSourceActive,
  transitionReferralHandoff,
  type HandoffStatus,
  type ReferralHandoff,
  type ReferralSource,
} from './growth';
import type { FollowUp, PartnerScorecard, Touch } from './store';

type Segment = 'links' | 'handoffs' | 'daily';

export type ReferralGrowthScreenProps = {
  visible: boolean;
  onClose: () => void;
  partners: Partner[];
  referrals: Referral[];
  touches: Touch[];
  followUps: FollowUp[];
  scorecards: Record<string, PartnerScorecard>;
  cases: CaseRecord[];
  /** Lets the app shell surface its known cache/offline state immediately. */
  offline?: boolean;
};

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'links', label: 'LINKS' },
  { key: 'handoffs', label: 'HANDOFFS' },
  { key: 'daily', label: 'DAILY PLAN' },
];

const STATUS_LABELS: Record<HandoffStatus, string> = {
  sent: 'Sent',
  received: 'Received',
  contact_attempted: 'Contact attempted',
  family_reached: 'Family reached',
  consult_scheduled: 'Consult scheduled',
  closed: 'Closed',
};

function localDateStamp(): string {
  const value = new Date();
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function partnerName(partner: Partner | undefined): string {
  return partner?.organization.trim() || partner?.name.trim() || 'Unassigned partner';
}

function shortDate(value?: string): string {
  if (!value) return 'No reminder due';
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return value;
  return new Date(year, month - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function copyLink(url: string) {
  Clipboard.setString(url);
  Alert.alert('Copied', 'The secure link is ready to paste.');
}

async function shareLink(url: string, message: string) {
  await Share.share({ message: `${message}\n${url}`, url });
}

function ConfigurationCard() {
  return (
    <View style={styles.configCard} accessibilityRole="alert">
      <Text style={styles.configTitle}>Referral portal is not configured</Text>
      <Text style={styles.configBody}>
        Set EXPO_PUBLIC_REFERRAL_PORTAL_URL for this app build. Links and handoffs stay disabled so ReferralFit never invents a public address.
      </Text>
    </View>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.emptyCard}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

export default function ReferralGrowthScreen({
  visible,
  onClose,
  partners,
  referrals,
  touches,
  followUps,
  scorecards,
  cases,
  offline = false,
}: ReferralGrowthScreenProps) {
  const [segment, setSegment] = useState<Segment>('links');
  const [sources, setSources] = useState<ReferralSource[]>([]);
  const [handoffs, setHandoffs] = useState<ReferralHandoff[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [networkOffline, setNetworkOffline] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showSourceForm, setShowSourceForm] = useState(false);
  const [showHandoffForm, setShowHandoffForm] = useState(false);
  const [sourceLabel, setSourceLabel] = useState('');
  const [practiceDisplay, setPracticeDisplay] = useState('');
  const [sourceDisplay, setSourceDisplay] = useState('');
  const [sourcePartnerId, setSourcePartnerId] = useState<string | undefined>();
  const [selectedReferralId, setSelectedReferralId] = useState<string | undefined>();
  const [clientAlias, setClientAlias] = useState('');
  const [recipientDisplay, setRecipientDisplay] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [oneTimeHandoffUrl, setOneTimeHandoffUrl] = useState<string | null>(null);

  const portalConfigured = Boolean(referralPortalBase());
  const partnerById = useMemo(() => new Map(partners.map((partner) => [partner.id, partner])), [partners]);
  const referralOptions = useMemo(
    () => referrals.filter((referral) => partnerById.has(referral.partnerId)),
    [referrals, partnerById],
  );
  const selectedReferral = referrals.find((referral) => referral.id === selectedReferralId);
  const recommendations = useMemo(() => buildRelationshipRecommendations({
    asOf: localDateStamp(),
    partners,
    referrals,
    touches,
    followUps,
    scorecards,
    cases,
  }), [partners, referrals, touches, followUps, scorecards, cases]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    setNetworkOffline(false);
    try {
      const data = await fetchReferralGrowth();
      setSources(data.sources);
      setHandoffs(data.handoffs);
    } catch (error) {
      setLoadError(errorMessage(error));
      setNetworkOffline(error instanceof GrowthError && error.offline);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  useEffect(() => {
    if (!visible) {
      // The token is intentionally memory-only and leaves the UI when the sheet closes.
      setOneTimeHandoffUrl(null);
      setBusyId(null);
    }
  }, [visible]);

  function resetSourceForm() {
    setSourceLabel('');
    setPracticeDisplay('');
    setSourceDisplay('');
    setSourcePartnerId(undefined);
    setShowSourceForm(false);
  }

  async function saveSource() {
    if (busyId) return;
    setBusyId('new-source');
    try {
      const created = await createReferralSource({
        partnerId: sourcePartnerId,
        label: sourceLabel,
        publicPracticeDisplay: practiceDisplay,
        publicSourceDisplay: sourceDisplay,
      });
      setSources((current) => [created, ...current]);
      resetSourceForm();
    } catch (error) {
      Alert.alert('Could not create link', errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleSource(source: ReferralSource) {
    if (busyId) return;
    setBusyId(source.id);
    const active = !source.active;
    setSources((current) => current.map((item) => item.id === source.id ? { ...item, active } : item));
    try {
      const confirmed = await setReferralSourceActive(source.id, active);
      setSources((current) => current.map((item) => item.id === source.id ? confirmed : item));
    } catch (error) {
      setSources((current) => current.map((item) => item.id === source.id ? source : item));
      Alert.alert('Could not update link', errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  function confirmRotateSource(source: ReferralSource) {
    Alert.alert(
      'Rotate this referral link?',
      'The current URL will stop working immediately. ReferralFit will create a replacement with the same public labels and Partner attribution.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Rotate link',
          style: 'destructive',
          onPress: () => {
            if (busyId) return;
            setBusyId(source.id);
            void rotateReferralSource(source.id)
              .then((replacement) => {
                setSources((current) => [replacement, ...current.map((item) => item.id === source.id
                  ? { ...item, active: false, rotatedToSourceId: replacement.id }
                  : item)]);
                Alert.alert('Link rotated', 'The old URL is inactive. Copy or share the new URL from the replacement card.');
              })
              .catch((error) => Alert.alert('Could not rotate link', errorMessage(error)))
              .finally(() => setBusyId(null));
          },
        },
      ],
    );
  }

  function chooseReferral(referral: Referral) {
    const partner = partnerById.get(referral.partnerId);
    setSelectedReferralId(referral.id);
    setRecipientDisplay(partnerName(partner));
    setRecipientEmail(partner?.email || '');
  }

  function resetHandoffForm() {
    setSelectedReferralId(undefined);
    setClientAlias('');
    setRecipientDisplay('');
    setRecipientEmail('');
    setShowHandoffForm(false);
  }

  async function saveHandoff() {
    if (!selectedReferral || busyId) return;
    setBusyId('new-handoff');
    try {
      const created = await createReferralHandoff({
        referralId: selectedReferral.id,
        caseId: selectedReferral.caseId,
        partnerId: selectedReferral.partnerId,
        clientAlias,
        recipientDisplay,
        recipientEmail,
      });
      setOneTimeHandoffUrl(created.url);
      resetHandoffForm();
      await load();
    } catch (error) {
      Alert.alert('Could not create handoff', errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  async function advanceHandoff(handoff: ReferralHandoff) {
    const next = nextHandoffStatus(handoff.status);
    if (!next || busyId) return;
    const optimistic = { ...handoff, status: next, version: handoff.version + 1 };
    setBusyId(handoff.id);
    setHandoffs((current) => current.map((item) => item.id === handoff.id ? optimistic : item));
    try {
      const confirmed = await transitionReferralHandoff(handoff.id, handoff.version, next);
      setHandoffs((current) => current.map((item) => item.id === handoff.id
        ? { ...item, status: confirmed.status, version: confirmed.version }
        : item));
      await load();
    } catch (error) {
      if (error instanceof GrowthError && error.conflict) {
        await load();
      } else {
        setHandoffs((current) => current.map((item) => item.id === handoff.id ? handoff : item));
      }
      Alert.alert('Could not update handoff', errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  function confirmRevoke(handoff: ReferralHandoff) {
    Alert.alert(
      'Revoke this handoff?',
      'The recipient link will stop working. The status history remains in your workspace.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: () => {
            if (busyId) return;
            setBusyId(handoff.id);
            void revokeReferralHandoff(handoff.id)
              .then(load)
              .catch((error) => Alert.alert('Could not revoke handoff', errorMessage(error)))
              .finally(() => setBusyId(null));
          },
        },
      ],
    );
  }

  function renderLinks() {
    return (
      <>
        {!portalConfigured ? <ConfigurationCard /> : null}
        <View style={styles.sectionHeading}>
          <View style={styles.sectionCopy}>
            <Text style={styles.sectionTitle}>Referral links</Text>
            <Text style={styles.sectionSubtitle}>Track where every public inquiry began.</Text>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Create referral link"
            disabled={!portalConfigured || Boolean(busyId)}
            onPress={() => setShowSourceForm((value) => !value)}
            style={[styles.primarySmall, (!portalConfigured || Boolean(busyId)) && styles.disabled]}
          >
            <Text style={styles.primarySmallText}>{showSourceForm ? 'Cancel' : 'New link'}</Text>
          </TouchableOpacity>
        </View>

        {showSourceForm ? (
          <View style={styles.formCard}>
            <Text style={styles.formTitle}>Create a trackable link</Text>
            <Text style={styles.privacyNote}>Public labels must describe the practice or source only. Never enter a client or family name.</Text>
            <TextInput style={styles.input} value={sourceLabel} onChangeText={setSourceLabel} maxLength={120} placeholder="Internal label, e.g. Conference QR" placeholderTextColor="#85928D" accessibilityLabel="Internal link label" />
            <TextInput style={styles.input} value={practiceDisplay} onChangeText={setPracticeDisplay} maxLength={120} placeholder="Public practice name" placeholderTextColor="#85928D" accessibilityLabel="Public practice display" />
            <TextInput style={styles.input} value={sourceDisplay} onChangeText={setSourceDisplay} maxLength={120} placeholder="Public source, e.g. Referred by our team" placeholderTextColor="#85928D" accessibilityLabel="Public source display" />
            <Text style={styles.fieldLabel}>OPTIONAL PARTNER</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.choiceRow}>
              <TouchableOpacity onPress={() => setSourcePartnerId(undefined)} style={[styles.choice, !sourcePartnerId && styles.choiceActive]} accessibilityState={{ selected: !sourcePartnerId }}>
                <Text style={[styles.choiceText, !sourcePartnerId && styles.choiceTextActive]}>None</Text>
              </TouchableOpacity>
              {partners.map((partner) => (
                <TouchableOpacity key={partner.id} onPress={() => setSourcePartnerId(partner.id)} style={[styles.choice, sourcePartnerId === partner.id && styles.choiceActive]} accessibilityState={{ selected: sourcePartnerId === partner.id }}>
                  <Text style={[styles.choiceText, sourcePartnerId === partner.id && styles.choiceTextActive]}>{partnerName(partner)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            {!sourcePartnerId ? <Text style={styles.helperText}>You can create this link now, but public intake remains unavailable until a Partner is attached.</Text> : null}
            <TouchableOpacity disabled={busyId === 'new-source'} onPress={() => void saveSource()} style={styles.primaryButton} accessibilityRole="button">
              {busyId === 'new-source' ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Create referral link</Text>}
            </TouchableOpacity>
          </View>
        ) : null}

        {sources.length === 0 ? (
          <EmptyState title="No referral links yet" body="Create a link for a partner, campaign, or QR placement. Submission totals update from verified public intake." />
        ) : sources.map((source) => {
          const url = referralSourceUrl(source.id);
          return (
            <View key={source.id} style={[styles.card, !source.active && styles.cardMuted]}>
              <View style={styles.cardTop}>
                <View style={styles.sectionCopy}>
                  <Text style={styles.cardTitle}>{source.label}</Text>
                  <Text style={styles.cardMeta}>{partnerName(partnerById.get(source.partnerId || ''))} · {source.submissionCount} submission{source.submissionCount === 1 ? '' : 's'}</Text>
                </View>
                <View style={[styles.statusBadge, source.active ? styles.statusLive : styles.statusOff]}>
                  <Text style={[styles.statusText, source.active ? styles.statusLiveText : styles.statusOffText]}>{source.active ? 'ACTIVE' : 'INACTIVE'}</Text>
                </View>
              </View>
              <Text style={styles.publicLabel}>{source.publicPracticeDisplay} · {source.publicSourceDisplay}</Text>
              {url && source.active ? (
                <View style={styles.linkBlock}>
                  <QRCode value={url} size={92} color="#16352E" backgroundColor="#FFFFFF" />
                  <View style={styles.linkCopy}>
                    <Text style={styles.urlText} selectable numberOfLines={3}>{url}</Text>
                    <View style={styles.actionRow}>
                      <TouchableOpacity style={styles.secondaryButton} onPress={() => copyLink(url)} accessibilityRole="button" accessibilityLabel={`Copy link ${source.label}`}><Text style={styles.secondaryText}>Copy</Text></TouchableOpacity>
                      <TouchableOpacity style={styles.secondaryButton} onPress={() => void shareLink(url, 'ReferralFit referral link')} accessibilityRole="button" accessibilityLabel={`Share link ${source.label}`}><Text style={styles.secondaryText}>Share</Text></TouchableOpacity>
                    </View>
                  </View>
                </View>
              ) : null}
              <View style={styles.actionRow}>
                {source.active && source.canRotate ? (
                  <TouchableOpacity disabled={busyId === source.id} onPress={() => confirmRotateSource(source)} style={styles.textButton} accessibilityRole="button" accessibilityLabel={`Rotate link ${source.label}`}>
                    <Text style={styles.dangerText}>Rotate link</Text>
                  </TouchableOpacity>
                ) : null}
                {!source.rotatedToSourceId ? (
                  <TouchableOpacity disabled={busyId === source.id} onPress={() => void toggleSource(source)} style={styles.textButton} accessibilityRole="button">
                    <Text style={source.active ? styles.dangerText : styles.textButtonText}>{source.active ? 'Deactivate link' : 'Reactivate link'}</Text>
                  </TouchableOpacity>
                ) : <Text style={styles.helperText}>Permanently replaced</Text>}
              </View>
            </View>
          );
        })}
      </>
    );
  }

  function renderHandoffs() {
    return (
      <>
        {!portalConfigured ? <ConfigurationCard /> : null}
        {oneTimeHandoffUrl ? (
          <View style={styles.oneTimeCard} accessibilityRole="alert">
            <Text style={styles.oneTimeEyebrow}>ONE-TIME LINK</Text>
            <Text style={styles.oneTimeTitle}>Share this handoff now</Text>
            <Text style={styles.oneTimeBody}>For privacy, ReferralFit cannot show this token again after you dismiss or close this screen.</Text>
            <Text style={styles.oneTimeUrl} selectable>{oneTimeHandoffUrl}</Text>
            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.oneTimeAction} onPress={() => copyLink(oneTimeHandoffUrl)} accessibilityRole="button"><Text style={styles.oneTimeActionText}>Copy</Text></TouchableOpacity>
              <TouchableOpacity style={styles.oneTimeAction} onPress={() => void shareLink(oneTimeHandoffUrl, 'Secure ReferralFit handoff')} accessibilityRole="button"><Text style={styles.oneTimeActionText}>Share</Text></TouchableOpacity>
              <TouchableOpacity style={styles.oneTimeDone} onPress={() => setOneTimeHandoffUrl(null)} accessibilityRole="button"><Text style={styles.oneTimeDoneText}>Done</Text></TouchableOpacity>
            </View>
          </View>
        ) : null}
        <View style={styles.sectionHeading}>
          <View style={styles.sectionCopy}>
            <Text style={styles.sectionTitle}>Closed-loop handoffs</Text>
            <Text style={styles.sectionSubtitle}>Share only a private alias and keep the next step visible.</Text>
          </View>
          <TouchableOpacity disabled={!portalConfigured || Boolean(busyId)} onPress={() => setShowHandoffForm((value) => !value)} style={[styles.primarySmall, (!portalConfigured || Boolean(busyId)) && styles.disabled]} accessibilityRole="button">
            <Text style={styles.primarySmallText}>{showHandoffForm ? 'Cancel' : 'New handoff'}</Text>
          </TouchableOpacity>
        </View>

        {showHandoffForm ? (
          <View style={styles.formCard}>
            <Text style={styles.formTitle}>Start a handoff</Text>
            <Text style={styles.privacyNote}>Select an existing referral. ReferralFit sends only the alias below — never client or case details.</Text>
            <Text style={styles.fieldLabel}>REFERRAL + PARTNER</Text>
            {referralOptions.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.choiceRow}>
                {referralOptions.map((referral) => (
                  <TouchableOpacity key={referral.id} onPress={() => chooseReferral(referral)} style={[styles.choice, selectedReferralId === referral.id && styles.choiceActive]} accessibilityState={{ selected: selectedReferralId === referral.id }}>
                    <Text style={[styles.choiceText, selectedReferralId === referral.id && styles.choiceTextActive]}>
                      {shortDate(referral.date)} · {partnerName(partnerById.get(referral.partnerId))}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            ) : <Text style={styles.helperText}>Add a referral tied to a Partner before creating a handoff.</Text>}
            <TextInput style={styles.input} value={clientAlias} onChangeText={setClientAlias} maxLength={32} autoCapitalize="characters" autoCorrect={false} placeholder="Private alias, e.g. RF-204" placeholderTextColor="#85928D" accessibilityLabel="Private client alias" />
            <Text style={styles.helperText}>Letters, numbers, periods, underscores, and hyphens only. Do not use a full name.</Text>
            <TextInput style={styles.input} value={recipientDisplay} onChangeText={setRecipientDisplay} maxLength={120} placeholder="Recipient organization" placeholderTextColor="#85928D" accessibilityLabel="Recipient display" />
            <TextInput style={styles.input} value={recipientEmail} onChangeText={setRecipientEmail} maxLength={254} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} placeholder="Recipient email (optional)" placeholderTextColor="#85928D" accessibilityLabel="Recipient email" />
            <TouchableOpacity disabled={!selectedReferral || busyId === 'new-handoff'} onPress={() => void saveHandoff()} style={[styles.primaryButton, (!selectedReferral || busyId === 'new-handoff') && styles.disabled]} accessibilityRole="button">
              {busyId === 'new-handoff' ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Create one-time handoff link</Text>}
            </TouchableOpacity>
          </View>
        ) : null}

        {handoffs.length === 0 ? (
          <EmptyState title="No handoffs yet" body="Create a secure, alias-only handoff from an existing referral and partner." />
        ) : handoffs.map((handoff) => {
          const next = nextHandoffStatus(handoff.status);
          return (
            <View key={handoff.id} style={[styles.card, handoff.revokedAt && styles.cardMuted]}>
              <View style={styles.cardTop}>
                <View style={styles.sectionCopy}>
                  <Text style={styles.cardTitle}>{handoff.clientAlias}</Text>
                  <Text style={styles.cardMeta}>{handoff.recipientDisplay}</Text>
                </View>
                <View style={[styles.statusBadge, handoff.revokedAt ? styles.statusOff : styles.statusLive]}>
                  <Text style={[styles.statusText, handoff.revokedAt ? styles.statusOffText : styles.statusLiveText]}>{handoff.revokedAt ? 'REVOKED' : STATUS_LABELS[handoff.status].toUpperCase()}</Text>
                </View>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailText}>Version {handoff.version}</Text>
                <Text style={styles.detailText}>{handoff.dueOn ? `Due ${shortDate(handoff.dueOn)}` : 'No reminder due'}</Text>
              </View>
              {!handoff.revokedAt ? (
                <View style={styles.actionRow}>
                  {next ? (
                    <TouchableOpacity disabled={busyId === handoff.id} onPress={() => void advanceHandoff(handoff)} style={styles.secondaryButton} accessibilityRole="button" accessibilityLabel={`Advance handoff to ${STATUS_LABELS[next]}`}>
                      <Text style={styles.secondaryText}>Next: {STATUS_LABELS[next]}</Text>
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity disabled={busyId === handoff.id} onPress={() => confirmRevoke(handoff)} style={styles.textButton} accessibilityRole="button"><Text style={styles.dangerText}>Revoke</Text></TouchableOpacity>
                </View>
              ) : null}
            </View>
          );
        })}
      </>
    );
  }

  function renderDailyPlan() {
    return (
      <>
        <View style={styles.planHero}>
          <Text style={styles.planEyebrow}>RELATIONSHIP INTELLIGENCE</Text>
          <Text style={styles.planTitle}>Five useful moves, at most.</Text>
          <Text style={styles.planBody}>Prioritized from your recorded cadence, open follow-ups, referral history, outcomes, and documented network needs — never paid placement.</Text>
        </View>
        {recommendations.length === 0 ? (
          <EmptyState title="Your relationship queue is clear" body="As you record touches, referrals, follow-ups, and case needs, explainable daily actions will appear here." />
        ) : recommendations.map((recommendation, index) => (
          <View key={`${recommendation.partnerId || 'network'}:${recommendation.title}`} style={styles.planCard}>
            <View style={styles.planCardTop}>
              <View style={[styles.planNumber, recommendation.urgency === 'high' && styles.planNumberHigh]}><Text style={styles.planNumberText}>{index + 1}</Text></View>
              <View style={styles.sectionCopy}>
                <Text style={styles.cardTitle}>{recommendation.title}</Text>
                <Text style={styles.scoreText}>{recommendation.urgency.toUpperCase()} · PRIORITY {recommendation.score}</Text>
              </View>
            </View>
            <Text style={styles.reasonText}>{recommendation.reason}</Text>
            <View style={styles.actionCallout}><Text style={styles.actionLabel}>NEXT MOVE</Text><Text style={styles.actionText}>{recommendation.action}</Text></View>
            <Text style={styles.evidenceText}>WHY: {recommendation.evidenceCodes.map((code) => code.replaceAll('_', ' ').toLowerCase()).join(' · ')}</Text>
          </View>
        ))}
      </>
    );
  }

  const effectiveOffline = offline || networkOffline;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.headerButton} accessibilityRole="button" accessibilityLabel="Close Referral Growth Hub"><Text style={styles.headerButtonText}>Close</Text></TouchableOpacity>
          <View style={styles.headerCopy}><Text style={styles.headerTitle}>Referral Growth</Text><Text style={styles.headerSubtitle}>Links, handoffs & daily relationships</Text></View>
          <TouchableOpacity disabled={loading} onPress={() => void load()} style={styles.headerButton} accessibilityRole="button" accessibilityLabel="Refresh Referral Growth Hub"><Text style={styles.headerButtonText}>{loading ? 'Syncing' : 'Refresh'}</Text></TouchableOpacity>
        </View>
        <View style={styles.segmentBar} accessibilityRole="tablist">
          {SEGMENTS.map((item) => (
            <TouchableOpacity key={item.key} onPress={() => setSegment(item.key)} style={[styles.segment, segment === item.key && styles.segmentActive]} accessibilityRole="tab" accessibilityState={{ selected: segment === item.key }}>
              <Text style={[styles.segmentText, segment === item.key && styles.segmentTextActive]}>{item.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {effectiveOffline ? (
          <View style={styles.offlineBanner}><Text style={styles.offlineText}>OFFLINE · Daily Plan uses data already on this device. Link and handoff changes require a connection.</Text></View>
        ) : null}
        {loading && sources.length === 0 && handoffs.length === 0 ? (
          <View style={styles.centered}><ActivityIndicator color="#1F5A49" /><Text style={styles.loadingText}>Loading growth activity…</Text></View>
        ) : loadError && segment !== 'daily' ? (
          <View style={styles.centered}>
            <Text style={styles.errorTitle}>{effectiveOffline ? 'You’re offline' : 'Could not load growth activity'}</Text>
            <Text style={styles.errorBody}>{loadError}</Text>
            <TouchableOpacity onPress={() => void load()} style={styles.retryButton} accessibilityRole="button"><Text style={styles.retryText}>Try again</Text></TouchableOpacity>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {segment === 'links' ? renderLinks() : segment === 'handoffs' ? renderHandoffs() : renderDailyPlan()}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F6F4EE' },
  header: { minHeight: 64, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#DDE4DF', backgroundColor: '#FFFFFF' },
  headerButton: { minWidth: 64, minHeight: 44, justifyContent: 'center' },
  headerButtonText: { color: '#1F5A49', fontSize: 12, fontWeight: '800' },
  headerCopy: { flex: 1, alignItems: 'center' },
  headerTitle: { color: '#16352E', fontSize: 17, fontWeight: '900' },
  headerSubtitle: { color: '#73827D', fontSize: 9, marginTop: 2 },
  segmentBar: { flexDirection: 'row', gap: 3, padding: 4, marginHorizontal: 16, marginVertical: 10, borderRadius: 13, backgroundColor: '#E6ECE7' },
  segment: { flex: 1, minHeight: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  segmentActive: { backgroundColor: '#1F5A49' },
  segmentText: { color: '#587068', fontSize: 10, fontWeight: '900', letterSpacing: 0.35 },
  segmentTextActive: { color: '#FFFFFF' },
  offlineBanner: { backgroundColor: '#FFF3D6', paddingHorizontal: 16, paddingVertical: 9, borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#E9D6A5' },
  offlineText: { color: '#795E1B', fontSize: 9, lineHeight: 14, fontWeight: '700' },
  content: { padding: 16, paddingBottom: 48, gap: 12 },
  centered: { flex: 1, padding: 32, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: '#73827D', fontSize: 12 },
  errorTitle: { color: '#16352E', fontSize: 17, fontWeight: '800', textAlign: 'center' },
  errorBody: { color: '#7D594B', fontSize: 12, lineHeight: 18, textAlign: 'center' },
  retryButton: { minHeight: 44, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1F5A49', borderRadius: 11 },
  retryText: { color: '#FFFFFF', fontWeight: '800' },
  configCard: { backgroundColor: '#FCECE6', borderWidth: 1, borderColor: '#E7C6B9', borderRadius: 15, padding: 14 },
  configTitle: { color: '#9A4B2F', fontSize: 13, fontWeight: '900' },
  configBody: { color: '#7D594B', fontSize: 10, lineHeight: 16, marginTop: 5 },
  sectionHeading: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12 },
  sectionCopy: { flex: 1 },
  sectionTitle: { color: '#16352E', fontSize: 17, fontWeight: '900' },
  sectionSubtitle: { color: '#73827D', fontSize: 10, lineHeight: 15, marginTop: 3 },
  primarySmall: { minHeight: 44, paddingHorizontal: 15, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1F5A49' },
  primarySmallText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  disabled: { opacity: 0.42 },
  formCard: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#CAD8D1', borderRadius: 17, padding: 15, gap: 10 },
  formTitle: { color: '#16352E', fontSize: 15, fontWeight: '900' },
  privacyNote: { color: '#507C86', fontSize: 10, lineHeight: 16, fontWeight: '600' },
  input: { minHeight: 48, borderWidth: 1, borderColor: '#D5DFDA', borderRadius: 11, paddingHorizontal: 13, color: '#16352E', fontSize: 13, backgroundColor: '#FAFBF9' },
  fieldLabel: { color: '#73827D', fontSize: 9, fontWeight: '900', letterSpacing: 0.55, marginTop: 2 },
  choiceRow: { gap: 8, paddingRight: 8 },
  choice: { minHeight: 44, maxWidth: 230, paddingHorizontal: 13, borderRadius: 12, borderWidth: 1, borderColor: '#D5DFDA', backgroundColor: '#FAFBF9', alignItems: 'center', justifyContent: 'center' },
  choiceActive: { borderColor: '#1F5A49', backgroundColor: '#E5EFE9' },
  choiceText: { color: '#587068', fontSize: 11, fontWeight: '700' },
  choiceTextActive: { color: '#1F5A49' },
  helperText: { color: '#85928D', fontSize: 9, lineHeight: 14 },
  primaryButton: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1F5A49', marginTop: 2 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  emptyCard: { borderWidth: 1, borderColor: '#D9E1DD', borderStyle: 'dashed', borderRadius: 16, padding: 22, alignItems: 'center' },
  emptyTitle: { color: '#16352E', fontSize: 14, fontWeight: '800', textAlign: 'center' },
  emptyBody: { color: '#73827D', fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 6 },
  card: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDE4DF', borderRadius: 17, padding: 15, gap: 11 },
  cardMuted: { opacity: 0.66, backgroundColor: '#F3F4F1' },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cardTitle: { color: '#16352E', fontSize: 14, fontWeight: '900' },
  cardMeta: { color: '#73827D', fontSize: 10, marginTop: 4 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 999, maxWidth: 130 },
  statusLive: { backgroundColor: '#E4F2E9' },
  statusOff: { backgroundColor: '#ECEDEC' },
  statusText: { fontSize: 8, fontWeight: '900', textAlign: 'center' },
  statusLiveText: { color: '#27694F' },
  statusOffText: { color: '#73827D' },
  publicLabel: { color: '#507C86', fontSize: 10, lineHeight: 15 },
  linkBlock: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 10, backgroundColor: '#F8FAF7', borderRadius: 13 },
  linkCopy: { flex: 1, gap: 8 },
  urlText: { color: '#365E63', fontSize: 9, lineHeight: 14 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  secondaryButton: { minHeight: 44, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: '#AFC8BC', alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7FBF8' },
  secondaryText: { color: '#1F5A49', fontSize: 10, fontWeight: '900' },
  textButton: { minHeight: 44, alignSelf: 'flex-start', paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  textButtonText: { color: '#1F5A49', fontSize: 10, fontWeight: '800' },
  dangerText: { color: '#B05B44', fontSize: 10, fontWeight: '800' },
  oneTimeCard: { backgroundColor: '#16352E', borderRadius: 17, padding: 16, gap: 8 },
  oneTimeEyebrow: { color: '#A9D4C0', fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  oneTimeTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '900' },
  oneTimeBody: { color: '#C6D7D0', fontSize: 10, lineHeight: 16 },
  oneTimeUrl: { color: '#FFFFFF', fontSize: 9, lineHeight: 15, paddingVertical: 5 },
  oneTimeAction: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#315C50' },
  oneTimeActionText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
  oneTimeDone: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  oneTimeDoneText: { color: '#16352E', fontSize: 10, fontWeight: '900' },
  detailRow: { flexDirection: 'row', gap: 18 },
  detailText: { color: '#73827D', fontSize: 10, fontWeight: '700' },
  planHero: { backgroundColor: '#16352E', borderRadius: 18, padding: 18 },
  planEyebrow: { color: '#A9D4C0', fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  planTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: '900', marginTop: 7 },
  planBody: { color: '#C6D7D0', fontSize: 10, lineHeight: 16, marginTop: 7 },
  planCard: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDE4DF', borderRadius: 17, padding: 15, gap: 11 },
  planCardTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  planNumber: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: '#507C86' },
  planNumberHigh: { backgroundColor: '#B0603F' },
  planNumberText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  scoreText: { color: '#73827D', fontSize: 8, fontWeight: '900', letterSpacing: 0.35, marginTop: 4 },
  reasonText: { color: '#526862', fontSize: 10, lineHeight: 16 },
  actionCallout: { backgroundColor: '#EAF1EA', borderRadius: 12, padding: 12 },
  actionLabel: { color: '#507C86', fontSize: 8, fontWeight: '900', letterSpacing: 0.55 },
  actionText: { color: '#16352E', fontSize: 11, lineHeight: 17, fontWeight: '700', marginTop: 4 },
  evidenceText: { color: '#85928D', fontSize: 8, lineHeight: 13 },
});
