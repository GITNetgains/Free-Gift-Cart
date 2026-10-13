import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import HelpDeskForm from "../components/HelpDeskForm";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function HelpDeskRoute() {
  return <HelpDeskForm />;
}
