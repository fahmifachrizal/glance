import { elem, fragment } from "./templating.js";

// Shared building blocks for the tools in the developer tools overlay. Note that
// templating.js's `.text()` is shadowed by a native property on some elements
// (e.g. <option>), so plain text is set through textContent in this file.

export function button(label, extraClass = "") {
    const b = elem("button").classes("dev-tools-button").attr("type", "button");
    b.textContent = label;
    if (extraClass !== "") b.classes(extraClass);
    return b;
}

// Options: readonly, wrap (soft-wrap long lines instead of scrolling), indent
// (Tab inserts a tab character rather than moving focus away).
export function editor(placeholder, { readonly = false, wrap = false, indent = false } = {}) {
    const textarea = elem("textarea")
        .classes("dev-tools-editor")
        .attrs({ spellcheck: "false", autocomplete: "off", autocapitalize: "off", placeholder });

    if (readonly) textarea.readOnly = true;
    if (wrap) textarea.classes("dev-tools-editor-wrap");

    if (indent) {
        textarea.on("keydown", (event) => {
            if (event.key !== "Tab" || event.shiftKey) return;

            event.preventDefault();
            const { selectionStart, selectionEnd, value } = textarea;
            textarea.value = value.slice(0, selectionStart) + "\t" + value.slice(selectionEnd);
            textarea.selectionStart = textarea.selectionEnd = selectionStart + 1;
            textarea.dispatchEvent(new Event("input"));
        });
    }

    return textarea;
}

export function textInput(placeholder = "", extraClass = "") {
    const input = elem("input")
        .classes("dev-tools-input")
        .attrs({ type: "text", spellcheck: "false", autocomplete: "off", autocapitalize: "off", placeholder });
    if (extraClass !== "") input.classes(extraClass);
    return input;
}

export function numberInput(value, min, max, title) {
    return elem("input")
        .classes("dev-tools-input", "dev-tools-input-number")
        .attrs({ type: "number", min, max, title, value });
}

export function selectOf(options, title, value) {
    const select = elem("select").classes("dev-tools-select").attr("title", title);

    for (const [optionValue, label] of options) {
        const option = elem("option").attr("value", optionValue);
        option.textContent = label;
        select.appendChild(option);
    }

    if (value !== undefined) select.value = value;
    return select;
}

export function indentSelect() {
    return selectOf([["2", "2 spaces"], ["4", "4 spaces"], ["tab", "Tab"]], "Indentation", "2");
}

export function checkbox(label, checked = false) {
    const input = elem("input").attrs({ type: "checkbox" });
    input.checked = checked;
    const text = elem("span");
    text.textContent = label;
    return { element: elem("label").classes("dev-tools-check").append(input, text), input };
}

export function createStatus() {
    const element = elem("div").classes("dev-tools-status");
    let current;

    return {
        element,
        set(text, kind) {
            current = kind;
            element.className = "dev-tools-status";
            if (kind !== undefined) element.classes("dev-tools-status-" + kind);
            element.textContent = text;
        },
        kind: () => current,
    };
}

// Works on plain http too, where navigator.clipboard is not available.
export async function copyText(text) {
    if (navigator.clipboard !== undefined) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch { /* fall through to the legacy path */ }
    }

    const previous = document.activeElement;
    const scratch = elem("textarea").styles({ position: "fixed", opacity: "0" });
    scratch.value = text;
    document.body.appendChild(scratch);
    scratch.select();

    let copied = false;
    try {
        copied = document.execCommand("copy");
    } catch { /* leave copied false */ }

    scratch.remove();
    if (previous instanceof HTMLElement) previous.focus();
    return copied;
}

export function copyButton(getText, label = "Copy") {
    const b = button(label);

    b.on("click", async () => {
        const text = getText();
        if (text === "") return;

        const copied = await copyText(text);
        b.textContent = copied ? "Copied" : "Failed";
        setTimeout(() => { b.textContent = label; }, 1200);
    });

    return b;
}

// A toolbar row: controls on the left, status text pushed to the right.
export function toolbar(controls, status) {
    const bar = elem("div").classes("dev-tools-toolbar").append(...controls);

    if (status !== undefined) {
        bar.append(elem("div").classes("grow"), status.element);
    }

    return bar;
}

export function pane(...children) {
    return {
        element: elem("div").classes("dev-tools-pane").append(...children),
        focus() {},
        withFocus(focus) {
            this.focus = focus;
            return this;
        },
    };
}

// A control with a small caption above it.
export function labelled(caption, control, extraClass = "") {
    const caps = elem("div").classes("dev-tools-label");
    caps.textContent = caption;

    const wrapper = elem("div").classes("dev-tools-editor-container").append(caps, control);
    if (extraClass !== "") wrapper.classes(extraClass);
    return wrapper;
}

export function split(left, right) {
    return elem("div").classes("dev-tools-split").append(left, right);
}

export function hint(text) {
    const element = elem("div").classes("dev-tools-hint");
    element.textContent = text;
    return element;
}

// A labelled, read-only output with its own copy button.
export function valueRow(label) {
    const caption = elem("div").classes("dev-tools-row-label");
    caption.textContent = label;

    const value = elem("div").classes("dev-tools-value");
    const copy = copyButton(() => value.textContent);
    copy.disabled = true;

    return {
        element: elem("div").classes("dev-tools-row").append(caption, value, copy),
        set(text) {
            value.textContent = text;
            copy.disabled = text === "";
        },
    };
}

export function rows(...valueRows) {
    return elem("div").classes("dev-tools-rows").append(...valueRows.map((row) => row.element));
}

// Side-by-side rows, as produced by the diff tools: [{ depth, left, right, status }].
export function renderDiffRows(output, diffRows) {
    output.innerHTML = "";
    const cells = fragment();

    for (const row of diffRows) {
        for (const side of ["left", "right"]) {
            const text = row[side];
            const cell = elem("div")
                .classes("dev-diff-cell", "dev-diff-" + row.status)
                .styleVar("depth", row.depth);

            if (text === null) {
                cell.classes("dev-diff-cell-empty");
            } else {
                cell.textContent = text;
            }

            cells.append(cell);
        }
    }

    output.appendChild(cells);
}

// Two inputs and an aligned side-by-side result. `compare(left, right)` returns
// { error, kind? } or { rows, counts: { changed, missing, added } }.
export function createDiffPane({ originalPlaceholder, changedPlaceholder, legend, compare, indent = false }) {
    const left = editor(originalPlaceholder, { indent });
    const right = editor(changedPlaceholder, { indent });
    const status = createStatus();
    const output = elem("div").classes("dev-diff");

    const compareButton = button("Compare", "dev-tools-button-primary");
    const clearButton = button("Clear");

    compareButton.on("click", () => {
        const result = compare(left.value, right.value);

        if (result.error !== undefined) {
            output.innerHTML = "";
            status.set(result.error, result.kind ?? "error");
            return;
        }

        renderDiffRows(output, result.rows);

        const { changed, missing, added } = result.counts;

        if (changed + missing + added === 0) {
            status.set("No differences", "ok");
            return;
        }

        status.set(`${changed} changed · ${missing} missing · ${added} added`, "diff");
    });

    clearButton.on("click", () => {
        left.value = "";
        right.value = "";
        output.innerHTML = "";
        status.set("");
        left.focus();
    });

    return pane(
        toolbar([compareButton, clearButton], status),
        elem("div").classes("dev-diff-inputs").append(
            labelled("Original", left),
            labelled("Changed", right),
        ),
        elem("div").classes("dev-diff-container").append(
            elem("div").classes("dev-diff-legend").append(document.createTextNode(legend)),
            output,
        ),
    ).withFocus(() => left.focus());
}
