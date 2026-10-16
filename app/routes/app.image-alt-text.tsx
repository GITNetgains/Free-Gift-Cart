import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

const ALT_MAX_LENGTH = 512;
// Name searches load several products at once, so keep each one's media and variant
// lists short enough to stay under the GraphQL query cost limit. A single product loads more.
const SEARCH_PRODUCT_LIMIT = 8;
const SEARCH_MEDIA_LIMIT = 40;
const SEARCH_VARIANT_LIMIT = 20;
const SINGLE_MEDIA_LIMIT = 250;
const SINGLE_VARIANT_LIMIT = 100;

type ProductImage = {
  id: string;
  alt: string;
  url: string;
  width: number | null;
  height: number | null;
  status: string;
  suggestion: string;
};

type ProductDetail = {
  id: string;
  title: string;
  status: string;
  mediaCount: number;
  hasMoreMedia: boolean;
  images: ProductImage[];
};

type MediaNode = {
  id: string;
  alt: string | null;
  mediaContentType: string;
  status: string;
  image?: { url: string; width: number | null; height: number | null } | null;
};

type VariantNode = {
  selectedOptions: Array<{ name: string; value: string }>;
  media?: { nodes: Array<{ id: string }> } | null;
};

type ProductNode = {
  id: string;
  title: string;
  status: string;
  vendor: string;
  productType: string;
  mediaCount?: { count: number } | null;
  media?: { pageInfo: { hasNextPage: boolean }; nodes: MediaNode[] } | null;
  variants?: { nodes: VariantNode[] } | null;
};

const PRODUCT_GID = "gid://shopify/Product/";

// Accepts a numeric ID, a product GID, or an admin product URL and returns the GID.
function toProductGid(input: string): string | null {
  const value = input.trim();
  if (/^\d+$/.test(value)) return PRODUCT_GID + value;
  const gid = value.match(/^gid:\/\/shopify\/Product\/(\d+)$/);
  if (gid) return PRODUCT_GID + gid[1];
  const url = value.match(/\/products\/(\d+)(?:[/?#]|$)/);
  if (url) return PRODUCT_GID + url[1];
  return null;
}

const numericId = (gid: string) => gid.split("/").pop() || "";

const PRODUCT_FIELDS = `#graphql
  fragment AltTextProductFields on Product {
    id
    title
    status
    vendor
    productType
    mediaCount { count }
    media(first: $mediaLimit) {
      pageInfo { hasNextPage }
      nodes {
        id
        alt
        mediaContentType
        status
        ... on MediaImage { image { url width height } }
      }
    }
    variants(first: $variantLimit) {
      nodes {
        selectedOptions { name value }
        media(first: 1) { nodes { id } }
      }
    }
  }
`;

const PRODUCT_BY_ID_QUERY = `#graphql
  ${PRODUCT_FIELDS}
  query ProductImagesForAltText($id: ID!, $mediaLimit: Int!, $variantLimit: Int!) {
    product(id: $id) { ...AltTextProductFields }
  }
`;

const PRODUCT_SEARCH_QUERY = `#graphql
  ${PRODUCT_FIELDS}
  query ProductSearchForAltText($query: String!, $first: Int!, $mediaLimit: Int!, $variantLimit: Int!) {
    products(first: $first, query: $query, sortKey: TITLE) {
      nodes { ...AltTextProductFields }
    }
  }
`;

// Generic camera/export names carry no meaning, so they are never used in a suggestion.
const GENERIC_FILE_WORDS = /^(img|image|dsc|dscn|dcim|pxl|photo|pic|picture|screenshot|screen shot|untitled|copy|final|edit|edited|new|web|large|small|thumb|thumbnail|product|main|front|default)$/i;

// Turns "red-leather-wallet_open_1a2b3c4d.jpg?v=123" into "red leather wallet open".
function wordsFromFileName(url: string, title: string): string {
  const file = decodeURIComponent(url.split("?")[0].split("/").pop() || "");
  const base = file.replace(/\.[a-z0-9]+$/i, "");
  const titleWords = new Set(title.toLowerCase().split(/\s+/));
  const words = base
    .split(/[\s_\-.+]+/)
    .filter((word) => word.length > 1)
    // Drop hashes, UUID chunks, dimensions and plain numbers that Shopify or cameras append.
    .filter((word) => !/^[0-9a-f]{6,}$/i.test(word) && !/\d{3,}/.test(word) && !/^\d+x\d+$/i.test(word))
    .filter((word) => !GENERIC_FILE_WORDS.test(word))
    // Skip words already in the product title so the suggestion doesn't repeat itself.
    .filter((word) => !titleWords.has(word.toLowerCase()));
  return words.length >= 1 && words.join("").length >= 3 ? words.join(" ").toLowerCase() : "";
}

// Builds a readable alt text for every image, preferring the variant the image belongs
// to (e.g. "Leather wallet - Red / Large"), then meaningful file name words, then the
// image's position. Suggestions are kept unique within the product.
function suggestAltTexts(node: ProductNode, images: Array<{ id: string; url: string }>): string[] {
  const variantLabel = new Map<string, string>();
  for (const variant of node.variants?.nodes ?? []) {
    const mediaId = variant.media?.nodes?.[0]?.id;
    if (!mediaId || variantLabel.has(mediaId)) continue;
    const values = variant.selectedOptions
      .filter((option) => option.value && option.value !== "Default Title")
      .map((option) => option.value);
    if (values.length > 0) variantLabel.set(mediaId, values.join(" / "));
  }

  const title = node.title.trim();
  const typeLabel = node.productType && !title.toLowerCase().includes(node.productType.toLowerCase()) ? node.productType.toLowerCase() : "";
  const used = new Set<string>();

  return images.map((image, index) => {
    const detail = variantLabel.get(image.id) || wordsFromFileName(image.url, title);
    let suggestion = detail ? `${title} - ${detail}` : index === 0 && typeLabel ? `${title} ${typeLabel}` : title;
    if (used.has(suggestion.toLowerCase()) || (!detail && images.length > 1 && index > 0)) {
      suggestion = `${suggestion} - view ${index + 1}`;
    }
    used.add(suggestion.toLowerCase());
    return suggestion.slice(0, ALT_MAX_LENGTH);
  });
}

function toProductDetail(node: ProductNode): ProductDetail {
  const mediaImages = (node.media?.nodes ?? []).filter((m) => m.mediaContentType === "IMAGE");
  const suggestions = suggestAltTexts(node, mediaImages.map((m) => ({ id: m.id, url: m.image?.url ?? "" })));
  const images = mediaImages.map((m, index) => ({
    id: m.id,
    alt: m.alt ?? "",
    url: m.image?.url ?? "",
    width: m.image?.width ?? null,
    height: m.image?.height ?? null,
    status: m.status,
    suggestion: suggestions[index],
  }));
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    mediaCount: node.mediaCount?.count ?? images.length,
    hasMoreMedia: Boolean(node.media?.pageInfo.hasNextPage),
    images,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();

  if (!q) return { q, products: [] as ProductDetail[], error: "" };

  try {
    const gid = toProductGid(q);
    if (gid) {
      const response = await admin.graphql(PRODUCT_BY_ID_QUERY, {
        variables: { id: gid, mediaLimit: SINGLE_MEDIA_LIMIT, variantLimit: SINGLE_VARIANT_LIMIT },
      });
      const json = await response.json();
      const node: ProductNode | null = json.data?.product ?? null;
      if (!node) return { q, products: [], error: `No product found with ID ${numericId(gid)}.` };
      return { q, products: [toProductDetail(node)], error: "" };
    }

    const escaped = q.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const response = await admin.graphql(PRODUCT_SEARCH_QUERY, {
      variables: { query: `title:*${escaped}*`, first: SEARCH_PRODUCT_LIMIT, mediaLimit: SEARCH_MEDIA_LIMIT, variantLimit: SEARCH_VARIANT_LIMIT },
    });
    const json = await response.json();
    const nodes: ProductNode[] = json.data?.products?.nodes ?? [];
    return { q, products: nodes.map(toProductDetail), error: "" };
  } catch (error) {
    console.error("Image alt text search failed", error);
    return { q, products: [], error: "Couldn't load products from Shopify. Please try again." };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  let updates: Array<{ id: string; alt: string }> = [];
  try {
    updates = JSON.parse(String(formData.get("updates") || "[]"));
  } catch {
    return { ok: false, error: "Invalid request." };
  }
  updates = updates
    .filter((u) => typeof u?.id === "string" && u.id.startsWith("gid://shopify/MediaImage/") && typeof u.alt === "string")
    .map((u) => ({ id: u.id, alt: u.alt.trim().slice(0, ALT_MAX_LENGTH) }));
  if (updates.length === 0) return { ok: false, error: "Nothing to save." };

  const response = await admin.graphql(
    `#graphql
      mutation UpdateImageAltText($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) {
          files { id alt }
          userErrors { field message code }
        }
      }
    `,
    { variables: { files: updates } },
  );
  const json = await response.json();
  const userErrors: Array<{ message: string }> = json.data?.fileUpdate?.userErrors ?? [];
  if (userErrors.length > 0) {
    return { ok: false, error: userErrors.map((e) => e.message).join(" ") };
  }
  const saved = json.data?.fileUpdate?.files?.length ?? 0;
  return { ok: true, saved };
};

type Drafts = Record<string, string>;

export default function ImageAltText() {
  const { q, products, error } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [search, setSearch] = useState(q);
  const [drafts, setDrafts] = useState<Drafts>({});

  useEffect(() => setSearch(q), [q]);

  // Existing alt text is loaded into each field; reset whenever the loaded images
  // (or their saved alt text) change.
  const dataKey = products.map((p) => p.images.map((i) => i.id + i.alt).join("|")).join("||");
  useEffect(() => {
    setDrafts(Object.fromEntries(products.flatMap((p) => p.images.map((image) => [image.id, image.alt]))));
  }, [dataKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) shopify.toast.show(`Alt text saved for ${fetcher.data.saved} image${fetcher.data.saved === 1 ? "" : "s"}`);
    else if (fetcher.data.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  const saving = fetcher.state !== "idle";
  const searching = navigation.state === "loading";

  const goTo = (query: string) => navigate(query ? `/app/image-alt-text?q=${encodeURIComponent(query)}` : "/app/image-alt-text");

  const pickProduct = async () => {
    const selection = await shopify.resourcePicker({ type: "product", multiple: false, filter: { variants: false } });
    if (!selection || selection.length === 0) return;
    goTo(numericId(selection[0].id));
  };

  const save = (images: ProductImage[]) => {
    const updates = images.map((image) => ({ id: image.id, alt: (drafts[image.id] ?? image.alt).trim() }));
    fetcher.submit({ updates: JSON.stringify(updates) }, { method: "POST", encType: "application/x-www-form-urlencoded" });
  };

  const totalImages = products.reduce((sum, p) => sum + p.images.length, 0);
  const totalMissing = products.reduce((sum, p) => sum + p.images.filter((i) => !i.alt.trim()).length, 0);

  return (
    <s-page heading="Image alt text">
      <s-section heading="Find a product">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Search by product name or product ID. Existing alt text is filled in for every image; images without alt text get a suggestion you can use or edit.
          </s-paragraph>
          <s-grid gridTemplateColumns="1fr auto auto" gap="base" alignItems="end">
            <form onSubmit={(event) => { event.preventDefault(); goTo(search.trim()); }}>
              <s-search-field label="Search products" labelAccessibilityVisibility="exclusive"
                placeholder="Product name, product ID or admin product URL"
                value={search} onInput={(event) => setSearch(event.currentTarget.value ?? "")} />
            </form>
            <s-button variant="primary" onClick={() => goTo(search.trim())} {...(searching ? { loading: true } : {})}>Search</s-button>
            <s-button icon="product" onClick={pickProduct}>Browse</s-button>
          </s-grid>
          {error && <s-banner tone="critical">{error}</s-banner>}
          {q && !error && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text color="subdued">
                {products.length === 0
                  ? <>No products match &ldquo;{q}&rdquo;.</>
                  : <>{products.length} product{products.length === 1 ? "" : "s"} · {totalImages} image{totalImages === 1 ? "" : "s"} · {totalMissing} missing alt text</>}
              </s-text>
              <s-button variant="tertiary" onClick={() => { setSearch(""); goTo(""); }}>Clear</s-button>
            </s-stack>
          )}
          {products.length === SEARCH_PRODUCT_LIMIT && (
            <s-paragraph color="subdued">Showing the first {SEARCH_PRODUCT_LIMIT} matches. Type a more specific name or use the product ID to narrow it down.</s-paragraph>
          )}
        </s-stack>
      </s-section>

      {products.map((product) => (
        <ProductImages
          key={product.id}
          product={product}
          drafts={drafts}
          setDrafts={setDrafts}
          saving={saving}
          onSave={save}
          onShowAll={() => goTo(numericId(product.id))}
        />
      ))}
    </s-page>
  );
}

function ProductImages({ product, drafts, setDrafts, saving, onSave, onShowAll }: {
  product: ProductDetail;
  drafts: Drafts;
  setDrafts: React.Dispatch<React.SetStateAction<Drafts>>;
  saving: boolean;
  onSave: (images: ProductImage[]) => void;
  onShowAll: () => void;
}) {
  const valueOf = (image: ProductImage) => drafts[image.id] ?? image.alt;
  const changed = product.images.filter((image) => valueOf(image).trim() !== image.alt);
  const empty = product.images.filter((image) => !valueOf(image).trim());

  const setDraft = (id: string, value: string) => setDrafts((current) => ({ ...current, [id]: value }));

  const useAllSuggestions = () => {
    setDrafts((current) => {
      const next = { ...current };
      for (const image of product.images) {
        if (!(next[image.id] ?? "").trim()) next[image.id] = image.suggestion;
      }
      return next;
    });
  };

  const discard = () => {
    setDrafts((current) => ({ ...current, ...Object.fromEntries(product.images.map((image) => [image.id, image.alt])) }));
  };

  return (
    <s-section>
      <s-stack gap="base">
        {/* Product header */}
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <s-stack gap="small-200">
            <s-heading>{product.title}</s-heading>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text color="subdued">ID {numericId(product.id)}</s-text>
              <s-badge tone={product.status === "ACTIVE" ? "success" : "neutral"}>{product.status.toLowerCase()}</s-badge>
              <s-badge>{product.images.length} image{product.images.length === 1 ? "" : "s"}</s-badge>
              {product.images.length > 0 && (empty.length > 0
                ? <s-badge tone="warning">{empty.length} missing alt text</s-badge>
                : <s-badge tone="success">All images have alt text</s-badge>)}
            </s-stack>
          </s-stack>
          {product.images.length > 0 && (
            <s-stack direction="inline" gap="small-200">
              {empty.length > 0 && <s-button icon="wand" onClick={useAllSuggestions}>Use {empty.length} suggestion{empty.length === 1 ? "" : "s"}</s-button>}
              <s-button disabled={changed.length === 0 || saving} onClick={discard}>Discard</s-button>
              <s-button variant="primary" disabled={changed.length === 0 || saving} onClick={() => onSave(changed)}
                {...(saving && changed.length > 0 ? { loading: true } : {})}>
                {changed.length > 0 ? `Save ${changed.length} change${changed.length === 1 ? "" : "s"}` : "Save"}
              </s-button>
            </s-stack>
          )}
        </s-grid>

        <s-divider />

        {product.images.length === 0 ? (
          <s-paragraph color="subdued">This product has no images.</s-paragraph>
        ) : (
          <s-grid gridTemplateColumns="repeat(4, minmax(0, 1fr))" gap="base">
            {product.images.map((image, index) => (
              <ImageCard
                key={image.id}
                image={image}
                index={index}
                value={valueOf(image)}
                saving={saving}
                onChange={(value) => setDraft(image.id, value)}
                onSave={() => onSave([image])}
              />
            ))}
          </s-grid>
        )}

        {product.hasMoreMedia && (
          <s-banner tone="info">
            Showing the first {product.images.length} images of {product.mediaCount} media items.{" "}
            <s-link onClick={onShowAll}>Show all images for this product</s-link>
          </s-banner>
        )}
      </s-stack>
    </s-section>
  );
}

function ImageCard({ image, index, value, saving, onChange, onSave }: {
  image: ProductImage;
  index: number;
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const dirty = value.trim() !== image.alt;
  const hasSavedAlt = Boolean(image.alt.trim());
  const isEmpty = !value.trim();

  return (
    <s-box padding="small" border="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-box borderRadius="base" overflow="hidden" background="subdued">
          <s-image src={image.url} alt={image.alt} aspectRatio="1/1" objectFit="contain" />
        </s-box>

        <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
          <s-text type="strong">Image {index + 1}</s-text>
          {dirty
            ? <s-badge tone="info">Unsaved</s-badge>
            : hasSavedAlt
              ? <s-badge tone="success">Has alt</s-badge>
              : <s-badge tone="warning">Missing alt</s-badge>}
        </s-stack>

        <s-text-area label="Alt text" rows={3} maxLength={ALT_MAX_LENGTH} value={value}
          placeholder={image.suggestion}
          details={`${value.length}/${ALT_MAX_LENGTH}`}
          onInput={(event) => onChange(event.currentTarget.value ?? "")} />

        {isEmpty && (
          <s-box padding="small-200" background="subdued" borderRadius="base">
            <s-stack gap="small-200">
              <s-text color="subdued">Suggested</s-text>
              <s-text>{image.suggestion}</s-text>
              <s-button variant="secondary" icon="wand" onClick={() => onChange(image.suggestion)}>Use suggestion</s-button>
            </s-stack>
          </s-box>
        )}

        <s-grid gridTemplateColumns="1fr auto" gap="small-200" alignItems="center">
          <s-link href={image.url} target="_blank">Full size</s-link>
          <s-button disabled={!dirty || saving} onClick={onSave}>Save</s-button>
        </s-grid>
      </s-stack>
    </s-box>
  );
}
