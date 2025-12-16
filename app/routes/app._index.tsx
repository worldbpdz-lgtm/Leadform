import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "~/shopify.server";
import { AdminPage } from "~/ui/AdminPage";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
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
    },
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
    },
  );

  const variantResponseJson = await variantResponse.json();

  return {
    product: responseJson!.data!.productCreate!.product,
    variant:
      variantResponseJson!.data!.productVariantsBulkUpdate!.productVariants,
  };
};

export default function Index() {
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
            <div className="lf-kpi">0</div>
            <div className="lf-muted lf-mt-2">No data yet</div>
          </div>
        </div>

        <div className="lf-col-4">
          <div className="lf-card">
            <div className="lf-card-title">Pending</div>
            <div className="lf-kpi">0</div>
            <div className="lf-muted lf-mt-2">Awaiting review</div>
          </div>
        </div>

        <div className="lf-col-4">
          <div className="lf-card">
            <div className="lf-card-title">Last sync</div>
            <div className="lf-kpi">—</div>
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
