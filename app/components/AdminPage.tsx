import type { ReactNode } from "react";

type AdminPageProps = {
  title: string;
  primaryAction?: ReactNode;
  children: ReactNode;
};

export function AdminPage({ title, primaryAction, children }: AdminPageProps) {
  return (
    <div className="lf-admin">
      <div className="lf-page lf-enter">
        <s-page heading={title}>
          {primaryAction ? <div slot="primary-action">{primaryAction}</div> : null}
          {children}
        </s-page>
      </div>
    </div>
  );
}
