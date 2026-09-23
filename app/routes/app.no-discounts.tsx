import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

type RestrictedProduct = { id: string; title: string; imageUrl: string };
type RestrictionSettings = { enabled: boolean; products: RestrictedProduct[]; validationId?: string };
const DEFAULT_SETTINGS: RestrictionSettings = { enabled: true, products: [] };
const SETTINGS_QUERY = `#graphql
  query NoDiscountSettings {
    shop {
      id
      metafield(namespace: "free_gift_cart", key: "no_discount_products") { jsonValue }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(SETTINGS_QUERY);
  const json = await response.json();
  const saved = json.data?.shop?.metafield?.jsonValue as Partial<RestrictionSettings> | undefined;
  return { settings: { ...DEFAULT_SETTINGS, ...saved, products: Array.isArray(saved?.products) ? saved.products : [] } };
};

async function ensureValidation(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  validationId?: string,
) {
  if (validationId) {
    const response = await admin.graphql(
      `#graphql
        mutation UpdateNoDiscountValidation($id: ID!) {
          validationUpdate(id: $id, validation: { title: "Block discounts on restricted products", enable: true, blockOnFailure: true }) {
            validation { id }
            userErrors { message }
          }
        }
      `,
      { variables: { id: validationId } },
    );
    const json = await response.json();
    if (json.data?.validationUpdate?.validation?.id) return { id: json.data.validationUpdate.validation.id as string };
  }
  const response = await admin.graphql(
    `#graphql
      mutation CreateNoDiscountValidation {
        validationCreate(validation: {
          title: "Block discounts on restricted products"
          functionHandle: "no-discount-products"
          enable: true
          blockOnFailure: true
        }) {
          validation { id }
          userErrors { message }
        }
      }
    `,
  );
  const json = await response.json();
  const payload = json.data?.validationCreate;
  return payload?.validation?.id
    ? { id: payload.validation.id as string }
    : { error: payload?.userErrors?.[0]?.message || "Checkout validation could not be activated." };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  let settings: RestrictionSettings;
  try {
    const incoming = JSON.parse(String(formData.get("settings"))) as RestrictionSettings;
    settings = {
      enabled: Boolean(incoming.enabled),
      products: Array.isArray(incoming.products)
        ? Array.from(new Map(incoming.products.filter((product) => product.id).map((product) => [product.id, product])).values())
        : [],
      validationId: incoming.validationId,
    };
  } catch {
    return { ok: false, error: "Settings payload is invalid." };
  }

  const validation = await ensureValidation(admin, settings.validationId);
  if (validation.error || !validation.id) return { ok: false, error: validation.error || "Checkout validation could not be activated." };
  settings.validationId = validation.id;

  const shopResponse = await admin.graphql(SETTINGS_QUERY);
  const shopJson = await shopResponse.json();
  const previousSettings = shopJson.data?.shop?.metafield?.jsonValue as Partial<RestrictionSettings> | undefined;
  const previousIds = new Set((previousSettings?.products ?? []).map((product) => product.id));
  const newIds = new Set(settings.products.map((product) => product.id));
  const removedIds = [...previousIds].filter((id) => !newIds.has(id));

  const metafields = [
    {
      ownerId: shopJson.data!.shop!.id,
      namespace: "free_gift_cart",
      key: "no_discount_products",
      type: "json",
      value: JSON.stringify(settings),
    },
    ...settings.products.map((product) => ({
      ownerId: product.id,
      namespace: "free_gift_cart",
      key: "no_discount",
      type: "boolean",
      value: "true",
    })),
    ...removedIds.map((id) => ({
      ownerId: id,
      namespace: "free_gift_cart",
      key: "no_discount",
      type: "boolean",
      value: "false",
    })),
  ];

  const saveResponse = await admin.graphql(
    `#graphql
      mutation SaveNoDiscountSettings($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { metafields { id } userErrors { message } }
      }
    `,
    { variables: { metafields } },
  );
  const saveJson = await saveResponse.json();
  const error = saveJson.data?.metafieldsSet?.userErrors?.[0]?.message;
  return error ? { ok: false, error } : { ok: true, settings };
};

export default function NoDiscountProducts() {
  const initial = useLoaderData<typeof loader>().settings;
  const [settings, setSettings] = useState<RestrictionSettings>(initial);
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const selectedIds = useMemo(() => settings.products.map((product) => ({ id: product.id })), [settings.products]);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      if (fetcher.data.settings) setSettings(fetcher.data.settings);
      shopify.toast.show("No-discount products saved");
    } else if (fetcher.data.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  const selectProducts = async () => {
    const selection = await shopify.resourcePicker({ type: "product", multiple: true, selectionIds: selectedIds, filter: { variants: false } });
    if (!selection) return;
    const selectedProducts = selection.map((product) => ({
      id: product.id,
      title: product.title,
      imageUrl: product.images?.[0]?.originalSrc || "",
    }));
    setSettings((current) => ({
      ...current,
      products: Array.from(
        new Map([...current.products, ...selectedProducts].map((product) => [product.id, product])).values(),
      ),
    }));
  };
  const save = () => fetcher.submit({ settings: JSON.stringify(settings) }, { method: "POST", encType: "application/x-www-form-urlencoded" });

  return (
    <s-page heading="No-discount products">
      <s-button slot="primary-action" variant="primary" icon="save" onClick={save} {...(fetcher.state !== "idle" ? { loading: true } : {})}>Save</s-button>
      <s-section heading="Checkout protection">
        <s-stack gap="base">
          <s-switch label="Block checkout when these products receive a discount" checked={settings.enabled} onChange={(event) => {
            const enabled = event.currentTarget.checked;
            setSettings((current) => ({ ...current, enabled }));
          }} />
          <s-paragraph color="subdued">Customers cannot complete checkout while any selected product has a discount. They must remove the discount first.</s-paragraph>
          <s-button icon="product-add" onClick={selectProducts}>Select products</s-button>
        </s-stack>
      </s-section>
      <s-section heading={`Restricted products (${settings.products.length})`}>
        {settings.products.length === 0 ? <s-paragraph color="subdued">No restricted products selected.</s-paragraph> : (
          <s-table>
            <s-table-header-row><s-table-header listSlot="primary">Product</s-table-header><s-table-header></s-table-header></s-table-header-row>
            <s-table-body>{settings.products.map((product) => (
              <s-table-row key={product.id}>
                <s-table-cell><s-stack direction="inline" gap="base" alignItems="center">{product.imageUrl && <s-thumbnail src={product.imageUrl} alt={product.title} size="small" />}<s-text>{product.title}</s-text></s-stack></s-table-cell>
                <s-table-cell><s-button icon="x" variant="tertiary" accessibilityLabel={`Remove ${product.title}`} onClick={() => setSettings((current) => ({ ...current, products: current.products.filter((item) => item.id !== product.id) }))} /></s-table-cell>
              </s-table-row>
            ))}</s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
