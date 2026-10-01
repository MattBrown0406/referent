import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { LEAD_SOURCES } from './business';
import type { LeadUrgency } from './cases';
import { phoneDigits } from './phone';

// "New lead": phone-first, under ten seconds. Caller name and phone are the
// only required fields; everything else is optional and can be added from the
// case file later. Saving creates the case, its primary contact, and the
// first-call follow-up in one server transaction (create_lead).
//
// Language: addiction is a medical disease; families act from love and fear;
// no shame. The 911/988 guidance appears only when the caller said someone
// is in danger right now, never by default.

export type NewLeadDraft = {
  callerName: string;
  phone: string;
  email: string;
  aboutRelationship: string;
  aboutFirstName: string;
  leadSource: string;
  urgency: LeadUrgency;
};

type Props = {
  visible: boolean;
  targetMinutes: number;
  onClose: () => void;
  onSave: (draft: NewLeadDraft) => void;
};

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
  coralInk: '#B0603F',
  coralText: '#7D594B',
  gray: '#73827D',
  line: '#DDE4DF',
};

function emptyDraft(): NewLeadDraft {
  return {
    callerName: '',
    phone: '',
    email: '',
    aboutRelationship: '',
    aboutFirstName: '',
    leadSource: 'Inbound call',
    urgency: 'none',
  };
}

export function validateLeadDraft(draft: NewLeadDraft): string | null {
  if (!draft.callerName.trim()) return 'Add the caller\'s name so the first call has a person on it.';
  const digits = phoneDigits(draft.phone);
  if (digits.length < 10 || digits.length > 15) return 'Add a phone number with the area code. That is the one thing a first call cannot do without.';
  if (draft.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.email.trim())) return 'That email does not look right. It is optional, so you can clear it.';
  return null;
}

export default function NewLeadSheet({ visible, targetMinutes, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<NewLeadDraft>(emptyDraft);
  const phoneRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) setDraft(emptyDraft());
  }, [visible]);

  function patch(changes: Partial<NewLeadDraft>) {
    setDraft((current) => ({ ...current, ...changes }));
  }

  function save() {
    const problem = validateLeadDraft(draft);
    if (problem) {
      Alert.alert('One more thing', problem);
      return;
    }
    onSave({
      callerName: draft.callerName.trim(),
      phone: draft.phone.trim(),
      email: draft.email.trim(),
      aboutRelationship: draft.aboutRelationship.trim(),
      aboutFirstName: draft.aboutFirstName.trim(),
      leadSource: draft.leadSource,
      urgency: draft.urgency,
    });
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.page}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close new lead" onPress={onClose} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle}>New lead</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Save lead" onPress={save} style={styles.headerButton}>
              <Text style={[styles.headerButtonText, styles.headerSave]}>Save</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.intro}>
              Name and number are enough. The first call goes on Today with a {targetMinutes}-minute clock; everything else can wait for the case file.
            </Text>

            <Text style={styles.label}>CALLER *</Text>
            <TextInput
              style={styles.input}
              value={draft.callerName}
              onChangeText={(callerName) => patch({ callerName })}
              placeholder="Who is calling"
              placeholderTextColor="#99A6A1"
              autoFocus
              autoCapitalize="words"
              returnKeyType="next"
              onSubmitEditing={() => phoneRef.current?.focus()}
            />

            <Text style={styles.label}>PHONE *</Text>
            <TextInput
              ref={phoneRef}
              style={styles.input}
              value={draft.phone}
              onChangeText={(phone) => patch({ phone })}
              placeholder="(541) 555-0142"
              placeholderTextColor="#99A6A1"
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
            />

            <Text style={styles.label}>EMAIL (OPTIONAL)</Text>
            <TextInput
              style={styles.input}
              value={draft.email}
              onChangeText={(email) => patch({ email })}
              placeholder="name@email.com"
              placeholderTextColor="#99A6A1"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.label}>CALLING ABOUT</Text>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.flex]}
                value={draft.aboutRelationship}
                onChangeText={(aboutRelationship) => patch({ aboutRelationship })}
                placeholder="son, wife, friend"
                placeholderTextColor="#99A6A1"
                autoCapitalize="none"
              />
              <TextInput
                style={[styles.input, styles.flex]}
                value={draft.aboutFirstName}
                onChangeText={(aboutFirstName) => patch({ aboutFirstName })}
                placeholder="First name"
                placeholderTextColor="#99A6A1"
                autoCapitalize="words"
              />
            </View>
            <Text style={styles.hint}>Relationship and first name only. The full story belongs in the case file.</Text>

            <Text style={styles.label}>LEAD SOURCE</Text>
            <View style={styles.pillRow}>
              {LEAD_SOURCES.map((source) => {
                const selected = draft.leadSource === source;
                return (
                  <TouchableOpacity
                    key={source}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => patch({ leadSource: source })}
                    style={[styles.pill, selected && styles.pillSelected]}
                  >
                    <Text style={[styles.pillText, selected && styles.pillTextSelected]}>{source}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.label}>RIGHT NOW</Text>
            {([
              { value: 'none', title: 'Everyone is safe at the moment', body: 'The family wants to talk about next steps.' },
              { value: 'immediate_danger', title: 'Someone is in danger right now', body: 'The caller described immediate danger or a possible overdose.' },
            ] as { value: LeadUrgency; title: string; body: string }[]).map((choice) => {
              const selected = draft.urgency === choice.value;
              return (
                <TouchableOpacity
                  key={choice.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => patch({ urgency: choice.value })}
                  style={[styles.choice, selected && styles.choiceSelected]}
                >
                  <View style={[styles.radio, selected && styles.radioSelected]} />
                  <View style={styles.flex}>
                    <Text style={styles.choiceTitle}>{choice.title}</Text>
                    <Text style={styles.choiceBody}>{choice.body}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
            {draft.urgency === 'immediate_danger' ? (
              <View style={styles.danger} accessibilityRole="alert">
                <Text style={styles.dangerTitle}>Present danger comes first</Text>
                <Text style={styles.dangerBody}>
                  If someone is in immediate danger or may have overdosed, the family should call 911 now. For a suicidal crisis, call or text 988. This app is not emergency care. Save the lead, then call the family back as soon as the emergency is in hand.
                </Text>
              </View>
            ) : null}

            <TouchableOpacity accessibilityRole="button" onPress={save} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Save lead</Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.cream },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line, backgroundColor: COLORS.white },
  headerTitle: { fontSize: 17, fontWeight: '800', color: COLORS.ink },
  headerButton: { minWidth: 64, minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  headerButtonText: { fontSize: 15, fontWeight: '700', color: COLORS.inkSoft },
  headerSave: { color: COLORS.forest, textAlign: 'right' },
  content: { padding: 18, paddingBottom: 48 },
  intro: { fontSize: 14, lineHeight: 20, color: COLORS.gray, marginBottom: 8 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.gray, marginTop: 16, marginBottom: 6 },
  input: { minHeight: 48, borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, backgroundColor: COLORS.white, paddingHorizontal: 12, paddingVertical: 10, fontSize: 17, color: COLORS.ink },
  row: { flexDirection: 'row', gap: 10 },
  hint: { fontSize: 12, color: COLORS.gray, marginTop: 6 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { minHeight: 40, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, justifyContent: 'center' },
  pillSelected: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  pillText: { fontSize: 13, fontWeight: '700', color: COLORS.inkSoft },
  pillTextSelected: { color: COLORS.white },
  choice: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, marginBottom: 8 },
  choiceSelected: { borderColor: COLORS.forest, backgroundColor: COLORS.mintPale },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: COLORS.line, marginTop: 2 },
  radioSelected: { borderColor: COLORS.forest, backgroundColor: COLORS.forest },
  choiceTitle: { fontSize: 15, fontWeight: '700', color: COLORS.ink },
  choiceBody: { fontSize: 13, color: COLORS.gray, marginTop: 2 },
  danger: { backgroundColor: COLORS.coralPale, borderWidth: 1, borderColor: '#E9C5B8', borderRadius: 12, padding: 12, marginTop: 4 },
  dangerTitle: { fontSize: 13, fontWeight: '800', color: COLORS.coralInk },
  dangerBody: { fontSize: 13, lineHeight: 19, color: COLORS.coralText, marginTop: 4 },
  primaryButton: { minHeight: 52, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', marginTop: 24 },
  primaryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
});
