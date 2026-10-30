/** Stop a local wait even when the external operation only cooperatively cancels. */
export function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void =>
      reject(signal.reason instanceof Error ? signal.reason : new Error('operation cancelled'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
