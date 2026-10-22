import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import sharp from "sharp";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const headers = { "Cache-Control": "private, no-store" };

// Returns one ticket image as a data URL, or with ?thumb=1 a small JPEG
// preview, for lists that show many images at once.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  const id = params.get("id") || "";
  const file = await db.helpDeskAttachment.findFirst({ where: { id, ticket: { shop: session.shop } } });
  if (!file) return data({ error: "This attachment is no longer available." }, { status: 404, headers });
  if (params.get("thumb")) {
    try {
      const thumb = await sharp(Buffer.from(file.data)).rotate().resize(240, 240, { fit: "cover" }).jpeg({ quality: 72 }).toBuffer();
      return data({ name: file.name, url: `data:image/jpeg;base64,${thumb.toString("base64")}` }, { headers });
    } catch {
      // Fall through to the original image.
    }
  }
  return data({ name: file.name, url: `data:${file.type};base64,${Buffer.from(file.data).toString("base64")}` }, { headers });
};
