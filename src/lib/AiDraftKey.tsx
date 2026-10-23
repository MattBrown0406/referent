import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

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

const CONSOLE_KEYS_URL = 'https://console.anthropic.com/settings/keys';

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
  'the case stage and how many times you have reached out',
  'anything you type in “Anything to mention?”',
];

export function AiKeyDisclosure() {
  return (
    <View>
      <Text style={styles.body}>
        ReferralFit is free, so AI drafts run on your own Anthropic account using your API key. Anthropic bills you directly, usually a few cents per draft.
      </Text>
      <Text style={styles.body}>For each draft, ReferralFit sends Anthropic only:</Text>
      {SHARED_WITH_ANTHROPIC.map((line) => <Text key={line} style={styles.bullet}>•  {line}</Text>)}
      <Text style={styles.body}>
        Never phone numbers, email addresses, case notes, documents, or your client’s name. Anthropic does not train its models on API data. Your key stays in this phone’s keychain; ReferralFit’s server passes it to Anthropic with each draft and never stores it.
      </Text>
      <Text style={styles.body}>
        If your practice needs a business associate agreement for this, set it up with Anthropic on your own account.
      </Text>
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

  if (!aiKeysSupported) {
    return <Text style={styles.body}>AI drafts use your phone’s keychain, so they are set up in the iPhone app.</Text>;
  }

  async function save() {
    if (busy) return;
    const apiKey = normalizeAnthropicKey(value);
    if (!looksLikeAnthropicKey(apiKey)) {
      setProblem('That does not look like an Anthropic API key. It starts with sk-ant-.');
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      await verifyAnthropicKey(apiKey);
      await saveAnthropicKey(userId, apiKey);
      setValue('');
      onSaved(apiKey);
    } catch (error) {
      setProblem(error instanceof DraftUnavailableError ? error.message : 'The key could not be saved on this phone. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View>
      <AiKeyDisclosure />
      <TouchableOpacity accessibilityRole="link" onPress={() => { Linking.openURL(CONSOLE_KEYS_URL).catch(() => undefined); }} style={styles.linkButton}>
        <Text style={styles.linkText}>Create a key in the Anthropic Console ↗</Text>
      </TouchableOpacity>
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
        <TouchableOpacity accessibilityRole="button" onPress={onCancel} style={styles.textButton}>
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
  linkButton: { minHeight: 44, justifyContent: 'center', marginTop: 8 },
  linkText: { fontSize: 15, fontWeight: '700', color: COLORS.forest },
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
