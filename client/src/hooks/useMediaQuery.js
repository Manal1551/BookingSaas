import { useEffect, useState } from 'react';

/**
 * Subscribes to a CSS media query.
 *
 * Used to switch the calendar to an agenda view and move filters into a
 * bottom sheet on small screens — decisions that need the real breakpoint,
 * not just a CSS class.
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Tailwind's `md` breakpoint. Below this we are in mobile layout. */
export const useIsMobile = () => !useMediaQuery('(min-width: 768px)');
