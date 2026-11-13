// What the developer tools are called, and what they can be found by. Kept apart
// from the tools themselves so the search box can match against it without
// loading any of them.
//
//   aliases   exact names that open the tool when typed into the search box
//   keywords  looser terms that only make the tool show up in suggestions

export const TOOLS = [
    { id: "json", label: "JSON Format", aliases: ["json", "json formatter"], keywords: ["format", "lint", "validate", "minify", "beautify", "prettify"] },
    { id: "json-diff", label: "JSON Diff", aliases: [], keywords: ["compare"] },
    { id: "text-diff", label: "Text Diff", aliases: ["diff"], keywords: ["compare"] },
    { id: "base64", label: "Base64", aliases: ["b64"], keywords: ["encode", "decode"] },
    { id: "url", label: "URL", aliases: ["url encode", "urlencode"], keywords: ["uri", "percent", "encode", "decode", "query"] },
    { id: "jwt", label: "JWT", aliases: [], keywords: ["token", "json web token", "decode"] },
    { id: "hash", label: "Hash", aliases: ["md5", "sha1", "sha256", "sha512"], keywords: ["sha", "checksum", "digest"] },
    { id: "uuid", label: "UUID", aliases: ["guid"], keywords: ["random", "identifier"] },
    { id: "password", label: "Password", aliases: [], keywords: ["random", "secret", "token", "generator", "generate"] },
    { id: "timestamp", label: "Timestamp", aliases: ["unix", "epoch"], keywords: ["date", "time", "datetime", "iso"] },
    { id: "cron", label: "Cron", aliases: ["crontab"], keywords: ["schedule"] },
    { id: "case", label: "Case", aliases: ["case converter"], keywords: ["camel", "snake", "kebab", "pascal", "upper", "lower", "title"] },
    { id: "base", label: "Number Base", aliases: ["radix"], keywords: ["binary", "hex", "octal", "decimal", "convert"] },
    { id: "color", label: "Color", aliases: ["colour"], keywords: ["rgb", "hsl", "hex"] },
    { id: "regex", label: "Regex", aliases: ["regexp"], keywords: ["regular expression", "pattern", "match"] },
    { id: "markdown", label: "Markdown", aliases: ["md"], keywords: ["html"] },
    { id: "yaml", label: "YAML", aliases: ["yml"], keywords: ["json", "convert"] },
];

// Opens the overlay on whichever tool was used last.
export const LAUNCHER = { id: "tools", label: "Tools", aliases: ["tool"], keywords: ["dev tools", "developer tools"] };

const normalize = (text) => text.trim().toLowerCase().replace(/\s+/g, " ");

const exactNames = (tool) => [tool.label, ...tool.aliases].map(normalize);

const searchNames = (tool) => [...exactNames(tool), ...tool.keywords.map(normalize)];

const startsAnyWord = (name, query) =>
    name.startsWith(query) || name.split(" ").some((word) => word.startsWith(query));

// `exact` are the tools whose name was typed in full, `partial` the ones the
// query is merely the beginning of a name or keyword.
export function findTools(query) {
    const q = normalize(query);
    const result = { exact: [], partial: [] };

    if (q === "") return result;

    for (const tool of [...TOOLS, LAUNCHER]) {
        if (exactNames(tool).includes(q)) {
            result.exact.push(tool);
        } else if (q.length >= 2 && searchNames(tool).some((name) => startsAnyWord(name, q))) {
            result.partial.push(tool);
        }
    }

    return result;
}
