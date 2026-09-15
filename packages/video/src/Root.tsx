import { Composition } from "remotion";
import { TestCard } from "./compositions/TestCard";
import { OUTPUT, testCardSchema } from "./schema";

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
  </>
);
