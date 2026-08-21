/**
 * Toasts, and one of them in particular.
 *
 * A screen built to a design ahead of the code behind it has controls that look finished and
 * do nothing, which is the worst of both: a person clicks, nothing happens, and they cannot
 * tell a dead control from a slow one or from their own mistake. `notYet` is the honest
 * version - the control says out loud that it is a placeholder, names itself, and the message
 * is the same everywhere so it reads as a category rather than as a bug.
 *
 * Rancher's own growl store, rather than anything of ours: it is what the rest of the
 * dashboard uses, so these land where a person already expects to be told things.
 */
type Store = { dispatch: (action: string, payload: unknown, opts?: unknown) => void };

interface ToastOptions {
  title?: string;
  timeout?: number;
}

function growl(store: Store, level: string, title: string, message: string, timeout: number): void {
  try {
    store.dispatch(`growl/${ level }`, { title, message, timeout }, { root: true });
  } catch {
    // A toast is never worth an exception on the way out of a click handler.
  }
}

/** Something worked. */
export function toastSuccess(store: Store, message: string, opts: ToastOptions = {}): void {
  growl(store, 'success', opts.title || 'Done', message, opts.timeout ?? 3000);
}

/** Something did not. */
export function toastError(store: Store, message: string, opts: ToastOptions = {}): void {
  growl(store, 'error', opts.title || 'That did not work', message, opts.timeout ?? 6000);
}

/**
 * This control is drawn but not wired.
 *
 * `what` is named in the message so a report of it is actionable without a screenshot: the
 * person can say which control they pressed and it matches a string in the source.
 */
export function toastNotYet(store: Store, what: string): void {
  growl(
    store,
    'info',
    'Not built yet',
    `"${ what }" is part of the design and has no code behind it. Nothing was changed.`,
    4000,
  );
}
