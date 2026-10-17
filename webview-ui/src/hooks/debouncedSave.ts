/** A save that waits out a burst of edits. `flush` sends a waiting one at once. */
export function debouncedSave<T>(send: (value: T) => void, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  const flush = () => {
    const waiting = pending;
    cancel();
    if (waiting) send(waiting.value);
  };
  return {
    save(value: T) {
      cancel();
      pending = { value };
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel,
  };
}
