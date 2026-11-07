import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
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
import { OfflineError, describeError } from './errors';
import {
  HANDOFF_ALIAS_MAX,
  HANDOFF_RECIPIENT_MAX,
  HANDOFF_STEPS,
  advanceHandoff,
  createHandoff,
  fetchHandoffs,
  handoffAliasProblem,
  handoffStatusLabel,
  isHandoffOpen,
  nextHandoffStatus,
  recipientProblem,
  revokeHandoff,
  type ReferralHandoff,
} from './handoffs';
import { WEB_PAGE } from './web-layout';

// Referrals > Handoffs: send a program a private link after referring a
// family to it, and follow the program's steps (src/lib/handoffs.ts).

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  mint: '#DCEAE0',
  mintPale: '#EDF4EF',
  cream: '#F6F4EE',
  white: '#FFFFFF',
  coral: '#B9553B',
  coralPale: '#F7E7E1',
  gray: '#73827D',
  line: '#DDE4DF',
};

// Outbound referrals offered for a new handoff, newest first.
const REFERRALS_OFFERED = 20;

type Props = {
  visible: boolean;
  referrals: Referral[];
  partnersById: Map<string, Partner>;
  // The case's title and contact names, which the alias must not contain.
  caseNamesFor: (caseId: string | undefined) => string[];
  onClose: () => void;
  // A handoff was created, stepped or revoked: its reminder changed on the
  // server (Today refreshes).
  onChanged: () => void;
};

function shortDate(stamp: string): string {
  const parsed = new Date(stamp.length === 10 ? `${stamp}T12:00:00` : stamp);
  return Number.isNaN(parsed.getTime()) ? stamp : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function failureText(error: unknown): string {
  return error instanceof OfflineError ? 'You are offline. Handoffs need a connection; try again when you are back online.' : describeError(error);
}

export default function HandoffsSheet({ visible, referrals, partnersById, caseNamesFor, onClose, onChanged }: Props) {
  const [handoffs, setHandoffs] = useState<ReferralHandoff[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; alias: string; handoffId: string } | null>(null);
  const [composing, setComposing] = useState(false);
  const [referralId, setReferralId] = useState<string | null>(null);
  const [alias, setAlias] = useState('');
  const [recipient, setRecipient] = useState('');
  const [email, setEmail] = useState('');
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setHandoffs(await fetchHandoffs());
    } catch (error) {
      setLoadError(failureText(error));
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setHandoffs(null);
    setLink(null);
    setComposing(false);
    void load();
  }, [visible, load]);

  const openByReferral = useMemo(() => new Set((handoffs || []).filter(isHandoffOpen).map((item) => item.referralId)), [handoffs]);
  const choices = useMemo(() => referrals
    .filter((referral) => referral.direction === 'Outbound' && partnersById.has(referral.partnerId) && !openByReferral.has(referral.id))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, REFERRALS_OFFERED), [referrals, partnersById, openByReferral]);
  const chosen = choices.find((referral) => referral.id === referralId) || null;

  const aliasProblem = chosen && alias.trim() ? handoffAliasProblem(alias, caseNamesFor(chosen.caseId), chosen.clientLabel || null) : null;

  function startComposing() {
    setComposing(true);
    setReferralId(null);
    setAlias('');
    setRecipient('');
    setEmail('');
    setFormError('');
  }

  function choose(referral: Referral) {
    setReferralId(referral.id);
    setRecipient((current) => current.trim() ? current : (partnersById.get(referral.partnerId)?.organization || ''));
    setFormError('');
  }

  async function create() {
    if (!chosen || busyId) return;
    const problem = handoffAliasProblem(alias, caseNamesFor(chosen.caseId), chosen.clientLabel || null) || recipientProblem(recipient, email);
    if (problem) {
      setFormError(problem);
      return;
    }
    setBusyId('new');
    setFormError('');
    try {
      const created = await createHandoff({
        referralId: chosen.id,
        caseId: chosen.caseId || null,
        partnerId: chosen.partnerId,
        clientAlias: alias,
        recipientDisplay: recipient,
        recipientEmail: email,
      });
      setLink({ url: created.link, alias: alias.trim(), handoffId: created.handoffId });
      setComposing(false);
      onChanged();
      await load();
    } catch (error) {
      setFormError(failureText(error));
    } finally {
      setBusyId(null);
    }
  }

  function confirmAdvance(handoff: ReferralHandoff) {
    const next = nextHandoffStatus(handoff.status);
    if (!next || busyId) return;
    Alert.alert(
      `Mark as ${handoffStatusLabel(next).toLowerCase()}?`,
      'The program usually does this from its link. Mark it here when they told you another way.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mark it',
          onPress: () => {
            setBusyId(handoff.id);
            void advanceHandoff(handoff)
              .then(() => { onChanged(); return load(); })
              .catch((error) => { Alert.alert('Not updated', failureText(error)); return load(); })
              .finally(() => setBusyId(null));
          },
        },
      ],
    );
  }

  function confirmRevoke(handoff: ReferralHandoff) {
    if (busyId) return;
    Alert.alert(
      'Revoke this handoff?',
      `The link stops working for ${handoff.recipientDisplay}, and its reminder is dropped. This cannot be undone; you can send a new one.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: () => {
            setBusyId(handoff.id);
            void revokeHandoff(handoff.id)
              .then(() => {
                // A revoked handoff's link is dead: stop offering to send it.
                setLink((current) => (current?.handoffId === handoff.id ? null : current));
                onChanged();
                return load();
              })
              .catch((error) => Alert.alert('Not revoked', failureText(error)))
              .finally(() => setBusyId(null));
          },
        },
      ],
    );
  }

  function shareLink() {
    if (!link) return;
    void Share.share({
      message: `A private ReferralFit link for the family we referred to you (${link.alias}). Please mark each step as it happens: ${link.url}`,
    }).catch(() => undefined);
  }

  function copyLink() {
    if (!link) return;
    void Clipboard.setStringAsync(link.url).then(() => Alert.alert('Copied', 'The handoff link is on the clipboard.'));
  }

  function renderLink() {
    if (!link) return null;
    return (
      <View style={styles.linkCard} accessibilityRole="alert">
        <Text style={styles.linkEyebrow}>SEND THIS LINK NOW</Text>
        <Text style={styles.linkTitle}>Handoff for {link.alias}</Text>
        <Text style={styles.linkBody}>For privacy the link is shown only once. Send it to the program now; if it is lost, revoke this handoff and send a new one.</Text>
        <Text style={styles.linkUrl} selectable>{link.url}</Text>
        <View style={styles.row}>
          <TouchableOpacity accessibilityRole="button" style={styles.smallButton} onPress={shareLink}><Text style={styles.smallButtonText}>Share</Text></TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" style={styles.smallButton} onPress={copyLink}><Text style={styles.smallButtonText}>Copy</Text></TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" style={styles.textButtonInline} onPress={() => setLink(null)}><Text style={styles.textButtonText}>Done</Text></TouchableOpacity>
        </View>
      </View>
    );
  }

  function renderForm() {
    return (
      <View style={styles.formCard}>
        <Text style={styles.label}>WHICH REFERRAL</Text>
        {choices.length ? choices.map((referral) => {
          const selected = referral.id === referralId;
          const partner = partnersById.get(referral.partnerId);
          return (
            <TouchableOpacity
              key={referral.id}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => choose(referral)}
              style={[styles.option, selected && styles.optionSelected]}
            >
              <Text style={styles.optionName} numberOfLines={1}>{partner?.organization || partner?.name}</Text>
              <Text style={styles.optionLine} numberOfLines={1}>{shortDate(referral.date)}{referral.clientLabel ? ` · ${referral.clientLabel} (only you see this)` : ''}</Text>
            </TouchableOpacity>
          );
        }) : <Text style={styles.hint}>Log an outbound referral first: a handoff follows a family you referred to a program.</Text>}

        <Text style={styles.label}>ALIAS THE PROGRAM SEES</Text>
        <TextInput
          value={alias}
          onChangeText={setAlias}
          maxLength={HANDOFF_ALIAS_MAX}
          placeholder="Family A"
          placeholderTextColor="#91A09B"
          autoCorrect={false}
          style={styles.input}
          accessibilityLabel="Alias the program sees"
        />
        <Text style={aliasProblem ? styles.problem : styles.hint}>{aliasProblem || 'Not the family’s name or anything that identifies them. The program sees only this alias, your practice’s name and the status.'}</Text>

        <Text style={styles.label}>PROGRAM OR PERSON RECEIVING IT</Text>
        <TextInput value={recipient} onChangeText={setRecipient} maxLength={HANDOFF_RECIPIENT_MAX} placeholder="Admissions team" placeholderTextColor="#91A09B" style={styles.input} accessibilityLabel="Who receives the handoff" />
        <Text style={styles.label}>THEIR EMAIL (OPTIONAL, FOR YOUR RECORDS)</Text>
        <TextInput value={email} onChangeText={setEmail} maxLength={254} placeholder="admissions@program.org" placeholderTextColor="#91A09B" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} style={styles.input} accessibilityLabel="Their email" />

        {formError ? <Text style={styles.problem}>{formError}</Text> : null}
        <TouchableOpacity
          accessibilityRole="button"
          disabled={!chosen || busyId === 'new'}
          onPress={() => void create()}
          style={[styles.primaryButton, (!chosen || busyId === 'new') && styles.buttonDisabled]}
        >
          {busyId === 'new' ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.primaryButtonText}>Create the link</Text>}
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" style={styles.textButton} onPress={() => setComposing(false)}><Text style={styles.textButtonText}>Cancel</Text></TouchableOpacity>
      </View>
    );
  }

  function renderHandoff(handoff: ReferralHandoff) {
    const partner = partnersById.get(handoff.partnerId);
    const next = nextHandoffStatus(handoff.status);
    const open = isHandoffOpen(handoff);
    const stepIndex = HANDOFF_STEPS.findIndex((step) => step.status === handoff.status);
    return (
      <View key={handoff.id} style={[styles.card, !open && styles.cardDone]}>
        <View style={styles.cardTop}>
          <View style={styles.flex}>
            <Text style={styles.cardTitle}>{handoff.clientAlias}</Text>
            <Text style={styles.cardLine} numberOfLines={1}>{handoff.recipientDisplay}{partner && partner.organization !== handoff.recipientDisplay ? ` · ${partner.organization}` : ''}</Text>
          </View>
          <View style={[styles.badge, handoff.revokedAt ? styles.badgeOff : open ? styles.badgeLive : styles.badgeDone]}>
            <Text style={[styles.badgeText, handoff.revokedAt ? styles.badgeOffText : null]}>{handoff.revokedAt ? 'Revoked' : handoffStatusLabel(handoff.status)}</Text>
          </View>
        </View>
        {!handoff.revokedAt ? (
          <View style={styles.steps} accessibilityLabel={`Step ${stepIndex + 1} of ${HANDOFF_STEPS.length}: ${handoffStatusLabel(handoff.status)}`}>
            {HANDOFF_STEPS.map((step, index) => <View key={step.status} style={[styles.step, index <= stepIndex && styles.stepDone]} />)}
          </View>
        ) : null}
        <Text style={styles.cardLine}>Sent {shortDate(handoff.createdAt)}{handoff.dueOn && open ? ` · reminder ${shortDate(handoff.dueOn)}` : ''}</Text>
        {open ? (
          <View style={styles.row}>
            {next ? (
              <TouchableOpacity accessibilityRole="button" disabled={busyId === handoff.id} onPress={() => confirmAdvance(handoff)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>Mark {handoffStatusLabel(next).toLowerCase()}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity accessibilityRole="button" disabled={busyId === handoff.id} onPress={() => confirmRevoke(handoff)} style={styles.textButtonInline}>
              <Text style={styles.revokeText}>Revoke</Text>
            </TouchableOpacity>
            {busyId === handoff.id ? <ActivityIndicator color={COLORS.forest} /> : null}
          </View>
        ) : null}
      </View>
    );
  }

  const openHandoffs = (handoffs || []).filter(isHandoffOpen);
  const finished = (handoffs || []).filter((item) => !isHandoffOpen(item));

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.page}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <View style={styles.headerButton} />
            <Text style={styles.headerTitle}>Handoffs</Text>
            <TouchableOpacity accessibilityRole="button" onPress={onClose} style={styles.headerButton}><Text style={styles.headerButtonText}>Done</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.lead}>After you refer a family, send the program a private link. They mark each step (received, family contacted, consult scheduled) and your reminder moves with them.</Text>
            {renderLink()}
            {composing ? renderForm() : (
              <TouchableOpacity accessibilityRole="button" style={styles.primaryButton} onPress={startComposing}>
                <Text style={styles.primaryButtonText}>New handoff</Text>
              </TouchableOpacity>
            )}
            {loadError ? (
              <View style={styles.errorBox}>
                <Text style={styles.problem}>{loadError}</Text>
                <TouchableOpacity accessibilityRole="button" style={styles.textButton} onPress={() => void load()}><Text style={styles.textButtonText}>Try again</Text></TouchableOpacity>
              </View>
            ) : handoffs === null ? <ActivityIndicator style={styles.loading} color={COLORS.forest} /> : (
              <>
                <Text style={styles.label}>OPEN · {openHandoffs.length}</Text>
                {openHandoffs.length ? openHandoffs.map(renderHandoff) : <Text style={styles.hint}>No open handoffs.</Text>}
                {finished.length ? <Text style={styles.label}>CLOSED OR REVOKED · {finished.length}</Text> : null}
                {finished.map(renderHandoff)}
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.cream, ...WEB_PAGE },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line, backgroundColor: COLORS.white },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '800', color: COLORS.ink },
  headerButton: { minWidth: 64, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end', paddingHorizontal: 6 },
  headerButtonText: { fontSize: 15, fontWeight: '700', color: COLORS.forest },
  content: { padding: 18, paddingBottom: 48 },
  lead: { fontSize: 15, lineHeight: 21, color: COLORS.inkSoft },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.gray, marginTop: 18, marginBottom: 6 },
  hint: { fontSize: 12, lineHeight: 17, color: COLORS.gray, marginTop: 6 },
  problem: { fontSize: 13, lineHeight: 18, color: COLORS.coral, marginTop: 6 },
  loading: { marginTop: 24 },
  errorBox: { marginTop: 16, padding: 12, borderRadius: 12, backgroundColor: COLORS.coralPale },
  formCard: { marginTop: 16, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white },
  option: { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, marginTop: 8 },
  optionSelected: { borderColor: COLORS.forest, backgroundColor: COLORS.mintPale },
  optionName: { fontSize: 15, fontWeight: '800', color: COLORS.ink },
  optionLine: { fontSize: 12, color: COLORS.gray, marginTop: 2 },
  input: { minHeight: 48, borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, backgroundColor: COLORS.white, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: COLORS.ink },
  linkCard: { marginTop: 16, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: COLORS.forest, backgroundColor: COLORS.mintPale },
  linkEyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.forest },
  linkTitle: { fontSize: 17, fontWeight: '800', color: COLORS.ink, marginTop: 4 },
  linkBody: { fontSize: 13, lineHeight: 18, color: COLORS.inkSoft, marginTop: 6 },
  linkUrl: { fontSize: 13, color: COLORS.ink, marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: COLORS.white },
  card: { marginTop: 10, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white },
  cardDone: { opacity: 0.75 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cardTitle: { fontSize: 16, fontWeight: '800', color: COLORS.ink },
  cardLine: { fontSize: 13, color: COLORS.gray, marginTop: 4 },
  badge: { borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  badgeLive: { backgroundColor: COLORS.mint },
  badgeDone: { backgroundColor: COLORS.mintPale },
  badgeOff: { backgroundColor: COLORS.coralPale },
  badgeText: { fontSize: 12, fontWeight: '800', color: COLORS.forest },
  badgeOffText: { color: COLORS.coral },
  steps: { flexDirection: 'row', gap: 4, marginTop: 12 },
  step: { flex: 1, height: 6, borderRadius: 3, backgroundColor: COLORS.line },
  stepDone: { backgroundColor: COLORS.forest },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  smallButton: { minHeight: 40, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: COLORS.forest, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center' },
  smallButtonText: { color: COLORS.forest, fontSize: 14, fontWeight: '800' },
  primaryButton: { minHeight: 52, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  primaryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
  buttonDisabled: { opacity: 0.4 },
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  textButtonInline: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 6 },
  textButtonText: { color: COLORS.inkSoft, fontSize: 15, fontWeight: '700' },
  revokeText: { color: COLORS.coral, fontSize: 14, fontWeight: '700' },
});
