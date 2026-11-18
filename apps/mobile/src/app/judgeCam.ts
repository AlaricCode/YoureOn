// Turning this phone into the room's judge cam and back (API-CONTRACT §2.15
// PATCH /v1/devices/current). The server's rules: a judge cam is bound to a room
// (role 'judge_cam' needs room_id) and only a judge cam is (role 'phone' with a room_id is a
// 400). At an attempt it picks the non-performer's most recently seen judge-cam device in the
// room as the recorder, so a phone that left judge-cam mode on screen but not on the server can
// take the recording away from the real judge cam. Every way out of judge-cam mode (the Profile
// row, the judge-cam screen's back arrow) goes through here.
// Pure TS: tested in node.

export type DeviceRoleRequest =
  | { ok: true; role: 'judge_cam'; roomId: string }
  | { ok: true; role: 'phone'; roomId?: undefined }
  | { ok: false; reason: 'no_room' };

export function deviceRoleRequest(on: boolean, roomId: string | null): DeviceRoleRequest {
  if (!on) return { ok: true, role: 'phone' };
  if (!roomId) return { ok: false, reason: 'no_room' };
  return { ok: true, role: 'judge_cam', roomId };
}
