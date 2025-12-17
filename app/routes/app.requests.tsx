import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { AdminPage } from "~/ui/AdminPage";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function RequestsLayout() {
  return (
    <AdminPage title="Requests">
      <Outlet />
    </AdminPage>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
