import { ConsoleNotifier } from './console';
import { Notifier } from './types';

export const notifier: Notifier = new ConsoleNotifier();
export { Notifier, NotificationPayload } from './types';