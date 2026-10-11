import React, { useEffect, useMemo, useRef, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { hyperframesDocument } from "../motion";
import { motionArea, type Brand, type TimelineScene } from "../schema";

/** Longest wait for the composition's fonts / GSAP / images, and for one seek; past it the frame renders as it is. */
const READY_TIMEOUT_MS = 20_000;
const SEEK_TIMEOUT_MS = 8_000;

/**
 * A HyperFrames shot (engine `hyperframes`): the composition Claude wrote, in
 * a sandboxed iframe (`allow-scripts` only: opaque origin, no access to the
 * render page) built by `hyperframesDocument`. Every frame the component
 * posts `hf-seek` with the shot-relative time and holds the render
 * (`delayRender`) until the page answers that its timelines were seeked and
 * painted, so each frame is deterministic like the rest of the composition.
 */
export const HyperFramesShot: React.FC<{ html: string; images: string[]; brand: Brand; kind: TimelineScene["kind"]; font: string }> = ({ html, images, brand, kind, font }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ref = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [readyHandle] = useState(() => delayRender("hyperframes composition", { timeoutInMilliseconds: READY_TIMEOUT_MS + 10_000 }));
  const seq = useRef(0);

  const srcDoc = useMemo(
    () =>
      hyperframesDocument({
        html,
        images,
        colours: { primary: brand.colours.primary, accent: brand.colours.accent, background: brand.colours.background, text: brand.colours.text, highlight: brand.colours.captionHighlight },
        fontFamily: `'${font}'`,
        safeBottom: motionArea(brand, kind).y1,
      }),
    [html, images, brand, kind, font],
  );

  // Ready = the page posted `hf-ready` (fonts + images in), or the timeout passed.
  useEffect(() => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setReady(true);
      continueRender(readyHandle);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && (e.data as { type?: string } | null)?.type === "hf-ready") finish();
    };
    window.addEventListener("message", onMessage);
    const timer = setTimeout(finish, READY_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      finish();
    };
  }, [readyHandle, srcDoc]);

  // Seek to this frame and wait for the page to paint it.
  useEffect(() => {
    if (!ready) return;
    const win = ref.current?.contentWindow;
    if (!win) return;
    const n = ++seq.current;
    const handle = delayRender(`hyperframes seek ${frame}`, { timeoutInMilliseconds: SEEK_TIMEOUT_MS + 10_000 });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      continueRender(handle);
    };
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; n?: number } | null;
      if (e.source === win && m?.type === "hf-seeked" && m.n === n) finish();
    };
    window.addEventListener("message", onMessage);
    const timer = setTimeout(finish, SEEK_TIMEOUT_MS);
    win.postMessage({ type: "hf-seek", t: frame / fps, n }, "*");
    return finish;
  }, [frame, fps, ready]);

  return (
    <AbsoluteFill style={{ backgroundColor: brand.colours.background, overflow: "hidden" }}>
      <iframe ref={ref} title="motion" srcDoc={srcDoc} sandbox="allow-scripts" style={{ width: 1080, height: 1920, border: 0, display: "block", background: "transparent" }} />
    </AbsoluteFill>
  );
};
