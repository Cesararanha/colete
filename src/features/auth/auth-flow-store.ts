import { create } from 'zustand';

import {
  forgetPendingSignup,
  keepPendingSignup,
  keptPendingSignup,
} from '../../lib/pending-signup';
import { RESEND_INTERVAL_MS } from './resend-interval';

type AuthFlowState = {
  pendingEmail: string | null;
  pendingName: string | null;
  resendAvailableAt: number | null;
  /** The kept sign up of this tab was read once, after the first render. */
  restored: boolean;
  setPendingSignup: (email: string, name: string) => void;
  setResendAvailableAt: (timestamp: number) => void;
  clearPendingSignup: () => void;
  restorePendingSignup: () => void;
};

export const useAuthFlowStore = create<AuthFlowState>((set, get) => ({
  pendingEmail: null,
  pendingName: null,
  resendAvailableAt: null,
  restored: false,
  setPendingSignup: (pendingEmail, pendingName) => {
    const resendAvailableAt = Date.now() + RESEND_INTERVAL_MS;
    keepPendingSignup({ email: pendingEmail, resendAvailableAt });
    set({ pendingEmail, pendingName, resendAvailableAt, restored: true });
  },
  setResendAvailableAt: (resendAvailableAt) => {
    // A new code is valid from now: the kept e-mail lasts as long as it does.
    const email = get().pendingEmail;
    if (email !== null) keepPendingSignup({ email, resendAvailableAt });
    set({ resendAvailableAt });
  },
  clearPendingSignup: () => {
    forgetPendingSignup();
    set({ pendingEmail: null, pendingName: null, resendAvailableAt: null });
  },
  // A reload of "Verificar código" keeps the code field (rev84 P1): the e-mail
  // comes back from this tab's storage, the name stays in page memory only.
  restorePendingSignup: () => {
    if (get().pendingEmail === null) {
      const kept = keptPendingSignup();
      if (kept !== null)
        set({ pendingEmail: kept.email, resendAvailableAt: kept.resendAvailableAt });
    }
    set({ restored: true });
  },
}));
