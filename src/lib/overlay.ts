// Something the app does not draw itself is on screen over a sheet: the
// Messages or Mail compose sheet, the share sheet, or a dropdown picker.
// While one is up, closing the sheet underneath would freeze it (iOS only
// dismisses the topmost presentation), so navigation that closes sheets —
// a notification tap — waits for it to finish first.

let openCount = 0;

// Returns the matching end call; calling it more than once is harmless.
export function beginOverlay(): () => void {
  openCount += 1;
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
