# Changelog

Tina4 keeps ONE version across all four frameworks (Python, PHP, Ruby, Node.js), so a version
number means the same thing everywhere.

**The authoritative release notes for every shipped version live in the documentation:**
https://tina4.com/nodejs/36-releases

This file is deliberately NOT a copy of those notes. Duplicating them is exactly how a
changelog rots into claiming a version that was never cut, so this file records only
UNRELEASED work. When a version ships, its notes go to the release notes above.

## Unreleased

### Added

- **MQTT 3.1.1 client** (`Mqtt` / `MqttMessage`), zero-dependency (`node:net` + `node:tls`),
  verified against a real broker with no mocks. Async by design: connect/publish/subscribe/receive
  return promises and `consume` is an async generator. QoS 0/1, retained, Last Will, per-connection
  TLS, QoS 2 refused loudly. Takes the family to **98 built-in features**.

### Changed

- Internal: the SQL dialect-translation module is renamed
  `packages/orm/src/sqlTranslation.ts` -> `packages/orm/src/sqlTranslator.ts`, so the filename
  matches the `SQLTranslator` class it exports (and the sibling frameworks). Consumers import the
  class by name from the package barrel (`export { SQLTranslator, QueryCache }`), and no exports
  map ever pointed at the file path, so this is a filename alignment with no API change.
