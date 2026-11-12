/**
 * Which file types the raw view can render as a plain-text document.
 *
 * The raw route and the opened-link file rows both ask this, so a file shows an
 * `Open as raw` button exactly when `/s/{id}/raw?file=` would answer with its
 * text instead of a refusal.
 */
export function isTextualType(type: string): boolean {
  const value = type.toLowerCase().split(";")[0].trim();
  if (value.startsWith("text/")) return true;
  return TEXTUAL_TYPES.has(value) || TEXTUAL_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

const TEXTUAL_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/sql",
  "application/graphql",
  "application/x-sh",
  "application/x-httpd-php",
  "application/rtf",
]);

/** Types some browsers report instead of `text/*` for the same file. */
const TEXTUAL_SUFFIXES = ["+json", "+xml", "+yaml"];

/**
 * Type first, then the extension: some pickers hand back an empty type or
 * `application/octet-stream` for files that are plainly text.
 */
export function isTextualFile(name: string, type: string): boolean {
  if (isTextualType(type)) return true;
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (!name.includes(".")) return TEXTUAL_NAMES.has(name.toLowerCase());
  return TEXTUAL_EXTENSIONS.has(extension);
}

const TEXTUAL_NAMES = new Set([".env", ".gitignore", ".npmrc", ".editorconfig", "dockerfile", "makefile"]);

const TEXTUAL_EXTENSIONS = new Set([
  "txt", "md", "markdown", "rst", "log", "csv", "tsv", "json", "jsonl", "ndjson",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "svg", "html", "htm",
  "css", "scss", "sass", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb",
  "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "sql", "graphql", "gql", "lua", "vim",
  "dockerfile", "makefile", "srt", "vtt", "tex", "diff", "patch",
]);
