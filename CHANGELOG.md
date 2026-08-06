# Changelog

## 0.3.1

**Drift detection no longer reports clean on files it cannot classify.**

`regen-drift` mapped implementation files to modules by directory name only. A
repository whose implementations live outside the module directory, such as
`impl/<stack>/`, had every changed file silently discarded, and the tool then
reported "No code-ahead drift" from an empty set. That is a false reassurance,
which is worse than a missed finding, and it meant drift detection had never
examined the reference demo at all.

- Unclassifiable code-shaped changes now report `CANNOT TELL` and exit non-zero
- Locks may declare `implementation_paths` to map code living outside the module
- Four regression tests added, 50 total

Found by exercising the reconciliation loop rather than by review.

## 0.3.0

- REP-0004: `risk` and `issue` item types, `depends_on` relation
- `regen-docs`: requirements, high-level design, detail design, RAID log, traceability matrix
- Derive-never-invent rule: silence renders as "Not specified" rather than invented prose

## 0.2.0

- REP-0002: modules documenting an HTTP interface must carry `api.openapi.yaml`
- Validator checks prose interface tables against the contract; the contract is authoritative
- Migration notes for trees with prose-only interfaces

## 0.1.0

Initial release: knowledge schema, JSON Schemas, validator, impact analysis,
knowledge debt report, drift detection, graph rendering.
