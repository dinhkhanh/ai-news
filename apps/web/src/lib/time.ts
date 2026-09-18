/** "5 phút", "3 giờ", "2 ngày": compact relative time for list rows (Vietnamese, no "ago" needed). */
export function timeAgo(date: Date | string, now = Date.now()): string {
  const t = typeof date === "string" ? Date.parse(date) : date.getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "vừa xong";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} giờ`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} ngày`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} tháng`;
  return `${Math.round(mo / 12)} năm`;
}

/** "2026-09-18 13:37" in Vietnam time, for details where the exact moment matters. */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" }).format(d);
}
