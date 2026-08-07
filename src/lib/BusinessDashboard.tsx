import React, { useMemo, useState } from 'react';
import {
  Linking,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { formatMoney, type Referral } from '../data';
import type { CaseRecord } from './cases';
import {
  type BusinessData,
  type BusinessPeriod,
  computeBusinessDashboard,
  type CaseIntegration,
} from './business';

type Props = {
  visible: boolean;
  cases: CaseRecord[];
  referrals: Referral[];
  data: BusinessData;
  loading: boolean;
  error?: string;
  onClose: () => void;
  onRefresh: () => void;
  onOpenCase: (caseId: string) => void;
};

const periods: { label: string; value: BusinessPeriod }[] = [
  { label: '30D', value: 30 },
  { label: '90D', value: 90 },
  { label: '1Y', value: 365 },
  { label: 'ALL', value: 'all' },
];

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function localDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function statusLabel(status: string): string {
  return status.replace(/^document\./, '').replaceAll('_', ' ').toLowerCase();
}

function needsAttention(record: CaseIntegration, today: string): boolean {
  const status = record.status.toLowerCase();
  if (record.provider === 'pandadoc') {
    return record.recordType === 'document'
      && !['document.completed', 'document.paid', 'document.declined', 'document.voided', 'completed', 'paid', 'declined', 'voided'].includes(status);
  }
  return record.recordType === 'invoice'
    && !['paid', 'canceled', 'cancelled', 'refunded'].includes(status)
    && Boolean(record.dueOn && record.dueOn <= today);
}

export default function BusinessDashboard({
  visible,
  cases,
  referrals,
  data,
  loading,
  error,
  onClose,
  onRefresh,
  onOpenCase,
}: Props) {
  const [period, setPeriod] = useState<BusinessPeriod>(90);
  const metrics = useMemo(
    () => computeBusinessDashboard(cases, referrals, data, period),
    [cases, referrals, data, period],
  );
  const today = localDateStamp(new Date());
  const attention = data.integrations.filter((record) => needsAttention(record, today));

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close business dashboard" onPress={onClose} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>Close</Text>
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.headerTitle}>Business</Text>
            <Text style={styles.headerSubtitle}>Pipeline, revenue, and follow-through</Text>
          </View>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Refresh business dashboard" onPress={onRefresh} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>{loading ? 'Syncing' : 'Refresh'}</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.periodRow}>
            {periods.map((option) => (
              <TouchableOpacity
                key={String(option.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: period === option.value }}
                onPress={() => setPeriod(option.value)}
                style={[styles.periodButton, period === option.value && styles.periodButtonActive]}
              >
                <Text style={[styles.periodText, period === option.value && styles.periodTextActive]}>{option.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {error ? (
            <View style={styles.warningCard}>
              <Text style={styles.warningTitle}>Live integration data unavailable</Text>
              <Text style={styles.warningBody}>{error} Revenue and case metrics below still use the case data already on this device.</Text>
            </View>
          ) : null}

          <Text style={styles.sectionTitle}>Financial snapshot</Text>
          <Text style={styles.sectionNote}>The period selects cases by open date; dollar figures are their current totals. Linked Square invoices take precedence over manual case totals.</Text>
          <View style={styles.metricGrid}>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>COLLECTED</Text>
              <Text style={styles.metricValue}>{formatMoney(metrics.collectedRevenue)}</Text>
              <Text style={styles.metricDetail}>{metrics.casesCreated} new cases</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>OUTSTANDING</Text>
              <Text style={styles.metricValue}>{formatMoney(metrics.outstandingRevenue)}</Text>
              <Text style={styles.metricDetail}>{metrics.overdueInvoices} overdue invoices</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>QUOTED</Text>
              <Text style={styles.metricValue}>{formatMoney(metrics.quotedRevenue)}</Text>
              <Text style={styles.metricDetail}>{metrics.activeCases} active cases</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>PLACEMENT RATE</Text>
              <Text style={styles.metricValue}>{percent(metrics.placementRate)}</Text>
              <Text style={styles.metricDetail}>{metrics.placedCases} placed · {metrics.lostCases} lost</Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>Case funnel</Text>
          <View style={styles.card}>
            {metrics.funnel.map((step, index) => (
              <View key={step.key} style={[styles.funnelRow, index === metrics.funnel.length - 1 && styles.lastRow]}>
                <View style={styles.funnelCopy}>
                  <Text style={styles.rowTitle}>{step.label}</Text>
                  <Text style={styles.rowDetail}>{step.value} cases · {percent(step.rate)} of inquiries</Text>
                </View>
                <View style={styles.funnelTrack}>
                  <View style={[styles.funnelFill, { width: `${Math.max(step.rate * 100, step.value ? 4 : 0)}%` }]} />
                </View>
              </View>
            ))}
            <View style={styles.funnelFooter}>
              <Text style={styles.funnelFooterText}>
                {metrics.averageDaysToEngaged == null
                  ? 'Time-to-engagement will appear as stage history accumulates.'
                  : `Average inquiry → engaged: ${metrics.averageDaysToEngaged.toFixed(1)} days`}
              </Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>Lead sources</Text>
          <View style={styles.card}>
            {metrics.sources.length ? metrics.sources.map((source, index) => (
              <View key={source.source} style={[styles.sourceRow, index === metrics.sources.length - 1 && styles.lastRow]}>
                <View style={styles.sourceCopy}>
                  <Text style={styles.rowTitle}>{source.source}</Text>
                  <Text style={styles.rowDetail}>{source.cases} cases · {source.placed} placed</Text>
                </View>
                <View style={styles.sourceMoney}>
                  <Text style={styles.sourceCollected}>{formatMoney(source.collected)}</Text>
                  <Text style={styles.sourceQuoted}>{formatMoney(source.quoted)} quoted</Text>
                </View>
              </View>
            )) : (
              <Text style={styles.emptyText}>Add a lead source to new or existing cases to see attribution here.</Text>
            )}
          </View>

          <Text style={styles.sectionTitle}>Referral outcomes</Text>
          <View style={styles.summaryCard}>
            <View style={styles.summaryMetric}>
              <Text style={styles.summaryValue}>{metrics.outboundReferrals}</Text>
              <Text style={styles.summaryLabel}>OUTBOUND</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryMetric}>
              <Text style={styles.summaryValue}>{metrics.outboundPlaced}</Text>
              <Text style={styles.summaryLabel}>PLACED</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryMetric}>
              <Text style={styles.summaryValue}>{percent(metrics.referralPlacementRate)}</Text>
              <Text style={styles.summaryLabel}>SUCCESS</Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>Square + PandaDoc</Text>
          <View style={styles.summaryCard}>
            <View style={styles.summaryMetric}>
              <Text style={styles.summaryValue}>{metrics.pendingContracts}</Text>
              <Text style={styles.summaryLabel}>CONTRACTS OPEN</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryMetric}>
              <Text style={styles.summaryValue}>{metrics.openInvoices}</Text>
              <Text style={styles.summaryLabel}>INVOICES OPEN</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryMetric}>
              <Text style={[styles.summaryValue, metrics.overdueInvoices > 0 && styles.overdueValue]}>{metrics.overdueInvoices}</Text>
              <Text style={styles.summaryLabel}>OVERDUE</Text>
            </View>
          </View>

          {attention.length ? (
            <View style={styles.card}>
              {attention.map((record, index) => {
                const linkedCase = cases.find((item) => item.id === record.caseId);
                return (
                  <TouchableOpacity
                    key={record.id}
                    onPress={() => record.externalUrl ? Linking.openURL(record.externalUrl) : onOpenCase(record.caseId)}
                    style={[styles.attentionRow, index === attention.length - 1 && styles.lastRow]}
                  >
                    <View style={styles.attentionBadge}><Text style={styles.attentionBadgeText}>{record.provider === 'square' ? 'S' : 'P'}</Text></View>
                    <View style={styles.funnelCopy}>
                      <Text style={styles.rowTitle}>{linkedCase?.title || 'Linked case'}</Text>
                      <Text style={styles.rowDetail}>{record.recordType} · {statusLabel(record.status)}{record.dueOn ? ` · due ${record.dueOn}` : ''}</Text>
                    </View>
                    <Text style={styles.openText}>{record.externalUrl ? 'Open' : 'Case'}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : (
            <Text style={styles.emptyFootnote}>No linked contract or invoice currently needs attention.</Text>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F6F4EE' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#DDE4DF', backgroundColor: '#FFFFFF' },
  headerCopy: { flex: 1, alignItems: 'center' },
  headerTitle: { color: '#16352E', fontSize: 17, fontWeight: '800' },
  headerSubtitle: { color: '#73827D', fontSize: 9, marginTop: 2 },
  headerButton: { minWidth: 58, minHeight: 44, justifyContent: 'center' },
  headerButtonText: { color: '#1F5A49', fontSize: 12, fontWeight: '800' },
  content: { padding: 16, paddingBottom: 40 },
  periodRow: { flexDirection: 'row', backgroundColor: '#E9EFE6', borderRadius: 13, padding: 3, marginBottom: 14 },
  periodButton: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  periodButtonActive: { backgroundColor: '#1F5A49' },
  periodText: { color: '#38564F', fontSize: 11, fontWeight: '800' },
  periodTextActive: { color: '#FFFFFF' },
  warningCard: { backgroundColor: '#F7E7E1', borderWidth: 1, borderColor: '#E9C5B8', borderRadius: 14, padding: 13, marginBottom: 14 },
  warningTitle: { color: '#B0603F', fontSize: 12, fontWeight: '800' },
  warningBody: { color: '#7D594B', fontSize: 10, lineHeight: 15, marginTop: 4 },
  sectionTitle: { color: '#16352E', fontSize: 14, fontWeight: '800', marginTop: 8, marginBottom: 9 },
  sectionNote: { color: '#73827D', fontSize: 9, lineHeight: 14, marginTop: -4, marginBottom: 9 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 8 },
  metricCard: { width: '48%', flexGrow: 1, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDE4DF', borderRadius: 15, padding: 13 },
  metricLabel: { color: '#73827D', fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },
  metricValue: { color: '#1F5A49', fontSize: 20, fontWeight: '900', marginTop: 5 },
  metricDetail: { color: '#73827D', fontSize: 9, marginTop: 5 },
  card: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDE4DF', borderRadius: 15, paddingHorizontal: 13, marginBottom: 12 },
  funnelRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  funnelCopy: { flex: 1 },
  rowTitle: { color: '#16352E', fontSize: 12, fontWeight: '800' },
  rowDetail: { color: '#73827D', fontSize: 9, marginTop: 3 },
  funnelTrack: { height: 7, backgroundColor: '#E9EFE6', borderRadius: 6, overflow: 'hidden', marginTop: 8 },
  funnelFill: { height: 7, backgroundColor: '#507C86', borderRadius: 6 },
  funnelFooter: { paddingVertical: 11 },
  funnelFooterText: { color: '#73827D', fontSize: 9, fontStyle: 'italic' },
  sourceRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  sourceCopy: { flex: 1 },
  sourceMoney: { alignItems: 'flex-end' },
  sourceCollected: { color: '#1F5A49', fontSize: 12, fontWeight: '800' },
  sourceQuoted: { color: '#73827D', fontSize: 8, marginTop: 2 },
  lastRow: { borderBottomWidth: 0 },
  emptyText: { color: '#73827D', fontSize: 10, lineHeight: 15, paddingVertical: 15 },
  summaryCard: { flexDirection: 'row', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDE4DF', borderRadius: 15, paddingVertical: 14, marginBottom: 12 },
  summaryMetric: { flex: 1, alignItems: 'center' },
  summaryValue: { color: '#1F5A49', fontSize: 19, fontWeight: '900' },
  summaryLabel: { color: '#73827D', fontSize: 7, fontWeight: '900', letterSpacing: 0.4, marginTop: 4 },
  summaryDivider: { width: 1, backgroundColor: '#DDE4DF' },
  overdueValue: { color: '#D9795F' },
  attentionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  attentionBadge: { width: 30, height: 30, borderRadius: 10, backgroundColor: '#DCEAE0', alignItems: 'center', justifyContent: 'center' },
  attentionBadgeText: { color: '#1F5A49', fontSize: 12, fontWeight: '900' },
  openText: { color: '#507C86', fontSize: 10, fontWeight: '800' },
  emptyFootnote: { color: '#73827D', fontSize: 9, fontStyle: 'italic', marginBottom: 12 },
});
