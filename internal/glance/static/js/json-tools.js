import { elem, fragment } from "./templating.js";
import { throttledDebounce } from "./utils.js";

const INDENTS = { "2": "  ", "4": "    ", "tab": "\t" };
const COMPACT_MAX_LENGTH = 120;

let instance = null;

// Without an explicit tab the overlay reopens on whichever one was last used.
export default function openJSONTools(tab) {
    if (instance === null) {
        instance = buildOverlay();
        document.body.appendChild(instance.element);
    }

    instance.open(tab);
}

/* ------------------------------------------------------------------ parsing */

// Returns { value } on success, or { error: { message, line, column } }.
function parseJSON(source) {
    try {
        return { value: JSON.parse(source) };
    } catch (err) {
        return { error: describeParseError(err, source) };
    }
}

// Engines word these very differently, so pull out whatever location they give
// and strip their trailing noise:
//   V8       "Expected ':' after property name in JSON at position 5 (line 1 column 6)"
//   V8       "Unexpected token ']', ...\"[1, 2,]\" is not valid JSON"  (no location)
//   Firefox  "JSON.parse: expected property name at line 3 column 2 of the JSON data"
function describeParseError(err, source) {
    const raw = err.message;

    let line = null;
    let column = null;

    const lineColumn = /line (\d+) column (\d+)/.exec(raw);
    const position = /at position (\d+)/.exec(raw);

    if (lineColumn !== null) {
        line = Number(lineColumn[1]);
        column = Number(lineColumn[2]);
    } else if (position !== null) {
        const offset = Math.min(Number(position[1]), source.length);
        const preceding = source.slice(0, offset);
        line = preceding.split("\n").length;
        column = offset - preceding.lastIndexOf("\n");
    }

    const message = raw
        .replace(/^JSON\.parse:\s*/, "")
        .replace(/\s*is not valid JSON$/, "")
        .replace(/,\s*(\.\.\.)?"[\s\S]*$/, "")
        .replace(/\s*(in JSON )?at position.*$/, "")
        .replace(/\s*at line \d+ column \d+( of the JSON data)?\.?$/, "")
        .trim();

    return { message: message || raw, line, column };
}

function formatParseError(error, label) {
    const where = error.line !== null ? ` at line ${error.line}, column ${error.column}` : "";
    return `${label}: ${error.message}${where}`;
}

/* --------------------------------------------------------------------- diff */

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Order-insensitive for object keys: a key only ever compares against the same
// key on the other side, so reordering keys is never reported as a difference.
function deepEqual(a, b) {
    if (a === b) return true;

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
    }

    if (isPlainObject(a) && isPlainObject(b)) {
        const aKeys = Object.keys(a);
        if (aKeys.length !== Object.keys(b).length) return false;
        for (const key of aKeys) {
            if (!Object.hasOwn(b, key)) return false;
            if (!deepEqual(a[key], b[key])) return false;
        }
        return true;
    }

    return false;
}

function keyLabel(key) {
    if (key === null) return "";
    return typeof key === "number" ? `${key}: ` : `${JSON.stringify(key)}: `;
}

function compactValue(value) {
    const serialized = JSON.stringify(value);
    return serialized.length > COMPACT_MAX_LENGTH
        ? serialized.slice(0, COMPACT_MAX_LENGTH - 1) + "…"
        : serialized;
}

function pushRow(rows, depth, left, right, status) {
    rows.push({ depth, left, right, status });
}

// Renders a subtree that exists on only one side, expanded so every child of a
// missing or added branch is visible.
function pushSingleSide(rows, depth, key, value, side, status) {
    const push = (text) => pushRow(
        rows, depth,
        side === "left" ? text : null,
        side === "right" ? text : null,
        status,
    );

    const label = keyLabel(key);

    if (isPlainObject(value)) {
        push(label + "{");
        for (const childKey of Object.keys(value)) {
            pushSingleSide(rows, depth + 1, childKey, value[childKey], side, status);
        }
        push("}");
    } else if (Array.isArray(value)) {
        push(label + "[");
        for (let i = 0; i < value.length; i++) {
            pushSingleSide(rows, depth + 1, i, value[i], side, status);
        }
        push("]");
    } else {
        push(label + JSON.stringify(value));
    }
}

function diffInto(rows, counts, depth, key, left, right) {
    const label = keyLabel(key);

    // Identical subtrees collapse to a single row so the output stays focused
    // on what actually differs.
    if (deepEqual(left, right)) {
        const text = label + compactValue(left);
        pushRow(rows, depth, text, text, "same");
        return;
    }

    if (isPlainObject(left) && isPlainObject(right)) {
        pushRow(rows, depth, label + "{", label + "{", "same");

        // Left keeps its own original order; keys only on the right follow in
        // the right's order.
        for (const childKey of Object.keys(left)) {
            if (Object.hasOwn(right, childKey)) {
                diffInto(rows, counts, depth + 1, childKey, left[childKey], right[childKey]);
            } else {
                counts.missing++;
                pushSingleSide(rows, depth + 1, childKey, left[childKey], "left", "missing");
            }
        }

        for (const childKey of Object.keys(right)) {
            if (!Object.hasOwn(left, childKey)) {
                counts.added++;
                pushSingleSide(rows, depth + 1, childKey, right[childKey], "right", "added");
            }
        }

        pushRow(rows, depth, "}", "}", "same");
        return;
    }

    if (Array.isArray(left) && Array.isArray(right)) {
        pushRow(rows, depth, label + "[", label + "[", "same");

        const length = Math.max(left.length, right.length);
        for (let i = 0; i < length; i++) {
            if (i < left.length && i < right.length) {
                diffInto(rows, counts, depth + 1, i, left[i], right[i]);
            } else if (i < left.length) {
                counts.missing++;
                pushSingleSide(rows, depth + 1, i, left[i], "left", "missing");
            } else {
                counts.added++;
                pushSingleSide(rows, depth + 1, i, right[i], "right", "added");
            }
        }

        pushRow(rows, depth, "]", "]", "same");
        return;
    }

    counts.changed++;
    pushRow(rows, depth, label + compactValue(left), label + compactValue(right), "changed");
}

function diff(left, right) {
    const rows = [];
    const counts = { missing: 0, added: 0, changed: 0 };
    diffInto(rows, counts, 0, null, left, right);
    return { rows, counts };
}

/* ------------------------------------------------------------------------ UI */

function button(label, extraClass = "") {
    const b = elem("button").classes("json-tools-button").text(label);
    if (extraClass !== "") b.classes(extraClass);
    return b;
}

function editor(placeholder) {
    const textarea = elem("textarea")
        .classes("json-tools-editor")
        .attrs({ spellcheck: "false", autocomplete: "off", placeholder });

    // A JSON editor should indent on Tab rather than move focus out.
    textarea.on("keydown", (event) => {
        if (event.key !== "Tab" || event.shiftKey) return;

        event.preventDefault();
        const { selectionStart, selectionEnd, value } = textarea;
        textarea.value = value.slice(0, selectionStart) + "\t" + value.slice(selectionEnd);
        textarea.selectionStart = textarea.selectionEnd = selectionStart + 1;
        textarea.dispatchEvent(new Event("input"));
    });

    return textarea;
}

function indentSelect() {
    const select = elem("select").classes("json-tools-select").attr("title", "Indentation");

    for (const [value, label] of [["2", "2 spaces"], ["4", "4 spaces"], ["tab", "Tab"]]) {
        // NOTE: `option.text` is a native property, so the templating helper of
        // the same name is shadowed here and textContent has to be set directly.
        const option = elem("option").attr("value", value);
        option.textContent = label;
        select.appendChild(option);
    }

    select.value = "2";
    return select;
}

function buildFormatPane() {
    const input = editor("Paste JSON here…");
    const status = elem("div").classes("json-tools-status");
    const indent = indentSelect();

    const formatButton = button("Format", "json-tools-button-primary");
    const minifyButton = button("Minify");
    const copyButton = button("Copy");
    const clearButton = button("Clear");

    const setStatus = (text, kind) => {
        status.className = "json-tools-status";
        if (kind !== undefined) status.classes("json-tools-status-" + kind);
        status.textContent = text;
    };

    // Returns { ok: true, value } so that valid input parsing to `null` is not
    // confused with a parse failure.
    const validate = () => {
        const source = input.value.trim();

        if (source === "") {
            setStatus("");
            return { ok: false };
        }

        const result = parseJSON(source);

        if (result.error !== undefined) {
            setStatus(formatParseError(result.error, "Invalid JSON"), "error");
            return { ok: false };
        }

        setStatus("Valid JSON", "ok");
        return { ok: true, value: result.value };
    };

    const rewrite = (serialize) => {
        const result = validate();
        if (!result.ok) return;

        input.value = serialize(result.value);
        validate();
    };

    formatButton.on("click", () => rewrite((value) => JSON.stringify(value, null, INDENTS[indent.value])));
    minifyButton.on("click", () => rewrite((value) => JSON.stringify(value)));

    indent.on("change", () => {
        if (input.value.trim() !== "" && status.hasClass("json-tools-status-ok")) {
            rewrite((value) => JSON.stringify(value, null, INDENTS[indent.value]));
        }
    });

    copyButton.on("click", async () => {
        if (input.value === "") return;

        try {
            await navigator.clipboard.writeText(input.value);
            copyButton.textContent = "Copied";
            setTimeout(() => { copyButton.textContent = "Copy"; }, 1200);
        } catch {
            setStatus("Could not copy to clipboard", "error");
        }
    });

    clearButton.on("click", () => {
        input.value = "";
        validate();
        input.focus();
    });

    input.on("input", throttledDebounce(validate, 10, 200));

    const pane = elem("div").classes("json-tools-pane").append(
        elem("div").classes("json-tools-toolbar").append(
            formatButton, minifyButton, indent, copyButton, clearButton,
            elem("div").classes("grow"),
            status,
        ),
        elem("div").classes("json-tools-editor-container").append(input),
    );

    return { element: pane, focus: () => input.focus() };
}

function buildDiffPane() {
    const left = editor("Original JSON…");
    const right = editor("Changed JSON…");
    const status = elem("div").classes("json-tools-status");
    const output = elem("div").classes("json-diff");

    const compareButton = button("Compare", "json-tools-button-primary");
    const clearButton = button("Clear");

    const setStatus = (text, kind) => {
        status.className = "json-tools-status";
        if (kind !== undefined) status.classes("json-tools-status-" + kind);
        status.textContent = text;
    };

    const renderRows = (rows) => {
        output.innerHTML = "";
        const cells = fragment();

        for (const row of rows) {
            for (const side of ["left", "right"]) {
                const text = row[side];
                const cell = elem("div")
                    .classes("json-diff-cell", "json-diff-" + row.status)
                    .styleVar("depth", row.depth);

                if (text === null) {
                    cell.classes("json-diff-cell-empty");
                } else {
                    cell.text(text);
                }

                cells.append(cell);
            }
        }

        output.appendChild(cells);
    };

    const compare = () => {
        const leftSource = left.value.trim();
        const rightSource = right.value.trim();

        if (leftSource === "" || rightSource === "") {
            output.innerHTML = "";
            setStatus("Paste JSON into both sides to compare", "neutral");
            return;
        }

        const leftResult = parseJSON(leftSource);
        if (leftResult.error !== undefined) {
            output.innerHTML = "";
            setStatus(formatParseError(leftResult.error, "Original is invalid"), "error");
            return;
        }

        const rightResult = parseJSON(rightSource);
        if (rightResult.error !== undefined) {
            output.innerHTML = "";
            setStatus(formatParseError(rightResult.error, "Changed is invalid"), "error");
            return;
        }

        const { rows, counts } = diff(leftResult.value, rightResult.value);
        renderRows(rows);

        const total = counts.changed + counts.missing + counts.added;

        if (total === 0) {
            setStatus("No differences", "ok");
            return;
        }

        setStatus(
            `${counts.changed} changed · ${counts.missing} missing · ${counts.added} added`,
            "diff",
        );
    };

    compareButton.on("click", compare);

    clearButton.on("click", () => {
        left.value = "";
        right.value = "";
        output.innerHTML = "";
        setStatus("");
        left.focus();
    });

    const pane = elem("div").classes("json-tools-pane").append(
        elem("div").classes("json-tools-toolbar").append(
            compareButton, clearButton,
            elem("div").classes("grow"),
            status,
        ),
        elem("div").classes("json-diff-inputs").append(
            elem("div").classes("json-tools-editor-container").append(
                elem("div").classes("json-tools-label").text("Original"),
                left,
            ),
            elem("div").classes("json-tools-editor-container").append(
                elem("div").classes("json-tools-label").text("Changed"),
                right,
            ),
        ),
        elem("div").classes("json-diff-container").append(
            elem("div").classes("json-diff-legend").text(
                "Keys are matched by name, so reordering them is not a difference. Rows follow the original's key order; keys only in the changed JSON are appended.",
            ),
            output,
        ),
    );

    return { element: pane, focus: () => left.focus() };
}

function buildOverlay() {
    const panes = {
        format: buildFormatPane(),
        diff: buildDiffPane(),
    };

    const tabs = {};
    const tabBar = elem("div").classes("json-tools-tabs");
    let currentTab = null;

    const selectTab = (name) => {
        currentTab = name;

        for (const [tabName, tab] of Object.entries(tabs)) {
            tab.classesIf(tabName === name, "json-tools-tab-current");
        }

        for (const [paneName, pane] of Object.entries(panes)) {
            pane.element.showIf(paneName === name);
        }
    };

    for (const [name, label] of [["format", "Format"], ["diff", "Diff"]]) {
        tabs[name] = elem("button")
            .classes("json-tools-tab")
            .text(label)
            .on("click", () => {
                selectTab(name);
                panes[name].focus();
            })
            .appendTo(tabBar);
    }

    const closeButton = elem("button")
        .classes("json-tools-close")
        .attr("title", "Close (Esc)")
        .html(`<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`);

    const panel = elem("div").classes("json-tools-panel").append(
        elem("div").classes("json-tools-header").append(
            elem("div").classes("json-tools-title").text("JSON Tools"),
            tabBar,
            closeButton,
        ),
        panes.format.element,
        panes.diff.element,
    );

    const element = elem("div").classes("json-tools-overlay").append(panel);

    const close = () => {
        element.classList.remove("json-tools-overlay-visible");
        document.body.classList.remove("json-tools-open");
    };

    closeButton.on("click", close);

    element.on("mousedown", (event) => {
        if (event.target === element) close();
    });

    // On the document rather than the overlay so Escape still closes it when
    // focus has moved outside the panel.
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!element.classList.contains("json-tools-overlay-visible")) return;

        event.stopPropagation();
        close();
    });

    selectTab("format");

    return {
        element,
        open: (tab) => {
            document.body.classList.add("json-tools-open");
            element.classList.add("json-tools-overlay-visible");
            selectTab(tab in panes ? tab : currentTab);
            panes[currentTab].focus();
        },
    };
}
