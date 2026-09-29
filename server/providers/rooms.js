'use strict';

/**
 * Room inventory provider. Mock-backed today; an Opera Cloud (housekeeping /
 * room status) adapter can replace it later behind the same methods.
 */
const toRoom = (r) => ({
  roomNumber: r.room_number,
  building: r.building,
  floor: r.floor,
  roomType: r.room_type,
  hkStatus: r.hk_status,
});

function createMockRoomProvider(db) {
  return {
    name: 'mock',
    get(roomNumber) {
      const r = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(String(roomNumber));
      return r ? toRoom(r) : null;
    },
    list() {
      return db.prepare('SELECT * FROM rooms ORDER BY room_number').all().map(toRoom);
    },
  };
}

module.exports = { createMockRoomProvider };
