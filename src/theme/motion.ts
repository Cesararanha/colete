import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** docs/15: with reduced motion, transitions become instant and nothing scales. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let current = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (current) setReduced(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      current = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}
