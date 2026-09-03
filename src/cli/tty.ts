export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const LEAVE_ALT_SCREEN = "\x1b[?1049l";
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const HOME_CLEAR = "\x1b[H\x1b[J";

export interface WatchScreenWriter {
  write(chunk: string): boolean;
}

/** Enter the alternate screen, hide the cursor, and always restore both in the returned disposer. */
export function attachWatchScreen(stdout: WatchScreenWriter): () => void {
  stdout.write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}`);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    stdout.write(`${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
  };
}

export function paintWatchFrame(stdout: WatchScreenWriter, frame: string): void {
  stdout.write(`${HOME_CLEAR}${frame}`);
}
