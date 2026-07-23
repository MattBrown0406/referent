import * as Calendar from 'expo-calendar/legacy';
import * as Contacts from 'expo-contacts/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Linking, Platform, Share } from 'react-native';

import type { CaseDocumentReference, Participant, WorkflowAppointment } from '../workflow/types';
import { workflowId } from '../features/workflow/utils';

export async function presentParticipantContact(participant: Participant): Promise<void> {
  if (Platform.OS === 'web') throw new Error('Device Contacts are available in the iOS and Android apps.');
  const permission = await Contacts.requestPermissionsAsync();
  if (!permission.granted) throw new Error('Contacts permission was denied. You can enable it in device Settings.');
  const parts = participant.name.trim().split(/\s+/);
  await Contacts.presentFormAsync(null, {
    contactType: Contacts.ContactTypes.Person,
    name: participant.name,
    firstName: parts.shift() || participant.name,
    lastName: parts.join(' ') || undefined,
    phoneNumbers: participant.phone ? [{ label: 'mobile', number: participant.phone }] : undefined,
    emails: participant.email ? [{ label: 'work', email: participant.email }] : undefined,
    note: participant.notes,
  });
}

export async function addAppointmentToCalendar(appointment: WorkflowAppointment): Promise<string> {
  if (Platform.OS === 'web') throw new Error('Device Calendar is available in the iOS and Android apps.');
  const permission = await Calendar.requestCalendarPermissionsAsync();
  if (!permission.granted) throw new Error('Calendar permission was denied. You can enable it in device Settings.');
  let calendarId: string | undefined;
  if (Platform.OS === 'ios') {
    calendarId = (await Calendar.getDefaultCalendarAsync()).id;
  } else {
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    calendarId = calendars.find((item) => item.allowsModifications)?.id;
  }
  if (!calendarId) throw new Error('No writable calendar is available on this device.');
  return Calendar.createEventAsync(calendarId, {
    title: appointment.title,
    startDate: new Date(appointment.startsAt),
    endDate: new Date(appointment.endsAt),
    timeZone: appointment.timeZone,
    notes: appointment.note,
  });
}

export async function pickCaseDocument(caseId: string): Promise<CaseDocumentReference | undefined> {
  if (Platform.OS === 'web') throw new Error('Document attachment is available in the iOS and Android apps.');
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
  if (result.canceled || !result.assets[0]) return undefined;
  const asset = result.assets[0];
  if (!FileSystem.documentDirectory) throw new Error('App document storage is unavailable.');
  const directory = `${FileSystem.documentDirectory}case-documents/${encodeURIComponent(caseId)}/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const safeName = asset.name.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'document';
  const id = workflowId('document');
  const uri = `${directory}${id}-${safeName}`;
  await FileSystem.copyAsync({ from: asset.uri, to: uri });
  return { id, caseId, name: asset.name, uri, mimeType: asset.mimeType, size: asset.size };
}

function managedDocumentUri(uri: string): string {
  if (!FileSystem.documentDirectory) throw new Error('App document storage is unavailable.');
  const root = `${FileSystem.documentDirectory}case-documents/`;
  let decoded: string;
  try { decoded = decodeURIComponent(uri); } catch { throw new Error('The stored document path is invalid.'); }
  if (!uri.startsWith(root) || decoded.includes('/../') || decoded.endsWith('/..')) {
    throw new Error('The document is outside ReferralFit app-local storage.');
  }
  return uri;
}

export async function openCaseDocument(document: CaseDocumentReference): Promise<void> {
  if (!document.uri) throw new Error('This is a legacy name-only reference; no local file is attached.');
  let uri = managedDocumentUri(document.uri);
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists || info.isDirectory) throw new Error('The attached document no longer exists.');
  if (Platform.OS === 'android' && uri.startsWith('file:')) uri = await FileSystem.getContentUriAsync(uri);
  const supported = await Linking.canOpenURL(uri);
  if (!supported) throw new Error('No installed app can open this document.');
  await Linking.openURL(uri);
}

export async function deleteCaseDocument(document: CaseDocumentReference): Promise<void> {
  if (!document.uri) return;
  const uri = managedDocumentUri(document.uri);
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

export async function shareBackupJson(serialized: string): Promise<void> {
  if (Platform.OS === 'web' || !FileSystem.cacheDirectory || !(await Sharing.isAvailableAsync())) {
    await Share.share({ title: 'ReferralFit backup', message: serialized });
    return;
  }
  const uri = `${FileSystem.cacheDirectory}referralfit-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await FileSystem.writeAsStringAsync(uri, serialized, { encoding: FileSystem.EncodingType.UTF8 });
  await Sharing.shareAsync(uri, { mimeType: 'application/json', dialogTitle: 'Save ReferralFit backup' });
}

export async function pickBackupJson(): Promise<string | undefined> {
  const result = await DocumentPicker.getDocumentAsync({ type: 'application/json', copyToCacheDirectory: true, multiple: false });
  if (result.canceled || !result.assets[0]) return undefined;
  const asset = result.assets[0];
  if (Platform.OS === 'web') return (await fetch(asset.uri)).text();
  return FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
}
