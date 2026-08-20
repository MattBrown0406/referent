import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { colors, typeColors } from './theme';
import { ReferentType } from './types';
import { DropdownSection } from './insurance';

export function TypeBadge({ type, small }: { type: ReferentType; small?: boolean }) {
  const c = typeColors[type];
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }, small && styles.badgeSmall]}>
      <Text style={[styles.badgeText, { color: c.fg }, small && styles.badgeTextSmall]}>{type}</Text>
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  small,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  small?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={[
        styles.chip,
        small && styles.chipSmall,
        selected ? { backgroundColor: colors.chipSelected } : { backgroundColor: colors.chipBg },
      ]}
    >
      <Text
        style={[
          styles.chipText,
          small && styles.chipTextSmall,
          selected ? { color: '#fff', fontWeight: '600' } : { color: '#374151' },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ChipRow({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.chipRow, style]}>{children}</View>;
}

export function NetBadge({ net, inbound }: { net: number; inbound: number }) {
  if (inbound === 0 && net === 0) return null;
  const positive = net > 0;
  const even = net === 0;
  return (
    <View
      style={[
        styles.badge,
        styles.badgeSmall,
        { backgroundColor: positive ? colors.inboundSoft : even ? colors.chipBg : colors.outboundSoft },
      ]}
    >
      <Text
        style={[
          styles.badgeTextSmall,
          { color: positive ? colors.inbound : even ? colors.subtext : colors.outbound, fontWeight: '700' },
        ]}
      >
        {positive ? `Sends business +${net}` : even ? 'Even trade' : `We send more ${net}`}
      </Text>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function PrimaryButton({
  label,
  onPress,
  variant = 'primary',
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  style?: ViewStyle;
}) {
  const bg = variant === 'primary' ? colors.accent : variant === 'danger' ? '#FEE2E2' : colors.chipBg;
  const fg = variant === 'primary' ? '#fff' : variant === 'danger' ? colors.danger : colors.text;
  return (
    <Pressable onPress={onPress} style={[styles.button, { backgroundColor: bg }, style]}>
      <Text style={{ color: fg, fontWeight: '600', fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

export function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <View style={styles.scoreRow}>
      <Text style={styles.scoreLabel}>{label}</Text>
      <View style={styles.scoreTrack}>
        <View style={[styles.scoreFill, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.scoreValue}>
        {value}/{max}
      </Text>
    </View>
  );
}

export function Dropdown({
  value,
  placeholder,
  sections,
  onSelect,
  title,
}: {
  value: string | null;
  placeholder: string;
  sections: DropdownSection[];
  onSelect: (v: string) => void;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable style={styles.ddField} onPress={() => setOpen(true)}>
        <Text style={[styles.ddValue, !value && { color: colors.subtext }]} numberOfLines={1}>
          {value ?? placeholder}
        </Text>
        <Text style={styles.ddChevron}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.ddBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.ddSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.ddTitle}>{title}</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              {sections.map((section, si) => (
                <View key={si}>
                  {section.header ? <Text style={styles.ddHeader}>{section.header}</Text> : null}
                  {section.items.map((item) => (
                    <Pressable
                      key={item}
                      style={[styles.ddOption, value === item && styles.ddOptionSelected]}
                      onPress={() => {
                        onSelect(item);
                        setOpen(false);
                      }}
                    >
                      <Text style={[styles.ddOptionText, value === item && { color: colors.accent, fontWeight: '700' }]}>
                        {item}
                      </Text>
                      {value === item ? <Text style={{ color: colors.accent, fontWeight: '700' }}>✓</Text> : null}
                    </Pressable>
                  ))}
                </View>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export function MultiDropdown({
  values,
  placeholder,
  options,
  onChange,
  title,
}: {
  values: string[];
  placeholder: string;
  options: string[];
  onChange: (v: string[]) => void;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const summary =
    values.length === 0
      ? null
      : values.length <= 2
        ? values.join(', ')
        : `${values.slice(0, 2).join(', ')} +${values.length - 2} more`;
  return (
    <>
      <Pressable style={styles.ddField} onPress={() => setOpen(true)}>
        <Text style={[styles.ddValue, !summary && { color: colors.subtext }]} numberOfLines={1}>
          {summary ?? placeholder}
        </Text>
        <Text style={styles.ddChevron}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.ddBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.ddSheet} onPress={(e) => e.stopPropagation()}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.ddTitle}>{title}</Text>
              <Pressable onPress={() => setOpen(false)}>
                <Text style={{ color: colors.accent, fontWeight: '800', fontSize: 15 }}>Done</Text>
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 420 }}>
              {options.map((item) => {
                const selected = values.includes(item);
                return (
                  <Pressable
                    key={item}
                    style={[styles.ddOption, selected && styles.ddOptionSelected]}
                    onPress={() =>
                      onChange(selected ? values.filter((v) => v !== item) : [...values, item])
                    }
                  >
                    <Text style={[styles.ddOptionText, selected && { color: colors.accent, fontWeight: '700' }]}>
                      {item}
                    </Text>
                    {selected ? <Text style={{ color: colors.accent, fontWeight: '700' }}>✓</Text> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  badgeSmall: { paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 13, fontWeight: '600' },
  badgeTextSmall: { fontSize: 11 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  chipSmall: { paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { fontSize: 14 },
  chipTextSmall: { fontSize: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.subtext,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 16,
  },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 12,
    alignItems: 'center',
  },
  scoreRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  scoreLabel: { width: 92, fontSize: 12, color: colors.subtext },
  scoreTrack: {
    flex: 1,
    height: 6,
    backgroundColor: colors.chipBg,
    borderRadius: 3,
    overflow: 'hidden',
    marginHorizontal: 8,
  },
  scoreFill: { height: 6, backgroundColor: colors.accent, borderRadius: 3 },
  scoreValue: { width: 44, fontSize: 12, color: colors.subtext, textAlign: 'right' },
  ddField: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  ddValue: { fontSize: 15, color: colors.text, flex: 1, paddingRight: 8 },
  ddChevron: { fontSize: 14, color: colors.subtext },
  ddBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    padding: 24,
  },
  ddSheet: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 16,
    maxWidth: 440,
    width: '100%',
    alignSelf: 'center',
  },
  ddTitle: { fontSize: 16, fontWeight: '800', color: colors.text, marginBottom: 8 },
  ddHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.subtext,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 10,
    marginBottom: 4,
  },
  ddOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  ddOptionSelected: { backgroundColor: colors.accentSoft },
  ddOptionText: { fontSize: 15, color: colors.text, flex: 1, paddingRight: 8 },
});
