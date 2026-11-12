import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { priceGiftsEnabledFor } from "../services/price-gifts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", priceGifts: priceGiftsEnabledFor(session.shop) };
};

export default function App() {
  const { apiKey, priceGifts } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app/dashboard">Dashboard</s-link>
        <s-link href="/app/photo-checks">Photo checks</s-link>
        <s-link href="/app/free-gift">Free gift settings</s-link>
        {priceGifts && <s-link href="/app/price-gifts">Price gifts</s-link>}
        <s-link href="/app/order-logs">Order logs</s-link>
        <s-link href="/app/checkout-notices">Checkout notices</s-link>
        <s-link href="/app/checkout-recommendations">Checkout recommendations</s-link>
        <s-link href="/app/inventory-sync">Inventory sync</s-link>
        <s-link href="/app/image-alt-text">Image alt text</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
