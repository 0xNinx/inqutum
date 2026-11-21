/**
 * Announcements for the backend connection banner (issue #446).
 *
 * ApiStatusBanner checks the API on load, when the browser comes back online,
 * and when the payer presses "Retry connection" or "Check status again". The
 * banner itself mounts and unmounts with the state, so it cannot reliably carry
 * the outcome of a check. This pure reducer turns each check event into the
 * text a persistent polite status region should speak (WCAG 2.1 SC 4.1.3).
 *
 * Rules:
 *  - The on-load check is a silent baseline. A backend that is already down at
 *    load is shown by the alert itself and is not announced again.
 *  - Only manual checks (a button press) announce "Checking", the result of a
 *    successful manual check, and repeated manual failures. Automatic checks
 *    (load, online, offline) stay silent, like background polling on the pay page.
 *  - Recovery is always announced, including an automatic one, because the
 *    payer is otherwise left with a banner that disappears silently.
 *  - A manual failure while already down appends "Attempt N." so the region
 *    text changes and the repeated failure is spoken again. A success resets the
 *    count, and the next failure starts again at attempt 1.
 *  - The first failure after an up state does not speak here; the role="alert"
 *    banner is newly mounted and announces itself.
 */

const API_STATUS_COPY = Object.freeze({
  checking: 'Checking the Quittance API.',
  restored: 'Connection restored. The Quittance API is available again.',
  available: 'The Quittance API is available.',
  stillDown: (attempt) => `Still unavailable. Attempt ${attempt}.`,
});

const UNKNOWN_API_STATUS = Object.freeze({ status: 'unknown', polite: '', failures: 0 });

/** Starting announcement. A configuration error means the backend is already known to be down. */
function initialApiStatusAnnouncement(configError) {
  return configError ? Object.freeze({ status: 'down', polite: '', failures: 1 }) : UNKNOWN_API_STATUS;
}

/**
 * Event shapes:
 *   { type: 'CHECK_STARTED', manual }
 *   { type: 'CHECK_SUCCEEDED', manual }
 *   { type: 'CHECK_FAILED', manual }
 * Unknown events return the previous announcement unchanged.
 */
function nextApiStatusAnnouncement(prev, event) {
  const previous = prev ?? UNKNOWN_API_STATUS;
  const manual = Boolean(event?.manual);

  switch (event?.type) {
    case 'CHECK_STARTED':
      return { ...previous, polite: manual ? API_STATUS_COPY.checking : '' };

    case 'CHECK_SUCCEEDED': {
      const wasDown = previous.status === 'down';
      let polite = '';
      if (wasDown) polite = API_STATUS_COPY.restored;
      else if (manual) polite = API_STATUS_COPY.available;
      return { status: 'up', polite, failures: 0 };
    }

    case 'CHECK_FAILED': {
      const failures = previous.status === 'down' ? previous.failures + 1 : 1;
      const polite = manual && failures > 1 ? API_STATUS_COPY.stillDown(failures) : '';
      return { status: 'down', polite, failures };
    }

    default:
      return previous;
  }
}

module.exports = {
  API_STATUS_COPY,
  initialApiStatusAnnouncement,
  nextApiStatusAnnouncement,
};
