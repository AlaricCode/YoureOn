import { describe, expect, it } from 'vitest';

import { getConnectionStatus, setConnectionStatus } from '../connection';

describe('connection status (reconnect banner on every screen)', () => {
  it('starts idle and follows the realtime client', () => {
    expect(getConnectionStatus()).toBe('idle');
    setConnectionStatus('live');
    setConnectionStatus('reconnecting');
    expect(getConnectionStatus()).toBe('reconnecting');
    setConnectionStatus('live');
    expect(getConnectionStatus()).toBe('live');
  });
});
