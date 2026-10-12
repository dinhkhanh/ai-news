/** Vietnamese labels of the comic studio's states and steps (docs/COMIC.md §2). */
export const COMIC_STATE_LABEL: Record<string, string> = {
  created: "Mới tạo",
  adapted: "Chờ duyệt kịch bản",
  script_approved: "Đã duyệt kịch bản",
  drawing: "Đang vẽ / còn khung",
  drawn: "Đã vẽ xong",
  exported: "Đã xuất",
};

export const COMIC_STEP_LABEL: Record<string, string> = {
  adapt: "Viết kịch bản",
  cast: "Vẽ bản mẫu nhân vật",
  draw: "Vẽ khung",
  export: "Xuất trang",
};

export const SIZE_LABEL = { small: "nhỏ", medium: "vừa", large: "lớn", wide: "rộng", tall: "cao" } as const;
export const SHOT_LABEL = {
  establishing: "toàn cảnh mở đầu",
  wide: "toàn cảnh",
  medium: "trung cảnh",
  "close-up": "cận cảnh",
  "extreme close-up": "đặc tả",
  "over-the-shoulder": "qua vai",
  "bird's-eye": "từ trên cao",
  "worm's-eye": "từ dưới lên",
} as const;
export const LAYOUT_LABEL = { auto: "Tự động", grid: "Lưới đều", splash: "Một khung lớn", "wide-top": "Rộng ở trên", "tall-left": "Cao bên trái" } as const;
export const KIND_LABEL = { speech: "Lời nói", thought: "Suy nghĩ", shout: "Hét", whisper: "Thì thầm", caption: "Lời dẫn", sfx: "Tiếng động" } as const;
