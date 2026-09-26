import { inBeirut, scheduledToUtc } from 'time';

// A datetime-local box has no zone of its own: the browser reads it in
// whatever zone the device is set to. Both directions go through the shop's
// zone explicitly, so the owner's laptop being in Beirut, in UTC or abroad
// changes nothing.

/** The value for a datetime-local input showing this instant as Beirut wall time. */
export function toBeirutInput(iso: string): string {
  const { date, hhmm } = inBeirut(new Date(iso));
  return `${date}T${hhmm}`;
}

/** The instant a datetime-local value names, read as Beirut wall time. */
export function fromBeirutInput(value: string): string {
  const [date = '', time = ''] = value.split('T');
  return scheduledToUtc(date, time.slice(0, 5)).toISOString();
}
