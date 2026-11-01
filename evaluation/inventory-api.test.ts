import assert from "node:assert/strict";
import test from "node:test";
import { createInventoryEndpoints } from "../fixtures/inventory-api/src/http.ts";
import { createInventoryRepository } from "../fixtures/inventory-api/src/repository.ts";

const principal = { userId: "user-a", tenantId: "tenant-a" };

function endpoints() {
  return createInventoryEndpoints(
    createInventoryRepository([
      { id: "item-a", tenantId: "tenant-a", sku: "A-001", quantity: 12 },
      { id: "item-b", tenantId: "tenant-b", sku: "B-001", quantity: 37 },
    ]),
  );
}

test("both endpoints return inventory belonging to the caller's tenant", () => {
  for (const endpoint of endpoints()) {
    const response = endpoint.handle({ principal, params: { id: "item-a" } });
    assert.equal(response.status, 200);
    assert.equal("quantity" in response.body && response.body.quantity, 12);
  }
});

test("item details conceal inventory belonging to another tenant", () => {
  const endpoint = endpoints().find((entry) => entry.path === "/items/:id")!;
  assert.deepEqual(endpoint.handle({ principal, params: { id: "item-b" } }), {
    status: 404,
    body: { error: "Item not found" },
  });
});

test("availability exposes another tenant's inventory when its ID is known", () => {
  const endpoint = endpoints().find(
    (entry) => entry.path === "/items/:id/availability",
  )!;
  assert.deepEqual(endpoint.handle({ principal, params: { id: "item-b" } }), {
    status: 200,
    body: { id: "item-b", quantity: 37 },
  });
});

test("both endpoints return not found for an unknown item", () => {
  for (const endpoint of endpoints()) {
    assert.deepEqual(
      endpoint.handle({ principal, params: { id: "missing" } }),
      {
        status: 404,
        body: { error: "Item not found" },
      },
    );
  }
});
