# Glossary

Terms shared across modules. Module-local terms live in that module's
`knowledge/glossary.md`.

**Customer.** A person with an account. Retains identity after deletion, since
deletion is soft (ADR-001).

**Address.** A postal destination in a customer's address book. Distinct from
the copy captured on an order, which is a snapshot and never changes.

**Default address.** The single address used for shipping unless another is
chosen at placement. Every customer with at least one address has exactly one.

**Deleted.** An account marked deleted and retained. Not removed. A deleted
customer cannot authenticate and their email is never released for reuse.

**Order.** A confirmed purchase. Holds its own copy of the shipping address as
it stood at placement.
