import { Notifier, NotificationPayload } from './types';

export class ConsoleNotifier implements Notifier {
  async send(payload: NotificationPayload): Promise<void> {
    console.log('[ConsoleNotifier]', JSON.stringify(payload, null, 2));
  }
}