# Release 3.13.104: GIS and OIDC SSO

## Outcome

Ship the shared GIS and configuration-first OIDC SSO contracts through strict TypeScript
and the existing ORM, QueryBuilder, Session and HTTP surfaces.

## Scope

- [ ] Port GIS Point/PointField and spatial queries
- [ ] Run the shared GIS fixture against real PostGIS
- [ ] Implement OIDC SSO from the approved shared contract
- [ ] Run the shared SSO fixture against real Keycloak and Session storage
- [ ] Update exports, examples, skills and release notes

## Parity

| Feature | Python | PHP | Ruby | Node.js |
| --- | --- | --- | --- | --- |
| GIS | Reference | Owed | Owed | In progress |
| SSO | Owed | Owed | Owed | In progress |

## Tests: real services, positive and negative, no mocks

- [ ] `gis_contract.json`: real PostGIS, fixture read at runtime
- [ ] `sso_contract.json`: real Keycloak, socket and Session provider
- [ ] Named negative controls and mutations turn red
- [ ] Full suite green at release HEAD

## Bugs

- [ ] Record reproduced defects here and close them with regressions

## Commits

- (none)

## Status: In progress

