import React from 'react';
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card, Chip, ChipRow, NetBadge, PrimaryButton, SectionLabel, TypeBadge } from '../components';
import { colors } from '../theme';
import { useStore } from '../store';
import { Referent } from '../types';

export default function ReferentDetailScreen({
  referent,
  onClose,
  onEdit,
  onLogReferral,
}: {
  referent: Referent;
  onClose: () => void;
  onEdit: () => void;
  onLogReferral: (direction: 'inbound' | 'outbound') => void;
}) {
  const { referrals, referralStats, deleteReferent } = useStore();
  const stats = referralStats(referent.id);
  const history = referrals
    .filter((f) => f.referentId === referent.id)
    .sort((a, b) => b.date.localeCompare(a.date));

  const confirmDelete = () => {
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (window.confirm(`Delete ${referent.name} and their referral history?`)) {
        deleteReferent(referent.id);
        onClose();
      }
    } else {
      Alert.alert('Delete referent', `Delete ${referent.name} and their referral history?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => { deleteReferent(referent.id); onClose(); } },
      ]);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.navBar}>
        <Pressable onPress={onClose}>
          <Text style={styles.navLink}>‹ Back</Text>
        </Pressable>
        <Pressable onPress={onEdit}>
          <Text style={styles.navLink}>Edit</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={styles.name}>{referent.name}</Text>
        {referent.organization ? <Text style={styles.org}>{referent.organization}</Text> : null}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <TypeBadge type={referent.type} />
          <NetBadge net={stats.net} inbound={stats.inbound} />
        </View>

        <Card style={{ marginTop: 16 }}>
          <Text style={styles.meta}>📍 {referent.city}, {referent.state}</Text>
          {referent.phone ? (
            <Pressable onPress={() => Linking.openURL(`tel:${referent.phone}`)}>
              <Text style={[styles.meta, styles.link]}>📞 {referent.phone}</Text>
            </Pressable>
          ) : null}
          {referent.email ? (
            <Pressable onPress={() => Linking.openURL(`mailto:${referent.email}`)}>
              <Text style={[styles.meta, styles.link]}>✉️ {referent.email}</Text>
            </Pressable>
          ) : null}
          {referent.cashPrice != null ? (
            <Text style={styles.meta}>💵 ${referent.cashPrice.toLocaleString()}{referent.priceUnit ?? ''} cash</Text>
          ) : null}
        </Card>

        <SectionLabel>Insurance</SectionLabel>
        {referent.insurance.length > 0 ? (
          <ChipRow>
            {referent.insurance.map((i) => (
              <Chip key={i} label={i} small />
            ))}
          </ChipRow>
        ) : (
          <Text style={styles.dim}>Cash pay only</Text>
        )}

        <SectionLabel>Therapeutic Specialties</SectionLabel>
        {referent.specialties.length > 0 ? (
          <ChipRow>
            {referent.specialties.map((s) => (
              <Chip key={s} label={s} small selected />
            ))}
          </ChipRow>
        ) : (
          <Text style={styles.dim}>None listed</Text>
        )}

        {referent.notes ? (
          <>
            <SectionLabel>Notes</SectionLabel>
            <Card>
              <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>{referent.notes}</Text>
            </Card>
          </>
        ) : null}

        <SectionLabel>Log a Referral</SectionLabel>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <PrimaryButton label="⬇ Inbound (they sent us)" onPress={() => onLogReferral('inbound')} style={{ flex: 1 }} />
          <PrimaryButton label="⬆ Outbound (we sent them)" variant="secondary" onPress={() => onLogReferral('outbound')} style={{ flex: 1 }} />
        </View>

        <SectionLabel>
          Referral History — {stats.inbound} in / {stats.outbound} out
        </SectionLabel>
        {history.length === 0 ? (
          <Text style={styles.dim}>No referrals logged yet.</Text>
        ) : (
          history.map((f) => (
            <Card key={f.id} style={{ paddingVertical: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontWeight: '700', color: f.direction === 'inbound' ? colors.inbound : colors.outbound }}>
                  {f.direction === 'inbound' ? '⬇ Inbound' : '⬆ Outbound'} · {f.clientLabel}
                </Text>
                <Text style={styles.dim}>{new Date(f.date).toLocaleDateString()}</Text>
              </View>
              {f.note ? <Text style={[styles.meta, { marginTop: 4 }]}>{f.note}</Text> : null}
            </Card>
          ))
        )}

        <View style={{ marginTop: 24 }}>
          <PrimaryButton label="Delete Referent" variant="danger" onPress={confirmDelete} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  navBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  navLink: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  name: { fontSize: 24, fontWeight: '800', color: colors.text },
  org: { fontSize: 15, color: colors.subtext, marginTop: 2 },
  meta: { fontSize: 14, color: colors.text, marginVertical: 3 },
  link: { color: colors.accent },
  dim: { color: colors.subtext, fontSize: 13 },
});
