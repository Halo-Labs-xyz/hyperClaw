"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

const ProvidersRuntime = dynamic(() => import("./ProvidersRuntime"), {
  ssr: false,
});

export default function Providers({
  children,
}: {
  children: ReactNode;
}) {
  return <ProvidersRuntime>{children}</ProvidersRuntime>;
}
