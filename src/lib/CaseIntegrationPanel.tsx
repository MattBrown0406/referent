import React, { useMemo, useState } from 'react';
import {
  Alert,
  Linking,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { formatMoney } from '../data';
import type { CaseRecord } from './cases';
import {
  type CaseIntegration,
  deleteCaseIntegration,
  type IntegrationProvider,
  type IntegrationRecordType,
  saveCaseIntegration,
} from './business';

type Props = {
  record: CaseRecord;
  integrations: CaseIntegration[];
  onChanged: () => void;
};

type FormState = {
  provider: IntegrationProvider;
  recordType: IntegrationRecordType;
  externalId: string;
  status: string;
  amount: string;
  dueOn: string;
  externalUrl: string;
};

const emptyForm: FormState = {
  provider: 'pandadoc',
  recordType: 'document',
  externalId: '',
  status: 'linked',
  amount: '',
  dueOn: '',
  externalUrl: '',
};

function friendlyStatus(status: string): string {
  return status.replace(/^document\./, '').replaceAll('_', ' ').toLowerCase();
}

function integrationTitle(item: CaseIntegration): string {
  if (item.provider === 'pandadoc') return item.recordType === 'document' ? 'PandaDoc contract' : `PandaDoc ${item.recordType}`;
  return item.recordType === 'invoice' ? 'Square invoice' : `Square ${item.recordType}`;
}

export default function CaseIntegrationPanel({ record, integrations, onChanged }: Props) {
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const caseIntegrations = useMemo(
    () => integrations.filter((item) => item.caseId === record.id),
    [integrations, record.id],
  );

  async function saveLink() {
    if (!form?.externalId.trim()) {
      Alert.alert('External ID required', 'Paste the document, invoice, payment, refund, or customer ID from Square or PandaDoc.');
      return;
    }
    if (form.externalUrl.trim() && !/^https:\/\//i.test(form.externalUrl.trim())) {
      Alert.alert('Invalid record URL', 'Use the full HTTPS link from Square or PandaDoc, or leave it blank.');
      return;
    }
    const dollars = Number(form.amount.replace(/[^\d.]/g, ''));
    if (form.amount.trim() && (!Number.isFinite(dollars) || dollars < 0)) {
      Alert.alert('Invalid amount', 'Enter a positive dollar amount or leave it blank.');
      return;
    }
    setSaving(true);
    try {
      await saveCaseIntegration({
        caseId: record.id,
        provider: form.provider,
        recordType: form.recordType,
        externalId: form.externalId,
        status: form.status,
        amountCents: form.amount.trim() ? Math.round(dollars * 100) : null,
        currency: 'USD',
        dueOn: form.dueOn.trim() || undefined,
        completedAt: undefined,
        externalUrl: form.externalUrl.trim(),
      });
      setForm(null);
      onChanged();
    } catch (error) {
      Alert.alert('Could not link record', (error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function removeLink(item: CaseIntegration) {
    Alert.alert('Unlink external record?', `${integrationTitle(item)} will remain in ${item.provider === 'square' ? 'Square' : 'PandaDoc'}, but Referent will stop tracking it.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unlink',
        style: 'destructive',
        onPress: () => {
          deleteCaseIntegration(item.id)
            .then(onChanged)
            .catch((error) => Alert.alert('Could not unlink record', (error as Error).message));
        },
      },
    ]);
  }

  return (
    <>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Contracts & payments</Text>
          <Text style={styles.hint}>PandaDoc and Square stay authoritative; Referent tracks status and next action.</Text>
        </View>
        <TouchableOpacity accessibilityRole="button" onPress={() => setForm(emptyForm)} style={styles.addButton}>
          <Text style={styles.addButtonText}>+ Link</Text>
        </TouchableOpacity>
      </View>

      {caseIntegrations.length ? (
        <View style={styles.card}>
          {caseIntegrations.map((item, index) => (
            <View key={item.id} style={[styles.row, index === caseIntegrations.length - 1 && styles.lastRow]}>
              <TouchableOpacity
                accessibilityRole="button"
                disabled={!item.externalUrl}
                onPress={() => item.externalUrl && Linking.openURL(item.externalUrl)}
                style={styles.rowBody}
              >
                <View style={[styles.providerBadge, item.provider === 'square' ? styles.squareBadge : styles.pandaBadge]}>
                  <Text style={styles.providerBadgeText}>{item.provider === 'square' ? 'S' : 'P'}</Text>
                </View>
                <View style={styles.rowCopy}>
                  <Text style={styles.rowTitle}>{integrationTitle(item)}</Text>
                  <Text style={styles.rowMeta}>
                    {friendlyStatus(item.status)}
                    {item.amountCents != null ? ` · ${formatMoney(item.amountCents / 100)}` : ''}
                    {item.dueOn ? ` · due ${item.dueOn}` : ''}
                  </Text>
                  <Text numberOfLines={1} style={styles.externalId}>{item.externalId}</Text>
                </View>
                {item.externalUrl ? <Text style={styles.openText}>Open</Text> : null}
              </TouchableOpacity>
              <TouchableOpacity accessibilityLabel={`Unlink ${integrationTitle(item)}`} onPress={() => removeLink(item)} style={styles.removeButton}>
                <Text style={styles.removeText}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.empty}>Link the existing PandaDoc document or Square invoice once. Signed and payment status can then update automatically through webhooks.</Text>
      )}

      {form ? (
        <View style={styles.formCard}>
          <View style={styles.formHeader}>
            <Text style={styles.formTitle}>Link external record</Text>
            <TouchableOpacity accessibilityRole="button" onPress={() => setForm(null)} style={styles.cancelButton}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.formContent}>
              <Text style={styles.formIntro}>Copy the record ID and optional URL from Square or PandaDoc. No card data or signature content is stored here.</Text>
              <Text style={styles.label}>PROVIDER</Text>
              <View style={styles.segmentRow}>
                {(['pandadoc', 'square'] as IntegrationProvider[]).map((provider) => (
                  <TouchableOpacity
                    key={provider}
                    onPress={() => setForm((current) => current ? {
                      ...current,
                      provider,
                      recordType: provider === 'pandadoc' ? 'document' : 'invoice',
                    } : current)}
                    style={[styles.segment, form.provider === provider && styles.segmentActive]}
                  >
                    <Text style={[styles.segmentText, form.provider === provider && styles.segmentTextActive]}>{provider === 'pandadoc' ? 'PandaDoc' : 'Square'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.label}>RECORD TYPE</Text>
              <View style={styles.segmentRow}>
                {(form.provider === 'pandadoc' ? ['document'] : ['invoice', 'payment', 'refund', 'customer']).map((recordType) => (
                  <TouchableOpacity
                    key={recordType}
                    onPress={() => setForm((current) => current ? { ...current, recordType: recordType as IntegrationRecordType } : current)}
                    style={[styles.segment, form.recordType === recordType && styles.segmentActive]}
                  >
                    <Text style={[styles.segmentText, form.recordType === recordType && styles.segmentTextActive]}>{recordType}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.label}>EXTERNAL ID *</Text>
              <TextInput value={form.externalId} onChangeText={(externalId) => setForm((current) => current ? { ...current, externalId } : current)} placeholder="Document or invoice ID" placeholderTextColor="#91A09B" autoCapitalize="none" style={styles.input} />
              <Text style={styles.label}>CURRENT STATUS</Text>
              <TextInput value={form.status} onChangeText={(status) => setForm((current) => current ? { ...current, status } : current)} placeholder="sent, completed, unpaid…" placeholderTextColor="#91A09B" autoCapitalize="none" style={styles.input} />
              {form.provider === 'square' ? (
                <>
                  <Text style={styles.label}>AMOUNT (OPTIONAL)</Text>
                  <TextInput value={form.amount} onChangeText={(amount) => setForm((current) => current ? { ...current, amount } : current)} placeholder="1500.00" placeholderTextColor="#91A09B" keyboardType="decimal-pad" style={styles.input} />
                  <Text style={styles.label}>DUE DATE (OPTIONAL)</Text>
                  <TextInput value={form.dueOn} onChangeText={(dueOn) => setForm((current) => current ? { ...current, dueOn } : current)} placeholder="YYYY-MM-DD" placeholderTextColor="#91A09B" autoCapitalize="none" style={styles.input} />
                </>
              ) : null}
              <Text style={styles.label}>RECORD URL (OPTIONAL)</Text>
              <TextInput value={form.externalUrl} onChangeText={(externalUrl) => setForm((current) => current ? { ...current, externalUrl } : current)} placeholder="https://…" placeholderTextColor="#91A09B" keyboardType="url" autoCapitalize="none" style={styles.input} />
              <TouchableOpacity onPress={saveLink} disabled={saving} style={styles.primaryButton}><Text style={styles.primaryButtonText}>{saving ? 'Linking…' : 'Link record'}</Text></TouchableOpacity>
          </View>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 17, marginBottom: 9 },
  headerCopy: { flex: 1, paddingRight: 10 },
  title: { color: '#16352E', fontSize: 14, fontWeight: '800' },
  hint: { color: '#73827D', fontSize: 9, lineHeight: 13, marginTop: 3 },
  addButton: { minHeight: 36, paddingHorizontal: 11, borderRadius: 10, backgroundColor: '#DCEAE0', justifyContent: 'center' },
  addButtonText: { color: '#1F5A49', fontSize: 10, fontWeight: '800' },
  card: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDE4DF', borderRadius: 15, paddingHorizontal: 12 },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  lastRow: { borderBottomWidth: 0 },
  rowBody: { flex: 1, minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  providerBadge: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  squareBadge: { backgroundColor: '#E2EBEE' },
  pandaBadge: { backgroundColor: '#DCEAE0' },
  providerBadgeText: { color: '#1F5A49', fontSize: 13, fontWeight: '900' },
  rowCopy: { flex: 1 },
  rowTitle: { color: '#16352E', fontSize: 11, fontWeight: '800' },
  rowMeta: { color: '#73827D', fontSize: 9, marginTop: 3 },
  externalId: { color: '#91A09B', fontSize: 8, marginTop: 3 },
  openText: { color: '#507C86', fontSize: 9, fontWeight: '800' },
  removeButton: { width: 36, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  removeText: { color: '#D9795F', fontSize: 21 },
  empty: { color: '#73827D', fontSize: 9, lineHeight: 14, fontStyle: 'italic', marginBottom: 4 },
  formCard: { marginTop: 12, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDE4DF', borderRadius: 15, overflow: 'hidden' },
  formHeader: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#EDF0ED', paddingHorizontal: 14, paddingVertical: 10 },
  formTitle: { flex: 1, color: '#16352E', fontSize: 13, fontWeight: '800' },
  cancelButton: { minHeight: 40, justifyContent: 'center', paddingLeft: 12 },
  cancelButtonText: { color: '#1F5A49', fontSize: 11, fontWeight: '800' },
  formContent: { padding: 14, paddingBottom: 18 },
  formIntro: { color: '#73827D', fontSize: 10, lineHeight: 16, marginBottom: 18 },
  label: { color: '#73827D', fontSize: 8, fontWeight: '900', letterSpacing: 0.5, marginBottom: 6, marginTop: 10 },
  input: { minHeight: 46, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDE4DF', borderRadius: 12, color: '#16352E', paddingHorizontal: 12, fontSize: 12 },
  segmentRow: { flexDirection: 'row', gap: 7, flexWrap: 'wrap' },
  segment: { minHeight: 40, minWidth: 88, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 11, borderWidth: 1, borderColor: '#DDE4DF', backgroundColor: '#FFFFFF' },
  segmentActive: { backgroundColor: '#1F5A49', borderColor: '#1F5A49' },
  segmentText: { color: '#38564F', fontSize: 10, fontWeight: '800', textTransform: 'capitalize' },
  segmentTextActive: { color: '#FFFFFF' },
  primaryButton: { minHeight: 50, marginTop: 22, borderRadius: 13, backgroundColor: '#1F5A49', alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
});
