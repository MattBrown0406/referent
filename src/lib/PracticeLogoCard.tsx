// The practice's logo (Workspace and settings), shown to families on the
// assessment page and in its email (docs/FAMILY_ASSESSMENT.md). The owner
// adds or removes it; it is public, like a logo on a website.
import { decode } from 'base64-arraybuffer';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { readAsBase64 } from './cases';
import { LOGO_TYPES, logoPublicUrl, removePracticeLogo, uploadPracticeLogo } from './family-assessment-api';
import { supabase } from './supabase';

type Props = { orgId: string; isOwner: boolean };

export default function PracticeLogoCard({ orgId, isOwner }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('orgs').select('logo_path').maybeSingle();
    // Before the assessment migration the column does not exist (42703): no card.
    if (error) { setAvailable(false); return; }
    setAvailable(true);
    setPath(typeof data?.logo_path === 'string' ? data.logo_path : null);
  }, []);

  useEffect(() => { void load(); }, [load, orgId]);

  async function pick() {
    if (busy) return;
    setMessage('');
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9, allowsMultipleSelection: false });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const type = asset.mimeType && LOGO_TYPES[asset.mimeType] ? asset.mimeType : '';
    if (!type) { setMessage('Choose a PNG, JPEG or WebP image.'); return; }
    setBusy(true);
    try {
      const bytes = decode(await readAsBase64(asset.uri));
      setPath(await uploadPracticeLogo(orgId, bytes, type, path));
      setMessage('Saved. Families see it on the assessment and its email.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The logo could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await removePracticeLogo(path);
      setPath(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The logo could not be removed.');
    } finally {
      setBusy(false);
    }
  }

  if (!available) return null;
  const url = logoPublicUrl(path);
  return (
    <View style={styles.card}>
      <Text style={styles.label}>Practice logo</Text>
      <Text style={styles.help}>Shown to families on the family assessment and in its email, next to your practice’s name. PNG, JPEG or WebP, up to 1 MB.</Text>
      {url ? <Image source={{ uri: url }} style={styles.logo} resizeMode="contain" accessibilityLabel="Your practice logo" /> : null}
      {busy ? <ActivityIndicator color="#1F5A49" accessibilityLabel="Saving the logo" /> : null}
      {isOwner ? (
        <View style={styles.row}>
          <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => { void pick(); }} style={styles.button}>
            <Text style={styles.buttonText}>{url ? 'Change logo' : 'Add logo'}</Text>
          </TouchableOpacity>
          {url ? (
            <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => { void remove(); }} style={styles.ghost}>
              <Text style={styles.ghostText}>Remove</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : <Text style={styles.help}>The practice owner can change it.</Text>}
      {message ? <Text style={styles.message} accessibilityLiveRegion="polite">{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#DDE4DF', padding: 16, marginBottom: 14, gap: 8 },
  label: { fontSize: 12, fontWeight: '800', letterSpacing: 0.6, color: '#55645F', textTransform: 'uppercase' },
  help: { fontSize: 13, lineHeight: 19, color: '#55645F' },
  logo: { width: '100%', height: 72, alignSelf: 'flex-start' },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  button: { minHeight: 40, paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#1F5A49', alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  ghost: { minHeight: 40, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: '#DDE4DF', alignItems: 'center', justifyContent: 'center' },
  ghostText: { color: '#38564F', fontSize: 14, fontWeight: '700' },
  message: { fontSize: 13, color: '#1F5A49', fontWeight: '600' },
});
