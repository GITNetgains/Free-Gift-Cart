import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { setUpsGroundCarrier, upsGroundCarrierStatus } from "../services/ups-ground-carrier.server";

// Two parts work together, and this switch turns both on or off:
// 1. extensions/ups-ground-shipping: a delivery customization that hides
//    options. Shopify only runs it while a delivery customization for that
//    function exists and is enabled.
// 2. The app's own UPS Ground carrier rate (live price from ShipStation), only
//    in zones that cover nothing but Alaska and/or Hawaii.
const FUNCTION_HANDLE = "ups-ground-shipping";
const TITLE = "UPS Ground for Alaska and Hawaii";

type Admin = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

async function findCustomization(admin: Admin) {
  const response = await admin.graphql(`#graphql
    query UpsGroundCustomization {
      deliveryCustomizations(first: 50) {
        nodes { id enabled shopifyFunction { handle } }
      }
    }
  `);
  const json = await response.json();
  const nodes = (json.data?.deliveryCustomizations?.nodes ?? []) as Array<{ id: string; enabled: boolean; shopifyFunction?: { handle?: string } }>;
  return nodes.find((node) => node.shopifyFunction?.handle === FUNCTION_HANDLE) ?? null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const [customization, carrier] = await Promise.all([findCustomization(admin), upsGroundCarrierStatus(admin)]);
  return { enabled: Boolean(customization?.enabled), carrier };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const enabled = (await request.formData()).get("enabled") === "true";
  const existing = await findCustomization(admin);

  const response = existing
    ? await admin.graphql(`#graphql
        mutation UpdateUpsGround($id: ID!, $input: DeliveryCustomizationInput!) {
          deliveryCustomizationUpdate(id: $id, deliveryCustomization: $input) {
            deliveryCustomization { enabled }
            userErrors { message }
          }
        }
      `, { variables: { id: existing.id, input: { enabled } } })
    : await admin.graphql(`#graphql
        mutation CreateUpsGround($input: DeliveryCustomizationInput!) {
          deliveryCustomizationCreate(deliveryCustomization: $input) {
            deliveryCustomization { enabled }
            userErrors { message }
          }
        }
      `, { variables: { input: { title: TITLE, functionHandle: FUNCTION_HANDLE, enabled } } });

  const json = await response.json();
  const payload = existing ? json.data?.deliveryCustomizationUpdate : json.data?.deliveryCustomizationCreate;
  if (!payload?.deliveryCustomization) {
    return { error: payload?.userErrors?.[0]?.message || "The shipping rule could not be saved." };
  }

  const carrierError = await setUpsGroundCarrier(admin, enabled);
  const carrier = await upsGroundCarrierStatus(admin);
  if (carrierError) return { error: carrierError, enabled: Boolean(payload.deliveryCustomization.enabled), carrier };
  return { enabled: Boolean(payload.deliveryCustomization.enabled), carrier };
};

export default function ShippingRules() {
  const loaded = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const pending = fetcher.formData?.get("enabled");
  const enabled = pending != null
    ? pending === "true"
    : fetcher.data && "enabled" in fetcher.data ? Boolean(fetcher.data.enabled) : loaded.enabled;
  const carrier = fetcher.data && "carrier" in fetcher.data && fetcher.data.carrier ? fetcher.data.carrier : loaded.carrier;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if ("error" in fetcher.data && fetcher.data.error) shopify.toast.show(fetcher.data.error, { isError: true });
    else shopify.toast.show(fetcher.data.enabled ? "UPS Ground rule turned on" : "UPS Ground rule turned off");
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <s-page heading="Shipping rules">
      <s-section heading="UPS Ground for Alaska and Hawaii">
        <s-stack gap="base">
          <s-switch
            label="Turn on this shipping rule"
            checked={enabled}
            disabled={fetcher.state !== "idle"}
            onChange={() => fetcher.submit({ enabled: String(!enabled) }, { method: "post" })}
          />
          <s-paragraph>When this is on, checkout follows these rules:</s-paragraph>
          <s-unordered-list>
            <s-list-item>Alaska and Hawaii addresses only see UPS Ground. Every other shipping option is hidden.</s-list-item>
            <s-list-item>If ShipStation doesn't offer UPS Ground, the app adds its own UPS Ground rate. The price comes live from ShipStation, using your UPS account and the Gifford, IL warehouse. If ShipStation doesn't answer in time, it shows $75.00.</s-list-item>
            <s-list-item>If both UPS Ground rates show up, only the cheaper one is kept.</s-list-item>
            <s-list-item>Addresses in every other state never see UPS Ground. No other shipping zone changes.</s-list-item>
          </s-unordered-list>
          <s-badge tone={enabled ? "success" : "neutral"}>{enabled ? "On" : "Off"}</s-badge>
        </s-stack>
      </s-section>
      <s-section heading="App UPS Ground rate">
        <s-stack gap="small">
          <s-paragraph>Status: {carrier.active ? "Active" : "Off"}</s-paragraph>
          <s-paragraph>
            Shipping zones it's added to: {carrier.zones.length ? carrier.zones.join(", ") : "none yet"}
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}
