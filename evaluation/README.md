# Fixture evaluation

This directory contains evaluator-only expectations and executable checks. It
must not be included in an investigating agent's accessible source root.

For the inventory experiment, expose only `fixtures/inventory-api/`, never the
whole lab repository. Prepare a snapshot from that subtree when snapshot tooling
is available. The fixture README specifies the business rule and trust boundary;
it does not identify the affected endpoint.

Run the behavior checks locally with Node.js 24:

```sh
node --test evaluation/inventory-api.test.ts
```

These checks intentionally assert the seeded disclosure as current fixture
behavior. Passing means the fixture still represents the intended experiment;
it does not mean the application is secure. They invoke endpoint functions,
not an actual HTTP server or an LLM investigation.

## Inventory answer key

The caller's tenant must constrain both inventory reads. In `src/http.ts`, both
endpoints pass a trusted principal and a caller-controlled item ID to the query
layer. In `src/queries.ts`, `getAvailability` ignores the principal and uses
`findById`. In `src/repository.ts`, that lookup filters only by ID. A caller from
tenant A who knows an item ID from tenant B can obtain its quantity.

The detail endpoint is the secure counterpart for this specific issue:
`getItem` calls `findForTenant`, whose predicate matches both the ID and the
principal's tenant ID. A report accusing this path of the same missing tenant
constraint would need evidence overcoming that check.

Expected investigation evidence spans the HTTP entry point, query, and repository
predicate. Merely noticing an unused parameter is insufficient to establish the
complete data flow. A useful follow-up is to inspect the called repository method
after discovering how the query performs its lookup; the agent need not follow a
fixed file order.

The demonstrated disclosure assumes the documented trusted-principal boundary,
tenant-owned inventory, and knowledge of another tenant's item ID. Do not infer
unauthenticated access, ID enumeration, write access, or deployment exploitability
from this fixture. Additional reported issues require review rather than being
automatically classified as false positives. No complete security assessment of
the sample is claimed.
