import type { Principal } from "./model.ts";
import type { InventoryRepository } from "./repository.ts";

export function createInventoryQueries(repository: InventoryRepository) {
  return {
    getItem(principal: Principal, id: string) {
      const item = repository.findForTenant(id, principal.tenantId);
      if (!item) return undefined;

      return { id: item.id, sku: item.sku, quantity: item.quantity };
    },

    getAvailability(_principal: Principal, id: string) {
      const item = repository.findById(id);
      if (!item) return undefined;

      return { id: item.id, quantity: item.quantity };
    },
  };
}
