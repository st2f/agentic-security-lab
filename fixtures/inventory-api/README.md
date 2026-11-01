# Inventory API source sample

This source sample models two read endpoints for warehouse inventory:

- `GET /items/:id` returns item details.
- `GET /items/:id/availability` returns the current quantity.

Inventory records belong to tenants. An authenticated user may read inventory only within their own tenant, regardless of whether another item's ID is known.

The hosting HTTP adapter authenticates the caller and supplies a trusted `principal` containing their user and tenant IDs. Request parameters remain caller-controlled. Authentication itself is outside this sample; the principal is not populated from request parameters or an unverified token.

Entry points are in `src/http.ts`. Application queries and the in-memory repository represent the application and persistence boundaries. Responses use HTTP-style status codes, but no server or database is required. The repository is initialized with rows by its caller; no external service is contacted.
