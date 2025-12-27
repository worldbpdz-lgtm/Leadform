// app/routes/app.integrations.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { AdminPage } from "~/components/AdminPage";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function IntegrationsLayout() {
  return (
    <AdminPage title="Integrations">
      <Outlet />
    </AdminPage>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
