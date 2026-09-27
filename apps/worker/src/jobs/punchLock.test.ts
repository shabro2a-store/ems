import { describe, it, expect } from 'vitest';
import { punchLockKey as webKey } from '@/lib/services/punchLock';
import { punchLockKey as workerKey } from './punchLock';

describe("the worker's punch lock", () => {
  it('is the same lock the web app takes for the same person', () => {
    for (const id of ['cmuk7emn60000exagfkal41vy', 'u1', 'a-much-longer-user-id-0123456789']) {
      expect(workerKey(id)).toBe(webKey(id));
    }
  });
});
