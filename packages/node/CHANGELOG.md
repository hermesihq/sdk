# Changelog

All notable changes to `@hermesihq/node`.

This file describes what a consumer gets, not how it was built. The repository's history is where the reasoning lives.

## Versioning

**`0.x` means the public API can still change.** A minor bump (`0.1` to `0.2`) may contain a breaking change; a patch bump will
not. That is the ordinary `0.x` reading of semver, chosen deliberately: this SDK's shape is still being learned from the first
integrations.

`1.0.0` is the commitment that a breaking change requires a major bump. It waits until at least one real integration exists.

## 0.2.0 (2026-10-07)

### Added

- **`events.get(eventId)`**: the notification each recipient got from an event and the messages each produced, with how far each
  got. `EventRun`, `RunNotification`, `Message` (`isFinal` tells when nothing more will happen).
- **Subscribers**: `subscribers.put`, `patch`, `get`, `delete`, `registerChannel`, `removeChannel`, `preferences` and
  `updatePreferences`. A field you give is set, `null` clears it and one you leave out is left alone; `data` replaces. An unknown
  field name is a `TypeError`. `SubscriberProfile`, `ChannelIdentity`, `Preferences`.
- **`messages.send` and `messages.get`**: the direct send, for when the channel is a requirement (an OTP that must be an SMS). It
  keeps one idempotency key across its retries, generated if you give none. `MessageResult`.
- `ConflictError` for a `409`, `HermesiSimulationError`, `simulatedCalls` and `SimulatedCall` for test mode. In test mode reads throw
  rather than invent an answer.

### Fixed

- **The documentation showed `delay: '15m'`**, a format the server does not accept: `delay` is an ISO 8601 duration, `'PT15M'`.
  It also did not say that the API ignored `sendAt` and `delay` until now; Hermesi now honours them (or refuses a request it
  cannot honour with `422 invalid_schedule`). The README has a Scheduling section.

## 0.1.0 (2026-10-04)

First release.

### Added

- `new Hermesi({ apiKey, baseUrl })` with `events.trigger(...)`, `subscribers.preferenceLink(...)` and `tokens.mint(...)`.
- Retries on connection failures, timeouts, `429` (honouring `Retry-After`) and `5xx`, with backoff and jitter.
- An idempotency key on every event, generated if you give none and kept across retries.
- Payloads that JSON would silently corrupt (a `Map`, `NaN`, an invalid `Date`) are refused before anything is sent.
- `simulate: true`, which records events instead of sending them.
- Typed errors: `HermesiAPIError` and its subclasses by status, `HermesiConnectionError`.
- ESM and CommonJS builds. No dependencies; Node 20 and later.
