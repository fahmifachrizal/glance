import { elem } from "./templating.js";
import { throttledDebounce } from "./utils.js";
import {
    button, editor, numberInput, selectOf, checkbox, createStatus, copyButton,
    toolbar, pane, labelled, hint, valueRow, rows,
} from "./dev-tools-ui.js";

// Implemented here rather than with SubtleCrypto, which is unavailable (along
// with crypto.randomUUID) when Glance is served over plain http, and which has
// no MD5 anyway.

/* ------------------------------------------------------------------- digests */

const M32 = 0xffffffff;
const M64 = (1n << 64n) - 1n;

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
const rotr64 = (x, n) => ((x >> n) | (x << (64n - n))) & M64;

const PRIMES = [];
for (let n = 2; PRIMES.length < 80; n++) {
    if (PRIMES.every((p) => n % p !== 0)) PRIMES.push(n);
}

// floor(n-th root of p) computed exactly with BigInt, by bisection.
function integerRoot(value, n) {
    let low = 0n;
    let high = 1n << BigInt(Math.ceil(value.toString(2).length / n) + 1);

    while (low < high) {
        const mid = (low + high + 1n) >> 1n;
        if (mid ** BigInt(n) <= value) low = mid;
        else high = mid - 1n;
    }

    return low;
}

// The first `bits` bits of the fractional part of the n-th root of a prime: the
// "nothing up my sleeve" constants the SHA-2 family is defined by.
function rootFraction(prime, n, bits) {
    const root = integerRoot(BigInt(prime) << BigInt(bits * n), n);
    return root & ((1n << BigInt(bits)) - 1n);
}

let constants = null;
function sha2Constants() {
    constants ??= {
        k256: PRIMES.slice(0, 64).map((p) => Number(rootFraction(p, 3, 32))),
        h256: PRIMES.slice(0, 8).map((p) => Number(rootFraction(p, 2, 32))),
        k512: PRIMES.map((p) => rootFraction(p, 3, 64)),
        h512: PRIMES.slice(0, 8).map((p) => rootFraction(p, 2, 64)),
        h384: PRIMES.slice(8, 16).map((p) => rootFraction(p, 2, 64)),
    };
    return constants;
}

// Message padding shared by every algorithm here: 0x80, zeros, then the bit
// length in the last `lengthBytes` bytes.
function pad(bytes, blockSize, lengthBytes, littleEndian) {
    const total = Math.ceil((bytes.length + 1 + lengthBytes) / blockSize) * blockSize;
    const out = new Uint8Array(total);
    out.set(bytes);
    out[bytes.length] = 0x80;
    new DataView(out.buffer).setBigUint64(total - 8, BigInt(bytes.length) * 8n, littleEndian);
    return out;
}

function words32(words, littleEndian) {
    const out = new Uint8Array(words.length * 4);
    const view = new DataView(out.buffer);
    words.forEach((word, i) => view.setUint32(i * 4, word, littleEndian));
    return out;
}

const MD5_SHIFTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(bytes) {
    const data = pad(bytes, 64, 8, true);
    const view = new DataView(data.buffer);
    let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];

    for (let offset = 0; offset < data.length; offset += 64) {
        const m = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true));
        let [a, b, c, d] = [a0, b0, c0, d0];

        for (let i = 0; i < 64; i++) {
            let f;
            let g;

            if (i < 16) { f = (b & c) | (~b & d); g = i; }
            else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
            else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * i) % 16; }

            f = (f + a + MD5_K[i] + m[g]) >>> 0;
            a = d;
            d = c;
            c = b;
            b = (b + rotl(f, MD5_SHIFTS[i])) >>> 0;
        }

        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }

    return words32([a0, b0, c0, d0], true);
}

export function sha1(bytes) {
    const data = pad(bytes, 64, 8, false);
    const view = new DataView(data.buffer);
    const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    const w = new Uint32Array(80);

    for (let offset = 0; offset < data.length; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

        let [a, b, c, d, e] = h;

        for (let i = 0; i < 80; i++) {
            let f;
            let k;

            if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
            else { f = b ^ c ^ d; k = 0xca62c1d6; }

            const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
            e = d;
            d = c;
            c = rotl(b, 30);
            b = a;
            a = temp;
        }

        [a, b, c, d, e].forEach((value, i) => { h[i] = (h[i] + value) >>> 0; });
    }

    return words32(h, false);
}

export function sha256(bytes) {
    const { k256, h256 } = sha2Constants();
    const data = pad(bytes, 64, 8, false);
    const view = new DataView(data.buffer);
    const h = h256.slice();
    const w = new Uint32Array(64);

    for (let offset = 0; offset < data.length; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);

        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let [a, b, c, d, e, f, g, hh] = h;

        for (let i = 0; i < 64; i++) {
            const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + s1 + ch + k256[i] + w[i]) >>> 0;
            const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (s0 + maj) >>> 0;

            hh = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }

        [a, b, c, d, e, f, g, hh].forEach((value, i) => { h[i] = (h[i] + value) >>> 0; });
    }

    return words32(h, false);
}

function sha512Family(bytes, initial, outputBytes) {
    const { k512 } = sha2Constants();
    const data = pad(bytes, 128, 16, false);
    const view = new DataView(data.buffer);
    const h = initial.slice();
    const w = new Array(80);

    for (let offset = 0; offset < data.length; offset += 128) {
        for (let i = 0; i < 16; i++) w[i] = view.getBigUint64(offset + i * 8);

        for (let i = 16; i < 80; i++) {
            const s0 = rotr64(w[i - 15], 1n) ^ rotr64(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
            const s1 = rotr64(w[i - 2], 19n) ^ rotr64(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M64;
        }

        let [a, b, c, d, e, f, g, hh] = h;

        for (let i = 0; i < 80; i++) {
            const s1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
            const ch = (e & f) ^ (~e & M64 & g);
            const t1 = (hh + s1 + ch + k512[i] + w[i]) & M64;
            const s0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (s0 + maj) & M64;

            hh = g;
            g = f;
            f = e;
            e = (d + t1) & M64;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) & M64;
        }

        [a, b, c, d, e, f, g, hh].forEach((value, i) => { h[i] = (h[i] + value) & M64; });
    }

    const out = new Uint8Array(64);
    const outView = new DataView(out.buffer);
    h.forEach((word, i) => outView.setBigUint64(i * 8, word));
    return out.slice(0, outputBytes);
}

export const sha512 = (bytes) => sha512Family(bytes, sha2Constants().h512, 64);
export const sha384 = (bytes) => sha512Family(bytes, sha2Constants().h384, 48);

export const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const ALGORITHMS = [
    ["MD5", md5],
    ["SHA-1", sha1],
    ["SHA-256", sha256],
    ["SHA-384", sha384],
    ["SHA-512", sha512],
];

export function buildHash() {
    const input = editor("Text to hash…", { wrap: true });
    const outputs = ALGORITHMS.map(([name]) => valueRow(name));

    const run = () => {
        if (input.value === "") {
            outputs.forEach((row) => row.set(""));
            return;
        }

        const bytes = new TextEncoder().encode(input.value);
        ALGORITHMS.forEach(([, algorithm], i) => outputs[i].set(toHex(algorithm(bytes))));
    };

    input.on("input", throttledDebounce(run, 10, 100));

    return pane(
        labelled("Text", input, "dev-tools-short"),
        hint("Hashes the exact text as UTF-8, including any trailing newline."),
        rows(...outputs),
    ).withFocus(() => input.focus());
}

/* -------------------------------------------------------------------- random */

// Uniform integer in [0, max) without modulo bias.
export function randomInt(max) {
    const limit = Math.floor(0x100000000 / max) * max;
    const buffer = new Uint32Array(1);

    do {
        crypto.getRandomValues(buffer);
    } while (buffer[0] >= limit);

    return buffer[0] % max;
}

function formatUUID(bytes) {
    const hex = toHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidV4() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUUID(bytes);
}

// Time-ordered: the first 48 bits are a millisecond Unix timestamp.
export function uuidV7(now = Date.now()) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let ms = BigInt(now);

    for (let i = 5; i >= 0; i--) {
        bytes[i] = Number(ms & 0xffn);
        ms >>= 8n;
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUUID(bytes);
}

export function buildUUID() {
    const version = selectOf([["v4", "v4 (random)"], ["v7", "v7 (time-ordered)"]], "Version", "v4");
    const count = numberInput(5, 1, 100, "How many");
    const uppercase = checkbox("Uppercase");
    const hyphens = checkbox("Hyphens", true);
    const output = editor("", { readonly: true });
    const generate = button("Generate", "dev-tools-button-primary");

    const run = () => {
        const n = Math.min(100, Math.max(1, Number(count.value) || 1));
        const make = version.value === "v7" ? uuidV7 : uuidV4;

        let ids = Array.from({ length: n }, make);
        if (!hyphens.input.checked) ids = ids.map((id) => id.replaceAll("-", ""));
        if (uppercase.input.checked) ids = ids.map((id) => id.toUpperCase());

        output.value = ids.join("\n");
    };

    generate.on("click", run);
    for (const control of [version, count]) control.on("change", run);
    for (const control of [uppercase, hyphens]) control.input.on("change", run);

    run();

    return pane(
        toolbar([generate, version, count, uppercase.element, hyphens.element, copyButton(() => output.value, "Copy all")]),
        elem("div").classes("dev-tools-editor-container").append(output),
    ).withFocus(() => generate.focus());
}

const CHARSETS = {
    lowercase: "abcdefghijklmnopqrstuvwxyz",
    uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    digits: "0123456789",
    symbols: "!@#$%^&*()-_=+[]{};:,.<>?/~",
};

const AMBIGUOUS = /[0O1lI|]/g;

// At least one character from every chosen set, so a short password cannot come
// out without, say, a digit despite digits being ticked.
export function generatePassword(length, sets, avoidAmbiguous) {
    const pools = sets.map((name) => {
        const chars = CHARSETS[name];
        return avoidAmbiguous ? chars.replace(AMBIGUOUS, "") : chars;
    });

    const all = pools.join("");
    if (all === "" || length < pools.length) return null;

    const chars = Array.from({ length }, () => all[randomInt(all.length)]);

    // Overwrite distinct random positions, one per chosen set.
    const positions = Array.from({ length }, (_, i) => i);
    for (const pool of pools) {
        const pick = randomInt(positions.length);
        const [position] = positions.splice(pick, 1);
        chars[position] = pool[randomInt(pool.length)];
    }

    return { password: chars.join(""), bits: length * Math.log2(all.length) };
}

export function buildPassword() {
    const length = numberInput(20, 4, 128, "Length");
    const boxes = {
        lowercase: checkbox("a-z", true),
        uppercase: checkbox("A-Z", true),
        digits: checkbox("0-9", true),
        symbols: checkbox("Symbols", true),
    };
    const ambiguous = checkbox("Avoid look-alikes (0 O 1 l I |)");
    const status = createStatus();
    const output = valueRow("Password");
    const regenerate = button("Generate", "dev-tools-button-primary");

    const run = () => {
        const sets = Object.keys(boxes).filter((name) => boxes[name].input.checked);
        const n = Math.min(128, Math.max(4, Number(length.value) || 4));
        const result = generatePassword(n, sets, ambiguous.input.checked);

        if (result === null) {
            output.set("");
            status.set("Pick at least one character set", "error");
            return;
        }

        output.set(result.password);
        status.set(`~${Math.round(result.bits)} bits of entropy`, "neutral");
    };

    regenerate.on("click", run);
    length.on("change", run);
    for (const box of [...Object.values(boxes), ambiguous]) box.input.on("change", run);

    run();

    return pane(
        toolbar([regenerate, length, ...Object.values(boxes).map((box) => box.element), ambiguous.element], status),
        rows(output),
    ).withFocus(() => regenerate.focus());
}
