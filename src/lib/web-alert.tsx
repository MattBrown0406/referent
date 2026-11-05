import { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AlertButton, AlertOptions, AlertType, KeyboardType } from 'react-native';

// React Native Web's Alert.alert does nothing, and the app asks before every
// delete, switch and send through it. On the web, installWebAlert() points
// Alert.alert and Alert.prompt at an in-page dialog that WebAlertHost (mounted
// next to the app in index.ts) shows one at a time, in the order asked.
//
// Same rules as iOS: a dialog closes only through one of its buttons. Escape
// (RN Web routes it to the topmost Modal only) presses the cancel button, or
// dismisses when the alert is cancelable, or presses OK when it is the only
// button. Enter on a focused button presses that button; anywhere else it
// presses the main button, never a destructive one.

type Dialog = {
  id: number;
  title: string;
  message?: string;
  buttons: AlertButton[];
  options?: AlertOptions;
  // Alert.prompt: a text field, its first value, and what gets the text.
  prompt?: { defaultValue: string; secure: boolean; keyboardType?: KeyboardType; onText: (button: AlertButton, text: string) => void };
};

let nextId = 1;
let queue: Dialog[] = [];
const listeners = new Set<(dialogs: Dialog[]) => void>();

function publish(): void {
  for (const listener of listeners) listener(queue);
}

function push(dialog: Omit<Dialog, 'id'>): void {
  queue = [...queue, { ...dialog, id: nextId++ }];
  publish();
}

function close(id: number): void {
  queue = queue.filter((dialog) => dialog.id !== id);
  publish();
}

function webAlert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions): void {
  push({ title, message, buttons: buttons && buttons.length ? buttons : [{ text: 'OK' }], options });
}

type PromptCallback = ((text: string) => void) | AlertButton[];

function webPrompt(
  title: string,
  message?: string,
  callbackOrButtons?: PromptCallback,
  type: AlertType = 'plain-text',
  defaultValue = '',
  keyboardType?: KeyboardType,
): void {
  const buttons: AlertButton[] = Array.isArray(callbackOrButtons)
    ? callbackOrButtons
    : [{ text: 'Cancel', style: 'cancel' }, { text: 'OK' }];
  const onText = (button: AlertButton, text: string) => {
    if (Array.isArray(callbackOrButtons)) {
      (button.onPress as ((value?: string) => void) | undefined)?.(text);
    } else if (button.style !== 'cancel') {
      callbackOrButtons?.(text);
    }
  };
  push({ title, message, buttons, prompt: { defaultValue, secure: type === 'secure-text', keyboardType, onText } });
}

let installed = false;

export function installWebAlert(): void {
  if (Platform.OS !== 'web' || installed) return;
  installed = true;
  Alert.alert = webAlert;
  Alert.prompt = webPrompt as typeof Alert.prompt;
}

// iOS order: with two buttons the cancel one sits first; with three or more
// they stack and the cancel one goes last.
function ordered(buttons: AlertButton[]): AlertButton[] {
  const cancel = buttons.filter((button) => button.style === 'cancel');
  const rest = buttons.filter((button) => button.style !== 'cancel');
  return buttons.length <= 2 ? [...cancel, ...rest] : [...rest, ...cancel];
}

export function WebAlertHost() {
  const [dialogs, setDialogs] = useState<Dialog[]>(queue);
  const [text, setText] = useState('');
  const dialog = dialogs[0];
  const dialogRef = useRef<Dialog | undefined>(dialog);
  dialogRef.current = dialog;
  const textRef = useRef(text);
  textRef.current = text;
  // The dialog a button already closed: a click and a key press arriving
  // together never run its action twice.
  const handledRef = useRef<number | null>(null);

  useEffect(() => {
    listeners.add(setDialogs);
    return () => { listeners.delete(setDialogs); };
  }, []);

  useEffect(() => {
    setText(dialog?.prompt?.defaultValue ?? '');
  }, [dialog?.id]);

  function press(button: AlertButton) {
    const current = dialogRef.current;
    if (!current || handledRef.current === current.id) return;
    handledRef.current = current.id;
    close(current.id);
    if (current.prompt) current.prompt.onText(button, textRef.current);
    else button.onPress?.();
  }

  function escape() {
    const current = dialogRef.current;
    if (!current) return;
    const cancel = current.buttons.find((button) => button.style === 'cancel');
    if (cancel) { press(cancel); return; }
    if (current.options?.cancelable) {
      if (handledRef.current === current.id) return;
      handledRef.current = current.id;
      close(current.id);
      current.options.onDismiss?.();
      return;
    }
    if (current.buttons.length === 1) press(current.buttons[0]);
  }

  function enter() {
    const current = dialogRef.current;
    if (!current) return;
    const main = [...current.buttons].reverse().find((button) => button.style !== 'cancel' && button.style !== 'destructive');
    if (main) press(main);
  }

  useEffect(() => {
    if (!dialog || typeof window === 'undefined') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      const target = event.target as { getAttribute?: (name: string) => string | null } | null;
      if (target?.getAttribute?.('role') === 'button') return; // the focused button presses itself
      event.preventDefault();
      event.stopPropagation();
      enter();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dialog?.id]);

  if (!dialog) return null;
  const buttons = ordered(dialog.buttons);
  const stacked = buttons.length > 2;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={escape}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityRole="alert" aria-modal accessibilityLabel={dialog.title}>
          <Text style={styles.title}>{dialog.title}</Text>
          {dialog.message ? <Text style={styles.message}>{dialog.message}</Text> : null}
          {dialog.prompt ? (
            <TextInput
              autoFocus
              value={text}
              onChangeText={setText}
              secureTextEntry={dialog.prompt.secure}
              keyboardType={dialog.prompt.keyboardType}
              style={styles.input}
              accessibilityLabel={dialog.title}
            />
          ) : null}
          <View style={[styles.buttons, stacked && styles.buttonsStacked]}>
            {buttons.map((button, index) => {
              const main = !stacked && index === buttons.length - 1 && button.style !== 'cancel' && button.style !== 'destructive';
              return (
                <Pressable
                  key={`${button.text ?? 'OK'}-${index}`}
                  onPress={() => press(button)}
                  accessibilityRole="button"
                  style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
                    styles.button,
                    stacked && styles.buttonStacked,
                    main && styles.buttonMain,
                    (hovered || pressed) && (main ? styles.buttonMainHover : styles.buttonHover),
                  ]}
                >
                  <Text style={[
                    styles.buttonText,
                    main && styles.buttonMainText,
                    button.style === 'destructive' && styles.buttonDestructive,
                    button.style === 'cancel' && styles.buttonCancel,
                  ]}>
                    {button.text ?? 'OK'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(22, 53, 46, 0.42)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 22,
    shadowColor: '#16352E',
    shadowOpacity: 0.22,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
  title: { fontSize: 17, fontWeight: '700', color: '#16352E' },
  message: { marginTop: 8, fontSize: 15, lineHeight: 21, color: '#38564F' },
  input: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#DDE4DF',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#16352E',
  },
  buttons: { marginTop: 20, flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
  buttonsStacked: { flexDirection: 'column', alignItems: 'stretch' },
  button: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: '#DDE4DF', alignItems: 'center' },
  buttonStacked: { paddingVertical: 11 },
  buttonHover: { backgroundColor: '#EDF4EF' },
  buttonMain: { backgroundColor: '#1F5A49', borderColor: '#1F5A49' },
  buttonMainHover: { backgroundColor: '#16352E' },
  buttonText: { fontSize: 15, fontWeight: '600', color: '#1F5A49' },
  buttonMainText: { color: '#FFFFFF' },
  buttonDestructive: { color: '#B4472C' },
  buttonCancel: { color: '#38564F', fontWeight: '500' },
});
