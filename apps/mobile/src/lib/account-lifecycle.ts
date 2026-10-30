// A confirmed server disable invalidates mounted camera/share drafts immediately.
// This event carries only an account identifier; it never carries credentials.
const listeners = new Set<(accountId: string) => void>();
export function subscribeAccountDisabled(listener: (accountId: string) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyAccountDisabled(accountId: string) {
  for (const listener of listeners) listener(accountId);
}
