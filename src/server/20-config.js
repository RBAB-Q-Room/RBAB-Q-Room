/* =====================================================================
 * Schema and configuration.
 * Every table below is one tab of the Google Sheet that holds the data.
 * ===================================================================== */

/** Bump whenever SCHEMA gains a tab or column (append columns at the end only). */
const SCHEMA_VERSION = 3;

const ROLES = { reception: 'reception', rooms_controller: 'rooms_controller', admin: 'admin' };
const STATUSES = ['waiting', 'room_assigned', 'preparing', 'ready', 'returned', 'completed', 'cancelled'];
const ACTIVE_STATUSES = ['waiting', 'room_assigned', 'preparing', 'ready', 'returned'];
const HK_STATUSES = ['clean', 'inspected', 'dirty', 'out_of_order'];
const LANGUAGES = ['en', 'ar', 'ru', 'de'];

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
    ['guest_notified_at', 's'], ['guest_returned_at', 's'], ['completed_at', 's'], ['cancelled_at', 's'], ['created_by', 'i'], ['language', 's'],
    // schema 3
    ['vip_code', 's'], ['tags', 's'], ['qr_first_opened_at', 's'], ['guest_seen_ready_at', 's'],
    ['feedback_rating', 'i'], ['feedback_helpful', 's'], ['feedback_at', 's'], ['create_seconds', 'i'],
  ],
  StatusHistory: [['id', 'i'], ['waiting_guest_id', 'i'], ['from_status', 's'], ['to_status', 's'], ['room_number', 's'], ['changed_at', 's'], ['changed_by', 'i'], ['note', 's']],
  GuestContent: [['sort', 'i'], ['id', 's'], ['icon', 's'], ['title', 's'], ['body', 's'], ['note', 's'], ['placeholder', 'b'], ['active', 'b'],
    ['title_ar', 's'], ['body_ar', 's'], ['note_ar', 's'], ['title_ru', 's'], ['body_ru', 's'], ['note_ru', 's'], ['title_de', 's'], ['body_de', 's'], ['note_de', 's'],
    ['highlight', 's'], ['highlight_ar', 's'], ['highlight_ru', 's'], ['highlight_de', 's']],
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
  guest_welcome_ar: 'أثناء انتظارك، تفضّل بالاستمتاع بمرافق المنتجع.',
  guest_welcome_ru: 'Пока вы ждёте, наслаждайтесь отдыхом на курорте.',
  guest_welcome_de: 'Genießen Sie das Resort, während Sie warten.',
  guest_base_url: '',                                       // optional override of the web app URL used in QR codes
  archive_after_days: '30',
  qr_expire_hours: '24',           // a guest link stops showing details this long after completion
  guest_show_placeholders: '1',    // show resort cards that still have placeholder text (turn off for live use)
  // Business case assumptions (illustrative, edited by management). Blank = not provided.
  bc_daily_checkins: '100',
  bc_waiting_pct: '65',
  bc_manual_minutes: '',           // minutes Reception spent on one paper Waiting Card
  bc_digital_minutes: '',          // blank = use the measured creation time
  bc_print_cost: '',               // AED per printed piece
  bc_print_pieces: '',             // printed pieces per paper Waiting Card
  bc_comm_minutes: '',             // minutes of manual follow-up per waiting guest (calls, desk queries)
  bc_qr_adoption_pct: '',          // blank = use the measured QR opening rate
};

/** Settings an admin may change in the app, with validation rules. */
const SETTINGS_SPEC = {
  hotel_name: { type: 'text', max: 80, required: true },
  hotel_map_url: { type: 'url' },
  hotel_website_url: { type: 'url' },
  wg_prefix: { type: 'prefix' },
  late_warn_minutes: { type: 'int', min: 1, max: 600 },
  late_alert_minutes: { type: 'int', min: 2, max: 900 },
  qr_expire_hours: { type: 'int', min: 1, max: 168 },
  archive_after_days: { type: 'int', min: 1, max: 365 },
  session_hours: { type: 'int', min: 1, max: 24 },
  guest_show_placeholders: { type: 'bool' },
  guest_welcome: { type: 'text', max: 160 },
  guest_welcome_ar: { type: 'text', max: 160 },
  guest_welcome_ru: { type: 'text', max: 160 },
  guest_welcome_de: { type: 'text', max: 160 },
  bc_daily_checkins: { type: 'num', min: 0, max: 5000 },
  bc_waiting_pct: { type: 'num', min: 0, max: 100 },
  bc_manual_minutes: { type: 'num', min: 0, max: 120 },
  bc_digital_minutes: { type: 'num', min: 0, max: 120 },
  bc_print_cost: { type: 'num', min: 0, max: 1000 },
  bc_print_pieces: { type: 'num', min: 0, max: 50 },
  bc_comm_minutes: { type: 'num', min: 0, max: 120 },
  bc_qr_adoption_pct: { type: 'num', min: 0, max: 100 },
};

/** Optional quick tags Reception can add in one tap. They feed the transparent priority reasons. */
const GUEST_TAGS = ['occasion', 'accessibility'];

// Opera room type codes and names, as used by the Room Guide application.
const DEFAULT_ROOM_TYPES = [
  ['KGA', 'Deluxe King Garden'], ['KGAOV', 'Deluxe King View'], ['KGE', 'Premium King Garden'], ['KGEOV', 'Premium King View'],
  ['TWA', 'Deluxe Twin Garden'], ['TWAOV', 'Deluxe Twin View'], ['SKA', 'Kids Escape Suite'], ['SKB', 'Family Room Garden'],
  ['SKC', 'Family Room View'], ['SKD', 'Junior Suite'], ['SKP', 'Senior Suite'], ['SXA', 'King Suite'],
];

/**
 * PLACEHOLDER guest content, in English, Arabic, Russian and German.
 * No hours, policies, venue names or contact details have been supplied by
 * the hotel, so none are invented. The hotel edits the GuestContent tab
 * (columns title/body/note plus _ar, _ru, _de); nothing here needs a code
 * change. Translations were written for this build and should be reviewed by
 * native speakers before guests see them.
 * Row: [sort, id, icon, placeholder, active, {en, ar, ru, de} x (title, body, note)]
 */
const DEFAULT_GUEST_CONTENT = [
  { sort: 1, id: 'all-inclusive', icon: 'sparkle',
    title: { en: 'All Inclusive', ar: 'الإقامة الشاملة', ru: 'Всё включено', de: 'All Inclusive' },
    body: { en: 'You are welcome to enjoy the all-inclusive resort benefits that apply to your booking while your room is prepared.',
      ar: 'يمكنك الاستمتاع بمزايا الإقامة الشاملة المتاحة ضمن حجزك أثناء تجهيز غرفتك.',
      ru: 'Пока готовится ваш номер, вы можете пользоваться услугами «всё включено», предусмотренными вашим бронированием.',
      de: 'Sie können die All-Inclusive-Leistungen Ihrer Buchung genießen, während Ihr Zimmer vorbereitet wird.' },
    note: { en: "Subject to the hotel's all-inclusive policy and your booking.", ar: 'وفقاً لسياسة الفندق للإقامة الشاملة ولحجزك.',
      ru: 'В соответствии с правилами отеля по системе «всё включено» и условиями вашего бронирования.', de: 'Es gelten die All-Inclusive-Bedingungen des Hotels und Ihre Buchung.' } },
  { sort: 2, id: 'pools', icon: 'pool',
    title: { en: 'Pools', ar: 'المسابح', ru: 'Бассейны', de: 'Pools' },
    body: { en: 'Pool information and locations will appear here.', ar: 'ستظهر هنا معلومات المسابح ومواقعها.', ru: 'Здесь появится информация о бассейнах и их расположении.', de: 'Informationen und Standorte der Pools erscheinen hier.' } },
  { sort: 3, id: 'beach', icon: 'beach',
    title: { en: 'Beach', ar: 'الشاطئ', ru: 'Пляж', de: 'Strand' },
    body: { en: 'Beach information and location will appear here.', ar: 'ستظهر هنا معلومات الشاطئ وموقعه.', ru: 'Здесь появится информация о пляже и его расположении.', de: 'Informationen und Lage des Strands erscheinen hier.' } },
  { sort: 4, id: 'dining', icon: 'dining',
    title: { en: 'Restaurants & Bars', ar: 'المطاعم والبارات', ru: 'Рестораны и бары', de: 'Restaurants & Bars' },
    body: { en: "The resort's restaurants and bars will be listed here.", ar: 'ستُعرض هنا مطاعم المنتجع وبارّاته.', ru: 'Здесь будет список ресторанов и баров курорта.', de: 'Die Restaurants und Bars des Resorts werden hier aufgeführt.' } },
  { sort: 5, id: 'activities', icon: 'activity',
    title: { en: 'Entertainment & Activities', ar: 'الترفيه والأنشطة', ru: 'Развлечения и активности', de: 'Unterhaltung & Aktivitäten' },
    body: { en: 'Entertainment and activity information will appear here.', ar: 'ستظهر هنا معلومات الترفيه والأنشطة.', ru: 'Здесь появится информация о развлечениях и активностях.', de: 'Informationen zu Unterhaltung und Aktivitäten erscheinen hier.' } },
  { sort: 6, id: 'wifi', icon: 'wifi',
    title: { en: 'Wi-Fi', ar: 'الواي فاي', ru: 'Wi-Fi', de: 'WLAN' },
    body: { en: 'Wi-Fi network and access details will appear here.', ar: 'ستظهر هنا تفاصيل شبكة الواي فاي والاتصال بها.', ru: 'Здесь появятся данные для подключения к Wi-Fi.', de: 'Angaben zum WLAN und Zugang erscheinen hier.' } },
  { sort: 7, id: 'services', icon: 'bell',
    title: { en: 'Guest Services', ar: 'خدمات الضيوف', ru: 'Служба поддержки гостей', de: 'Gästeservice' },
    body: { en: 'Guest services information and contact details will appear here.', ar: 'ستظهر هنا معلومات خدمات الضيوف وبيانات التواصل.', ru: 'Здесь появится информация о службе поддержки гостей и контакты.', de: 'Informationen und Kontaktdaten des Gästeservice erscheinen hier.' } },
];

/** Flatten a DEFAULT_GUEST_CONTENT entry into a GuestContent row. */
function guestContentRow_(g) {
  const row = { sort: g.sort, id: g.id, icon: g.icon, placeholder: true, active: true,
    title: g.title.en, body: g.body.en, note: (g.note && g.note.en) || '' };
  ['ar', 'ru', 'de'].forEach(function (l) {
    row['title_' + l] = g.title[l] || '';
    row['body_' + l] = g.body[l] || '';
    row['note_' + l] = (g.note && g.note[l]) || '';
  });
  return row;
}
