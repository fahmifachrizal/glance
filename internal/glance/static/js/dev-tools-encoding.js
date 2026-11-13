import { elem } from "./templating.js";
import { throttledDebounce } from "./utils.js";
import {
    button, editor, selectOf, checkbox, createStatus, copyButton, toolbar, pane,
    labelled, split, valueRow, rows,
} from "./dev-tools-ui.js";
import { formatRelative } from "./dev-tools-time.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/* ------------------------------------------------------------------- base64 */

export function encodeBase64(text, urlSafe = false) {
    const bytes = encoder.encode(text);
    let binary = "";

    // Chunked so very large inputs do not overflow the argument limit.
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }

    const encoded = btoa(binary);
    return urlSafe ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded;
}

// Accepts both the standard and URL-safe alphabets, with or without padding.
export function decodeBase64(text) {
    let normalized = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");

    if (normalized.length % 4 === 1) throw new Error("Invalid Base64 length");
    normalized += "=".repeat((4 - normalized.length % 4) % 4);

    let binary;
    try {
        binary = atob(normalized);
    } catch {
        throw new Error("Contains characters that are not valid Base64");
    }

    try {
        return decoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    } catch {
        throw new Error("Decodes to bytes that are not valid UTF-8 text");
    }
}

export function buildBase64() {
    const input = editor("Text or Base64…", { wrap: true });
    const output = editor("Result", { readonly: true, wrap: true });
    const mode = selectOf([["encode", "Encode"], ["decode", "Decode"]], "Direction", "encode");
    const urlSafe = checkbox("URL-safe");
    const status = createStatus();
    const swap = button("Use result as input");

    const run = () => {
        if (input.value === "") {
            output.value = "";
            status.set("");
            return;
        }

        try {
            output.value = mode.value === "encode"
                ? encodeBase64(input.value, urlSafe.input.checked)
                : decodeBase64(input.value);
            status.set("");
        } catch (err) {
            output.value = "";
            status.set(err.message, "error");
        }
    };

    swap.on("click", () => {
        if (output.value === "") return;

        input.value = output.value;
        mode.value = mode.value === "encode" ? "decode" : "encode";
        run();
    });

    input.on("input", run);
    mode.on("change", run);
    urlSafe.input.on("change", run);

    return pane(
        toolbar([mode, urlSafe.element, swap, copyButton(() => output.value)], status),
        split(labelled("Input", input), labelled("Result", output)),
    ).withFocus(() => input.focus());
}

/* ---------------------------------------------------------------------- url */

export function convertURL(text, { decode, fullURL, spaceAsPlus }) {
    if (!decode) {
        const encoded = fullURL ? encodeURI(text) : encodeURIComponent(text);
        return spaceAsPlus ? encoded.replace(/%20/g, "+") : encoded;
    }

    const source = spaceAsPlus ? text.replace(/\+/g, " ") : text;
    return fullURL ? decodeURI(source) : decodeURIComponent(source);
}

export function buildURL() {
    const input = editor("Text or URL…", { wrap: true });
    const output = editor("Result", { readonly: true, wrap: true });
    const mode = selectOf([["encode", "Encode"], ["decode", "Decode"]], "Direction", "encode");
    const scope = selectOf([["component", "Component"], ["full", "Full URL"]], "Component encodes every reserved character; Full URL leaves :/?#& intact", "component");
    const plus = checkbox("Space as +");
    const status = createStatus();

    const run = () => {
        if (input.value === "") {
            output.value = "";
            status.set("");
            return;
        }

        try {
            output.value = convertURL(input.value, {
                decode: mode.value === "decode",
                fullURL: scope.value === "full",
                spaceAsPlus: plus.input.checked,
            });
            status.set("");
        } catch {
            output.value = "";
            status.set("Contains a malformed % sequence", "error");
        }
    };

    input.on("input", run);
    mode.on("change", run);
    scope.on("change", run);
    plus.input.on("change", run);

    return pane(
        toolbar([mode, scope, plus.element, copyButton(() => output.value)], status),
        split(labelled("Input", input), labelled("Result", output)),
    ).withFocus(() => input.focus());
}

/* ---------------------------------------------------------------------- jwt */

export function decodeJWT(token) {
    const parts = token.trim().split(".");

    if (parts.length < 2 || parts.length > 3) {
        throw new Error("A JWT has three dot-separated parts");
    }

    const parse = (part, name) => {
        try {
            return JSON.parse(decodeBase64(part));
        } catch {
            throw new Error(`The ${name} is not Base64URL-encoded JSON`);
        }
    };

    return {
        header: parse(parts[0], "header"),
        payload: parse(parts[1], "payload"),
        signature: parts[2] ?? "",
    };
}

const CLAIMS = [["iat", "Issued at"], ["nbf", "Not before"], ["exp", "Expires"]];

export function buildJWT() {
    const input = editor("Paste a JWT…", { wrap: true });
    const header = editor("Header", { readonly: true });
    const payload = editor("Payload", { readonly: true });
    const status = createStatus();
    const claimRows = Object.fromEntries(CLAIMS.map(([claim, label]) => [claim, valueRow(label)]));

    const clear = () => {
        header.value = "";
        payload.value = "";
        for (const row of Object.values(claimRows)) row.set("");
    };

    const run = () => {
        if (input.value.trim() === "") {
            clear();
            status.set("");
            return;
        }

        let decoded;
        try {
            decoded = decodeJWT(input.value);
        } catch (err) {
            clear();
            status.set(err.message, "error");
            return;
        }

        header.value = JSON.stringify(decoded.header, null, 2);
        payload.value = JSON.stringify(decoded.payload, null, 2);

        const now = Date.now();
        for (const [claim] of CLAIMS) {
            const seconds = decoded.payload?.[claim];

            if (typeof seconds !== "number") {
                claimRows[claim].set("");
                continue;
            }

            const when = new Date(seconds * 1000);
            claimRows[claim].set(`${when.toLocaleString()} (${formatRelative(when.getTime() - now)})`);
        }

        const expires = decoded.payload?.exp;
        if (typeof expires === "number" && expires * 1000 < now) {
            status.set("Expired · signature not verified", "error");
        } else {
            status.set("Decoded · signature not verified", "ok");
        }
    };

    input.on("input", throttledDebounce(run, 10, 150));

    const clearButton = button("Clear");
    clearButton.on("click", () => {
        input.value = "";
        run();
        input.focus();
    });

    return pane(
        toolbar([clearButton], status),
        elem("div").classes("dev-tools-short").append(labelled("Token", input)),
        split(labelled("Header", header), labelled("Payload", payload)),
        rows(...CLAIMS.map(([claim]) => claimRows[claim])),
    ).withFocus(() => input.focus());
}
