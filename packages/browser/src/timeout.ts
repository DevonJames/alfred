export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function closeSoon(closable: { close: () => Promise<unknown> } | undefined, ms = 2_000): Promise<void> {
  if (!closable) return;
  await withTimeout(closable.close().catch(() => undefined), ms, "close timed out").catch(() => undefined);
}
