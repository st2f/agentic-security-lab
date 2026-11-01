import type { InventoryItem } from "./model.ts";

export function createInventoryRepository(rows: readonly InventoryItem[]) {
  const items = rows.map((row) => ({ ...row }));

  return {
    findById(id: string): InventoryItem | undefined {
      return items.find((item) => item.id === id);
    },

    findForTenant(id: string, tenantId: string): InventoryItem | undefined {
      return items.find((item) => item.id === id && item.tenantId === tenantId);
    },
  };
}

export type InventoryRepository = ReturnType<typeof createInventoryRepository>;
