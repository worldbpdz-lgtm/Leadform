// app/routes/app.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

function NavLink({
  href,
  label,
  match = "exact",
}: {
  href: string;
  label: string;
  match?: "exact" | "prefix";
}) {
  const { pathname, search } = useLocation();
  const active = match === "exact" ? pathname === href : pathname.startsWith(href);

  // Preserve shop/host/embedded params across navigation
  const fullHref = `${href}${search || ""}`;

  return (
    <s-link href={fullHref} {...(active ? { active: true } : {})}>
      {label}
    </s-link>
  );
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <NavLink href="/app" label="Dashboard" match="exact" />
        <NavLink href="/app/requests" label="Requests" match="prefix" />
        <NavLink href="/app/requests/basket" label="Basket" match="exact" />
        <NavLink href="/app/forms" label="Form Builder" match="prefix" />
        <NavLink href="/app/roles" label="Roles" match="prefix" />
        <NavLink href="/app/integrations" label="Integrations" match="prefix" />
        <NavLink href="/app/pixels" label="Pixels" match="prefix" />
        <NavLink href="/app/settings" label="Settings" match="prefix" />
        <NavLink href="/app/billing" label="Billing" match="prefix" />
      </s-app-nav>

      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
