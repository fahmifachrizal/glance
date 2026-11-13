import { elem } from "./templating.js";
import { throttledDebounce } from "./utils.js";
import {
    editor, textInput, createStatus, pane, labelled, split, valueRow, rows, createDiffPane,
} from "./dev-tools-ui.js";

/* ---------------------------------------------------------------- text diff */

const MAX_DIFF_CELLS = 16_000_000;

// Longest-common-subsequence line diff. Returns [{ type: "same" | "del" | "add", line }]
// in order, or null when the inputs are too large to compare.
export function diffLines(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;

    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }

    const left = a.slice(start, endA);
    const right = b.slice(start, endB);
    const n = left.length;
    const m = right.length;

    if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;

    // table[i][j] = length of the LCS of left[i:] and right[j:]
    const width = m + 1;
    const table = new Uint16Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i * width + j] = left[i] === right[j]
                ? table[(i + 1) * width + j + 1] + 1
                : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }

    const ops = a.slice(0, start).map((line) => ({ type: "same", line }));
    let i = 0;
    let j = 0;

    while (i < n && j < m) {
        if (left[i] === right[j]) {
            ops.push({ type: "same", line: left[i] });
            i++;
            j++;
        } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
            ops.push({ type: "del", line: left[i++] });
        } else {
            ops.push({ type: "add", line: right[j++] });
        }
    }

    while (i < n) ops.push({ type: "del", line: left[i++] });
    while (j < m) ops.push({ type: "add", line: right[j++] });

    for (const line of a.slice(endA)) ops.push({ type: "same", line });
    return ops;
}

// Pairs each run of removed lines with the added lines that replace them so they
// sit side by side; whatever is left over is reported as missing or added.
export function alignDiff(ops) {
    const rows = [];
    const counts = { missing: 0, added: 0, changed: 0 };

    for (let i = 0; i < ops.length;) {
        if (ops[i].type === "same") {
            rows.push({ depth: 0, left: ops[i].line, right: ops[i].line, status: "same" });
            i++;
            continue;
        }

        const removed = [];
        const added = [];
        while (i < ops.length && ops[i].type !== "same") {
            (ops[i].type === "del" ? removed : added).push(ops[i].line);
            i++;
        }

        for (let k = 0; k < Math.max(removed.length, added.length); k++) {
            const left = removed[k] ?? null;
            const right = added[k] ?? null;

            if (left !== null && right !== null) {
                counts.changed++;
                rows.push({ depth: 0, left, right, status: "changed" });
            } else if (left !== null) {
                counts.missing++;
                rows.push({ depth: 0, left, right: null, status: "missing" });
            } else {
                counts.added++;
                rows.push({ depth: 0, left: null, right, status: "added" });
            }
        }
    }

    return { rows, counts };
}

const splitLines = (text) => text.replace(/\r\n?/g, "\n").split("\n");

function compareText(leftSource, rightSource) {
    if (leftSource === "" && rightSource === "") {
        return { error: "Paste text into either side to compare", kind: "neutral" };
    }

    const ops = diffLines(splitLines(leftSource), splitLines(rightSource));
    if (ops === null) {
        return { error: "Too large to compare line by line" };
    }

    return alignDiff(ops);
}

export function buildTextDiff() {
    return createDiffPane({
        originalPlaceholder: "Original text…",
        changedPlaceholder: "Changed text…",
        legend: "Lines are compared exactly. A removed line and the line replacing it are shown side by side.",
        compare: compareText,
        indent: true,
    });
}

/* --------------------------------------------------------------------- case */

export function splitWords(text) {
    return text
        .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
        .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

export const CASES = [
    ["camelCase", (w) => w.map((x, i) => i === 0 ? x.toLowerCase() : capitalize(x)).join("")],
    ["PascalCase", (w) => w.map(capitalize).join("")],
    ["snake_case", (w) => w.map((x) => x.toLowerCase()).join("_")],
    ["CONSTANT_CASE", (w) => w.map((x) => x.toUpperCase()).join("_")],
    ["kebab-case", (w) => w.map((x) => x.toLowerCase()).join("-")],
    ["dot.case", (w) => w.map((x) => x.toLowerCase()).join(".")],
    ["Title Case", (w) => w.map(capitalize).join(" ")],
    ["Sentence case", (w) => w.map((x, i) => i === 0 ? capitalize(x) : x.toLowerCase()).join(" ")],
];

// Each line is converted on its own, so a list of identifiers converts in one go.
export function convertCase(text, convert) {
    return text.split("\n").map((line) => convert(splitWords(line))).join("\n");
}

export function buildCase() {
    const input = editor("Type or paste text, one item per line…", { wrap: true });
    const outputs = [
        ...CASES.map(([name]) => valueRow(name)),
        valueRow("lowercase"),
        valueRow("UPPERCASE"),
    ];

    const run = () => {
        const text = input.value;
        CASES.forEach(([, convert], i) => outputs[i].set(text === "" ? "" : convertCase(text, convert)));
        outputs[CASES.length].set(text.toLowerCase());
        outputs[CASES.length + 1].set(text.toUpperCase());
    };

    input.on("input", run);

    return pane(
        labelled("Text", input, "dev-tools-short"),
        rows(...outputs),
    ).withFocus(() => input.focus());
}

/* -------------------------------------------------------------------- regex */

const MATCH_LIMIT = 1000;

export function runRegex(pattern, flags, text) {
    let regex;
    try {
        regex = new RegExp(pattern, flags);
    } catch (err) {
        return { error: err.message.replace(/^Invalid regular expression: (?:\/.*\/[a-z]*: )?/, "") };
    }

    const matches = [];
    let truncated = false;

    if (!regex.global && !regex.sticky) {
        const match = regex.exec(text);
        if (match !== null) matches.push(match);
    } else {
        regex.lastIndex = 0;

        for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
            if (matches.length === MATCH_LIMIT) {
                truncated = true;
                break;
            }

            matches.push(match);

            // A zero-length match would otherwise be found again forever.
            if (match[0] === "") regex.lastIndex++;
            if (!regex.global) break;
        }
    }

    return { matches, truncated };
}

function renderHighlight(output, text, matches) {
    output.innerHTML = "";
    let position = 0;

    matches.forEach((match, i) => {
        if (match[0] === "") return;

        output.append(text.slice(position, match.index));

        const mark = elem("mark").classes("dev-tools-match");
        if (i % 2 === 1) mark.classes("dev-tools-match-alt");
        mark.textContent = match[0];
        output.append(mark);

        position = match.index + match[0].length;
    });

    output.append(text.slice(position));
}

function renderMatches(list, matches) {
    list.innerHTML = "";

    matches.forEach((match, i) => {
        const item = elem("div").classes("dev-tools-match-item");
        const title = elem("div").classes("dev-tools-match-title");
        title.textContent = `#${i + 1} at ${match.index}: ${JSON.stringify(match[0])}`;
        item.append(title);

        const groups = [];
        for (let g = 1; g < match.length; g++) {
            groups.push([String(g), match[g]]);
        }
        for (const [name, value] of Object.entries(match.groups ?? {})) {
            groups.push([name, value]);
        }

        for (const [name, value] of groups) {
            const line = elem("div").classes("dev-tools-match-group");
            line.textContent = `${name}: ${value === undefined ? "(no match)" : JSON.stringify(value)}`;
            item.append(line);
        }

        list.append(item);
    });
}

export function buildRegex() {
    const pattern = textInput("Pattern", "dev-tools-input-grow");
    const flags = textInput("flags", "dev-tools-input-flags");
    flags.value = "g";
    flags.attr("title", "g global · i ignore case · m multiline · s dotAll · u unicode · y sticky");

    const text = editor("Text to test against…", { wrap: true });
    const highlight = elem("div").classes("dev-tools-highlight");
    const list = elem("div").classes("dev-tools-match-list");
    const status = createStatus();

    const run = () => {
        if (pattern.value === "") {
            highlight.innerHTML = "";
            list.innerHTML = "";
            status.set("");
            return;
        }

        const result = runRegex(pattern.value, flags.value, text.value);

        if (result.error !== undefined) {
            highlight.innerHTML = "";
            list.innerHTML = "";
            status.set(result.error, "error");
            return;
        }

        renderHighlight(highlight, text.value, result.matches);
        renderMatches(list, result.matches);

        const count = result.matches.length;
        const label = `${result.truncated ? count + "+" : count} ${count === 1 ? "match" : "matches"}`;
        status.set(label, count > 0 ? "ok" : "neutral");
    };

    const debounced = throttledDebounce(run, 10, 150);
    for (const control of [pattern, flags, text]) control.on("input", debounced);

    return pane(
        elem("div").classes("dev-tools-toolbar").append(
            elem("span").classes("dev-tools-affix").text("/"),
            pattern,
            elem("span").classes("dev-tools-affix").text("/"),
            flags,
            status.element,
        ),
        split(
            labelled("Text", text),
            elem("div").classes("dev-tools-editor-container").append(
                labelled("Highlighted", highlight, "dev-tools-half"),
                labelled("Matches", list, "dev-tools-half"),
            ),
        ),
    ).withFocus(() => pattern.focus());
}
