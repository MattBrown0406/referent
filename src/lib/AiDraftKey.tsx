import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { looksLikeAnthropicKey, maskAnthropicKey, normalizeAnthropicKey } from './outreach';
import {
  aiKeysSupported,
  DraftUnavailableError,
  getAnthropicKey,
  removeAnthropicKey,
  saveAnthropicKey,
  verifyAnthropicKey,
} from './outreach-api';

// Bring-your-own-key setup for AI drafts. ReferralFit is free, so drafts run
// on the practitioner's own Anthropic account: they paste their API key once,
// it is checked with Anthropic, and it stays in this phone's keychain. The
// screen says what is shared with Anthropic before anything is (App Review
// 5.1.2(i)); saving the key is the user's agreement to that.

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  mintPale: '#EDF4EF',
  white: '#FFFFFF',
  coralInk: '#B0603F',
  gray: '#73827D',
  line: '#DDE4DF',
};

const SHARED_WITH_ANTHROPIC = [
  'the recipient’s first name, and their relationship (or the partner’s organization and type)',
  'your first name and your practice’s name',
  'the case stage, how many times you have reached out, and how and how long ago you last did',
  'anything you type in “Anything to mention?”',
];

export function AiKeyDisclosure() {
  return (
    <View>
      <Text style={styles.body}>
        AI drafts are written by Claude from Anthropic, using your own Anthropic account and API key. ReferralFit does not sell, charge for, or receive anything from this feature.
      </Text>
      <Text style={styles.body}>For each draft, ReferralFit sends Anthropic only:</Text>
      {SHARED_WITH_ANTHROPIC.map((line) => <Text key={line} style={styles.bullet}>•  {line}</Text>)}
      <Text style={styles.body}>
        Never phone numbers, email addresses, last names, case titles, case notes, or documents. Anthropic does not train its models on API data. Your key stays in this phone’s keychain; ReferralFit’s server passes it to Anthropic with each draft and never stores it.
      </Text>
      <Text style={styles.body}>
        If your practice needs a business associate agreement for this, set it up with Anthropic on your own account.
      </Text>
      <Text style={styles.body}>By saving your key, you agree to send the information above to Anthropic each time you ask for a draft.</Text>
    </View>
  );
}

type SetupProps = {
  userId: string;
  saveLabel: string;
  onSaved: (apiKey: string) => void;
  onCancel?: () => void;
  cancelLabel?: string;
};

export function AiKeySetup({ userId, saveLabel, onSaved, onCancel, cancelLabel }: SetupProps) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  // Cancel (or closing the sheet) while the key is being checked means no:
  // the key is not saved and nothing is drafted.
  const abandonedRef = useRef(false);
  const savingRef = useRef(false);
  useEffect(() => () => { abandonedRef.current = true; }, []);

  if (!aiKeysSupported) {
    return <Text style={styles.body}>AI drafts use your phone’s keychain, so they are set up in the iPhone app.</Text>;
  }

  async function save() {
    if (savingRef.current) return;
    const apiKey = normalizeAnthropicKey(value);
    if (!looksLikeAnthropicKey(apiKey)) {
      setProblem('That does not look like an Anthropic API key. It starts with sk-ant-.');
      return;
    }
    savingRef.current = true;
    abandonedRef.current = false;
    setBusy(true);
    setProblem('');
    try {
      await verifyAnthropicKey(apiKey);
      if (abandonedRef.current) return;
      const previous = await getAnthropicKey(userId);
      await saveAnthropicKey(userId, apiKey);
      if (abandonedRef.current) {
        // Cancelled while the keychain write was in flight: put back what was there.
        if (previous) await saveAnthropicKey(userId, previous).catch(() => undefined);
        else await removeAnthropicKey(userId);
        return;
      }
      setValue('');
      onSaved(apiKey);
    } catch (error) {
      if (!abandonedRef.current) setProblem(error instanceof DraftUnavailableError ? error.message : 'The key could not be saved on this phone. Try again.');
    } finally {
      savingRef.current = false;
      if (!abandonedRef.current) setBusy(false);
    }
  }

  function cancel() {
    abandonedRef.current = true;
    onCancel?.();
  }

  return (
    <View>
      <AiKeyDisclosure />
      <Text style={styles.body}>To get a key, sign in at console.anthropic.com and create one under API keys, then paste it here.</Text>
      <Text style={styles.label}>YOUR ANTHROPIC API KEY</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={(text) => { setValue(text); setProblem(''); }}
        placeholder="sk-ant-…"
        placeholderTextColor="#99A6A1"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        textContentType="none"
        importantForAutofill="no"
        accessibilityLabel="Your Anthropic API key"
      />
      {problem ? <Text style={styles.problem}>{problem}</Text> : null}
      <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => { void save(); }} style={[styles.primaryButton, busy && styles.busy]}>
        {busy ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.primaryButtonText}>{saveLabel}</Text>}
      </TouchableOpacity>
      {onCancel ? (
        <TouchableOpacity accessibilityRole="button" onPress={cancel} style={styles.textButton}>
          <Text style={styles.textButtonText}>{cancelLabel || 'Not now'}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// Workspace → AI drafts: shows whether a key is saved on this phone, and
// lets the user add, replace, or remove it.
export function AiDraftsCard({ userId, visible }: { userId: string; visible: boolean }) {
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!visible || !userId) return;
    let active = true;
    setLoaded(false);
    void getAnthropicKey(userId).then((key) => {
      if (!active) return;
      setSavedKey(key);
      setLoaded(true);
    });
    return () => { active = false; };
  }, [visible, userId]);

  function confirmRemove() {
    Alert.alert('Remove your API key?', 'AI drafts stop on this phone until you add a key again. Plain drafts and sending still work.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void removeAnthropicKey(userId).then(() => setSavedKey(null));
        },
      },
    ]);
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>AI drafts</Text>
      {!loaded ? <ActivityIndicator color={COLORS.forest} /> : editing ? (
        <AiKeySetup
          userId={userId}
          saveLabel="Check and save key"
          onSaved={(apiKey) => { setSavedKey(apiKey); setEditing(false); }}
          onCancel={() => setEditing(false)}
          cancelLabel="Cancel"
        />
      ) : savedKey ? (
        <>
          <Text style={styles.body}>Connected on this phone with {maskAnthropicKey(savedKey)}. Follow-up drafts are written by Claude on your Anthropic account.</Text>
          <View style={styles.row}>
            <TouchableOpacity accessibilityRole="button" onPress={() => setEditing(true)} style={styles.smallButton}>
              <Text style={styles.smallButtonText}>Replace key</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" onPress={confirmRemove} style={styles.smallButtonQuiet}>
              <Text style={styles.smallButtonQuietText}>Remove</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.body}>
            {aiKeysSupported
              ? 'Add your own Anthropic API key to have AI draft follow-up texts, emails, and call scripts. Without one, Follow up still gives you a plain draft to edit and send.'
              : 'AI drafts are set up in the iPhone app.'}
          </Text>
          {aiKeysSupported ? (
            <TouchableOpacity accessibilityRole="button" onPress={() => setEditing(true)} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Add your Anthropic key</Text>
            </TouchableOpacity>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: COLORS.white, borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, padding: 16, marginBottom: 14 },
  cardLabel: { fontSize: 15, fontWeight: '800', color: COLORS.ink, marginBottom: 6 },
  body: { fontSize: 14, lineHeight: 20, color: COLORS.inkSoft, marginTop: 8 },
  bullet: { fontSize: 14, lineHeight: 20, color: COLORS.inkSoft, marginTop: 4, paddingLeft: 4 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.gray, marginTop: 16, marginBottom: 6 },
  input: { minHeight: 48, borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, backgroundColor: COLORS.white, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: COLORS.ink },
  problem: { fontSize: 13, lineHeight: 18, color: COLORS.coralInk, marginTop: 8 },
  primaryButton: { minHeight: 50, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  primaryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
  busy: { opacity: 0.7 },
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  textButtonText: { color: COLORS.inkSoft, fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 10, marginTop: 12 },
  smallButton: { minHeight: 44, paddingHorizontal: 16, borderRadius: 12, backgroundColor: COLORS.mintPale, borderWidth: 1, borderColor: COLORS.forest, justifyContent: 'center' },
  smallButtonText: { color: COLORS.forest, fontSize: 14, fontWeight: '800' },
  smallButtonQuiet: { minHeight: 44, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, justifyContent: 'center' },
  smallButtonQuietText: { color: COLORS.inkSoft, fontSize: 14, fontWeight: '700' },
});
