import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { Partner } from '../data';
import { fetchGlobalDirectory, publishPartnerProgram, type GlobalPartner } from './directory';
import { potentialProgramMatch, publicProgramDraft, type PublicProgramDraft } from './program-sharing';

type Props = { partner: Partner; userId: string; orgId: string; onCancel: () => void; onPublished: (partner: Partner, created: boolean) => void };

export default function ShareProgramPanel({ partner, userId, orgId, onCancel, onPublished }: Props) {
  const [draft, setDraft] = useState(() => publicProgramDraft(partner));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [listings, setListings] = useState<GlobalPartner[] | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setError(''); setListings(null);
    fetchGlobalDirectory().then((rows) => { if (active) setListings(rows); })
      .catch((e) => { if (active) setError(`Could not check existing programs: ${e.message}`); });
    return () => { active = false; };
  }, [userId, orgId, loadVersion]);
  const candidates = (listings || []).filter((listing) => potentialProgramMatch(draft, listing));

  async function publish(existingGlobalId?: string) {
    if (busy || !confirmed || listings === null) return;
    setBusy(true); setError('');
    try {
      const result = await publishPartnerProgram(partner.id, draft, userId, orgId, existingGlobalId);
      if (alive.current) onPublished(result.partner, result.created);
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  const field = (key: 'organization' | 'city' | 'state' | 'phone' | 'email' | 'website', label: string, placeholder: string) => (
    <View key={key} style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput accessibilityLabel={label} editable={!busy} value={draft[key]} placeholder={placeholder}
        autoCapitalize={key === 'state' ? 'characters' : ['email','website'].includes(key) ? 'none' : 'words'}
        keyboardType={key === 'email' ? 'email-address' : key === 'phone' ? 'phone-pad' : key === 'website' ? 'url' : 'default'}
        maxLength={key === 'state' ? 2 : 500} style={s.input}
        onChangeText={(value) => { setDraft((old: PublicProgramDraft) => ({ ...old, [key]: value })); setConfirmed(false); }} />
    </View>
  );
  return (
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <TouchableOpacity accessibilityRole="button" onPress={onCancel} disabled={busy}><Text style={s.link}>Back to private partner details</Text></TouchableOpacity>
      <Text style={s.title}>Share a public program</Text>
      <Text style={s.body}>Other practices will see only the program details below. Your directory remains separate. This does not share your private contact person, rates, relationship notes, referrals, revenue, clients, or cases.</Text>
      {field('organization', 'Public program / campus name', 'Use the specific program and campus name')}
      {field('city', 'Program city', 'City')}{field('state', 'Program state', 'OR')}
      {field('phone', 'Public admissions phone (optional)', 'Enter a public program phone')}
      {field('email', 'Public admissions email (optional)', 'Enter a public program email')}
      {field('website', 'Public program website (optional)', 'https://example.com')}
      <View style={s.notice}>
        <Text style={s.label}>Also shared from this program</Text>
        {([['Provider types', draft.types], ['Insurance', draft.insurance], ['Specialties', draft.therapies], ['Populations', draft.populations], ['Levels', draft.levels], ['Regions', draft.regions]] as [string, string[]][]).map(([label, values]) => <Text key={label} style={s.body}>{label}: {values.join(' · ') || 'Not listed'}</Text>)}
        <Text style={s.body}>Insurance network status: {Object.entries(draft.insurance_networks).map(([plan, networks]) => `${plan}: ${networks?.join(', ')}`).join(' · ') || 'Not listed'}</Text>
        <Text style={s.body}>Pricing and private notes are never copied. New community listings are marked unverified.</Text>
      </View>
      {listings === null && !error ? <ActivityIndicator accessibilityLabel="Checking for existing programs" /> : null}
      {candidates.length ? <View style={s.notice}>
        <Text style={s.label}>This program may already be listed</Text>
        <Text style={s.body}>Choose the existing listing when it is the same program. Its public details will not be overwritten.</Text>
        {candidates.slice(0, 5).map((listing) => <TouchableOpacity key={listing.id} accessibilityRole="button" disabled={busy || !confirmed} onPress={() => publish(listing.id)} style={[s.button, (!confirmed || busy) && s.disabled]}><Text style={s.buttonText}>Use {listing.organization} · {listing.city}, {listing.state}</Text></TouchableOpacity>)}
      </View> : null}
      <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: confirmed }} disabled={busy} onPress={() => setConfirmed((v) => !v)} style={s.notice}>
        <Text style={s.label}>{confirmed ? '☑' : '☐'} I have reviewed these public details</Text>
        <Text style={s.body}>I am authorized to share this information, and it contains no private practice or client information.</Text>
      </TouchableOpacity>
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {listings === null && error ? <TouchableOpacity accessibilityRole="button" onPress={() => setLoadVersion((n) => n + 1)}><Text style={s.link}>Retry program check</Text></TouchableOpacity> : null}
      <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy || !confirmed || listings === null, busy }} disabled={busy || !confirmed || listings === null} onPress={() => publish()} style={[s.button, (busy || !confirmed || listings === null) && s.disabled]}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>{candidates.length ? 'Publish or reuse matching program' : 'Publish program to global directory'}</Text>}
      </TouchableOpacity>
      <Text style={s.body}>Exact program name and location matches reuse an existing listing. Use a distinct campus name for a different location. Public edits later require directory administration; editing your private partner never changes the global listing.</Text>
    </ScrollView>
  );
}
const s = StyleSheet.create({
  content: { padding: 20, gap: 16, paddingBottom: 40 }, title: { fontSize: 24, fontWeight: '800', color: '#16352E' },
  body: { fontSize: 13, lineHeight: 20, color: '#38564F' }, label: { fontSize: 14, fontWeight: '700', color: '#16352E' },
  link: { color: '#1F5A49', fontWeight: '700', paddingVertical: 8 }, field: { gap: 6 },
  input: { borderWidth: 1, borderColor: '#DDE4DF', borderRadius: 10, padding: 12, backgroundColor: '#fff', color: '#16352E' },
  notice: { padding: 14, borderRadius: 12, backgroundColor: '#EDF4EF', gap: 8 },
  button: { backgroundColor: '#1F5A49', padding: 14, borderRadius: 12, alignItems: 'center' },
  buttonText: { fontSize: 14, fontWeight: '700', color: '#fff', textAlign: 'center' }, disabled: { opacity: 0.45 }, error: { color: '#AF3428', lineHeight: 20 },
});
