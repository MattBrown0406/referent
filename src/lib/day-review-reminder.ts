// The day review reminder's time, kept on this device per account (like the
// other notification choices in App.tsx): 'HH:MM' on a half hour, or 'off'.
// The schedule itself lives in notifications.ts.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { DAY_REVIEW_DEFAULT_TIME, dayReviewReminderTime, setDayReviewReminderTime } from './notifications';

const reminderKey = (userId: string) => `referralfit-day-review-reminder-v1:${userId.toLowerCase()}`;

/** The account's saved time (6 PM when none was saved or it cannot be read), handed to the schedule. */
export async function loadDayReviewReminder(userId: string): Promise<string> {
  if (!userId) return DAY_REVIEW_DEFAULT_TIME;
  let time = DAY_REVIEW_DEFAULT_TIME;
  try {
    time = dayReviewReminderTime(await AsyncStorage.getItem(reminderKey(userId)));
  } catch {
    // Unreadable storage: the default time.
  }
  await setDayReviewReminderTime(time, userId).catch(() => undefined);
  return time;
}

/** Saves the account's choice and moves the reminder. Throws when it could not be saved. */
export async function saveDayReviewReminder(userId: string, time: string): Promise<string> {
  const next = dayReviewReminderTime(time);
  if (!userId) return next;
  await AsyncStorage.setItem(reminderKey(userId), next);
  await setDayReviewReminderTime(next, userId).catch(() => undefined);
  return next;
}
