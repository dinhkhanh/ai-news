import { Composition } from "remotion";
import { News } from "./compositions/News";
import { TestCard } from "./compositions/TestCard";
import { OUTPUT, testCardSchema, timelineSchema, type Timeline } from "./schema";
import { sampleMotionTimeline, sampleTimeline } from "./sample";

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
  </>
);
