import { createContext, useCallback, useContext, useRef, useState } from 'react';

/**
 * Minimal, dependency-free toast system.
 *
 *   const toast = useToast();
 *   toast.success('Booking created');
 *   toast.error('Could not save', { action: { label: 'Retry', onClick: retry } });
 *
 * Toasts stack, auto-dismiss (errors linger a little longer), and can carry a
 * single action button — used for "Retry" on failed API calls.
 */
const ToastContext = createContext(null);

let idSeq = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (variant, message, opts = {}) => {
      const id = ++idSeq;
      const duration = opts.duration ?? (variant === 'error' ? 6000 : 4000);
      setToasts((list) => [...list, { id, variant, message, action: opts.action }]);
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss]
  );

  const value = {
    success: (message, opts) => push('success', message, opts),
    error: (message, opts) => push('error', message, opts),
    info: (message, opts) => push('info', message, opts),
    dismiss,
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-auto sm:items-end"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const VARIANT_STYLES = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  error: 'border-red-200 bg-red-50 text-red-700',
  info: 'border-slate-200 bg-white text-slate-700',
};

const VARIANT_ICON = { success: '✓', error: '!', info: 'i' };

function ToastItem({ toast, onDismiss }) {
  const { variant, message, action } = toast;
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={[
        'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg',
        VARIANT_STYLES[variant] || VARIANT_STYLES.info,
      ].join(' ')}
    >
      <span className="mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-full bg-white/60 text-xs font-bold">
        {VARIANT_ICON[variant] || 'i'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words">{message}</p>
        {action && (
          <button
            className="mt-1 text-sm font-semibold underline underline-offset-2"
            onClick={() => {
              onDismiss();
              action.onClick();
            }}
          >
            {action.label}
          </button>
        )}
      </div>
      <button
        className="-mr-1 -mt-0.5 flex-shrink-0 rounded p-1 text-lg leading-none opacity-60 hover:opacity-100"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
