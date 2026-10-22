import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

// Opening the app lands on the dashboard; free gift settings live at /app/free-gift.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  throw redirect(`/app/dashboard${new URL(request.url).search}`);
};
