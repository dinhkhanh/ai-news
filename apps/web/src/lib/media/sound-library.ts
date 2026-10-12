/**
 * Public sound library (/app/sounds): pure helpers shared by the search, the server actions, the page and the
 * editor. Search runs on Openverse (api.openverse.org, open source, no key needed: Jamendo, Wikimedia Commons,
 * Freesound); Pixabay Music has no API, so its tracks come in as file imports with the Pixabay licence filled in.
 * Tested in `sound-library.test.ts`; no server-only imports here.
 */

/** Openverse audio sources (`source_name`s of /v1/audio/stats/), in the order the filter lists them. */
export const OPENVERSE_SOURCES = [
  { id: "jamendo", label: "Jamendo", hint: "nhạc" },
  { id: "freesound", label: "Freesound", hint: "hiệu ứng, không khí" },
  { id: "wikimedia_audio", label: "Wikimedia Commons", hint: "âm thanh khác" },
] as const;
export type OpenverseSource = (typeof OPENVERSE_SOURCES)[number]["id"];
export const isOpenverseSource = (s: string): s is OpenverseSource => OPENVERSE_SOURCES.some((x) => x.id === s);

/** Where a collection item came from: an Openverse result, a Pixabay Music import, or the user's own file. */
export const SOUND_PROVIDERS = ["openverse", "pixabay", "upload"] as const;
export type SoundProvider = (typeof SOUND_PROVIDERS)[number];

export const SOUND_KINDS = ["music", "sfx", "other"] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];
export const SOUND_KIND_LABEL: Record<SoundKind, string> = { music: "Nhạc nền", sfx: "Hiệu ứng", other: "Âm thanh khác" };
export const isSoundKind = (k: string): k is SoundKind => (SOUND_KINDS as readonly string[]).includes(k);

/** Openverse length buckets: shortest < 30 s, short 30 s – 2 min, medium 2 – 10 min, long > 10 min. */
export const SOUND_LENGTHS = [
  { id: "shortest", label: "< 30 giây" },
  { id: "short", label: "30 giây – 2 phút" },
  { id: "medium", label: "2 – 10 phút" },
  { id: "long", label: "> 10 phút" },
] as const;
export type SoundLength = (typeof SOUND_LENGTHS)[number]["id"];
export const isSoundLength = (l: string): l is SoundLength => SOUND_LENGTHS.some((x) => x.id === l);

export const COLLECTION_NAME_MAX = 60;
export const SOUND_QUERY_MAX = 200;
/** Largest audio file a collection keeps (download or upload); the music library uses the same cap. */
export const SOUND_MAX_BYTES = 25 * 1024 * 1024;
export const SOUND_PAGE_SIZE = 20;
/** Openverse caps anonymous paging at 240 results. */
export const OPENVERSE_MAX_RESULTS = 240;
export const COLLECTION_COLOURS = ["#c2410c", "#2563eb", "#7c3aed", "#0f766e", "#be185d", "#a16207", "#4d7c0f"] as const;

export const PIXABAY_LICENCE = "Pixabay Content License";
export const PIXABAY_LICENCE_URL = "https://pixabay.com/service/license-summary/";

export type LicenceInfo = {
  /** Short label for a badge: "CC0", "CC BY 4.0", "Pixabay", "Tệp riêng". */
  label: string;
  /** Usable in a video on a monetised channel. */
  commercial: boolean;
  /** The licence requires naming the author. */
  attributionRequired: boolean;
  shareAlike: boolean;
  /** One-line explanation for the licence card. */
  note: string;
  tone: "free" | "credit" | "sharealike" | "restricted" | "own";
};

/**
 * What a licence code allows. Codes are Openverse's (`cc0`, `pdm`, `by`, `by-sa`, `by-nc`, `by-nd`, …,
 * `sampling+`, `nc-sampling+`) plus `pixabay` and `own` (a file the user vouches for).
 */
export function licenceInfo(code: string, version?: string | null): LicenceInfo {
  const c = code.toLowerCase();
  const v = version ? ` ${version}` : "";
  if (c === "cc0" || c === "pdm")
    return { label: c === "cc0" ? "CC0" : "Public domain", commercial: true, attributionRequired: false, shareAlike: false, tone: "free", note: "Phạm vi công cộng: dùng tự do, kể cả thương mại. Ghi công không bắt buộc nhưng vẫn được gắn." };
  if (c === "pixabay")
    return { label: "Pixabay", commercial: true, attributionRequired: false, shareAlike: false, tone: "free", note: "Pixabay Content License: dùng được cho kênh kiếm tiền, không bắt buộc ghi công. Vài bài có đăng ký Content ID; nếu bị khiếu nại, gửi link trang Pixabay để gỡ." };
  if (c === "own")
    return { label: "Tệp riêng", commercial: true, attributionRequired: false, shareAlike: false, tone: "own", note: "Tệp do thành viên tải lên; người tải lên chịu trách nhiệm về quyền sử dụng ghi ở đây." };
  const nc = c.includes("nc");
  const nd = c.includes("nd");
  const sa = c.includes("sa") && !c.includes("sampling");
  if (c === "sampling+" || c === "nc-sampling+")
    return { label: c === "sampling+" ? "Sampling+" : "NC Sampling+", commercial: false, attributionRequired: true, shareAlike: false, tone: "restricted", note: "Chỉ được dùng một phần để phối lại, không dùng nguyên bản trong video." };
  const label = `CC ${c.toUpperCase()}${v}`;
  if (nc) return { label, commercial: false, attributionRequired: true, shareAlike: sa, tone: "restricted", note: "Không dùng thương mại: không chèn vào video của kênh có quảng cáo hoặc tài trợ." };
  if (nd) return { label, commercial: true, attributionRequired: true, shareAlike: false, tone: "restricted", note: "Không được chỉnh sửa: chèn làm nhạc nền dưới lời đọc là tạo bản phái sinh, nên tránh." };
  if (sa) return { label, commercial: true, attributionRequired: true, shareAlike: true, tone: "sharealike", note: "Dùng được cho kênh kiếm tiền, bắt buộc ghi công; bản phối lại phải giữ cùng giấy phép." };
  if (c === "by") return { label, commercial: true, attributionRequired: true, shareAlike: false, tone: "credit", note: "Dùng được cho kênh kiếm tiền, bắt buộc ghi tên tác giả và giấy phép." };
  return { label: code, commercial: false, attributionRequired: true, shareAlike: false, tone: "restricted", note: "Giấy phép chưa rõ: kiểm tra trang gốc trước khi dùng." };
}

/** A search result, already normalised; the client gets this shape and nothing else. */
export type SoundResult = {
  provider: "openverse";
  providerId: string;
  title: string;
  creator: string | null;
  creatorUrl: string | null;
  source: string;
  sourceLabel: string;
  landingUrl: string | null;
  /** Direct audio URL (played in the browser for "Nghe thử", downloaded when added to a collection). */
  audioUrl: string;
  licence: string;
  licenceVersion: string | null;
  licenceUrl: string | null;
  kind: SoundKind;
  durationSec: number | null;
  tags: string[];
};

type OpenverseAudio = {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  foreign_landing_url?: unknown;
  creator?: unknown;
  creator_url?: unknown;
  license?: unknown;
  license_version?: unknown;
  license_url?: unknown;
  source?: unknown;
  provider?: unknown;
  category?: unknown;
  duration?: unknown;
  tags?: unknown;
  mature?: unknown;
};

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const httpUrl = (v: unknown) => {
  const u = s(v);
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : null;
  } catch {
    return null;
  }
};

export const sourceLabel = (source: string) =>
  OPENVERSE_SOURCES.find((x) => x.id === source)?.label ?? (source === "pixabay" ? "Pixabay" : source === "upload" ? "Tệp tải lên" : source);

/** Freesound has no categories in Openverse; everything there is an effect or an ambience. */
export function kindOf(category: string | null, source: string | null): SoundKind {
  if (category === "music") return "music";
  if (category === "sound_effect" || source === "freesound") return "sfx";
  return "other";
}

/** One Openverse `/v1/audio/` item → `SoundResult`, or null when it has no playable URL or is marked mature. */
export function parseOpenverseAudio(raw: unknown): SoundResult | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as OpenverseAudio;
  const id = s(a.id);
  const audioUrl = httpUrl(a.url);
  const licence = s(a.license);
  if (!id || !audioUrl || !licence || a.mature === true) return null;
  const source = s(a.source) ?? s(a.provider) ?? "openverse";
  const ms = typeof a.duration === "number" && Number.isFinite(a.duration) && a.duration > 0 ? a.duration : null;
  const tags = Array.isArray(a.tags)
    ? [...new Set(a.tags.map((t) => (t && typeof t === "object" ? s((t as { name?: unknown }).name)?.toLowerCase() : null)).filter((t): t is string => Boolean(t)))].slice(0, 8)
    : [];
  return {
    provider: "openverse",
    providerId: id,
    title: (s(a.title) ?? "Không tên").replace(/\.(wav|mp3|ogg|flac|aiff?|m4a)$/i, "").slice(0, 200),
    creator: s(a.creator),
    creatorUrl: httpUrl(a.creator_url),
    source,
    sourceLabel: sourceLabel(source),
    landingUrl: httpUrl(a.foreign_landing_url),
    audioUrl,
    licence: licence.toLowerCase(),
    licenceVersion: s(a.license_version),
    licenceUrl: httpUrl(a.license_url),
    kind: kindOf(s(a.category), source),
    durationSec: ms ? Math.round(ms / 100) / 10 : null,
    tags,
  };
}

export type SoundSearch = {
  q: string;
  kind: "all" | "music" | "sfx";
  sources: OpenverseSource[];
  /** Only licences a monetised channel may use (Openverse `license_type=commercial`, then NC / ND dropped). */
  commercialOnly: boolean;
  lengths: SoundLength[];
  page: number;
};

/** Normalise untrusted search input (from the client) into a `SoundSearch`. */
export function parseSoundSearch(input: Partial<Record<keyof SoundSearch, unknown>>): SoundSearch {
  const q = typeof input.q === "string" ? input.q.replace(/\s+/g, " ").trim().slice(0, SOUND_QUERY_MAX) : "";
  const kind = input.kind === "music" || input.kind === "sfx" ? input.kind : "all";
  const sources = Array.isArray(input.sources) ? [...new Set(input.sources.filter((x): x is OpenverseSource => typeof x === "string" && isOpenverseSource(x)))] : [];
  const lengths = Array.isArray(input.lengths) ? [...new Set(input.lengths.filter((x): x is SoundLength => typeof x === "string" && isSoundLength(x)))] : [];
  const page = typeof input.page === "number" && Number.isInteger(input.page) ? Math.min(Math.max(1, input.page), Math.floor(OPENVERSE_MAX_RESULTS / SOUND_PAGE_SIZE)) : 1;
  return { q, kind, sources: sources.length ? sources : OPENVERSE_SOURCES.map((x) => x.id), commercialOnly: input.commercialOnly !== false, lengths, page };
}

/**
 * The Openverse search URL for a `SoundSearch`. "Hiệu ứng" is the Freesound source plus Openverse's
 * `sound_effect` category: Freesound items carry no category, so a category filter alone would drop them.
 */
export function openverseSearchUrl(f: SoundSearch, base = "https://api.openverse.org"): string {
  const u = new URL("/v1/audio/", base);
  if (f.q) u.searchParams.set("q", f.q);
  let sources: string[] = f.sources;
  if (f.kind === "music") u.searchParams.set("category", "music");
  if (f.kind === "sfx") sources = sources.filter((x) => x === "freesound");
  if (f.kind === "sfx" && sources.length === 0) {
    sources = f.sources;
    u.searchParams.set("category", "sound_effect");
  }
  if (sources.length && sources.length < OPENVERSE_SOURCES.length) u.searchParams.set("source", sources.join(","));
  u.searchParams.set("license_type", f.commercialOnly ? "commercial" : "all-cc");
  if (f.lengths.length) u.searchParams.set("length", f.lengths.join(","));
  u.searchParams.set("page", String(f.page));
  u.searchParams.set("page_size", String(SOUND_PAGE_SIZE));
  u.searchParams.set("mature", "false");
  return u.toString();
}

/** Openverse detail URL for one audio id (a UUID; anything else is refused before a request is made). */
export function openverseDetailUrl(id: string, base = "https://api.openverse.org"): string | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return new URL(`/v1/audio/${id.toLowerCase()}/`, base).toString();
}

/** Drop what the licence filter promised to keep out (Openverse's `commercial` type still lets ND through). */
export function keepResult(r: SoundResult, commercialOnly: boolean): boolean {
  if (!commercialOnly) return true;
  const l = licenceInfo(r.licence, r.licenceVersion);
  return l.commercial && l.tone !== "restricted";
}

/** Pixabay Music has no API: the library links to its search with the same words. */
export function pixabaySearchUrl(q: string): string {
  const words = q.trim().replace(/\s+/g, " ").slice(0, 100);
  return words ? `https://pixabay.com/music/search/${encodeURIComponent(words)}/` : "https://pixabay.com/music/";
}

/** A Pixabay Music track page (`pixabay.com/music/<slug>-<id>/`, any locale prefix), canonical form, else null. */
export function pixabayMusicPage(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.hostname !== "pixabay.com" && u.hostname !== "www.pixabay.com") return null;
  const m = u.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(music|sound-effects)\/([a-z0-9-]+-\d+)\/?$/i);
  if (!m) return null;
  return `https://pixabay.com/${m[1].toLowerCase()}/${m[2].toLowerCase()}/`;
}

/** "Rain light" from a Pixabay page slug (`rain-light-123456`), used when the import form has no title. */
export function titleFromPixabayPage(page: string): string | null {
  const slug = page.match(/\/([a-z0-9-]+)-\d+\/$/i)?.[1];
  if (!slug) return null;
  const words = slug.replace(/-/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : null;
}

export type CreditInput = { title: string; creator: string | null; sourceLabel: string; licence: string; licenceVersion: string | null };

/** The credit line a video carries for a sound (description / outro), e.g. `Nhạc: “New Trend” – Anny Sky (Jamendo), CC BY-SA 3.0`. */
export function soundCredit(item: CreditInput, kind: SoundKind = "music"): string {
  const l = licenceInfo(item.licence, item.licenceVersion);
  const head = kind === "music" ? "Nhạc" : "Âm thanh";
  const who = item.creator ? ` – ${item.creator}` : "";
  const where = item.sourceLabel ? ` (${item.sourceLabel})` : "";
  const lic = l.tone === "own" ? "" : `, ${item.licence === "pixabay" ? PIXABAY_LICENCE : l.label}`;
  return `${head}: “${item.title}”${who}${where}${lic}`;
}

/** Clean a collection name; empty = invalid. */
export const collectionName = (raw: string) => raw.replace(/\s+/g, " ").trim().slice(0, COLLECTION_NAME_MAX);

export type CollectionAccess = { createdBy: string | null; shared: boolean };
export type CollectionActor = { userId: string; canWrite: boolean; canManageWorkspace: boolean };

/** Who sees a collection: everyone in the workspace when shared, else its creator. */
export const canSeeCollection = (c: CollectionAccess, a: Pick<CollectionActor, "userId">) => c.shared || c.createdBy === a.userId;

/** Who adds / removes sounds: any writer on a shared collection, only its creator on a private one. */
export const canEditCollection = (c: CollectionAccess, a: CollectionActor) => a.canWrite && (c.shared || c.createdBy === a.userId);

/** Who renames, shares / unshares and deletes: its creator, or a workspace admin / owner / platform admin when it is shared. */
export const canManageCollection = (c: CollectionAccess, a: CollectionActor) => a.canWrite && (c.createdBy === a.userId || (c.shared && a.canManageWorkspace));

/** MIME type to store an audio file with, by its reported type or its extension; null = not audio we can mix. */
export function audioContentType(fileName: string, reported: string | null | undefined): string | null {
  const t = (reported ?? "").toLowerCase().split(";")[0].trim();
  const ext = fileName.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  if (/^audio\/(mpeg|mp3)$/.test(t) || (!t.startsWith("audio/") && ext === "mp3")) return "audio/mpeg";
  if (/^audio\/(wav|x-wav|wave|vnd\.wave)$/.test(t) || (!t.startsWith("audio/") && ext === "wav")) return "audio/wav";
  if (/^audio\/(ogg|vorbis|opus)$/.test(t) || (!t.startsWith("audio/") && (ext === "ogg" || ext === "oga" || ext === "opus"))) return "audio/ogg";
  if (/^audio\/(flac|x-flac)$/.test(t) || (!t.startsWith("audio/") && ext === "flac")) return "audio/flac";
  if (/^audio\/(mp4|x-m4a|m4a|aac)$/.test(t) || t === "video/mp4" || (!t.startsWith("audio/") && (ext === "m4a" || ext === "mp4" || ext === "aac"))) return "audio/mp4";
  return null;
}

export const AUDIO_EXT: Record<string, string> = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac", "audio/mp4": "m4a" };

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "–";
  const t = Math.max(0, Math.round(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** Hosts the server downloads Openverse audio from (Freesound previews, Jamendo, Wikimedia uploads); anything else is refused. */
const AUDIO_HOSTS = ["freesound.org", "jamendo.com", "wikimedia.org"];
export function isAllowedAudioUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    return AUDIO_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Audio container from a file's first bytes (MP3 / WAV / Ogg / FLAC / MP4), null = not audio we accept. */
export function sniffAudio(b: Uint8Array): string | null {
  const ascii = (from: number, len: number) => String.fromCharCode(...b.subarray(from, from + len));
  if (b.length >= 3 && ascii(0, 3) === "ID3") return "audio/mpeg";
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg"; // MPEG frame sync (also ADTS AAC)
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  if (b.length >= 4 && ascii(0, 4) === "OggS") return "audio/ogg";
  if (b.length >= 4 && ascii(0, 4) === "fLaC") return "audio/flac";
  if (b.length >= 8 && ascii(4, 4) === "ftyp") return "audio/mp4";
  return null;
}

export type CollectionItemView = {
  id: string;
  collectionId: string;
  provider: SoundProvider;
  providerId: string | null;
  source: string;
  sourceLabel: string;
  title: string;
  creator: string | null;
  creatorUrl: string | null;
  landingUrl: string | null;
  licence: string;
  licenceVersion: string | null;
  licenceUrl: string | null;
  kind: SoundKind;
  durationSec: number | null;
  /** R2 key of the stored copy. */
  key: string;
  credit: string;
};

export type CollectionView = {
  id: string;
  name: string;
  shared: boolean;
  colour: string;
  createdByName: string | null;
  mine: boolean;
  canEdit: boolean;
  canManage: boolean;
  items: CollectionItemView[];
};
