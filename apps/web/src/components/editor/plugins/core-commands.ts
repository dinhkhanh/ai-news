import { definePlugin } from "../core/plugin";

const mod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

/** Save, undo / redo, play, the command palette, panel digits: the editor's own keyboard. */
export const coreCommands = definePlugin({
  id: "core.commands",
  name: "Lệnh cơ bản",
  description: "Lưu, hoàn tác, phát, bảng lệnh ⌘K, chuyển Dựng ⇄ Xuất & duyệt.",
  required: true,
  commands: [
    { id: "core.palette", title: () => "Bảng lệnh", group: "Tệp", keys: "⌘K", shortcut: { match: (e) => mod(e) && e.key.toLowerCase() === "k", global: true }, run: (c) => c.ui.setPaletteOpen(true) },
    { id: "core.save", title: (c) => `Lưu thành v${c.props.version.version + 1}`, group: "Tệp", keys: "⌘S", shortcut: { match: (e) => mod(e) && e.key.toLowerCase() === "s", global: true }, when: (c) => c.canSave && c.dirty, run: (c) => c.services.save() },
    { id: "core.undo", title: (c) => (c.history.undoLabel ? `Hoàn tác: ${c.history.undoLabel}` : "Hoàn tác"), group: "Tệp", keys: "⌘Z", shortcut: { match: (e) => mod(e) && !e.shiftKey && e.key.toLowerCase() === "z" }, when: (c) => c.history.canUndo, run: (c) => c.history.undo() },
    { id: "core.redo", title: (c) => (c.history.redoLabel ? `Làm lại: ${c.history.redoLabel}` : "Làm lại"), group: "Tệp", keys: "⇧⌘Z", shortcut: { match: (e) => mod(e) && ((e.shiftKey && e.key.toLowerCase() === "z") || e.key.toLowerCase() === "y") }, when: (c) => c.history.canRedo, run: (c) => c.history.redo() },
    { id: "core.reset", title: () => "Huỷ mọi thay đổi chưa lưu", group: "Tệp", when: (c) => c.dirty && !c.readOnly, run: (c) => c.reset() },
    { id: "core.play", title: () => "Phát / tạm dừng", group: "Cả video", keys: "Space", shortcut: { match: (e) => e.key === " " && !mod(e) && !(e.target instanceof HTMLButtonElement) }, run: (c) => c.player.toggle() },
    { id: "core.deliver", title: (c) => (c.ui.mode === "edit" ? "Xuất & duyệt" : "Về trình dựng"), group: "Tệp", keys: "⌘E", shortcut: { match: (e) => mod(e) && e.key.toLowerCase() === "e", global: true }, run: (c) => c.ui.setMode(c.ui.mode === "edit" ? "deliver" : "edit") },
  ],
});
