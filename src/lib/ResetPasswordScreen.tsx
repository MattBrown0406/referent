import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { friendlyAuthError, PASSWORD_REQUIREMENTS, passwordProblem } from './auth-flows';
import { supabase } from './supabase';

// Shown when the app is opened from a password-recovery email link. The link
// already established a session (App.tsx exchanges the tokens), so all that is
// left is to set the new password.

const COLORS = {
  ink: '#16352E',
  forest: '#1F5A49',
  mintPale: '#EDF4EF',
  cream: '#F6F4EE',
  white: '#FFFFFF',
  coral: '#D9795F',
  coralPale: '#F7E7E1',
  gray: '#73827D',
  line: '#DDE4DF',
};

type Props = {
  email: string | null;
  onDone: () => void;
};

export default function ResetPasswordScreen({ email, onDone }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    if (busy) return;
    const problem = passwordProblem(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError(friendlyAuthError(updateError.message, 'signIn'));
      return;
    }
    setPassword('');
    setConfirm('');
    setSaved(true);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
          <View style={styles.card}>
            <Text style={styles.title}>{saved ? 'Password updated' : 'Set a new password'}</Text>
            {saved ? (
              <>
                <Text style={styles.body}>You are signed in{email ? ` as ${email}` : ''}. Use the new password next time you sign in.</Text>
                <TouchableOpacity accessibilityRole="button" activeOpacity={0.85} onPress={onDone} style={styles.button}>
                  <Text style={styles.buttonText}>Continue</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.body}>{email ? `Choose a new password for ${email}.` : 'Choose a new password for your ReferralFit account.'}</Text>

                <Text style={styles.fieldLabel}>NEW PASSWORD</Text>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder={PASSWORD_REQUIREMENTS}
                  placeholderTextColor="#99A6A1"
                  secureTextEntry
                  autoCapitalize="none"
                  textContentType="newPassword"
                  style={styles.input}
                />
                <Text style={styles.fieldLabel}>CONFIRM NEW PASSWORD</Text>
                <TextInput
                  value={confirm}
                  onChangeText={setConfirm}
                  placeholder="Type it again"
                  placeholderTextColor="#99A6A1"
                  secureTextEntry
                  autoCapitalize="none"
                  textContentType="newPassword"
                  onSubmitEditing={save}
                  style={styles.input}
                />
                <Text style={styles.hint}>{PASSWORD_REQUIREMENTS}</Text>

                {error ? (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                ) : null}

                <TouchableOpacity accessibilityRole="button" activeOpacity={0.85} onPress={save} style={[styles.button, busy && { opacity: 0.7 }]}>
                  {busy ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.buttonText}>Save new password</Text>}
                </TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" onPress={onDone} style={styles.linkButton}>
                  <Text style={styles.linkText}>Not now</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.cream },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  card: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 420,
    backgroundColor: COLORS.white,
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: '#E5E8E3',
  },
  title: { textAlign: 'center', fontSize: 22, fontWeight: '800', color: COLORS.ink, letterSpacing: -0.4 },
  body: { marginTop: 8, marginBottom: 18, textAlign: 'center', fontSize: 13, lineHeight: 19, color: COLORS.gray },
  fieldLabel: { color: COLORS.gray, fontSize: 10, fontWeight: '800', letterSpacing: 1.05, marginBottom: 9, marginTop: 5 },
  input: {
    backgroundColor: COLORS.mintPale,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.line,
    paddingHorizontal: 14,
    color: COLORS.ink,
    fontSize: 13,
    marginBottom: 12,
  },
  hint: { fontSize: 11, lineHeight: 16, color: COLORS.gray, marginBottom: 12, marginTop: -4 },
  errorBox: { backgroundColor: COLORS.coralPale, borderRadius: 12, padding: 12, marginBottom: 12 },
  errorText: { color: COLORS.coral, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  button: { backgroundColor: COLORS.forest, borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  buttonText: { color: COLORS.white, fontSize: 14, fontWeight: '800' },
  linkButton: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 8 },
  linkText: { color: COLORS.forest, fontSize: 13, fontWeight: '700' },
});
