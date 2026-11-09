import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import { currentAuthSessionIdentity } from './auth-session';
import { friendlyStoreError, StoreError } from './errors';
import {
  contactFromPicker,
  contactsFromFile,
  MAX_IMPORT_FILE_BYTES,
  type ImportRow,
  type RawContact,
} from './partner-import';
import { supabase } from './supabase';

// ─── Partners from contacts and files (docs/PARTNER_IMPORT.md) ─────────────
// iPhone: iOS's own contact picker (expo-contacts' presentContactPickerAsync,
// CNContactPickerViewController). It runs outside the app and hands back
// only the contact picked, so the app never asks for the address book and
// never sees the rest of it. Web: a .csv or .vcf file read in the browser.
// The chosen rows go to import_partners (migration 20261108180000).

type PickerModule = { presentContactPickerAsync: () => Promise<unknown> };

let pickerModule: PickerModule | null | undefined;

function contactsModule(): PickerModule | null {
  if (pickerModule !== undefined) return pickerModule;
  try {
    // A build without the native module (an older binary) shows no Contacts option.
    pickerModule = Platform.OS === 'ios' && requireOptionalNativeModule('ExpoContacts')
      ? (require('expo-contacts/legacy') as PickerModule)
      : null;
  } catch {
    pickerModule = null;
  }
  return pickerModule;
}

/** The iPhone's contact picker is in this build. */
export function deviceContactsAvailable(): boolean {
  return contactsModule() !== null;
}

/** A file can be chosen (the web app). */
export function contactFilesAvailable(): boolean {
  return Platform.OS === 'web' && typeof document !== 'undefined';
}

/** One contact picked in iOS's picker, or null when cancelled. */
export async function pickDeviceContact(): Promise<RawContact | null> {
  const module = contactsModule();
  if (!module) throw new StoreError('Contacts are not available in this version of the app.', false);
  try {
    return contactFromPicker((await module.presentContactPickerAsync()) as Parameters<typeof contactFromPicker>[0]);
  } catch (error) {
    throw new StoreError((error as Error)?.message || 'The contact picker could not open.', false);
  }
}

export type PickedFile = { contacts: RawContact[]; fileName: string } | { problem: string } | null;

/**
 * A .csv or .vcf chosen on the web, read in the browser. Must be called
 * inside the tap (browsers open a file chooser only then): nothing is
 * awaited before the chooser opens. Null when the chooser is closed (in a
 * browser without the 'cancel' event it simply never settles; the sheet does
 * not wait on it).
 */
export function pickContactsFile(): Promise<PickedFile> {
  return new Promise((resolve) => {
    if (!contactFilesAvailable()) { resolve(null); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.vcf,text/csv,text/vcard,text/x-vcard';
    input.style.display = 'none';
    let settled = false;
    const done = (value: PickedFile) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('cancel', () => done(null));
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { done(null); return; }
      if (file.size > MAX_IMPORT_FILE_BYTES) { done({ problem: 'That file is larger than 5 MB. Export only the contacts you want, then try again.' }); return; }
      file.arrayBuffer()
        .then((bytes) => {
          // UTF-8 first; Excel and Outlook often save Windows-1252 (é, ñ).
          let text: string;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            text = new TextDecoder('windows-1252').decode(bytes);
          }
          const contacts = contactsFromFile(file.name, text);
          done(contacts.length
            ? { contacts, fileName: file.name }
            : { problem: 'No contacts were found in that file. Use a .csv with a header row (name, organization, email, phone...) or a .vcf contacts file.' });
        })
        .catch(() => done({ problem: 'That file could not be read.' }));
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** ids: the partners added or linked, in the order of the rows sent (import_partners). */
export type ImportResult = { added: number; linked: number; skipped: number; ids?: string[] };

/** Sends the confirmed rows. The signed-in account must still be the one that chose them. */
export async function importPartners(rows: ImportRow[], expectedUserId: string): Promise<ImportResult> {
  const identity = await currentAuthSessionIdentity();
  if (!identity || identity.userId !== expectedUserId.toLowerCase()) {
    throw new StoreError('The signed-in account changed. Open the import again.', false);
  }
  const { data, error, status } = await supabase.rpc('import_partners', { p_rows: rows });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === 'PGRST202' || code === '42883') throw new StoreError('Importing partners needs the latest ReferralFit update on the server.', false);
    throw friendlyStoreError(error, status, 'The partners could not be added.');
  }
  const result = (data || {}) as Record<string, unknown>;
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const ids = Array.isArray(result.ids) ? result.ids.filter((id): id is string => typeof id === 'string') : [];
  return { added: count(result.added), linked: count(result.linked), skipped: count(result.skipped), ids };
}
