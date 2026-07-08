export interface NotificationPayload {
  channel: string;
  recipient: string;
  template: string;
  context: Record<string, unknown>;
}

export interface Notifier {
  send(payload: NotificationPayload): Promise<void>;
}