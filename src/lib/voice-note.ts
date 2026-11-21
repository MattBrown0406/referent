// Voice note in Review notes: the practitioner talks, iOS's speech
// recognizer (expo-speech-recognition) types it into the notes box as they
// speak, and they edit it and tap Find as for pasted notes. On the phone when
// the iPhone can (requiresOnDeviceRecognition); otherwise Apple's speech
// service turns the sound into text, and the sheet says so. The sound itself
// is never saved. iPhone only: the web app hides the button (and its pages
// turn the microphone off). Only on a build that has the native module: a JS
// update reaching an older build never touches it. docs/DAY_REVIEW.md.
import { requireOptionalNativeModule } from 'expo';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Platform } from 'react-native';
import type {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionOptions,
  ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition';
import type { ExpoSpeechRecognitionModuleType } from 'expo-speech-recognition/build/ExpoSpeechRecognitionModule.types';

import { REVIEW_TEXT_MAX } from './share-intake';

type SpeechNative = Pick<ExpoSpeechRecognitionModuleType,
  'start' | 'stop' | 'abort' | 'requestPermissionsAsync' | 'isRecognitionAvailable' | 'supportsOnDeviceRecognition'>
  & { addListener(event: string, listener: (payload: never) => void): { remove(): void } };

function speechModule(): SpeechNative | null {
  if (Platform.OS !== 'ios') return null;
  try {
    return requireOptionalNativeModule<SpeechNative>('ExpoSpeechRecognition');
  } catch {
    return null;
  }
}

const native = speechModule();

/** This build can take a voice note (iPhone, with the speech module in it). */
export const voiceNotesSupported = Boolean(native);

// iOS ends a recognition session on its own now and then (a pause, a time
// limit when Apple's servers do the work). The note goes on in a new session,
// up to this many times, and stops after this long in all.
const MAX_RESTARTS = 40;
const MAX_NOTE_MS = 30 * 60_000;
// Stop asked for, but iOS never said it ended: give up waiting.
const STOP_GRACE_MS = 3_000;
// Words that are often misheard in this work (a hint to the recognizer only).
const CONTEXT_WORDS = ['ReferralFit', 'Fieldy', 'Plaud', 'interventionist', 'intervention', 'detox', 'IOP', 'PHP', 'sober living', 'residential', 'Medicaid', 'Aetna', 'Cigna', 'BlueCross'];

/** Final pieces and the piece still being heard, joined into one note (pure). */
export function joinSpoken(...parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(' ');
}

export type VoiceState = 'idle' | 'asking' | 'listening' | 'stopping';

export type VoiceNoteHandlers = {
  /** Everything heard in this note so far (it replaces the last call's text). */
  onText: (spoken: string) => void;
  /** A line for the sheet's message area. */
  onNotice: (text: string, ok: boolean) => void;
};

type Session = {
  committed: string;
  interim: string;
  // The last final piece: iOS 18 can send the same piece again as it ends.
  lastFinal: string;
  room: number;
  userStopped: boolean;
  noRestart: boolean;
  restarts: number;
  startedAt: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
  // Why it stopped without Stop being tapped, said once it has ended.
  endNotice: { text: string; ok: boolean } | null;
};

export function useVoiceNote({ onText, onNotice }: VoiceNoteHandlers) {
  const [state, setState] = useState<VoiceState>('idle');
  // Checked once: whether this iPhone turns speech into text on the phone.
  const [onDevice] = useState(() => {
    try {
      return native?.supportsOnDeviceRecognition() ?? false;
    } catch {
      return false;
    }
  });
  const sessionRef = useRef<Session | null>(null);
  const handlersRef = useRef({ onText, onNotice });
  handlersRef.current = { onText, onNotice };

  const startSession = useCallback(() => {
    if (!native) return;
    const options: ExpoSpeechRecognitionOptions = {
      lang: 'en-US',
      interimResults: true,
      continuous: true,
      maxAlternatives: 1,
      addsPunctuation: true,
      requiresOnDeviceRecognition: onDevice,
      iosTaskHint: 'dictation',
      contextualStrings: CONTEXT_WORDS,
    };
    native.start(options);
  }, [onDevice]);

  const finishSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.stopTimer) clearTimeout(session.stopTimer);
    const text = joinSpoken(session.committed, session.interim);
    sessionRef.current = null;
    setState('idle');
    handlersRef.current.onText(text);
    if (session.endNotice) handlersRef.current.onNotice(session.endNotice.text, session.endNotice.ok);
    else if (!text) handlersRef.current.onNotice('No words were heard. Tap Voice note and speak, or type your notes.', false);
  }, []);

  /** Stop listening: what was heard stays in the box. */
  const stop = useCallback((notice?: { text: string; ok: boolean }) => {
    const session = sessionRef.current;
    if (!native || !session) return;
    session.userStopped = true;
    if (notice && !session.endNotice) session.endNotice = notice;
    setState('stopping');
    try {
      native.stop();
    } catch {
      finishSession();
      return;
    }
    if (session.stopTimer) clearTimeout(session.stopTimer);
    session.stopTimer = setTimeout(() => {
      try { native.abort(); } catch { /* already ended */ }
      finishSession();
    }, STOP_GRACE_MS);
  }, [finishSession]);

  /** Stop at once, throwing away nothing already in the box (the sheet is closing). */
  const cancel = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.stopTimer) clearTimeout(session.stopTimer);
    sessionRef.current = null;
    setState('idle');
    try { native?.abort(); } catch { /* already ended */ }
  }, []);

  useEffect(() => {
    if (!native) return undefined;
    const subscriptions = [
      native.addListener('start', (() => {
        if (sessionRef.current && !sessionRef.current.userStopped) setState('listening');
      }) as (payload: never) => void),
      native.addListener('result', ((event: ExpoSpeechRecognitionResultEvent) => {
        const session = sessionRef.current;
        if (!session) return;
        const heard = event.results?.[0]?.transcript ?? '';
        // A final piece is kept; the next pieces are new words after it.
        if (event.isFinal) {
          const piece = heard.trim();
          if (piece && !(piece === session.lastFinal && !session.interim)) session.committed = joinSpoken(session.committed, piece);
          if (piece) session.lastFinal = piece;
          session.interim = '';
        } else {
          session.interim = heard;
        }
        const text = joinSpoken(session.committed, session.interim);
        handlersRef.current.onText(text);
        if (text.length >= session.room && !session.userStopped) {
          stop({ text: `The voice note stopped: the box holds the most one review reads (${REVIEW_TEXT_MAX.toLocaleString('en-US')} characters). Review it, then record the rest.`, ok: false });
        }
      }) as (payload: never) => void),
      native.addListener('error', ((event: ExpoSpeechRecognitionErrorEvent) => {
        const session = sessionRef.current;
        if (!session) return;
        const code = event?.error;
        if (code === 'aborted') return;
        session.noRestart = true;
        const keep = 'What was heard is in the box.';
        session.endNotice = session.endNotice ?? (
          code === 'no-speech'
            ? (joinSpoken(session.committed, session.interim) ? { text: `The voice note stopped after a long pause. ${keep} Tap Voice note to add more.`, ok: true } : null)
            : code === 'interrupted'
              ? { text: `The voice note stopped for a call, Siri or an alarm. ${keep} Tap Voice note to go on.`, ok: false }
              : code === 'not-allowed'
                ? { text: 'ReferralFit is not allowed to use the microphone or speech recognition. Turn both on in Settings > Apps > ReferralFit.', ok: false }
                : code === 'network'
                  ? { text: `The voice note needs a connection on this iPhone and lost it. ${keep}`, ok: false }
                  : code === 'language-not-supported' || code === 'service-not-allowed'
                    ? { text: 'Voice notes are not available on this iPhone right now. Check that Dictation is on in Settings > General > Keyboard.', ok: false }
                    : { text: `The voice note stopped. ${keep}`, ok: false }
        );
      }) as (payload: never) => void),
      native.addListener('end', (() => {
        const session = sessionRef.current;
        if (!session) return;
        const tooLong = Date.now() - session.startedAt > MAX_NOTE_MS || session.restarts >= MAX_RESTARTS;
        if (session.userStopped || session.noRestart || tooLong || AppState.currentState !== 'active') {
          if (tooLong && !session.userStopped && !session.endNotice) {
            session.endNotice = { text: 'The voice note stopped after a long time. What was heard is in the box. Tap Voice note to add more.', ok: true };
          }
          finishSession();
          return;
        }
        // iOS ended the session on its own: go on in a new one, after a
        // moment for the last one to let go of the microphone.
        session.committed = joinSpoken(session.committed, session.interim);
        session.interim = '';
        session.lastFinal = '';
        session.restarts += 1;
        setTimeout(() => {
          if (sessionRef.current !== session || session.userStopped) return;
          try {
            startSession();
          } catch {
            finishSession();
          }
        }, 200);
      }) as (payload: never) => void),
    ];
    // Leaving the app ends the note (iOS stops the microphone anyway).
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'background' && sessionRef.current && !sessionRef.current.userStopped) {
        stop({ text: 'The voice note stopped when you left ReferralFit. What was heard is in the box. Tap Voice note to go on.', ok: true });
      }
    });
    return () => {
      subscriptions.forEach((subscription) => subscription.remove());
      appState.remove();
      if (sessionRef.current) {
        if (sessionRef.current.stopTimer) clearTimeout(sessionRef.current.stopTimer);
        sessionRef.current = null;
        try { native.abort(); } catch { /* already ended */ }
      }
    };
  }, [finishSession, startSession, stop]);

  /**
   * Start listening. `room` is how many characters the box can still take
   * for this note (the review reads at most REVIEW_TEXT_MAX).
   */
  const start = useCallback(async (room: number) => {
    if (!native || sessionRef.current || state !== 'idle') return;
    if (room < 40) {
      handlersRef.current.onNotice(`The box already holds the most one review reads (${REVIEW_TEXT_MAX.toLocaleString('en-US')} characters). Review these notes first.`, false);
      return;
    }
    setState('asking');
    let permission;
    try {
      permission = await native.requestPermissionsAsync();
    } catch {
      permission = null;
    }
    if (!permission?.granted) {
      setState('idle');
      Alert.alert(
        'Turn on the microphone for voice notes',
        'ReferralFit needs the microphone and speech recognition to type your voice note. Turn both on in Settings > Apps > ReferralFit. You can still paste or type your notes.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open Settings', onPress: () => { void Linking.openSettings().catch(() => undefined); } },
        ],
      );
      return;
    }
    let available = false;
    try { available = native.isRecognitionAvailable(); } catch { available = false; }
    if (!available) {
      setState('idle');
      handlersRef.current.onNotice('Voice notes are not available on this iPhone right now. Check that Dictation is on in Settings > General > Keyboard, and that you are online, then try again.', false);
      return;
    }
    sessionRef.current = {
      committed: '', interim: '', lastFinal: '', room, userStopped: false, noRestart: false, restarts: 0, startedAt: Date.now(), stopTimer: null, endNotice: null,
    };
    try {
      startSession();
      setState('listening');
    } catch {
      sessionRef.current = null;
      setState('idle');
      handlersRef.current.onNotice('The voice note could not start. Try again, or type your notes.', false);
    }
  }, [startSession, state]);

  return { supported: voiceNotesSupported, onDevice, state, start, stop: () => stop(), cancel };
}
