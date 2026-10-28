// The early-preview notice is shown once per browser. Storage can be missing or throw
// (private mode, blocked site data): then the notice shows again next visit, and never blocks.
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
// Bump when the notice says something new, so everyone sees it once more.
const KEY = "gendo.notice.v2";

export function noticeSeen(s: Store): boolean {
  try {
    return s.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markNoticeSeen(s: Store) {
  try {
    s.setItem(KEY, "1");
  } catch {
    // nowhere to remember it: it shows again next time
  }
}

/** Ask the notice to open again (the network banner's "Early preview" link). */
export const openNotice = () => dispatchEvent(new Event("gendo:notice"));
