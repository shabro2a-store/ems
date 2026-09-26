import { inBeirut } from 'time';

type Neighbour = { kind: 'IN' | 'OUT'; at: Date };

/**
 * Why a corrected time cannot stand, or null if it can.
 *
 * A correction may move a punch anywhere between the person's punches either
 * side of it, and no further. Every reader pairs punches by their order in
 * time, so a checkout moved before its own check-in pairs that check-in with
 * the NEXT shift's checkout - 32 hours paid for 16, and a day of overtime -
 * and landing exactly on a neighbour leaves the order to whichever row the
 * database returns first. A time in the future is refused outright: nothing
 * has happened there to correct, and a punch nobody can see yet reads as a
 * shift that is still open.
 */
export function correctionProblem(args: {
  newAt: Date;
  now: Date;
  previous: Neighbour | null;
  next: Neighbour | null;
}): { code: 'IN_THE_FUTURE' | 'OUT_OF_ORDER'; message: string } | null {
  if (args.newAt > args.now) {
    return { code: 'IN_THE_FUTURE', message: 'That time is in the future. A correction can only say when something already happened.' };
  }
  const named = (n: Neighbour) => {
    const { date, hhmm } = inBeirut(n.at);
    return `${n.kind === 'IN' ? 'check-in' : 'check-out'} at ${date} ${hhmm}`;
  };
  if (args.previous && args.newAt <= args.previous.at) {
    return {
      code: 'OUT_OF_ORDER',
      message:
        `That time is not after their ${named(args.previous)}, which comes before this punch. ` +
        'Moving it there would pair their punches the wrong way round - correct that punch first, or pick a later time.',
    };
  }
  if (args.next && args.newAt >= args.next.at) {
    return {
      code: 'OUT_OF_ORDER',
      message:
        `That time is not before their ${named(args.next)}, which comes after this punch. ` +
        'Moving it there would pair their punches the wrong way round - correct that punch first, or pick an earlier time.',
    };
  }
  return null;
}
