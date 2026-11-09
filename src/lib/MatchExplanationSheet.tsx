// Why these programs: a plain-language explanation of the Match screen's
// ranking for the family, ready to send by Messages or Mail. It explains
// the order; it never changes it (src/lib/match-explanation.ts). With the
// practitioner's own Anthropic key it can be rewritten in warmer words; the
// cautions, disclosures and how the order was decided stay as written.
// docs/MATCH_EXPLANATION.md.
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useMemo, useRef, useState } from 'react';
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

import type { ReferralMatch } from '../data';
import { AssistUnavailableError, requestExplanationRewrite } from './ai-assist-api';
import {
  EXPLAIN_DEFAULT,
  EXPLAIN_MAX,
  explainMatches,
  explanationText,
  rewriteFacts,
  rewriteMatches,
  withDisclosures,
  type Rewrite,
} from './match-explanation';
import type { ProgramScore } from './matching';
import { aiKeysSupported, getAnthropicKey } from './outreach-api';
import { WEB_PAGE } from './web-layout';

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  mintPale: '#EDF4EF',
  cream: '#F6F4EE',
  white: '#FFFFFF',
  coralPale: '#F7E7E1',
  coralText: '#8E3B28',
  gray: '#73827D',
  muted: '#55645F',
  line: '#DDE4DF',
};

type Props = {
  visible: boolean;
  userId: string;
  /** The criteria the Match screen ranked with. */
  profile: ReferralMatch;
  /** The Match screen's own ranked list (rankPrograms), unchanged. */
  ranked: ProgramScore[];
  onClose: () => void;
};

export default function MatchExplanationSheet({ visible, userId, profile, ranked, onClose }: Props) {
  const [count, setCount] = useState(EXPLAIN_DEFAULT);
  const [rewrite, setRewrite] = useState<Rewrite | null>(null);
  const [text, setText] = useState('');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const openingRef = useRef(0);

  const shown = Math.min(count, ranked.length, EXPLAIN_MAX);
  const explanation = useMemo(() => explainMatches(profile, ranked, shown), [profile, ranked, shown]);
  const explanationRef = useRef(explanation);
  explanationRef.current = explanation;

  // A fresh explanation each time the sheet opens.
  useEffect(() => {
    openingRef.current += 1;
    if (!visible) return;
    const opening = openingRef.current;
    setCount(EXPLAIN_DEFAULT);
    setRewrite(null);
    setEdited(false);
    setBusy(false);
    setMessage(null);
    setHasKey(false);
    if (aiKeysSupported) {
      void getAnthropicKey(userId).then((key) => { if (opening === openingRef.current) setHasKey(Boolean(key)); });
    }
  }, [visible, userId]);

  // The text follows the explanation. It is written again only when its
  // words would change (another program count, a rewrite, a new ranking),
  // not on every refresh of the data behind it.
  const generated = useMemo(() => explanationText(explanation, rewrite), [explanation, rewrite]);
  useEffect(() => {
    if (!visible) return;
    setText(generated);
    setEdited(false);
  }, [visible, generated]);

  function confirmReplace(proceed: () => void) {
    if (!edited) { proceed(); return; }
    Alert.alert('Replace your edits?', 'The explanation will be written again from the ranking.', [
      { text: 'Keep my edits', style: 'cancel' },
      { text: 'Replace', style: 'destructive', onPress: proceed },
    ]);
  }

  function chooseCount(next: number) {
    if (next === count || busy) return;
    confirmReplace(() => { setRewrite(null); setMessage(null); setCount(next); });
  }

  async function rewriteWarmer() {
    if (busy) return;
    const opening = openingRef.current;
    const facts = rewriteFacts(explanation);
    setBusy(true);
    setMessage(null);
    try {
      const key = await getAnthropicKey(userId);
      if (!key) {
        if (opening === openingRef.current) setHasKey(false);
        return;
      }
      const result = await requestExplanationRewrite(facts, key);
      if (opening !== openingRef.current) return;
      if (!rewriteMatches(explanationRef.current, result)) {
        setMessage({ ok: false, text: 'The ranking changed while this was being written. Your text is unchanged; try again.' });
        return;
      }
      setRewrite(result);
      setMessage({ ok: true, text: 'Rewritten from the same facts, in the same order. The cautions, disclosures and how the order was decided are unchanged. Read it before you send it.' });
    } catch (error) {
      if (opening !== openingRef.current) return;
      if (error instanceof AssistUnavailableError && error.reason === 'key') setHasKey(false);
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'This is unavailable right now.' });
    } finally {
      if (opening === openingRef.current) setBusy(false);
    }
  }

  function finalText(): { text: string; added: number } {
    return withDisclosures(text.trim(), explanation);
  }

  async function share() {
    const { text: body, added } = finalText();
    if (!body) return;
    if (added) setText(body);
    try {
      await Share.share({ message: body });
      if (added) setMessage({ ok: true, text: 'A disclosure you removed was added back: it must go to the family.' });
    } catch {
      setMessage({ ok: false, text: 'Could not open sharing. Copy the text instead.' });
    }
  }

  async function copy() {
    const { text: body, added } = finalText();
    if (!body) return;
    if (added) setText(body);
    try {
      await Clipboard.setStringAsync(body);
      setMessage({ ok: true, text: added ? 'Copied. A disclosure you removed was added back: it must go to the family.' : 'Copied.' });
    } catch {
      setMessage({ ok: false, text: 'Could not copy. Select the text and copy it instead.' });
    }
  }

  const choices = Array.from({ length: Math.min(EXPLAIN_MAX, ranked.length) }, (_, index) => index + 1);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.page}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>Close</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle} accessibilityRole="header">Why these programs</Text>
          <View style={styles.headerButton} />
        </View>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
            <Text style={styles.intro}>
              A plain-language explanation of your ranking for the family. It lists the programs in the order the Match screen shows and explains why; it never changes the order. Edit anything before you send it.
            </Text>
            {ranked.length ? (
              <>
                <Text style={styles.label}>PROGRAMS TO EXPLAIN</Text>
                <View style={styles.pillRow}>
                  {choices.map((value) => {
                    const on = value === shown;
                    return (
                      <TouchableOpacity
                        key={value}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on, disabled: busy }}
                        accessibilityLabel={value === 1 ? 'Explain the top program' : `Explain the top ${value} programs`}
                        disabled={busy}
                        onPress={() => chooseCount(value)}
                        style={[styles.pill, on && styles.pillOn]}
                      >
                        <Text style={[styles.pillText, on && styles.pillTextOn]}>{value === 1 ? 'Top 1' : `Top ${value}`}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            ) : null}
            {aiKeysSupported && hasKey && ranked.length ? (
              <View style={styles.row}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy, busy }}
                  disabled={busy}
                  onPress={() => confirmReplace(() => { void rewriteWarmer(); })}
                  style={[styles.secondaryButton, busy && styles.off]}
                >
                  {busy ? <ActivityIndicator color={COLORS.forest} accessibilityLabel="Rewriting" /> : <Text style={styles.secondaryButtonText}>Rewrite in warmer words</Text>}
                </TouchableOpacity>
                {rewrite ? (
                  <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => confirmReplace(() => { setRewrite(null); setMessage(null); })} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>Use the plain version</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}
            {message ? (
              <View style={[styles.notice, message.ok && styles.noticeOk]} accessibilityRole="alert" accessibilityLiveRegion="polite">
                <Text style={[styles.noticeText, message.ok && styles.noticeTextOk]}>{message.text}</Text>
              </View>
            ) : null}
            <TextInput
              value={text}
              onChangeText={(value) => { setText(value); setEdited(true); }}
              multiline
              editable={!busy}
              accessibilityLabel="The explanation for the family"
              style={styles.text}
            />
            <Text style={styles.hint}>
              No names are in it: say who it is for when you send it. Any financial relationship with a program is disclosed, and stays in when you share.
            </Text>
          </ScrollView>
          <View style={styles.footer}>
            <TouchableOpacity accessibilityRole="button" disabled={busy || !text.trim()} onPress={() => { void copy(); }} style={[styles.footerSecondary, (busy || !text.trim()) && styles.off]}>
              <Text style={styles.secondaryButtonText}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" disabled={busy || !text.trim()} onPress={() => { void share(); }} style={[styles.primaryButton, (busy || !text.trim()) && styles.off]}>
              <Text style={styles.primaryButtonText}>Send to the family</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.cream, ...WEB_PAGE },
  flex: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line, backgroundColor: COLORS.white },
  headerTitle: { fontSize: 17, fontWeight: '800', color: COLORS.ink },
  headerButton: { minWidth: 64, minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  headerButtonText: { fontSize: 15, fontWeight: '700', color: COLORS.inkSoft },
  content: { padding: 18, paddingBottom: 48, gap: 6 },
  intro: { fontSize: 14, lineHeight: 20, color: COLORS.muted },
  hint: { fontSize: 12, lineHeight: 17, color: COLORS.muted, marginTop: 4 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.muted, marginTop: 14, marginBottom: 4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { minHeight: 36, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, justifyContent: 'center' },
  pillOn: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  pillText: { fontSize: 13, fontWeight: '700', color: COLORS.inkSoft },
  pillTextOn: { color: COLORS.white },
  notice: { backgroundColor: COLORS.coralPale, borderRadius: 12, padding: 12, marginTop: 10 },
  noticeOk: { backgroundColor: COLORS.mintPale },
  noticeText: { fontSize: 13, lineHeight: 19, color: COLORS.coralText, fontWeight: '600' },
  noticeTextOk: { color: COLORS.forest },
  text: { minHeight: 320, marginTop: 12, borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, backgroundColor: COLORS.white, padding: 14, fontSize: 15, lineHeight: 22, color: COLORS.ink, textAlignVertical: 'top' },
  footer: { flexDirection: 'row', gap: 10, padding: 14, borderTopWidth: 1, borderTopColor: COLORS.line, backgroundColor: COLORS.white },
  primaryButton: { flex: 1, minHeight: 52, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
  footerSecondary: { minHeight: 52, paddingHorizontal: 18, borderRadius: 14, borderWidth: 1, borderColor: COLORS.forest, alignItems: 'center', justifyContent: 'center' },
  secondaryButton: { minHeight: 44, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start', marginTop: 10 },
  secondaryButtonText: { color: COLORS.forest, fontSize: 15, fontWeight: '800' },
  off: { opacity: 0.5 },
});
