import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { fetchBenchmarks, type BenchmarkReport } from './benchmarks';

// Rendered inside the Business dashboard. Self-fetching so the dashboard's
// existing data flow stays untouched; the server enforces the entitlement,
// this component only decides between the data view and the teaser.

type Props = {
  visible: boolean;
  entitled: boolean;
};

const COLORS = {
  ink: '#101828',
  gray: '#667085',
  line: '#EAECF0',
  card: '#FFFFFF',
  blue: '#175CD3',
  blueSoft: '#EFF4FF',
  green: '#067647',
  coral: '#D92D20',
};

function percentLabel(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function starsLabel(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} / 5`;
}

function moneyLabel(value: number | null): string {
  return value === null ? '—' : `$${value.toLocaleString()}`;
}

export default function BenchmarksPanel({ visible, entitled }: Props) {
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !entitled) return;
    let active = true;
    setLoading(true);
    setError('');
    fetchBenchmarks()
      .then((next) => { if (active) setReport(next); })
      .catch((fetchError) => { if (active) setError((fetchError as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [visible, entitled]);

  if (!entitled) {
    return (
      <View style={styles.teaser}>
        <Text style={styles.teaserTitle}>How do you compare?</Text>
        <Text style={styles.teaserBody}>
          Benchmarks put your admit rate, family experience, placement rate, and pricing next
          to anonymized medians from practices across the ReferralFit network. Part of the
          Benchmarks plan.
        </Text>
      </View>
    );
  }
  if (loading && !report) {
    return <View style={styles.centered}><ActivityIndicator color={COLORS.blue} /></View>;
  }
  if (error) {
    return <View style={styles.teaser}><Text style={styles.errorText}>{error}</Text></View>;
  }
  if (!report) return null;

  const rows: { label: string; mine: string; network: string }[] = [
    { label: 'Admit rate', mine: percentLabel(report.workspace.admitRate), network: percentLabel(report.network.admitRate) },
    { label: 'Family experience', mine: starsLabel(report.workspace.familyExperience), network: starsLabel(report.network.familyExperience) },
    { label: 'Placement rate', mine: percentLabel(report.workspace.placementRate), network: percentLabel(report.network.placementRate) },
    { label: 'Median quote', mine: moneyLabel(report.workspace.medianQuote), network: moneyLabel(report.network.medianQuote) },
  ];
  const anyNetwork = rows.some((row) => row.network !== '—');

  return (
    <View style={styles.card}>
      <View style={styles.tableHeader}>
        <Text style={[styles.headerCell, styles.labelCell]} />
        <Text style={styles.headerCell}>You</Text>
        <Text style={styles.headerCell}>Network</Text>
      </View>
      {rows.map((row, index) => (
        <View key={row.label} style={[styles.row, index === rows.length - 1 && styles.lastRow]}>
          <Text style={[styles.cellLabel, styles.labelCell]}>{row.label}</Text>
          <Text style={styles.cellMine}>{row.mine}</Text>
          <Text style={styles.cellNetwork}>{row.network}</Text>
        </View>
      ))}
      <Text style={styles.footnote}>
        {anyNetwork
          ? 'Network values are medians across participating practices; nothing identifiable is shared.'
          : `Network medians unlock once at least ${report.network.contributorFloor} practices contribute enough activity — your data stays anonymous either way.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.line,
    padding: 16,
  },
  centered: { paddingVertical: 24, alignItems: 'center' },
  tableHeader: { flexDirection: 'row', paddingBottom: 8 },
  headerCell: { flex: 1, fontSize: 12, fontWeight: '700', color: COLORS.gray, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'right' },
  labelCell: { flex: 1.4, textAlign: 'left' },
  row: { flexDirection: 'row', paddingVertical: 10, borderTopWidth: 1, borderTopColor: COLORS.line },
  lastRow: {},
  cellLabel: { flex: 1.4, fontSize: 14.5, color: COLORS.ink, fontWeight: '600' },
  cellMine: { flex: 1, fontSize: 14.5, color: COLORS.blue, fontWeight: '700', textAlign: 'right' },
  cellNetwork: { flex: 1, fontSize: 14.5, color: COLORS.green, fontWeight: '700', textAlign: 'right' },
  footnote: { fontSize: 12.5, color: COLORS.gray, lineHeight: 18, paddingTop: 10 },
  teaser: {
    backgroundColor: COLORS.blueSoft,
    borderRadius: 12,
    padding: 16,
    gap: 6,
  },
  teaserTitle: { fontSize: 15, fontWeight: '700', color: COLORS.ink },
  teaserBody: { fontSize: 13.5, color: COLORS.gray, lineHeight: 19 },
  errorText: { fontSize: 14, color: COLORS.coral },
});
