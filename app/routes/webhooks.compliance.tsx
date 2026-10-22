import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { purgeShop, redactCustomer } from "../services/help-desk.server";

// Shopify's mandatory privacy webhooks. The Help Desk stores customers' names,
// emails, phone numbers, messages and photos, so erasure requests remove them.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const body = payload as { customer?: { id?: number; email?: string } };
  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      // The store owner answers data requests; Help Desk tickets for this
      // customer are listed in the app under their email.
      const count = body.customer?.email ? await db.helpDeskTicket.count({ where: { shop, email: body.customer.email } }) : 0;
      console.log(`customers/data_request for ${shop}: customer ${body.customer?.id} has ${count} Help Desk ticket(s)`);
      break;
    }
    case "CUSTOMERS_REDACT": {
      const count = await redactCustomer(db, shop, { email: body.customer?.email, id: body.customer?.id });
      console.log(`customers/redact for ${shop}: deleted ${count} Help Desk ticket(s) for customer ${body.customer?.id}`);
      break;
    }
    case "SHOP_REDACT":
      await purgeShop(db, shop);
      await db.inventorySyncPair.deleteMany({ where: { shop } });
      console.log(`shop/redact for ${shop}: Help Desk data erased`);
      break;
    default:
      console.log(`Unhandled compliance topic ${topic} for ${shop}`);
  }
  return new Response();
};
