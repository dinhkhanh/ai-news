"use client";
import dynamic from "next/dynamic";
import type { EditorProps } from "./types";

/** The editor bundles the Remotion composition (fonts, Player); it only ever runs in the browser. */
const Editor = dynamic(() => import("./editor").then((m) => m.Editor), {
  ssr: false,
  loading: () => <p className="p-6 text-sm text-muted-foreground">Đang tải trình chỉnh sửa…</p>,
});

export function EditorLoader(props: EditorProps) {
  return <Editor {...props} />;
}
