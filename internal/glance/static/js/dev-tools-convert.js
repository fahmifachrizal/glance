import { elem } from "./templating.js";
import { textInput, createStatus, copyButton, pane, toolbar, valueRow, rows } from "./dev-tools-ui.js";

/* -------------------------------------------------------------- number base */

const BASES = [
    { name: "Binary", radix: 2, prefix: "0b", digits: /^[01]+$/ },
    { name: "Octal", radix: 8, prefix: "0o", digits: /^[0-7]+$/ },
    { name: "Decimal", radix: 10, prefix: "", digits: /^\d+$/ },
    { name: "Hexadecimal", radix: 16, prefix: "0x", digits: /^[0-9a-f]+$/i },
];

// Returns a BigInt, or null for empty input; throws on invalid digits. Accepts a
// leading minus sign, a matching 0b/0o/0x prefix, and spaces or underscores as
// digit separators.
export function parseInteger(text, base) {
    let source = text.trim().replace(/[\s_]/g, "");
    if (source === "") return null;

    let negative = false;
    if (source.startsWith("-")) {
        negative = true;
        source = source.slice(1);
    }

    if (base.prefix !== "" && source.toLowerCase().startsWith(base.prefix)) {
        source = source.slice(2);
    }

    if (!base.digits.test(source)) {
        throw new Error(`Not a valid ${base.name.toLowerCase()} number`);
    }

    let value = 0n;
    const radix = BigInt(base.radix);
    for (const digit of source.toLowerCase()) {
        value = value * radix + BigInt(parseInt(digit, 16));
    }

    return negative ? -value : value;
}

export function formatInteger(value, radix) {
    return value.toString(radix);
}

export function buildBase() {
    const status = createStatus();
    const inputs = BASES.map((base) => textInput(base.name));

    const update = (source, base) => {
        let value;
        try {
            value = parseInteger(source.value, base);
        } catch (err) {
            status.set(err.message, "error");
            source.classes("dev-tools-input-invalid");
            return;
        }

        status.set("");
        source.classList.remove("dev-tools-input-invalid");

        BASES.forEach((other, i) => {
            if (inputs[i] === source) return;
            inputs[i].classList.remove("dev-tools-input-invalid");
            inputs[i].value = value === null ? "" : formatInteger(value, other.radix);
        });
    };

    const rowElements = BASES.map((base, i) => {
        inputs[i].on("input", () => update(inputs[i], base));

        const caption = elem("div").classes("dev-tools-row-label");
        caption.textContent = base.name;

        return elem("div").classes("dev-tools-row").append(
            caption,
            inputs[i],
            copyButton(() => inputs[i].value),
        );
    });

    return pane(
        toolbar([], status),
        elem("div").classes("dev-tools-rows").append(...rowElements),
    ).withFocus(() => inputs[2].focus());
}

/* -------------------------------------------------------------------- color */

export function rgbToHsl(r, g, b) {
    const [rn, gn, bn] = [r / 255, g / 255, b / 255];
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const lightness = (max + min) / 2;
    const delta = max - min;

    if (delta === 0) return { h: 0, s: 0, l: Math.round(lightness * 100) };

    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hue;

    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;

    return {
        h: Math.round(((hue * 60) + 360) % 360),
        s: Math.round(saturation * 100),
        l: Math.round(lightness * 100),
    };
}

const hex2 = (n) => Math.round(n).toString(16).padStart(2, "0");

// color: { r, g, b, a } with r/g/b in 0-255 and a in 0-1.
export function formatColor({ r, g, b, a }) {
    const { h, s, l } = rgbToHsl(r, g, b);
    const opaque = a >= 1;
    const alpha = Math.round(a * 100) / 100;

    return {
        hex: `#${hex2(r)}${hex2(g)}${hex2(b)}${opaque ? "" : hex2(a * 255)}`,
        rgb: opaque ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`,
        hsl: opaque ? `hsl(${h}, ${s}%, ${l}%)` : `hsla(${h}, ${s}%, ${l}%, ${alpha})`,
    };
}

// Reads whatever the browser understands as a CSS color (hex, rgb(), hsl(),
// names…) by letting a canvas normalise it. An invalid value leaves the canvas
// style unchanged, so two different starting values that end up different
// means the input was rejected.
let context = null;
export function parseColor(text) {
    context ??= document.createElement("canvas").getContext("2d");

    const read = (start) => {
        context.fillStyle = start;
        context.fillStyle = text;
        return context.fillStyle;
    };

    const first = read("#010203");
    if (first !== read("#fdfcfb")) return null;

    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(first);
    if (hex !== null) {
        return { r: parseInt(hex[1], 16), g: parseInt(hex[2], 16), b: parseInt(hex[3], 16), a: 1 };
    }

    const rgba = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/.exec(first);
    if (rgba !== null) {
        return {
            r: Math.round(Number(rgba[1])),
            g: Math.round(Number(rgba[2])),
            b: Math.round(Number(rgba[3])),
            a: rgba[4] === undefined ? 1 : Number(rgba[4]),
        };
    }

    return null;
}

export function buildColor() {
    const input = textInput("Any CSS color: #ff8800, rgb(255 136 0), hsl(32 100% 50%), tomato…");
    const picker = elem("input").classes("dev-tools-color-picker").attrs({ type: "color", title: "Pick a color" });
    const swatch = elem("div").classes("dev-tools-swatch");
    const status = createStatus();
    const outputs = { hex: valueRow("HEX"), rgb: valueRow("RGB"), hsl: valueRow("HSL") };

    const show = (color) => {
        const formatted = formatColor(color);
        outputs.hex.set(formatted.hex);
        outputs.rgb.set(formatted.rgb);
        outputs.hsl.set(formatted.hsl);
        swatch.style.backgroundColor = formatted.rgb;
        picker.value = `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
    };

    const run = () => {
        if (input.value.trim() === "") {
            for (const row of Object.values(outputs)) row.set("");
            swatch.style.backgroundColor = "";
            status.set("");
            return;
        }

        const color = parseColor(input.value.trim());

        if (color === null) {
            for (const row of Object.values(outputs)) row.set("");
            swatch.style.backgroundColor = "";
            status.set("Not a color the browser understands", "error");
            return;
        }

        status.set("");
        show(color);
    };

    input.on("input", run);

    picker.on("input", () => {
        input.value = picker.value;
        run();
    });

    return pane(
        elem("div").classes("dev-tools-toolbar").append(input.classes("dev-tools-input-grow"), picker, status.element),
        swatch,
        rows(outputs.hex, outputs.rgb, outputs.hsl),
    ).withFocus(() => input.focus());
}
