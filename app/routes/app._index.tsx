import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "~/shopify.server";
import { AdminPage } from "~/ui/AdminPage";
import { prisma } from "~/db.server";

type LoaderData = {
  kpis: {
    requestsToday: number;
    pending: number;
    lastSyncAt: string | null; // ISO string
  };
};

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Resolve this shop in your DB (Shop.shopDomain is @unique)
  const shopRow = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!shopRow) {
    const data: LoaderData = {
      kpis: { requestsToday: 0, pending: 0, lastSyncAt: null },
    };
    return data;
  }

  const now = new Date();
  const todayStart = startOfDay(now);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  // RequestStatus enum values (lowercase) from schema.prisma
  const pendingStatuses = ["received", "in_review"] as const;

  const [requestsToday, pending, last] = await Promise.all([
    prisma.request.count({
      where: {
        shopId: shopRow.id,
        createdAt: { gte: todayStart, lt: tomorrowStart },
      },
    }),
    prisma.request.count({
      where: {
        shopId: shopRow.id,
        status: { in: pendingStatuses as any },
      },
    }),
    prisma.sheetsSyncLog.findFirst({
      where: { connection: { shopId: shopRow.id } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  const lastSyncAt = last?.createdAt ? last.createdAt.toISOString() : null;

  const data: LoaderData = {
    kpis: { requestsToday, pending, lastSyncAt },
  };
  return data;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const color = ["Red", "Orange", "Yellow", "Green"][
    Math.floor(Math.random() * 4)
  ];

  const response = await admin.graphql(
    `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
          }
        }
      }`,
    {
      variables: {
        product: {
          title: `${color} Snowboard`,
        },
      },
    }
  );

  const responseJson = await response.json();
  const product = responseJson.data!.productCreate!.product!;
  const variantId = product.variants.edges[0]!.node!.id!;

  const variantResponse = await admin.graphql(
    `#graphql
      mutation shopifyReactRouterTemplateUpdateVariant(
        $productId: ID!
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants {
            id
            price
            barcode
            createdAt
          }
        }
      }`,
    {
      variables: {
        productId: product.id,
        variants: [{ id: variantId, price: "100.00" }],
      },
    }
  );

  const variantResponseJson = await variantResponse.json();

  return {
    product: responseJson!.data!.productCreate!.product,
    variant:
      variantResponseJson!.data!.productVariantsBulkUpdate!.productVariants,
  };
};

export default function Index() {
  const { kpis } = useLoaderData() as LoaderData;

  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.data?.product?.id) {
      shopify.toast.show("Test action completed");
    }
  }, [fetcher.data?.product?.id, shopify]);

  const testAction = () => fetcher.submit({}, { method: "POST" });

  const lastSyncLabel = kpis.lastSyncAt
    ? new Date(kpis.lastSyncAt).toLocaleString()
    : "—";

  return (
    <AdminPage
      title="Dashboard"
      primaryAction={
        <s-button onClick={testAction} {...(isLoading ? { loading: true } : {})}>
          Test action
        </s-button>
      }
    >
      <div className="lf-grid">
        <div className="lf-col-4">
          <div className="lf-card">
            <div className="lf-card-title">Requests today</div>
            <div className="lf-kpi">{kpis.requestsToday}</div>
            <div className="lf-muted lf-mt-2">
              {kpis.requestsToday ? "New requests today" : "No data yet"}
            </div>
          </div>
        </div>

        <div className="lf-col-4">
          <div className="lf-card">
            <div className="lf-card-title">Pending</div>
            <div className="lf-kpi">{kpis.pending}</div>
            <div className="lf-muted lf-mt-2">Awaiting review</div>
          </div>
        </div>

        <div className="lf-col-4">
          <div className="lf-card">
            <div className="lf-card-title">Last sync</div>
            <div className="lf-kpi">{lastSyncLabel}</div>
            <div className="lf-muted lf-mt-2">Google Sheets</div>
          </div>
        </div>
      </div>

      <div className="lf-mt-5">
        <div className="lf-card">
          <div className="lf-card-heading">Activity</div>
          <div className="lf-muted">
            Premium admin foundation is active. Next feature will be Requests
            (list + details) powered by Prisma.
          </div>
        </div>
      </div>

      {/* Keep this small debug block for now so you can confirm action works */}
      {fetcher.data?.product ? (
        <div className="lf-mt-5">
          <div className="lf-card">
            <div className="lf-card-title">Debug</div>
            <div className="lf-muted">Test action returned a product payload.</div>
            <pre style={{ margin: 0, marginTop: 12, overflow: "auto" }}>
              <code>{JSON.stringify(fetcher.data.product, null, 2)}</code>
            </pre>
          </div>
        </div>
      ) : null}
    </AdminPage>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
