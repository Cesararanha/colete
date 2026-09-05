import { create } from 'zustand';

type AuthFlowState = {
  pendingEmail: string | null;
  pendingName: string | null;
  resendAvailableAt: number | null;
  setPendingSignup: (email: string, name: string) => void;
  setResendAvailableAt: (timestamp: number) => void;
  clearPendingSignup: () => void;
};

export const useAuthFlowStore = create<AuthFlowState>((set) => ({
  pendingEmail: null,
  pendingName: null,
  resendAvailableAt: null,
  setPendingSignup: (pendingEmail, pendingName) =>
    set({ pendingEmail, pendingName, resendAvailableAt: Date.now() + 60_000 }),
  setResendAvailableAt: (resendAvailableAt) => set({ resendAvailableAt }),
  clearPendingSignup: () => set({ pendingEmail: null, pendingName: null, resendAvailableAt: null }),
}));
