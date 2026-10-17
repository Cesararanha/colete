export type InviteScannerProps = {
  onRead: (value: string) => void;
  onError: (reason: 'denied' | 'unavailable') => void;
  onCancel: () => void;
};
