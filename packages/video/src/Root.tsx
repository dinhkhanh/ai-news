import { Composition } from "remotion";
import { sampleComicPage } from "./comic-sample";
import { ComicPageStill, type ComicPageStillProps } from "./compositions/ComicPage";
import { ComicStripStill, type ComicStripStillProps } from "./compositions/ComicStrip";
import { News } from "./compositions/News";
import { TestCard } from "./compositions/TestCard";
import { OUTPUT, testCardSchema, timelineSchema, type Timeline } from "./schema";
import { sampleMotionTimeline, sampleSketchTimeline, sampleTimeline } from "./sample";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="TestCard"
      component={TestCard}
      schema={testCardSchema}
      width={OUTPUT.width}
      height={OUTPUT.height}
      fps={OUTPUT.fps}
      durationInFrames={6 * OUTPUT.fps}
      defaultProps={{ title: "ai-news test render", durationSec: 6, fps: OUTPUT.fps }}
      calculateMetadata={({ props }) => ({ durationInFrames: props.durationSec * OUTPUT.fps, fps: OUTPUT.fps })}
    />
    <Composition
      id="News"
      component={News}
      schema={timelineSchema}
      width={OUTPUT.width}
      height={OUTPUT.height}
      fps={OUTPUT.fps}
      durationInFrames={sampleTimeline.durationFrames}
      defaultProps={sampleTimeline as Timeline}
      calculateMetadata={({ props }) => ({ durationInFrames: props.durationFrames, fps: OUTPUT.fps })}
    />
    {/* Studio only: the motion graphics engines on sample data. */}
    <Composition
      id="NewsMotionSample"
      component={News}
      schema={timelineSchema}
      width={OUTPUT.width}
      height={OUTPUT.height}
      fps={OUTPUT.fps}
      durationInFrames={sampleMotionTimeline.durationFrames}
      defaultProps={sampleMotionTimeline}
      calculateMetadata={({ props }) => ({ durationInFrames: props.durationFrames, fps: OUTPUT.fps })}
    />
    {/* Studio only: photos turning into drawings (pencil, ink, colour). */}
    <Composition
      id="NewsSketchSample"
      component={News}
      schema={timelineSchema}
      width={OUTPUT.width}
      height={OUTPUT.height}
      fps={OUTPUT.fps}
      durationInFrames={sampleSketchTimeline.durationFrames}
      defaultProps={sampleSketchTimeline}
      calculateMetadata={({ props }) => ({ durationInFrames: props.durationFrames, fps: OUTPUT.fps })}
    />
    {/* A comic page as a still (renderStillOnLambda, docs/COMIC.md §3): size from the comic's format and the page height. */}
    <Composition
      id="ComicPage"
      component={ComicPageStill}
      width={sampleComicPage.format.width}
      height={sampleComicPage.page.height}
      fps={1}
      durationInFrames={1}
      defaultProps={sampleComicPage as ComicPageStillProps}
      calculateMetadata={({ props }) => ({ width: Math.round(props.format.width), height: Math.round(props.page.height), durationInFrames: 1, fps: 1 })}
    />
    {/* One file of the webtoon export: slices of pages at the strip width (planStrip in comic.ts). */}
    <Composition
      id="ComicStrip"
      component={ComicStripStill}
      width={sampleComicPage.format.width}
      height={sampleComicPage.page.height}
      fps={1}
      durationInFrames={1}
      defaultProps={{ format: sampleComicPage.format, font: sampleComicPage.font, width: sampleComicPage.format.width, height: sampleComicPage.page.height, srcs: sampleComicPage.srcs, pieces: [{ page: sampleComicPage.page, srcTop: 0, dstTop: 0, dstHeight: sampleComicPage.page.height, credit: null }] } as ComicStripStillProps}
      calculateMetadata={({ props }) => ({ width: Math.round(props.width), height: Math.round(props.height), durationInFrames: 1, fps: 1 })}
    />
  </>
);
