# Backend status banner: keyboard and async status

Covers `frontend/components/ApiStatusBanner.tsx` (issue #446). The banner runs
health and status checks on load, on `online` and `offline` events, and on the
"Retry connection" and "Check status again" buttons. Its outcome was not
announced before: the banner unmounts on success, and a busy button was
`disabled`, which can drop focus.

## What changed

- `lib/api-status-announcement.js` (+ `.d.ts`): a pure reducer that turns check
  events into the text of a persistent `role="status"` region.
- The banner keeps that region mounted in every branch, so a result is spoken
  even when the banner disappears.
- Retry and check buttons use `aria-disabled` plus an in-flight guard, not
  `disabled`, so focus stays on the button while a check runs. This follows the
  convention in `docs/ACCESSIBILITY.md`.
- Decorative icons get `aria-hidden="true"`.
- Test: `tests/api-status-banner-a11y.test.js`.

## Announcement rules

| Path | Spoken (polite region) |
|------|------------------------|
| On-load check, backend up | Nothing (silent baseline) |
| On-load check, backend down | Nothing. The alert already shows the error. |
| Manual check starts | "Checking the Quittance API." |
| Manual check succeeds, was up | "The Quittance API is available." |
| Manual check succeeds, was down | "Connection restored. The Quittance API is available again." |
| Automatic check succeeds, was down (browser back online) | Same restored message |
| First failure after up | Nothing here. The `role="alert"` banner is newly mounted and announces itself. |
| Manual failure while already down | "Still unavailable. Attempt N." for N ≥ 2 |
| Automatic failure while down | Nothing (background checks stay quiet) |
| Browser goes offline | Alert text changes; nothing extra spoken |

Authorization: not applicable. The status and health endpoints are public and
the banner never gates on a wallet or a session. A 401 or 403 from those
endpoints falls into the failure path above, through `apiErrorMessage`.

## Edge cases

| Case | Behaviour |
|------|-----------|
| Retry pressed twice quickly | The second press returns early (`inFlight` ref). Nothing is re-announced. |
| StrictMode (`reactStrictMode: true`) double-runs the mount effect | Two silent automatic checks. The reducer is pure, so the result is the same. |
| Backend recovers after a manual retry | The banner unmounts. The restored message is spoken. Focus was on the retry button, which is removed, so focus falls to `body`. Known gap, see below. |
| Repeated manual success while up | The text does not change, so it is not re-announced. This is intended: nothing has changed. |
| Dismiss button activated | The banner unmounts and focus falls to `body`. Known gap. |
| `API_CONFIG.error` set at build time | The banner starts as down with `failures: 1`. The first manual retry says "Still unavailable. Attempt 2." |
| Offline, then online | Offline sets the alert. Online runs an automatic check. If it succeeds, the restored message is spoken. |

## Known gaps (not changed here)

- Focus is not moved when the banner unmounts after a successful retry or a
  dismiss. Moving it to the page `<main id="main-content">` would be a
  follow-up, and it changes focus order for every page, so it needs its own review.

## Rollback

The change is additive in behaviour. To roll back, restore the previous
`ApiStatusBanner.tsx`, delete `lib/api-status-announcement.js`,
`lib/api-status-announcement.d.ts` and `tests/api-status-banner-a11y.test.js`.
No API, storage or route changes, and no other module imports the new lib file.

## Verification (not run in this change)

```bash
cd frontend
node --test tests/api-status-banner-a11y.test.js
npm run lint
npm run typecheck
```

Manual check (screen reader on): with the backend stopped, open any page. Tab
to "Retry connection" and press Enter. Hear "Checking the Quittance API.", then
"Still unavailable. Attempt 2.". Start the backend, press Enter again, and hear
"Connection restored. The Quittance API is available again.". Focus stays on the
button during the check.
