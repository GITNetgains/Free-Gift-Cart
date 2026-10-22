import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = new URL(request.url).searchParams.get("id") || "";
  const file = await db.helpDeskAttachment.findFirst({ where: { id, ticket: { shop: session.shop } } });
  if (!file) return data({ error: "This attachment is no longer available." }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  return data({ name: file.name, url: `data:${file.type};base64,${Buffer.from(file.data).toString("base64")}` }, { headers: { "Cache-Control": "private, no-store" } });
};
