import { SegmentedLinks } from "@/components/ui/segmented";

/** The comic studio's three halves: the comics, the art styles and the reusable characters. */
export function ComicTabs({ active }: { active: "comics" | "styles" | "characters" }) {
  return (
    <SegmentedLinks
      label="Truyện tranh"
      options={[
        { href: "/app/comics", label: "Truyện", active: active === "comics" },
        { href: "/app/comics/styles", label: "Phong cách", active: active === "styles" },
        { href: "/app/comics/characters", label: "Nhân vật", active: active === "characters" },
      ]}
    />
  );
}
