/** Cheap heuristic used when the model is unavailable: Vietnamese diacritics density. */
export function heuristicLanguage(text: string): "vi" | "en" {
  const sample = text.slice(0, 4000);
  const viChars = (sample.match(/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/gi) ?? []).length;
  return viChars / Math.max(1, sample.length) > 0.01 ? "vi" : "en";
}
