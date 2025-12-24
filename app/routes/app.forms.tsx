// app/routes/app.forms.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { AdminPage } from "~/ui/AdminPage";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export default function FormsLayout() {
  return (
    <AdminPage title="Form Builder">
      <Outlet />
    </AdminPage>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
