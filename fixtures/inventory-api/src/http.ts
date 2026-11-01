import type { Principal } from "./model.ts";
import type { InventoryRepository } from "./repository.ts";
import { createInventoryQueries } from "./queries.ts";

type Request = {
  principal: Principal;
  params: { id: string };
};

export function createInventoryEndpoints(repository: InventoryRepository) {
  const queries = createInventoryQueries(repository);

  return [
    {
      method: "GET",
      path: "/items/:id",
      handle(request: Request) {
        const item = queries.getItem(request.principal, request.params.id);
        return item
          ? { status: 200, body: item }
          : { status: 404, body: { error: "Item not found" } };
      },
    },
    {
      method: "GET",
      path: "/items/:id/availability",
      handle(request: Request) {
        const availability = queries.getAvailability(
          request.principal,
          request.params.id,
        );
        return availability
          ? { status: 200, body: availability }
          : { status: 404, body: { error: "Item not found" } };
      },
    },
  ];
}
