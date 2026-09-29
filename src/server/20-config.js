/* =====================================================================
 * Schema and configuration.
 * Every table below is one tab of the Google Sheet that holds the data.
 * ===================================================================== */

const ROLES = { reception: 'reception', rooms_controller: 'rooms_controller', admin: 'admin' };
const STATUSES = ['waiting', 'room_assigned', 'preparing', 'ready', 'returned', 'completed', 'cancelled'];
const ACTIVE_STATUSES = ['waiting', 'room_assigned', 'preparing', 'ready', 'returned'];
const HK_STATUSES = ['clean', 'inspected', 'dirty', 'out_of_order'];

// Column types: s = text, i = integer, b = boolean.
const SCHEMA = {
  Users: [['id', 'i'], ['username', 's'], ['display_name', 's'], ['role', 's'], ['salt', 's'], ['hash', 's'], ['active', 'b'], ['created_at', 's']],
  Sessions: [['token_hash', 's'], ['user_id', 'i'], ['expires_at', 's']],
  Reservations: [
    ['confirmation_no', 's'], ['guest_name', 's'], ['arrival_date', 's'], ['arrival_time', 's'], ['departure_date', 's'], ['room_type', 's'],
    ['adults', 'i'], ['children', 'i'], ['phone', 's'], ['email', 's'], ['nights', 'i'], ['rate_plan', 's'], ['meal_plan', 's'],
    ['nationality', 's'], ['vip_code', 's'], ['special_requests', 's'], ['imported_at', 's'],
  ],
  Rooms: [['room_number', 's'], ['building', 's'], ['floor', 's'], ['room_type', 's'], ['hk_status', 's']],
  RoomTypes: [['code', 's'], ['name', 's']],
  WaitingGuests: [
    ['id', 'i'], ['wg_number', 's'], ['qr_token', 's'], ['source', 's'],
    ['confirmation_no', 's'], ['guest_name', 's'], ['arrival_date', 's'], ['arrival_time', 's'], ['departure_date', 's'], ['room_type', 's'],
    ['adults', 'i'], ['children', 'i'], ['phone', 's'], ['email', 's'],
    ['luggage_tag', 's'], ['associate', 's'], ['preferences', 's'], ['remarks', 's'],
    ['room_number', 's'], ['status', 's'], ['priority', 'b'], ['cancel_reason', 's'],
    ['guest_arrival_at', 's'], ['created_at', 's'], ['room_assigned_at', 's'], ['preparation_started_at', 's'], ['room_ready_at', 's'],
    ['guest_notified_at', 's'], ['guest_returned_at', 's'], ['completed_at', 's'], ['cancelled_at', 's'], ['created_by', 'i'],
  ],
  StatusHistory: [['id', 'i'], ['waiting_guest_id', 'i'], ['from_status', 's'], ['to_status', 's'], ['room_number', 's'], ['changed_at', 's'], ['changed_by', 'i'], ['note', 's']],
  GuestContent: [['sort', 'i'], ['id', 's'], ['icon', 's'], ['title', 's'], ['body', 's'], ['note', 's'], ['placeholder', 'b'], ['active', 'b']],
  Config: [['key', 's'], ['value', 's']],
  Meta: [['key', 's'], ['value', 's']],
  Audit: [['at', 's'], ['user_id', 'i'], ['action', 's'], ['detail', 's']],
};

// Editable settings (Config tab). Defaults apply when a key is missing.
const CONFIG_DEFAULTS = {
  wg_prefix: 'WG',
  wg_pad: '4',
  session_hours: '12',
  auth_rounds: '100',
  late_warn_minutes: '30',
  late_alert_minutes: '60',
  hotel_name: 'Rixos Bab Al Bahr',
  hotel_map_url: 'https://easymap.ae/rixos-bab-al-bahr/', // same map link used by Room Guide
  hotel_website_url: '',                                    // not supplied yet; button stays disabled until set
  guest_welcome: 'While you wait, feel free to enjoy the resort.',
  guest_base_url: '',                                       // optional override of the web app URL used in QR codes
  archive_after_days: '30',
};

// Opera room type codes and names, as used by the Room Guide application.
const DEFAULT_ROOM_TYPES = [
  ['KGA', 'Deluxe King Garden'], ['KGAOV', 'Deluxe King View'], ['KGE', 'Premium King Garden'], ['KGEOV', 'Premium King View'],
  ['TWA', 'Deluxe Twin Garden'], ['TWAOV', 'Deluxe Twin View'], ['SKA', 'Kids Escape Suite'], ['SKB', 'Family Room Garden'],
  ['SKC', 'Family Room View'], ['SKD', 'Junior Suite'], ['SKP', 'Senior Suite'], ['SXA', 'King Suite'],
];

/**
 * PLACEHOLDER guest content. No hours, policies, venue names or contact
 * details have been supplied by the hotel, so none are invented.
 * The hotel edits the GuestContent tab; nothing here needs a code change.
 */
const DEFAULT_GUEST_CONTENT = [
  [1, 'all-inclusive', 'sparkle', 'All Inclusive', 'You are welcome to enjoy the all-inclusive resort benefits that apply to your booking while your room is prepared.', "Subject to the hotel's all-inclusive policy and your booking.", true, true],
  [2, 'pools', 'pool', 'Pools', 'Pool information and locations will appear here.', '', true, true],
  [3, 'beach', 'beach', 'Beach', 'Beach information and location will appear here.', '', true, true],
  [4, 'dining', 'dining', 'Restaurants & Bars', "The resort's restaurants and bars will be listed here.", '', true, true],
  [5, 'activities', 'activity', 'Entertainment & Activities', 'Entertainment and activity information will appear here.', '', true, true],
  [6, 'wifi', 'wifi', 'Wi-Fi', 'Wi-Fi network and access details will appear here.', '', true, true],
  [7, 'services', 'bell', 'Guest Services', 'Guest services information and contact details will appear here.', '', true, true],
];
