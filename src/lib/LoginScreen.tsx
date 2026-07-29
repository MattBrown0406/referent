import React, { useState } from 'react';
import {
  ActivityIndicator,
  Image,
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

import { supabase } from './supabase';

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  mint: '#DCEAE0',
  mintPale: '#EDF4EF',
  cream: '#F6F4EE',
  white: '#FFFFFF',
  coral: '#D9795F',
  coralPale: '#F7E7E1',
  gray: '#73827D',
  line: '#DDE4DF',
};

type Props = {
  onSignedIn: () => void;
};

export default function LoginScreen({ onSignedIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    if (busy) return;
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    setBusy(false);
    if (authError) {
      setError(authError.message === 'Invalid login credentials'
        ? 'Those credentials did not match. Check the email and password and try again.'
        : authError.message);
      return;
    }
    onSignedIn();
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
          <View style={styles.card}>
            <Image accessibilityLabel="ReferralFit Fit Point logo" source={require('../../assets/icon-fit-point.png')} style={styles.brandMark} />
            <Text style={styles.brandName}>ReferralFit</Text>
            <Text style={styles.tagline}>Sign in to sync your referral network across devices.</Text>

            <Text style={styles.fieldLabel}>EMAIL</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="matt@freedominterventions.com"
              placeholderTextColor="#99A6A1"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="emailAddress"
              style={styles.input}
            />
            <Text style={styles.fieldLabel}>PASSWORD</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Your password"
              placeholderTextColor="#99A6A1"
              secureTextEntry
              autoCapitalize="none"
              textContentType="password"
              onSubmitEditing={signIn}
              style={styles.input}
            />

            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <TouchableOpacity activeOpacity={0.85} onPress={signIn} style={[styles.button, busy && { opacity: 0.7 }]}>
              {busy ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.buttonText}>Sign in</Text>}
            </TouchableOpacity>

            <Text style={styles.footnote}>Single-user workspace. Session stays on this device in secure storage.</Text>
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
  brandMark: { width: 56, height: 56, borderRadius: 18, alignSelf: 'center' },
  brandName: { marginTop: 12, textAlign: 'center', fontSize: 24, fontWeight: '800', color: COLORS.ink, letterSpacing: -0.5 },
  tagline: { marginTop: 6, marginBottom: 22, textAlign: 'center', fontSize: 13, lineHeight: 19, color: COLORS.gray },
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
  errorBox: { backgroundColor: COLORS.coralPale, borderRadius: 12, padding: 12, marginBottom: 12 },
  errorText: { color: COLORS.coral, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  button: { backgroundColor: COLORS.forest, borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  buttonText: { color: COLORS.white, fontSize: 14, fontWeight: '800' },
  footnote: { marginTop: 16, textAlign: 'center', fontSize: 10, lineHeight: 15, color: COLORS.gray },
});
