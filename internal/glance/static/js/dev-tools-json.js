import { throttledDebounce } from "./utils.js";
import { elem } from "./templating.js";
import { button, editor, indentSelect, createStatus, copyButton, toolbar, pane, createDiffPane } from "./dev-tools-ui.js";

const INDENTS = { "2": "  ", "4": "    ", "tab": "\t" };
const COMPACT_MAX_LENGTH = 120;

/* ------------------------------------------------------------------ parsing */

// Returns { value } on success, or { error: { message, line, column } }.
export function parseJSON(source) {
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

export function formatParseError(error, label) {
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

export function buildJSONFormat() {
    const input = editor("Paste JSON here…", { indent: true });
    const status = createStatus();
    const indent = indentSelect();

    const formatButton = button("Format", "dev-tools-button-primary");
    const minifyButton = button("Minify");
    const clearButton = button("Clear");
    const copy = copyButton(() => input.value);

    // Returns { ok: true, value } so that valid input parsing to `null` is not
    // confused with a parse failure.
    const validate = () => {
        const source = input.value.trim();

        if (source === "") {
            status.set("");
            return { ok: false };
        }

        const result = parseJSON(source);

        if (result.error !== undefined) {
            status.set(formatParseError(result.error, "Invalid JSON"), "error");
            return { ok: false };
        }

        status.set("Valid JSON", "ok");
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
        if (input.value.trim() !== "" && status.kind() === "ok") {
            rewrite((value) => JSON.stringify(value, null, INDENTS[indent.value]));
        }
    });

    clearButton.on("click", () => {
        input.value = "";
        validate();
        input.focus();
    });

    input.on("input", throttledDebounce(validate, 10, 200));

    return pane(
        toolbar([formatButton, minifyButton, indent, copy, clearButton], status),
        elem("div").classes("dev-tools-editor-container").append(input),
    ).withFocus(() => input.focus());
}

function compareJSON(leftSource, rightSource) {
    if (leftSource.trim() === "" || rightSource.trim() === "") {
        return { error: "Paste JSON into both sides to compare", kind: "neutral" };
    }

    const left = parseJSON(leftSource);
    if (left.error !== undefined) {
        return { error: formatParseError(left.error, "Original is invalid") };
    }

    const right = parseJSON(rightSource);
    if (right.error !== undefined) {
        return { error: formatParseError(right.error, "Changed is invalid") };
    }

    return diff(left.value, right.value);
}

export function buildJSONDiff() {
    return createDiffPane({
        originalPlaceholder: "Original JSON…",
        changedPlaceholder: "Changed JSON…",
        legend: "Keys are matched by name, so reordering them is not a difference. Rows follow the original's key order; keys only in the changed JSON are appended.",
        compare: compareJSON,
        indent: true,
    });
}
