import React, { type ReactNode, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type KeyboardTypeOptions,
  type TextInputProps,
} from 'react-native';

export const COLORS = {
  ink: '#16352E', inkSoft: '#38564F', forest: '#1F5A49', sage: '#9EB7A2',
  mint: '#DCEAE0', mintPale: '#EDF4EF', cream: '#F6F4EE', white: '#FFFFFF',
  coral: '#D9795F', coralPale: '#F7E7E1', gold: '#D7AD58', gray: '#73827D', line: '#DDE4DF',
};

export interface Choice { label: string; value: string; detail?: string }

export function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return <View style={styles.section}>
    <View style={styles.sectionHead}><View style={styles.grow}><Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>{subtitle ? <Text style={styles.muted}>{subtitle}</Text> : null}</View>{action}</View>
    {children}
  </View>;
}

export function Card({ children, tone = 'white' }: { children: ReactNode; tone?: 'white' | 'mint' | 'coral' }) {
  return <View style={[styles.card, tone === 'mint' && styles.cardMint, tone === 'coral' && styles.cardCoral]}>{children}</View>;
}

export function Field({ label, value, onChangeText, error, multiline, placeholder, keyboardType, autoCapitalize, accessibilityLabel }: {
  label: string; value: string; onChangeText: (text: string) => void; error?: string; multiline?: boolean;
  placeholder?: string; keyboardType?: KeyboardTypeOptions; autoCapitalize?: TextInputProps['autoCapitalize']; accessibilityLabel?: string;
}) {
  return <View style={styles.fieldWrap}>
    <Text style={styles.label}>{label}</Text>
    <TextInput
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={error}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={COLORS.gray}
      multiline={multiline}
      keyboardType={keyboardType}
      autoCapitalize={autoCapitalize}
      style={[styles.input, multiline && styles.multiline, Boolean(error) && styles.inputError]}
    />
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

export function ChoiceField({ label, value, options, onChange, allowEmpty = false, emptyLabel = 'None' }: {
  label: string; value?: string; options: readonly Choice[]; onChange: (value: string) => void; allowEmpty?: boolean; emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const all = allowEmpty ? [{ label: emptyLabel, value: '' }, ...options] : [...options];
  const selected = all.find((choice) => choice.value === (value ?? ''));
  return <View style={styles.fieldWrap}>
    <Text style={styles.label}>{label}</Text>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${label}: ${selected?.label ?? 'Select'}`} onPress={() => setOpen(true)} style={styles.selectButton}>
      <Text numberOfLines={1} style={styles.selectText}>{selected?.label ?? 'Select'}</Text><Text aria-hidden style={styles.chevron}>⌄</Text>
    </TouchableOpacity>
    <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Close ${label}`} style={styles.overlay} onPress={() => setOpen(false)}>
        <Pressable accessibilityRole="none" style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.sheetHead}><Text accessibilityRole="header" style={styles.sheetTitle}>{label}</Text><TouchableOpacity accessibilityRole="button" accessibilityLabel={`Close ${label}`} onPress={() => setOpen(false)}><Text style={styles.close}>Close</Text></TouchableOpacity></View>
          <ScrollView style={styles.sheetScroll}>{all.map((choice) => {
            const active = choice.value === (value ?? '');
            return <TouchableOpacity key={choice.value || '__empty'} accessibilityRole="radio" accessibilityState={{ checked: active }} onPress={() => { onChange(choice.value); setOpen(false); }} style={[styles.choice, active && styles.choiceActive]}>
              <View style={styles.grow}><Text style={[styles.choiceText, active && styles.choiceTextActive]}>{choice.label}</Text>{choice.detail ? <Text style={styles.muted}>{choice.detail}</Text> : null}</View><Text style={styles.check}>{active ? '●' : '○'}</Text>
            </TouchableOpacity>;
          })}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  </View>;
}

export function Button({ label, onPress, tone = 'primary', disabled = false, selected }: {
  label: string; onPress: () => void; tone?: 'primary' | 'secondary' | 'danger' | 'quiet'; disabled?: boolean; selected?: boolean;
}) {
  return <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress} style={[styles.button, styles[`button_${tone}`], disabled && styles.disabled, selected && styles.selected]}>
    <Text style={[styles.buttonText, tone !== 'primary' && styles.buttonTextDark, tone === 'danger' && styles.buttonTextDanger, selected && styles.buttonTextSelected]}>{label}</Text>
  </TouchableOpacity>;
}

export function Empty({ children }: { children: ReactNode }) { return <Text style={styles.empty}>{children}</Text>; }
export function Row({ children }: { children: ReactNode }) { return <View style={styles.row}>{children}</View>; }
export function Badge({ children, tone = 'mint' }: { children: ReactNode; tone?: 'mint' | 'coral' | 'gold' }) { return <View style={[styles.badge, tone === 'coral' && styles.badgeCoral, tone === 'gold' && styles.badgeGold]}><Text style={styles.badgeText}>{children}</Text></View>; }
export function Divider() { return <View style={styles.divider} />; }

export const styles = StyleSheet.create({
  grow: { flex: 1 },
  section: { gap: 12, marginBottom: 22 },
  sectionHead: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  sectionTitle: { color: COLORS.ink, fontSize: 21, fontWeight: '800' },
  muted: { color: COLORS.gray, fontSize: 13, lineHeight: 19 },
  card: { backgroundColor: COLORS.white, borderColor: COLORS.line, borderRadius: 18, borderWidth: 1, gap: 10, padding: 16 },
  cardMint: { backgroundColor: COLORS.mintPale },
  cardCoral: { backgroundColor: COLORS.coralPale },
  fieldWrap: { gap: 6, marginBottom: 11 },
  label: { color: COLORS.inkSoft, fontSize: 12, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  input: { backgroundColor: COLORS.white, borderColor: COLORS.line, borderRadius: 12, borderWidth: 1, color: COLORS.ink, fontSize: 16, minHeight: 48, paddingHorizontal: 13, paddingVertical: 10 },
  multiline: { minHeight: 100, textAlignVertical: 'top' },
  inputError: { borderColor: COLORS.coral },
  error: { color: '#A33E2B', fontSize: 12, fontWeight: '600' },
  selectButton: { alignItems: 'center', backgroundColor: COLORS.white, borderColor: COLORS.line, borderRadius: 12, borderWidth: 1, flexDirection: 'row', minHeight: 48, paddingHorizontal: 13 },
  selectText: { color: COLORS.ink, flex: 1, fontSize: 16 },
  chevron: { color: COLORS.gray, fontSize: 22 },
  overlay: { backgroundColor: 'rgba(22,53,46,0.42)', flex: 1, justifyContent: 'flex-end' },
  sheet: { backgroundColor: COLORS.cream, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '72%', padding: 18 },
  sheetHead: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  sheetTitle: { color: COLORS.ink, fontSize: 20, fontWeight: '800' },
  close: { color: COLORS.forest, fontSize: 15, fontWeight: '700', padding: 8 },
  sheetScroll: { flexGrow: 0 },
  choice: { alignItems: 'center', borderBottomColor: COLORS.line, borderBottomWidth: 1, flexDirection: 'row', gap: 8, minHeight: 54, padding: 10 },
  choiceActive: { backgroundColor: COLORS.mint },
  choiceText: { color: COLORS.ink, fontSize: 16, fontWeight: '600' },
  choiceTextActive: { color: COLORS.forest },
  check: { color: COLORS.forest, fontSize: 18 },
  button: { alignItems: 'center', borderRadius: 999, justifyContent: 'center', minHeight: 42, paddingHorizontal: 16, paddingVertical: 9 },
  button_primary: { backgroundColor: COLORS.forest },
  button_secondary: { backgroundColor: COLORS.mint, borderColor: COLORS.sage, borderWidth: 1 },
  button_danger: { backgroundColor: COLORS.coralPale, borderColor: COLORS.coral, borderWidth: 1 },
  button_quiet: { backgroundColor: 'transparent', borderColor: COLORS.line, borderWidth: 1 },
  buttonText: { color: COLORS.white, fontSize: 14, fontWeight: '800' },
  buttonTextDark: { color: COLORS.ink },
  buttonTextDanger: { color: '#8C3524' },
  selected: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  buttonTextSelected: { color: COLORS.white },
  disabled: { opacity: 0.45 },
  empty: { color: COLORS.gray, fontSize: 14, fontStyle: 'italic', paddingVertical: 8 },
  row: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  badge: { alignSelf: 'flex-start', backgroundColor: COLORS.mint, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  badgeCoral: { backgroundColor: COLORS.coralPale },
  badgeGold: { backgroundColor: '#F4E8CA' },
  badgeText: { color: COLORS.inkSoft, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  divider: { backgroundColor: COLORS.line, height: 1, marginVertical: 5 },
});
