import { SegmentedLinks } from "@/components/ui/segmented";

/** The two halves of "Giọng đọc": the voices themselves and how words are read (the shared dictionary). */
export function VoiceTabs({ active }: { active: "voices" | "pronunciations" }) {
  return (
    <SegmentedLinks
      label="Giọng đọc"
      options={[
        { href: "/app/voices", label: "Giọng đọc", active: active === "voices" },
        { href: "/app/voices/pronunciations", label: "Cách đọc từ ngữ", active: active === "pronunciations" },
      ]}
    />
  );
}
