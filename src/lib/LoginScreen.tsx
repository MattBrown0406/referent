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

import {
  type AuthMode,
  EMAIL_CONFIRM_REDIRECT,
  friendlyAuthError,
  isPlausibleEmail,
  normalizeEmail,
  PASSWORD_RECOVERY_REDIRECT,
  PASSWORD_REQUIREMENTS,
  passwordProblem,
} from './auth-flows';
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

// A "notice" replaces the form after an email has been sent, so the user
// knows exactly what to do next instead of staring at the same fields.
type Notice =
  | { kind: 'confirmEmail'; email: string }
  | { kind: 'resetSent'; email: string };

const TAGLINES: Record<AuthMode, string> = {
  signIn: 'Sign in to sync your referral network across devices.',
  signUp: 'Create a free workspace for your practice. It takes about a minute.',
  forgot: 'Enter your email and we will send a link to set a new password.',
};

export default function LoginScreen({ onSignedIn }: Props) {
  const [mode, setMode] = useState<AuthMode>('signIn');
  const [practiceName, setPracticeName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  function switchMode(next: AuthMode) {
    setMode(next);
    setError(null);
    setInfo(null);
    setNotice(null);
    setPassword('');
    setConfirmPassword('');
  }

  async function signIn() {
    if (busy) return;
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: normalizeEmail(email),
      password,
    });
    setBusy(false);
    if (authError) {
      setError(friendlyAuthError(authError.message, 'signIn'));
      return;
    }
    onSignedIn();
  }

  async function signUp() {
    if (busy) return;
    const practice = practiceName.trim();
    const name = displayName.trim();
    if (!practice) {
      setError('Enter your practice or organization name.');
      return;
    }
    if (!name) {
      setError('Enter your name.');
      return;
    }
    if (!isPlausibleEmail(email)) {
      setError('Enter a valid email address.');
      return;
    }
    const problem = passwordProblem(password, confirmPassword);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const normalizedEmail = normalizeEmail(email);
    // handle_new_user() (supabase/migrations/20260929174333_self_serve_accounts.sql)
    // reads practice_name and display_name from raw_user_meta_data to create the
    // workspace and the owner membership.
    const { data, error: authError } = await supabase.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        data: { practice_name: practice, display_name: name },
        emailRedirectTo: EMAIL_CONFIRM_REDIRECT,
      },
    });
    setBusy(false);
    if (authError) {
      setError(friendlyAuthError(authError.message, 'signUp'));
      return;
    }
    if (data.session) {
      // Email confirmation is off: the account is live immediately.
      onSignedIn();
      return;
    }
    // With email confirmation on, Supabase returns a user with no identities
    // when the address is already registered (to avoid leaking membership).
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      setError(friendlyAuthError('User already registered', 'signUp'));
      return;
    }
    setPassword('');
    setConfirmPassword('');
    setNotice({ kind: 'confirmEmail', email: normalizedEmail });
  }

  async function resendConfirmation(target: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    const { error: resendError } = await supabase.auth.resend({
      type: 'signup',
      email: target,
      options: { emailRedirectTo: EMAIL_CONFIRM_REDIRECT },
    });
    setBusy(false);
    if (resendError) {
      setError(friendlyAuthError(resendError.message, 'signUp'));
      return;
    }
    setInfo(`Confirmation email sent again to ${target}.`);
  }

  async function sendReset() {
    if (busy) return;
    if (!isPlausibleEmail(email)) {
      setError('Enter the email address for your account.');
      return;
    }
    setBusy(true);
    setError(null);
    const normalizedEmail = normalizeEmail(email);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: PASSWORD_RECOVERY_REDIRECT,
    });
    setBusy(false);
    if (resetError) {
      setError(friendlyAuthError(resetError.message, 'forgot'));
      return;
    }
    setNotice({ kind: 'resetSent', email: normalizedEmail });
  }

  function renderNotice(current: Notice) {
    const isConfirm = current.kind === 'confirmEmail';
    return (
      <>
        <Text style={styles.noticeTitle}>{isConfirm ? 'Check your email' : 'Reset link sent'}</Text>
        <Text style={styles.noticeBody}>
          {isConfirm
            ? `We sent a confirmation link to ${current.email}. Open it on this device to finish creating your account, then sign in.`
            : `If an account exists for ${current.email}, a link to set a new password is on its way. Open it on this device to continue.`}
        </Text>
        {info ? <Text style={styles.infoText}>{info}</Text> : null}
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
        {isConfirm ? (
          <TouchableOpacity accessibilityRole="button" activeOpacity={0.85} onPress={() => resendConfirmation(current.email)} style={[styles.secondaryButton, busy && { opacity: 0.7 }]}>
            {busy ? <ActivityIndicator color={COLORS.forest} /> : <Text style={styles.secondaryButtonText}>Resend confirmation email</Text>}
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity accessibilityRole="button" activeOpacity={0.85} onPress={() => switchMode('signIn')} style={styles.button}>
          <Text style={styles.buttonText}>Back to sign in</Text>
        </TouchableOpacity>
      </>
    );
  }

  function renderForm() {
    const submit = mode === 'signIn' ? signIn : mode === 'signUp' ? signUp : sendReset;
    const submitLabel = mode === 'signIn' ? 'Sign in' : mode === 'signUp' ? 'Create account' : 'Send reset link';
    return (
      <>
        {mode !== 'forgot' ? (
          <View style={styles.segment} accessibilityRole="tablist">
            <TouchableOpacity
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === 'signIn' }}
              onPress={() => switchMode('signIn')}
              style={[styles.segmentButton, mode === 'signIn' && styles.segmentButtonActive]}
            >
              <Text style={[styles.segmentText, mode === 'signIn' && styles.segmentTextActive]}>Sign in</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === 'signUp' }}
              onPress={() => switchMode('signUp')}
              style={[styles.segmentButton, mode === 'signUp' && styles.segmentButtonActive]}
            >
              <Text style={[styles.segmentText, mode === 'signUp' && styles.segmentTextActive]}>Create account</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {mode === 'signUp' ? (
          <>
            <Text style={styles.fieldLabel}>PRACTICE OR ORGANIZATION</Text>
            <TextInput
              value={practiceName}
              onChangeText={setPracticeName}
              placeholder="Riverbend Interventions"
              placeholderTextColor="#99A6A1"
              autoCapitalize="words"
              textContentType="organizationName"
              maxLength={120}
              style={styles.input}
            />
            <Text style={styles.fieldLabel}>YOUR NAME</Text>
            <TextInput
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="Your name"
              placeholderTextColor="#99A6A1"
              autoCapitalize="words"
              textContentType="name"
              maxLength={80}
              style={styles.input}
            />
          </>
        ) : null}

        <Text style={styles.fieldLabel}>EMAIL</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="you@yourpractice.com"
          placeholderTextColor="#99A6A1"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="emailAddress"
          onSubmitEditing={mode === 'forgot' ? sendReset : undefined}
          style={styles.input}
        />

        {mode !== 'forgot' ? (
          <>
            <Text style={styles.fieldLabel}>PASSWORD</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder={mode === 'signUp' ? PASSWORD_REQUIREMENTS : 'Your password'}
              placeholderTextColor="#99A6A1"
              secureTextEntry
              autoCapitalize="none"
              textContentType={mode === 'signUp' ? 'newPassword' : 'password'}
              onSubmitEditing={mode === 'signIn' ? signIn : undefined}
              style={styles.input}
            />
          </>
        ) : null}

        {mode === 'signUp' ? (
          <>
            <Text style={styles.fieldLabel}>CONFIRM PASSWORD</Text>
            <TextInput
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="Type it again"
              placeholderTextColor="#99A6A1"
              secureTextEntry
              autoCapitalize="none"
              textContentType="newPassword"
              onSubmitEditing={signUp}
              style={styles.input}
            />
            <Text style={styles.hint}>{PASSWORD_REQUIREMENTS}</Text>
          </>
        ) : null}

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <TouchableOpacity accessibilityRole="button" activeOpacity={0.85} onPress={submit} style={[styles.button, busy && { opacity: 0.7 }]}>
          {busy ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.buttonText}>{submitLabel}</Text>}
        </TouchableOpacity>

        {mode === 'signIn' ? (
          <TouchableOpacity accessibilityRole="button" onPress={() => switchMode('forgot')} style={styles.linkButton}>
            <Text style={styles.linkText}>Forgot password?</Text>
          </TouchableOpacity>
        ) : null}
        {mode === 'forgot' ? (
          <TouchableOpacity accessibilityRole="button" onPress={() => switchMode('signIn')} style={styles.linkButton}>
            <Text style={styles.linkText}>Back to sign in</Text>
          </TouchableOpacity>
        ) : null}
      </>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
          <View style={styles.card}>
            <Image accessibilityLabel="ReferralFit partner network logo" source={require('../../assets/icon-referent-symbiosis.png')} style={styles.brandMark} />
            <Text style={styles.brandName}>ReferralFit</Text>
            <Text style={styles.tagline}>{notice ? ' ' : TAGLINES[mode]}</Text>

            {notice ? renderNotice(notice) : renderForm()}

            <Text style={styles.footnote}>Free for your practice. Create an account in a minute. Your practice's data is private to your workspace — other practices can never see it. Your session stays on this device in secure storage.</Text>
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
  tagline: { marginTop: 6, marginBottom: 18, textAlign: 'center', fontSize: 13, lineHeight: 19, color: COLORS.gray },
  segment: { flexDirection: 'row', backgroundColor: COLORS.mintPale, borderRadius: 14, padding: 4, marginBottom: 16 },
  segmentButton: { flex: 1, minHeight: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  segmentButtonActive: { backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line },
  segmentText: { fontSize: 13, fontWeight: '700', color: COLORS.gray },
  segmentTextActive: { color: COLORS.ink },
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
  infoText: { color: COLORS.forest, fontSize: 12, lineHeight: 17, fontWeight: '600', textAlign: 'center', marginBottom: 12 },
  button: { backgroundColor: COLORS.forest, borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  buttonText: { color: COLORS.white, fontSize: 14, fontWeight: '800' },
  secondaryButton: { backgroundColor: COLORS.mint, borderRadius: 16, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  secondaryButtonText: { color: COLORS.forest, fontSize: 13, fontWeight: '800' },
  linkButton: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 8 },
  linkText: { color: COLORS.forest, fontSize: 13, fontWeight: '700' },
  noticeTitle: { textAlign: 'center', fontSize: 18, fontWeight: '800', color: COLORS.ink, marginBottom: 8 },
  noticeBody: { textAlign: 'center', fontSize: 13, lineHeight: 19, color: COLORS.inkSoft, marginBottom: 16 },
  footnote: { marginTop: 16, textAlign: 'center', fontSize: 10, lineHeight: 15, color: COLORS.gray },
});
