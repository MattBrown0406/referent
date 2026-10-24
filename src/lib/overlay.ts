// Something the app does not draw itself is on screen over a sheet: the
// Messages or Mail compose sheet, the share sheet, or a dropdown picker.
// While one is up, presenting another sheet fails and leaves it frozen (iOS
// presents only from the topmost view controller), so notification taps and
// timed sheet opens wait for it to finish first.

let openCount = 0;
let openedTotal = 0; // only grows: lets awaited work tell one came and went

// Returns the matching end call; calling it more than once is harmless.
export function beginOverlay(): () => void {
  openCount += 1;
  openedTotal += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    openCount = Math.max(0, openCount - 1);
  };
}

export function overlayOpen(): boolean {
  return openCount > 0;
}

export function overlaysOpened(): number {
  return openedTotal;
}
