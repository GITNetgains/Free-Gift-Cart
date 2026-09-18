export type GraphqlClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{ json(): Promise<unknown> }>;
};

export const VARIANTS_QUERY = `#graphql
  query InventorySyncVariants($ids: [ID!]!, $locationId: ID!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id title inventoryPolicy product { id title }
        inventoryItem {
          id tracked
          inventoryLevel(locationId: $locationId) { quantities(names: ["available"]) { name quantity } }
        }
      }
    }
    location(id: $locationId) { id name isActive fulfillmentService { id } }
  }
`;

export const LOCATIONS_QUERY = `#graphql
  query InventorySyncLocations($after: String) {
    locations(first: 100, after: $after) {
      nodes { id name isActive fulfillmentService { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const SET_QUANTITY_MUTATION = `#graphql
  mutation InventorySyncSet($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { code message }
    }
  }
`;

export async function query<T>(admin: GraphqlClient, operation: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await admin.graphql(operation, { variables });
  const body = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length || !body.data) throw new Error(body.errors?.map((e) => e.message).join("; ") || "Shopify returned no data.");
  return body.data;
}

type Variant = {
  id: string; title: string; inventoryPolicy: string; product: { id: string; title: string };
  inventoryItem: { id: string; tracked: boolean; inventoryLevel: { quantities: Array<{ name: string; quantity: number }> } | null };
};
export type SyncLocation = { id: string; name: string; isActive: boolean; fulfillmentService: { id: string } | null };

export async function locations(admin: GraphqlClient) {
  const result: SyncLocation[] = [];
  let after: string | null = null;
  do {
    const data: { locations: { nodes: SyncLocation[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await query(admin, LOCATIONS_QUERY, { after });
    result.push(...data.locations.nodes.filter((location) => location.isActive && !location.fulfillmentService));
    after = data.locations.pageInfo.hasNextPage ? data.locations.pageInfo.endCursor : null;
  } while (after);
  return result;
}

export async function readPair(admin: GraphqlClient, originalId: string, duplicateId: string, locationId: string) {
  if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(originalId) || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(duplicateId) || !/^gid:\/\/shopify\/Location\/\d+$/.test(locationId)) {
    throw new Error("Select two product variants and a location.");
  }
  if (originalId === duplicateId) throw new Error("Original and duplicate must be different variants.");
  const data = await query<{ nodes: Array<Variant | null>; location: SyncLocation | null }>(admin, VARIANTS_QUERY, { ids: [originalId, duplicateId], locationId });
  if (!data.location?.isActive || data.location.fulfillmentService) throw new Error("Choose an active merchant-managed location.");
  const [original, duplicate] = data.nodes;
  if (!original || !duplicate) throw new Error("A selected variant no longer exists or is not accessible.");
  if (original.product.id === duplicate.product.id) throw new Error("Choose a duplicate from a different product.");
  for (const variant of [original, duplicate]) {
    if (!variant.inventoryItem.tracked) throw new Error(`Enable inventory tracking for ${variant.product.title}.`);
    if (variant.inventoryPolicy !== "DENY") throw new Error(`Turn off 'Continue selling when out of stock' for ${variant.product.title}.`);
    if (!variant.inventoryItem.inventoryLevel) throw new Error(`Stock ${variant.product.title} at the selected location first.`);
  }
  const available = (variant: Variant) => {
    const quantity = variant.inventoryItem.inventoryLevel?.quantities.find((q) => q.name === "available")?.quantity;
    if (!Number.isInteger(quantity)) throw new Error("Available inventory is missing.");
    return quantity as number;
  };
  return { original, duplicate, location: data.location, originalQuantity: available(original), duplicateQuantity: available(duplicate) };
}

export class InventoryRejectedError extends Error {}

export async function setQuantity(admin: GraphqlClient, input: { itemId: string; locationId: string; quantity: number; compareQuantity: number; key: string; pairId: string }) {
  const data = await query<{ inventorySetQuantities: { inventoryAdjustmentGroup: unknown; userErrors: Array<{ code: string; message: string }> } }>(admin, SET_QUANTITY_MUTATION, {
    key: input.key,
    input: { name: "available", reason: "correction", referenceDocumentUri: `inventory-sync://pairs/${input.pairId}`, quantities: [{ inventoryItemId: input.itemId, locationId: input.locationId, quantity: input.quantity, compareQuantity: input.compareQuantity }] },
  });
  const payload = data.inventorySetQuantities;
  if (payload?.userErrors?.length) throw new InventoryRejectedError(payload.userErrors.map((error) => error.message).join("; "));
  if (!payload?.inventoryAdjustmentGroup) throw new Error("Inventory update result is unknown; retrying with the same request key.");
}
