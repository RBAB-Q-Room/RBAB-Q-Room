'use strict';

/**
 * Reservation provider.
 *
 * This is the ONLY place the application reads reservation data. Today it is
 * backed by the mock `reservations` table. A future Opera Cloud adapter would
 * implement the same two methods (and be selected in server/index.js) without
 * touching Waiting Guest logic, routes or UI.
 *
 * Contract: returns plain objects shaped like `toReservation` below.
 */
function toReservation(r) {
  return {
    confirmationNo: r.confirmation_no,
    guestName: r.guest_name,
    arrivalDate: r.arrival_date,
    arrivalTime: r.arrival_time,
    departureDate: r.departure_date,
    roomType: r.room_type,
    adults: r.adults,
    children: r.children,
    phone: r.phone,
    email: r.email,
    nights: r.nights,
    ratePlan: r.rate_plan,
    mealPlan: r.meal_plan,
    nationality: r.nationality,
    vipCode: r.vip_code,
    specialRequests: r.special_requests,
  };
}

function createMockReservationProvider(db) {
  return {
    name: 'mock',
    findByConfirmation(no) {
      const r = db.prepare('SELECT * FROM reservations WHERE confirmation_no = ?').get(String(no).trim());
      return r ? toReservation(r) : null;
    },
    /** Prefix search on confirmation number, for type-ahead. */
    searchByConfirmation(prefix, limit = 8) {
      const p = String(prefix).trim().replace(/[%_]/g, '');
      if (!p) return [];
      return db
        .prepare('SELECT * FROM reservations WHERE confirmation_no LIKE ? ORDER BY confirmation_no LIMIT ?')
        .all(`${p}%`, limit)
        .map(toReservation);
    },
  };
}

module.exports = { createMockReservationProvider };
