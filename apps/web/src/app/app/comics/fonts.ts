import { Be_Vietnam_Pro, Itim } from "next/font/google";

/** Lettering faces of the comic pages (`COMIC_FONTS`), loaded by next/font and handed to `ComicPageView` by name. */
const itim = Itim({ weight: "400", subsets: ["latin", "latin-ext", "vietnamese"], display: "swap" });
const beVietnam = Be_Vietnam_Pro({ weight: ["400", "700"], subsets: ["latin", "latin-ext", "vietnamese"], display: "swap" });

export const comicFamilies = { itim: itim.style.fontFamily, bevietnam: beVietnam.style.fontFamily };
