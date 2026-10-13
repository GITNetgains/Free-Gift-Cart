import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const HELP_DESK_PRODUCTS_QUERY = `#graphql
  query HelpDeskProducts($query: String!, $after: String) {
    products(first: 50, query: $query, after: $after, sortKey: TITLE) {
      nodes { id title }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const term = (url.searchParams.get("q") || "").trim().slice(0, 100).replace(/[\\":()*]/g, " ").trim();
  try {
    const response = await admin.graphql(HELP_DESK_PRODUCTS_QUERY, {
      variables: { query: term ? `title:*${term}*` : "", after: url.searchParams.get("after") || null },
    });
    const result = await response.json() as { errors?: unknown[]; data?: { products: { nodes: { id: string; title: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } };
    if (result.errors?.length || !result.data?.products) throw new Error("Product lookup failed");
    return { products: result.data.products.nodes as { id: string; title: string }[], pageInfo: result.data.products.pageInfo as { hasNextPage: boolean; endCursor: string | null }, error: null };
  } catch {
    return { products: [], pageInfo: { hasNextPage: false, endCursor: null }, error: "Products could not be loaded. Try searching again." };
  }
};
