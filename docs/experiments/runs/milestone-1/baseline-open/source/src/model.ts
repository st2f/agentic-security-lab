export type Principal = {
  userId: string;
  tenantId: string;
};

export type InventoryItem = {
  id: string;
  tenantId: string;
  sku: string;
  quantity: number;
};
