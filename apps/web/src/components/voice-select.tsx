import { NativeSelect } from "@/components/ui/native-select";
import type { VoiceOption } from "@/lib/media/tts";

const LANG = { vi: "Tiếng Việt", en: "English" } as const;

/**
 * The "Giọng đọc" select of the new-project and build forms (`voicePresetId`, "" = the workspace default).
 * A classic voice reads one language only; a project in the other language then gets the default (`pickVoice`).
 */
export function VoiceSelect({
  id,
  voices,
  value,
  size,
  className,
  emptyLabel = "Giọng mặc định",
  title = "Giọng đọc lời bình. Tạo giọng riêng (chọn giọng + dặn cách đọc) ở mục Giọng đọc.",
  disabled,
  onChange,
}: {
  id: string;
  voices: VoiceOption[];
  value: string | null;
  size?: "sm";
  className?: string;
  emptyLabel?: string;
  title?: string;
  disabled?: boolean;
  onChange?: (voicePresetId: string) => void;
}) {
  const mine = voices.filter((v) => v.workspace);
  const platform = voices.filter((v) => !v.workspace);
  const label = (v: VoiceOption) => `${v.name}${v.model ? "" : ` · chỉ ${LANG[v.language]}`}`;
  return (
    <NativeSelect
      id={id}
      name="voicePresetId"
      defaultValue={value ?? ""}
      fieldSize={size}
      className={className}
      title={title}
      disabled={disabled}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
    >
      <option value="">{emptyLabel}</option>
      {mine.length ? (
        <optgroup label="Giọng của workspace">
          {mine.map((v) => (
            <option key={v.id} value={v.id}>
              {label(v)}
              {v.isDefault ? " (mặc định)" : ""}
            </option>
          ))}
        </optgroup>
      ) : null}
      <optgroup label="Giọng có sẵn">
        {platform.map((v) => (
          <option key={v.id} value={v.id}>
            {label(v)}
          </option>
        ))}
      </optgroup>
    </NativeSelect>
  );
}
