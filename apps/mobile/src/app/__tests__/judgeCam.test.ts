import { describe, expect, it } from 'vitest';

import { deviceRoleRequest } from '../judgeCam';

describe('deviceRoleRequest (PATCH /v1/devices/current)', () => {
  it('binds a judge cam to the room it judges', () => {
    expect(deviceRoleRequest(true, 'room-1')).toEqual({
      ok: true,
      role: 'judge_cam',
      roomId: 'room-1',
    });
  });

  it('needs a room to become a judge cam (the server would 400)', () => {
    expect(deviceRoleRequest(true, null)).toEqual({ ok: false, reason: 'no_room' });
  });

  it('goes back to a phone WITHOUT a room_id, in or out of a room (the server 400s on one)', () => {
    expect(deviceRoleRequest(false, 'room-1')).toEqual({ ok: true, role: 'phone' });
    expect(deviceRoleRequest(false, null)).toEqual({ ok: true, role: 'phone' });
    const r = deviceRoleRequest(false, 'room-1');
    expect(r.ok && r.roomId).toBeUndefined();
  });
});
