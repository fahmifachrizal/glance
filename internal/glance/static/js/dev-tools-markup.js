import { elem } from "./templating.js";
import {
    button, editor, createStatus, copyButton, toolbar, pane, labelled, split, hint,
} from "./dev-tools-ui.js";
import { parseJSON, formatParseError } from "./dev-tools-json.js";

/* ----------------------------------------------------------------- markdown */

const escapeHTML = (text) => text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Only web, mail and phone links (or relative ones) survive; anything else, such
// as javascript:, becomes a dead link. Control characters are removed first
// because browsers ignore them inside a scheme.
function safeURL(url) {
    const compact = url.replace(/[\u0000- ]/g, "");
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(compact);
    return hasScheme && !/^(https?|mailto|tel):/i.test(compact) ? "#" : url;
}

function renderInline(raw, stash) {
    const hold = (html) => {
        stash.push(html);
        return `\u0000${stash.length - 1}\u0000`;
    };

    let s = raw;

    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${escapeHTML(code.trim())}</code>`));
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, (_, char) => hold(escapeHTML(char)));
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (_, alt, url, title) =>
        hold(`<img src="${escapeHTML(safeURL(url))}" alt="${escapeHTML(alt)}"${title ? ` title="${escapeHTML(title)}"` : ""}>`));
    s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (_, text, url, title) =>
        hold(`<a href="${escapeHTML(safeURL(url))}"${title ? ` title="${escapeHTML(title)}"` : ""}>${renderInline(text, stash)}</a>`));
    s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/g, (_, url) =>
        hold(`<a href="${escapeHTML(url)}">${escapeHTML(url)}</a>`));

    s = escapeHTML(s)
        .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
        .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
        .replace(/\*(?=\S)([\s\S]*?\S)\*/g, "<em>$1</em>")
        .replace(/(^|\W)_(?=\S)([\s\S]*?\S)_(?!\w)/g, "$1<em>$2</em>")
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
        .replace(/ {2,}\n/g, "<br>\n");

    return s;
}

function inline(text) {
    const stash = [];
    let s = renderInline(text.replace(/\u0000/g, ""), stash);

    // Held fragments can themselves contain placeholders (a code span inside a link).
    while (/\u0000\d+\u0000/.test(s)) {
        s = s.replace(/\u0000(\d+)\u0000/g, (_, index) => stash[Number(index)]);
    }

    return s;
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;

const startsBlock = (line) =>
    FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);

const indentOf = (line) => line.length - line.trimStart().length;

function renderList(lines, start, out) {
    const first = LIST_ITEM.exec(lines[start]);
    const baseIndent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const sameList = (m) => m && m[1].length === baseIndent && /\d/.test(m[2]) === ordered;

    const items = [];
    let item = null;
    let loose = false;
    let i = start;

    while (i < lines.length) {
        const line = lines[i];
        const m = LIST_ITEM.exec(line);

        if (sameList(m)) {
            item = { lines: [m[3]], contentIndent: baseIndent + m[2].length + 1 };
            items.push(item);
            i++;
            continue;
        }

        if (line.trim() === "") {
            let j = i;
            while (j < lines.length && lines[j].trim() === "") j++;
            if (j >= lines.length) break;

            if (indentOf(lines[j]) > baseIndent) {
                for (let k = i; k < j; k++) item.lines.push("");
                loose = true;
            } else if (sameList(LIST_ITEM.exec(lines[j]))) {
                loose = true;
            } else {
                break;
            }

            i = j;
            continue;
        }

        if (indentOf(line) > baseIndent) {
            item.lines.push(line.slice(Math.min(indentOf(line), item.contentIndent)));
            i++;
            continue;
        }

        // A line that does not start a new block continues the item's paragraph.
        if (!startsBlock(line)) {
            item.lines.push(line.trim());
            i++;
            continue;
        }

        break;
    }

    const tag = ordered ? "ol" : "ul";
    const startNumber = ordered ? Number(/\d+/.exec(first[2])[0]) : 1;
    const attributes = ordered && startNumber !== 1 ? ` start="${startNumber}"` : "";

    const body = items.map((entry) => {
        let html = renderBlocks(entry.lines).join("\n");
        if (!loose) html = html.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
        return `<li>${html}</li>`;
    });

    out.push(`<${tag}${attributes}>\n${body.join("\n")}\n</${tag}>`);
    return i;
}

function renderBlocks(lines) {
    const out = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (line.trim() === "") {
            i++;
            continue;
        }

        let m = FENCE.exec(line);
        if (m !== null) {
            const [, fence, language] = m;
            const closing = new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`);
            const code = [];

            for (i++; i < lines.length && !closing.test(lines[i]); i++) code.push(lines[i]);
            i++;

            const className = language ? ` class="language-${escapeHTML(language)}"` : "";
            out.push(`<pre><code${className}>${escapeHTML(code.join("\n"))}</code></pre>`);
            continue;
        }

        m = HEADING.exec(line);
        if (m !== null) {
            out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
            i++;
            continue;
        }

        if (RULE.test(line)) {
            out.push("<hr>");
            i++;
            continue;
        }

        if (QUOTE.test(line)) {
            const quoted = [];
            for (; i < lines.length && QUOTE.test(lines[i]); i++) {
                quoted.push(lines[i].replace(/^\s{0,3}> ?/, ""));
            }
            out.push(`<blockquote>\n${renderBlocks(quoted).join("\n")}\n</blockquote>`);
            continue;
        }

        if (LIST_ITEM.test(line)) {
            i = renderList(lines, i, out);
            continue;
        }

        const paragraph = [line];
        let level = 0;

        for (i++; i < lines.length && lines[i].trim() !== ""; i++) {
            if (/^\s{0,3}=+\s*$/.test(lines[i])) { level = 1; i++; break; }
            if (/^\s{0,3}-+\s*$/.test(lines[i])) { level = 2; i++; break; }
            if (startsBlock(lines[i])) break;
            paragraph.push(lines[i]);
        }

        // Trailing double spaces mark a hard line break, so only the end is trimmed.
        const text = inline(paragraph.map((l) => l.trimStart()).join("\n").trimEnd());
        out.push(level > 0 ? `<h${level}>${text}</h${level}>` : `<p>${text}</p>`);
    }

    return out;
}

// A deliberately small Markdown: headings, emphasis, links, images, code, lists,
// quotes and rules. Raw HTML in the input is escaped, never passed through.
export function markdownToHTML(source) {
    const lines = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
    return renderBlocks(lines).join("\n");
}

export function buildMarkdown() {
    const input = editor("Markdown…", { indent: true });
    const html = editor("HTML", { readonly: true, wrap: true });
    const preview = elem("iframe").classes("dev-tools-preview").attr("sandbox", "allow-popups");
    const output = elem("div").classes("dev-tools-editor-container").append(preview, html);

    const previewButton = button("Preview", "dev-tools-button-current");
    const htmlButton = button("HTML");
    let showHTML = false;

    const render = () => {
        html.value = markdownToHTML(input.value);

        const style = getComputedStyle(input);
        preview.srcdoc = `<!doctype html><meta charset="utf-8"><base target="_blank"><style>
            body { margin: 0; padding: 12px 16px; font: 14px/1.6 ${style.fontFamily.includes("mono") ? "system-ui, sans-serif" : style.fontFamily}; color: ${style.color}; background: ${style.backgroundColor}; }
            a { color: inherit; } img { max-width: 100%; }
            pre { overflow: auto; padding: 10px 12px; border-radius: 4px; background: rgba(128,128,128,.15); }
            code { font-family: ui-monospace, monospace; font-size: .9em; background: rgba(128,128,128,.15); padding: .1em .3em; border-radius: 3px; }
            pre code { padding: 0; background: none; }
            blockquote { margin: 0; padding-left: 12px; border-left: 3px solid rgba(128,128,128,.5); opacity: .85; }
            hr { border: 0; border-top: 1px solid rgba(128,128,128,.4); }
        </style>${html.value}`;
    };

    const show = (wantHTML) => {
        showHTML = wantHTML;
        preview.showIf(!showHTML);
        html.showIf(showHTML);
        previewButton.classesIf(!showHTML, "dev-tools-button-current");
        htmlButton.classesIf(showHTML, "dev-tools-button-current");
    };

    previewButton.on("click", () => show(false));
    htmlButton.on("click", () => show(true));
    input.on("input", render);
    show(false);

    return pane(
        toolbar([previewButton, htmlButton, copyButton(() => html.value, "Copy HTML")]),
        split(labelled("Markdown", input), labelled("Result", output)),
        hint("Headings, emphasis, links, images, code, lists, quotes and rules. Raw HTML is shown as text, and tables are not supported."),
    ).withFocus(() => input.focus());
}

/* --------------------------------------------------------------------- yaml */

// A YAML reader for the part of the language configuration files actually use:
// block mappings and sequences, flow [..] and {..} collections, quoted and plain
// scalars, | and > block scalars, comments. Anchors, aliases, tags and multiple
// documents are rejected rather than guessed at.

class YAMLError extends Error {
    constructor(message, line) {
        super(line === undefined ? message : `Line ${line}: ${message}`);
    }
}

const EMPTY = Symbol("empty");

// Keys such as "__proto__" must not reach the prototype.
function setKey(object, key, value) {
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

function findClosingQuote(text, start) {
    const quote = text[start];

    for (let i = start + 1; i < text.length; i++) {
        if (quote === '"' && text[i] === "\\") {
            i++;
        } else if (text[i] === quote) {
            if (quote === "'" && text[i + 1] === "'") i++;
            else return i;
        }
    }

    return -1;
}

const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", 0: "\0", a: "\x07", e: "\x1b", v: "\v", " ": " ", '"': '"', "/": "/", "\\": "\\", _: " ", N: "\u0085" };

function unquote(token, line) {
    if (token[0] === "'") return token.slice(1, -1).replaceAll("''", "'");

    const body = token.slice(1, -1);
    let out = "";

    for (let i = 0; i < body.length; i++) {
        if (body[i] !== "\\") {
            out += body[i];
            continue;
        }

        const code = body[++i];
        const digits = { x: 2, u: 4, U: 8 }[code];

        if (digits !== undefined) {
            const hex = body.slice(i + 1, i + 1 + digits);
            if (hex.length !== digits || !/^[0-9a-f]+$/i.test(hex)) throw new YAMLError("Invalid escape sequence", line);
            out += String.fromCodePoint(parseInt(hex, 16));
            i += digits;
        } else if (code in ESCAPES) {
            out += ESCAPES[code];
        } else {
            throw new YAMLError(`Unknown escape \\${code ?? ""}`, line);
        }
    }

    return out;
}

function resolveScalar(text) {
    if (text === "" || text === "~" || /^(null|Null|NULL)$/.test(text)) return null;
    if (/^(true|True|TRUE)$/.test(text)) return true;
    if (/^(false|False|FALSE)$/.test(text)) return false;
    if (/^[-+]?\d+$/.test(text)) return Number(text);
    if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text, 16);
    if (/^0o[0-7]+$/.test(text)) return parseInt(text.slice(2), 8);
    if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(text) || /^[-+]?\d+[eE][-+]?\d+$/.test(text)) return Number(text);
    return text;
}

function stripComment(text) {
    let quote = null;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (quote !== null) {
            if (quote === '"' && char === "\\") i++;
            else if (char === quote) {
                if (quote === "'" && text[i + 1] === "'") i++;
                else quote = null;
            }
        } else if ((char === '"' || char === "'") && (i === 0 || /[\s[{,]/.test(text[i - 1]))) {
            quote = char;
        } else if (char === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
            return text.slice(0, i);
        }
    }

    return text;
}

function splitKey(text, line) {
    if (text[0] === '"' || text[0] === "'") {
        const end = findClosingQuote(text, 0);
        if (end === -1) return null;

        const after = text.slice(end + 1);
        if (!/^\s*:(\s|$)/.test(after)) return null;

        return { key: unquote(text.slice(0, end + 1), line), rest: after.replace(/^\s*:/, "").trim() };
    }

    if (text[0] === "[" || text[0] === "{") return null;

    const m = /^(.*?)\s*:(?:\s+(.*))?$/.exec(text);
    if (m === null || m[1] === "") return null;

    return { key: m[1], rest: (m[2] ?? "").trim() };
}

function parseFlow(source, lineNumber) {
    let i = 0;
    const fail = (message) => { throw new YAMLError(message, lineNumber); };
    const skip = () => { while (i < source.length && /\s/.test(source[i])) i++; };

    const value = () => {
        skip();
        const char = source[i];

        if (char === "[") return sequence();
        if (char === "{") return mapping();

        if (char === '"' || char === "'") {
            const end = findClosingQuote(source, i);
            if (end === -1) fail("Unterminated string");
            const result = unquote(source.slice(i, end + 1), lineNumber);
            i = end + 1;
            return result;
        }

        const start = i;
        while (i < source.length) {
            if (",]}".includes(source[i])) break;
            if (source[i] === ":" && (i + 1 >= source.length || /[\s,\]}]/.test(source[i + 1]))) break;
            i++;
        }

        const text = source.slice(start, i).trim();
        if (text === "") return EMPTY;
        if (/^[&*!]/.test(text)) fail("Anchors, aliases and tags are not supported");
        return resolveScalar(text);
    };

    const sequence = () => {
        i++;
        const out = [];

        for (;;) {
            skip();
            if (source[i] === "]") { i++; return out; }
            if (i >= source.length) fail("Unterminated [");

            const item = value();
            if (item === EMPTY) fail("Expected a value");
            out.push(item);

            skip();
            if (source[i] === ",") { i++; continue; }
            if (source[i] === "]") { i++; return out; }
            fail("Expected , or ]");
        }
    };

    const mapping = () => {
        i++;
        const out = {};

        for (;;) {
            skip();
            if (source[i] === "}") { i++; return out; }
            if (i >= source.length) fail("Unterminated {");

            const key = value();
            if (key === EMPTY) fail("Expected a key");

            skip();
            let item = null;
            if (source[i] === ":") {
                i++;
                skip();
                if (source[i] !== "," && source[i] !== "}") {
                    item = value();
                    if (item === EMPTY) item = null;
                }
            }
            setKey(out, String(key), item);

            skip();
            if (source[i] === ",") { i++; continue; }
            if (source[i] === "}") { i++; return out; }
            fail("Expected , or }");
        }
    };

    const result = value();
    skip();
    if (result === EMPTY || i < source.length) fail("Unexpected text after the flow collection");
    return result;
}

function flowDepth(text) {
    let depth = 0;
    let quote = null;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (quote !== null) {
            if (quote === '"' && char === "\\") i++;
            else if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "[" || char === "{") {
            depth++;
        } else if (char === "]" || char === "}") {
            depth--;
        }
    }

    return depth;
}

export function parseYAML(source) {
    const lines = source.replace(/\r\n?/g, "\n").split("\n").map((raw, index) => {
        const content = stripComment(raw).trimEnd();
        const text = content.trimStart();

        if (text !== "" && /^ *\t/.test(content)) {
            throw new YAMLError("Tabs cannot be used for indentation", index + 1);
        }

        return { raw, number: index + 1, indent: content.length - text.length, text, blank: text === "" };
    });

    let pos = 0;

    const skipBlank = () => {
        while (pos < lines.length && lines[pos].blank) pos++;
    };

    const isDash = (line) => line.text === "-" || line.text.startsWith("- ");

    const parseBlockScalar = (header, parentIndent, line) => {
        const flags = header.slice(1);
        if (!/^([-+]?\d?|\d[-+])$/.test(flags)) throw new YAMLError("Invalid block scalar header", line.number);

        const chomp = flags.includes("+") ? "keep" : flags.includes("-") ? "strip" : "clip";
        const explicit = /\d/.exec(flags);
        const body = [];

        while (pos < lines.length) {
            const raw = lines[pos].raw;

            if (raw.trim() === "") {
                body.push("");
            } else if (indentOf(raw) > parentIndent) {
                body.push(raw);
            } else {
                break;
            }

            pos++;
        }

        const firstContent = body.find((l) => l !== "");
        const blockIndent = explicit !== null
            ? Math.max(parentIndent, 0) + Number(explicit[0])
            : firstContent === undefined ? 0 : indentOf(firstContent);

        const content = body.map((l) => {
            if (l === "") return "";
            if (indentOf(l) < blockIndent) throw new YAMLError("Bad indentation in a block scalar", line.number);
            return l.slice(blockIndent);
        });

        let trailing = 0;
        while (content.length > 0 && content[content.length - 1] === "") {
            content.pop();
            trailing++;
        }

        let text;
        if (header[0] === "|") {
            text = content.join("\n");
        } else {
            text = content.reduce((out, current, index) => {
                if (index === 0) return current;
                const previous = content[index - 1];
                if (current === "") return out + "\n";
                if (previous === "") return out + current;
                return out + (current.startsWith(" ") || previous.startsWith(" ") ? "\n" : " ") + current;
            }, "");
        }

        if (content.length === 0) return chomp === "keep" ? "\n".repeat(trailing) : "";
        if (chomp === "strip") return text;
        return text + "\n".repeat(chomp === "keep" ? trailing + 1 : 1);
    };

    const parseValueText = (text, parentIndent, line) => {
        const first = text[0];

        if (first === "|" || first === ">") return parseBlockScalar(text, parentIndent, line);

        if (first === "[" || first === "{") {
            let buffer = text;
            while (flowDepth(buffer) > 0 && pos < lines.length) {
                buffer += " " + lines[pos].text;
                pos++;
            }
            if (flowDepth(buffer) !== 0) throw new YAMLError("Unterminated flow collection", line.number);
            return parseFlow(buffer, line.number);
        }

        if (first === '"' || first === "'") {
            const end = findClosingQuote(text, 0);
            if (end === -1) throw new YAMLError("Multi-line quoted strings are not supported", line.number);
            if (text.slice(end + 1).trim() !== "") throw new YAMLError("Unexpected text after a quoted string", line.number);
            return unquote(text.slice(0, end + 1), line.number);
        }

        if (first === "&" || first === "*" || first === "!") {
            throw new YAMLError("Anchors, aliases and tags are not supported", line.number);
        }

        if (first === "@" || first === "`" || first === "%") {
            throw new YAMLError(`"${first}" cannot start a plain value`, line.number);
        }

        // A plain scalar may continue on more deeply indented lines.
        let value = text;
        while (pos < lines.length && !lines[pos].blank && lines[pos].indent > parentIndent) {
            value += " " + lines[pos].text;
            pos++;
        }

        if (/:(\s|$)/.test(value)) {
            throw new YAMLError("A plain value cannot contain \": \" (quote it, or fix the indentation)", line.number);
        }

        return resolveScalar(value);
    };

    const parseSequence = (indent) => {
        const out = [];

        for (;;) {
            skipBlank();
            const line = lines[pos];
            if (line === undefined || line.indent !== indent || !isDash(line)) break;

            const rest = line.text.slice(1).trimStart();

            if (rest === "") {
                pos++;
                skipBlank();
                out.push(lines[pos]?.indent > indent ? parseBlock() : null);
                continue;
            }

            // Whatever follows the dash is read as a line of its own, indented
            // past the dash: a mapping, a nested sequence or a scalar.
            lines[pos] = { ...line, indent: indent + (line.text.length - rest.length), text: rest, parent: indent };
            out.push(parseBlock());
        }

        return out;
    };

    const parseMapping = (indent) => {
        const out = {};

        for (;;) {
            skipBlank();
            const line = lines[pos];
            if (line === undefined || line.indent !== indent) break;

            const pair = splitKey(line.text, line.number);
            if (pair === null) throw new YAMLError("Expected a \"key: value\" pair", line.number);
            if (/^[&*!]/.test(line.text)) throw new YAMLError("Anchors, aliases and tags are not supported", line.number);

            pos++;
            let value;

            if (pair.rest === "") {
                skipBlank();
                const next = lines[pos];

                if (next !== undefined && next.indent > indent) value = parseBlock();
                else if (next !== undefined && next.indent === indent && isDash(next)) value = parseSequence(indent);
                else value = null;
            } else {
                value = parseValueText(pair.rest, indent, line);
            }

            setKey(out, pair.key, value);
        }

        return out;
    };

    function parseBlock() {
        skipBlank();
        const line = lines[pos];
        if (line === undefined) return null;

        if (isDash(line)) return parseSequence(line.indent);
        if (splitKey(line.text, line.number) !== null) return parseMapping(line.indent);

        pos++;
        return parseValueText(line.text, line.parent ?? line.indent - 1, line);
    }

    skipBlank();
    if (lines[pos]?.text === "---") pos++;

    const result = parseBlock();

    skipBlank();
    if (pos < lines.length) {
        const line = lines[pos];
        throw new YAMLError(
            line.text === "---" || line.text === "..."
                ? "Multiple documents are not supported"
                : "Unexpected content or indentation",
            line.number,
        );
    }

    return result;
}

const PLAIN_STRING = /^[A-Za-z_][\w./@+ -]*$/;
const RESERVED_WORD = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

function scalarToYAML(value) {
    if (value === null) return "null";
    if (typeof value === "string") {
        const plain = PLAIN_STRING.test(value) && !value.endsWith(" ") && !RESERVED_WORD.test(value);
        return plain ? value : JSON.stringify(value);
    }
    return String(value);
}

const isFilledCollection = (value) =>
    value !== null && typeof value === "object" && Object.keys(value).length > 0;

export function stringifyYAML(value, level = 0) {
    const pad = "  ".repeat(level);

    if (Array.isArray(value)) {
        if (value.length === 0) return "[]";

        return value.map((item) => {
            if (!isFilledCollection(item)) return `${pad}- ${stringifyYAML(item, level + 1)}`;

            // Start the nested block on the dash's own line.
            const nested = stringifyYAML(item, level + 1);
            return `${pad}- ${nested.slice((level + 1) * 2)}`;
        }).join("\n");
    }

    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length === 0) return "{}";

        return entries.map(([key, item]) => {
            const name = scalarToYAML(key);
            return isFilledCollection(item)
                ? `${pad}${name}:\n${stringifyYAML(item, level + 1)}`
                : `${pad}${name}: ${stringifyYAML(item, level + 1)}`;
        }).join("\n");
    }

    return scalarToYAML(value);
}

export function buildYAML() {
    const yamlEditor = editor("YAML…", { indent: true });
    const jsonEditor = editor("JSON…", { indent: true });
    const status = createStatus();
    const clearButton = button("Clear");

    yamlEditor.on("input", () => {
        if (yamlEditor.value.trim() === "") {
            jsonEditor.value = "";
            status.set("");
            return;
        }

        try {
            jsonEditor.value = JSON.stringify(parseYAML(yamlEditor.value), null, 2);
            status.set("Valid YAML", "ok");
        } catch (err) {
            status.set(err.message, "error");
        }
    });

    jsonEditor.on("input", () => {
        if (jsonEditor.value.trim() === "") {
            yamlEditor.value = "";
            status.set("");
            return;
        }

        const result = parseJSON(jsonEditor.value);
        if (result.error !== undefined) {
            status.set(formatParseError(result.error, "Invalid JSON"), "error");
            return;
        }

        yamlEditor.value = stringifyYAML(result.value) + "\n";
        status.set("Valid JSON", "ok");
    });

    clearButton.on("click", () => {
        yamlEditor.value = "";
        jsonEditor.value = "";
        status.set("");
        yamlEditor.focus();
    });

    return pane(
        toolbar([copyButton(() => yamlEditor.value, "Copy YAML"), copyButton(() => jsonEditor.value, "Copy JSON"), clearButton], status),
        split(labelled("YAML", yamlEditor), labelled("JSON", jsonEditor)),
        hint("Edit either side. Anchors, aliases, tags and multiple documents are not supported."),
    ).withFocus(() => yamlEditor.focus());
}
