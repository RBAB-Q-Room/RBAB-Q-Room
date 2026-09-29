'use strict';
const config = require('./config');

/**
 * Content shown on the guest page under "While you wait".
 *
 * IMPORTANT: this is PLACEHOLDER content. No opening hours, policies, venue
 * names or contact numbers have been supplied by the hotel yet, so none are
 * invented here. Replace `body`, `details`, `links` and `contact` with the
 * hotel's approved information (or load them from a CMS/database later).
 * Items with `placeholder: true` are flagged in the UI as pending content.
 */
module.exports = function guestContent() {
  return {
    hotelName: 'Rixos Bab Al Bahr',
    welcome: 'While you wait, feel free to enjoy the resort.',
    links: {
      // Same resort map link used by the Room Guide application.
      map: { label: 'Hotel Map', url: 'https://easymap.ae/rixos-bab-al-bahr/' },
      website: {
        label: 'Hotel Website',
        url: config.hotelWebsiteUrl || null, // set WG_HOTEL_WEBSITE to enable
      },
    },
    sections: [
      {
        id: 'all-inclusive',
        icon: 'sparkle',
        title: 'All Inclusive',
        body: 'You are welcome to enjoy the all-inclusive resort benefits that apply to your booking while your room is prepared.',
        note: 'Subject to the hotel\'s all-inclusive policy and your booking.',
        placeholder: true,
      },
      {
        id: 'pools',
        icon: 'pool',
        title: 'Pools',
        body: 'Pool information and locations will appear here.',
        placeholder: true,
      },
      {
        id: 'beach',
        icon: 'beach',
        title: 'Beach',
        body: 'Beach information and location will appear here.',
        placeholder: true,
      },
      {
        id: 'dining',
        icon: 'dining',
        title: 'Restaurants & Bars',
        body: 'The resort\'s restaurants and bars will be listed here.',
        placeholder: true,
      },
      {
        id: 'activities',
        icon: 'activity',
        title: 'Entertainment & Activities',
        body: 'Entertainment and activity information will appear here.',
        placeholder: true,
      },
      {
        id: 'wifi',
        icon: 'wifi',
        title: 'Wi-Fi',
        body: 'Wi-Fi network and access details will appear here.',
        placeholder: true,
      },
      {
        id: 'services',
        icon: 'bell',
        title: 'Guest Services',
        body: 'Guest services information and contact details will appear here.',
        placeholder: true,
      },
    ],
  };
};
