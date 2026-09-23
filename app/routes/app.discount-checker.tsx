import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

type DiscountRow = {
  id: string;
  title: string;
  status: string;
  kind: "code" | "automatic";
  discountType: string;
  scope: string;
  applies: boolean | null;
};

type CheckResult = {
  product: { id: string; title: string; imageUrl: string };
  restricted: boolean;
  discounts: DiscountRow[];
};

type DiscountItemsUnion = {
  __typename: string;
  allItems?: boolean;
  products?: { nodes: Array<{ id: string }> };
  collections?: { nodes: Array<{ id: string }> };
};

type DiscountUnion = {
  __typename: string;
  title: string;
  status: string;
  customerGets?: { items?: DiscountItemsUnion };
};

type DiscountsPage = {
  data?: {
    discountNodes?: {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      nodes: Array<{ id: string; discount: DiscountUnion | null }>;
    };
  };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

const ITEMS_FRAGMENT = `#graphql
  fragment DiscountItemsFields on DiscountItems {
    __typename
    ... on AllDiscountItems { allItems }
    ... on DiscountProducts { products(first: 250) { nodes { id } } }
    ... on DiscountCollections { collections(first: 100) { nodes { id } } }
  }
`;

const DISCOUNTS_QUERY = `#graphql
  ${ITEMS_FRAGMENT}
  query DiscountsForChecker($cursor: String) {
    discountNodes(first: 100, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        discount {
          __typename
          ... on DiscountCodeBasic { title status customerGets { items { ...DiscountItemsFields } } }
          ... on DiscountAutomaticBasic { title status customerGets { items { ...DiscountItemsFields } } }
          ... on DiscountCodeBxgy { title status customerGets { items { ...DiscountItemsFields } } }
          ... on DiscountAutomaticBxgy { title status customerGets { items { ...DiscountItemsFields } } }
          ... on DiscountCodeFreeShipping { title status }
          ... on DiscountAutomaticFreeShipping { title status }
          ... on DiscountCodeApp { title status }
          ... on DiscountAutomaticApp { title status }
        }
      }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = String(formData.get("productId") || "");
  if (!productId) return { ok: false, error: "No product selected." };

  const productResponse = await admin.graphql(
    `#graphql
      query ProductForChecker($id: ID!) {
        product(id: $id) {
          id
          title
          featuredImage { url }
          collections(first: 100) { nodes { id } }
          metafield(namespace: "free_gift_cart", key: "no_discount") { value }
        }
      }
    `,
    { variables: { id: productId } },
  );
  const productJson = await productResponse.json();
  const product = productJson.data?.product;
  if (!product) return { ok: false, error: "Product not found." };
  const productCollectionIds = new Set<string>((product.collections?.nodes ?? []).map((c: { id: string }) => c.id));
  const restricted = product.metafield?.value === "true";

  const discounts: DiscountRow[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const response = await admin.graphql(DISCOUNTS_QUERY, { variables: { cursor } });
    const json: DiscountsPage = await response.json();
    const page = json.data?.discountNodes;
    for (const node of page?.nodes ?? []) {
      const d = node.discount;
      if (!d) continue;
      const kind: DiscountRow["kind"] = d.__typename.startsWith("DiscountCode") ? "code" : "automatic";

      if (d.__typename === "DiscountCodeFreeShipping" || d.__typename === "DiscountAutomaticFreeShipping") {
        discounts.push({ id: node.id, title: d.title, status: d.status, kind, discountType: "Free shipping", scope: "Doesn't discount product price", applies: false });
        continue;
      }
      if (d.__typename === "DiscountCodeApp" || d.__typename === "DiscountAutomaticApp") {
        discounts.push({ id: node.id, title: d.title, status: d.status, kind, discountType: "App (function) discount", scope: "Determined dynamically at checkout — can't be checked here", applies: null });
        continue;
      }

      const items = d.customerGets?.items;
      let applies = false;
      let scope = "Unknown";
      if (items?.__typename === "AllDiscountItems") {
        applies = Boolean(items.allItems);
        scope = "All products";
      } else if (items?.__typename === "DiscountProducts") {
        const ids: string[] = (items.products?.nodes ?? []).map((p: { id: string }) => p.id);
        applies = ids.includes(productId);
        scope = "Specific products";
      } else if (items?.__typename === "DiscountCollections") {
        const ids: string[] = (items.collections?.nodes ?? []).map((c: { id: string }) => c.id);
        applies = ids.some((id) => productCollectionIds.has(id));
        scope = "Specific collections";
      }

      discounts.push({
        id: node.id,
        title: d.title,
        status: d.status,
        kind,
        discountType: d.__typename.includes("Bxgy") ? "Buy X get Y" : "Amount off order/products",
        scope,
        applies,
      });
    }
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    pages += 1;
  } while (cursor && pages < 10);

  discounts.sort((a, b) => Number(b.applies) - Number(a.applies));

  const result: CheckResult = {
    product: { id: product.id, title: product.title, imageUrl: product.featuredImage?.url || "" },
    restricted,
    discounts,
  };
  return { ok: true, result };
};

export default function DiscountChecker() {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [selected, setSelected] = useState<{ id: string; title: string; imageUrl: string } | null>(null);

  const pickProduct = async () => {
    const selection = await shopify.resourcePicker({ type: "product", multiple: false, filter: { variants: false } });
    if (!selection || selection.length === 0) return;
    const product = selection[0];
    const picked = { id: product.id, title: product.title, imageUrl: product.images?.[0]?.originalSrc || "" };
    setSelected(picked);
    fetcher.submit({ productId: picked.id }, { method: "POST", encType: "application/x-www-form-urlencoded" });
  };

  useEffect(() => {
    if (fetcher.data && !fetcher.data.ok && fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const result = fetcher.data?.ok ? fetcher.data.result : null;
  const loading = fetcher.state !== "idle";

  return (
    <s-page heading="Discounts on product">
      <s-section heading="Check a product">
        <s-stack gap="base">
          <s-paragraph color="subdued">Search a product to see every active discount (code and automatic) and whether it currently applies to it.</s-paragraph>
          <s-button icon="search" onClick={pickProduct} {...(loading ? { loading: true } : {})}>Select product</s-button>
          {selected && (
            <s-stack direction="inline" gap="base" alignItems="center">
              {selected.imageUrl && <s-thumbnail src={selected.imageUrl} alt={selected.title} size="small" />}
              <s-text>{selected.title}</s-text>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {result && (
        <s-section heading={`Discounts (${result.discounts.length})`}>
          {result.restricted && (
            <s-banner heading="No-discount product" tone="critical">This product is marked as No-Discount in your app settings. Any discount marked &ldquo;Yes&rdquo; below will block checkout while this product is in the cart.</s-banner>
          )}
          {result.discounts.length === 0 ? (
            <s-paragraph color="subdued">No active discounts found.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Discount</s-table-header>
                <s-table-header>Type</s-table-header>
                <s-table-header>Scope</s-table-header>
                <s-table-header>Applies to this product?</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {result.discounts.map((discount) => (
                  <s-table-row key={discount.id}>
                    <s-table-cell><s-text>{discount.title}</s-text></s-table-cell>
                    <s-table-cell><s-text color="subdued">{discount.kind === "code" ? "Code" : "Automatic"} · {discount.discountType}</s-text></s-table-cell>
                    <s-table-cell><s-text color="subdued">{discount.scope}</s-text></s-table-cell>
                    <s-table-cell>
                      <s-badge tone={discount.applies === true ? "critical" : discount.applies === false ? "neutral" : "caution"}>
                        {discount.applies === true ? "Yes" : discount.applies === false ? "No" : "Unknown"}
                      </s-badge>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      )}
    </s-page>
  );
}
