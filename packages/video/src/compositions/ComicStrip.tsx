import { AbsoluteFill } from "remotion";
import type { ComicDoc, ComicPage } from "../comic";
import { ComicPageView } from "../comic-view";
import { RemotionImg } from "./ComicPage";

export type ComicStripStillProps = {
  format: ComicDoc["format"];
  font: ComicDoc["font"];
  /** Size of the file (`STRIP_WIDTH` × the part's height). */
  width: number;
  height: number;
  /** Slices of pages (`planStrip`): `srcTop` in page px, `dst*` in px of this file. */
  pieces: { page: ComicPage; srcTop: number; dstTop: number; dstHeight: number; credit: string | null }[];
  srcs: Record<string, string>;
};

/**
 * One file of the webtoon export (composition id `ComicStrip`): slices of pages, each the same `ComicPageView` as the
 * reader scaled to the strip width, stacked on white. Cut lines come from `planStrip`, which keeps them off panels.
 */
export const ComicStripStill: React.FC<ComicStripStillProps> = ({ format, font, width, pieces, srcs }) => {
  const s = width / format.width;
  return (
    <AbsoluteFill style={{ background: "#FFFFFF" }}>
      {pieces.map((p, i) => (
        <div key={i} style={{ position: "absolute", left: 0, top: p.dstTop, width, height: p.dstHeight, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, top: -p.srcTop * s, width }}>
            <ComicPageView format={format} font={font} page={p.page} srcs={srcs} credit={p.credit} ImageComponent={RemotionImg} />
          </div>
        </div>
      ))}
    </AbsoluteFill>
  );
};
