'use strict';

// windows-notification-state's native part, which discord_utils loads on every
// system: Haiku has no focus assist, so notifications are always welcome.
module.exports = {
  getNotificationState: () => 'QUNS_ACCEPTS_NOTIFICATIONS',
  getSessionState: () => 'QUNS_ACCEPTS_NOTIFICATIONS',
};
