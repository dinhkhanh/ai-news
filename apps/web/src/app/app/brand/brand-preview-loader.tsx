"use client";
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { BrandPreview as BrandPreviewType } from "./brand-preview";

/** The preview bundles the Remotion composition + Player; browser only, like the editor. */
const BrandPreview = dynamic(() => import("./brand-preview").then((m) => m.BrandPreview), {
  ssr: false,
  loading: () => <div className="aspect-[9/16] w-full animate-pulse rounded-xl bg-muted" />,
});

export function BrandPreviewLoader(props: ComponentProps<typeof BrandPreviewType>) {
  return <BrandPreview {...props} />;
}
