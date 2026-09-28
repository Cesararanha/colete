// A response observer is created before the action it watches and awaited
// after it. If it rejects in between (a first response that fails its
// assertion, for example), nothing handles the rejection yet: Playwright takes
// it as the test's failure and tears the fixtures down while the body still
// runs, so the test's finally finds `request` closed and the account it
// created stays in auth.users. The handler is attached in the same statement
// that creates the observer, as docs/25 §2 requires of barrier promises. It
// only marks the rejection as handled: the same promise still rejects at the
// test's own await, with its own message.
export function handledObserver<T>(observer: Promise<T>): Promise<T> {
  observer.catch(() => undefined);
  return observer;
}
