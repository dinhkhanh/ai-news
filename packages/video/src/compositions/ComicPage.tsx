import { loadFont as loadBeVietnamPro } from "@remotion/google-fonts/BeVietnamPro";
import { loadFont as loadItim } from "@remotion/google-fonts/Itim";
import type { CSSProperties } from "react";
import { AbsoluteFill, Img } from "remotion";
import { ComicPageView, type ComicPageViewProps } from "../comic-view";

loadItim("normal", { weights: ["400"], subsets: ["latin", "latin-ext", "vietnamese"] });
loadBeVietnamPro("normal", { weights: ["400", "700"], subsets: ["latin", "latin-ext", "vietnamese"] });

/** Remotion's `<Img>` holds the frame until the picture has loaded. */
const RemotionImg = (p: { src: string; alt: string; style?: CSSProperties }) => <Img {...p} />;

export type ComicPageStillProps = Omit<ComicPageViewProps, "placeholders" | "ImageComponent">;

/** Remotion composition for the page export (`renderStillOnLambda`, composition id `ComicPage`): one page as a still. */
export const ComicPageStill: React.FC<ComicPageStillProps> = (props) => (
  <AbsoluteFill style={{ background: "#FFFFFF" }}>
    <ComicPageView {...props} ImageComponent={RemotionImg} />
  </AbsoluteFill>
);
