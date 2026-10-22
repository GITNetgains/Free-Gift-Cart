import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Anything opened from Shopify admin goes straight into the app (and on to the dashboard).
  if (url.searchParams.get("shop") || url.searchParams.get("host") || url.searchParams.get("embedded")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Zion App</h1>
        <p className={styles.text}>
          Free gifts, a customer help desk and checkout tools for your Shopify store.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Free gift offer</strong>. Reward carts over a set amount with a
            free gift, added from a cart popup and discounted automatically.
          </li>
          <li>
            <strong>Help Desk</strong>. A storefront support form with order lookup
            and image uploads, with every request in one place.
          </li>
          <li>
            <strong>Checkout tools</strong>. Country and state checkout notices,
            discount protection and inventory sync.
          </li>
        </ul>
      </div>
    </div>
  );
}
