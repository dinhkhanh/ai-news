import React, { useEffect, useMemo, useRef, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { hyperframesDocument } from "../motion";
import { motionArea, type Backdrop, type Brand, type TimelineScene } from "../schema";
import { MotionBackdrop } from "./MotionBackdrop";

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
 * With a `backdrop` the clip or picture shows under the iframe (Remotion seeks
 * video far better than a page could) and the page and the composition's root
 * are transparent, so a backdrop swapped in later shows through unchanged code.
 */
export const HyperFramesShot: React.FC<{ html: string; images: string[]; backdrop: Backdrop | null; durationFrames: number; brand: Brand; kind: TimelineScene["kind"]; font: string }> = ({ html, images, backdrop, durationFrames, brand, kind, font }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const transparent = Boolean(backdrop);
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
        transparent,
      }),
    [html, images, brand, kind, font, transparent],
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
      {backdrop ? <MotionBackdrop backdrop={backdrop} durationFrames={durationFrames} scrim="linear-gradient(180deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,.3) 40%, rgba(0,0,0,.4) 65%, rgba(0,0,0,.7) 100%)" /> : null}
      <iframe ref={ref} title="motion" srcDoc={srcDoc} sandbox="allow-scripts" style={{ position: "absolute", left: 0, top: 0, width: 1080, height: 1920, border: 0, display: "block", background: "transparent" }} />
    </AbsoluteFill>
  );
};
