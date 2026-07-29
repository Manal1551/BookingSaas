import { useEffect, useState } from 'react';

/**
 * Connection-loss banner.
 *
 * Matters here because the booking transport retries on network failure — the
 * banner tells the user *why* a save is taking a while, rather than leaving a
 * spinner unexplained.
 */
export default function OfflineBanner() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      aria-live="assertive"
      className="sticky top-0 z-[70] flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-sm font-medium text-white"
    >
      <span aria-hidden="true">⚠</span>
      You are offline — changes cannot be saved until the connection returns.
    </div>
  );
}
