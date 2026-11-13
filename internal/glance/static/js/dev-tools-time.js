import { elem } from "./templating.js";
import { throttledDebounce } from "./utils.js";
import {
    button, textInput, createStatus, toolbar, pane, hint, valueRow, rows,
} from "./dev-tools-ui.js";

// Signed milliseconds from now (negative for the past) as "in 3 days" / "2 hours ago".
export function formatRelative(deltaMs) {
    const units = [
        ["year", 365 * 86400000],
        ["month", 30 * 86400000],
        ["day", 86400000],
        ["hour", 3600000],
        ["minute", 60000],
        ["second", 1000],
    ];
    const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

    for (const [unit, size] of units) {
        if (Math.abs(deltaMs) >= size || unit === "second") {
            const amount = deltaMs / size;
            return formatter.format(unit === "second" ? Math.trunc(amount) : Math.round(amount), unit);
        }
    }
}

/* ---------------------------------------------------------------- timestamp */

// Plain numbers are read as seconds, milliseconds, microseconds or nanoseconds
// depending on their size; anything else is handed to Date.
export function parseTimestamp(input) {
    const text = input.trim();
    if (text === "") return null;

    let date;
    if (/^-?\d+(\.\d+)?$/.test(text)) {
        const n = Number(text);
        const magnitude = Math.abs(n);
        const ms = magnitude >= 1e17 ? n / 1e6
            : magnitude >= 1e14 ? n / 1e3
            : magnitude >= 1e11 ? n
            : n * 1000;
        date = new Date(ms);
    } else {
        date = new Date(text);
    }

    return Number.isNaN(date.getTime()) ? undefined : date;
}

export function buildTimestamp() {
    const input = textInput("Unix time, or a date such as 2024-05-01T10:00:00Z");
    const status = createStatus();
    const outputs = {
        seconds: valueRow("Unix (seconds)"),
        milliseconds: valueRow("Unix (milliseconds)"),
        iso: valueRow("ISO 8601 (UTC)"),
        local: valueRow(`Local (${Intl.DateTimeFormat().resolvedOptions().timeZone})`),
        relative: valueRow("Relative"),
    };

    const run = () => {
        const date = parseTimestamp(input.value);

        if (date === null || date === undefined) {
            for (const row of Object.values(outputs)) row.set("");
            status.set(date === undefined ? "Not a recognised timestamp or date" : "", date === undefined ? "error" : undefined);
            return;
        }

        status.set("");
        outputs.seconds.set(String(Math.floor(date.getTime() / 1000)));
        outputs.milliseconds.set(String(date.getTime()));
        outputs.iso.set(date.toISOString());
        outputs.local.set(date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }));
        outputs.relative.set(formatRelative(date.getTime() - Date.now()));
    };

    const now = button("Now", "dev-tools-button-primary");
    now.on("click", () => {
        input.value = String(Math.floor(Date.now() / 1000));
        run();
    });

    input.on("input", throttledDebounce(run, 10, 100));

    input.value = String(Math.floor(Date.now() / 1000));
    run();

    return pane(
        toolbar([now], status),
        input,
        hint("Numbers are read as seconds, milliseconds, microseconds or nanoseconds depending on their size."),
        rows(...Object.values(outputs)),
    ).withFocus(() => input.select());
}

/* --------------------------------------------------------------------- cron */

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const MACROS = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
};

const FIELDS = [
    { name: "minute", min: 0, max: 59 },
    { name: "hour", min: 0, max: 23 },
    { name: "day of month", min: 1, max: 31 },
    { name: "month", min: 1, max: 12, names: MONTH_NAMES.map((name) => name.slice(0, 3).toUpperCase()), nameBase: 1 },
    { name: "day of week", min: 0, max: 7, names: DAY_NAMES.map((name) => name.slice(0, 3).toUpperCase()), nameBase: 0 },
];

function parseCronValue(text, field) {
    if (/^\d+$/.test(text)) return Number(text);

    const index = field.names?.indexOf(text.toUpperCase()) ?? -1;
    if (index !== -1) return index + field.nameBase;

    throw new Error(`"${text}" is not valid for the ${field.name} field`);
}

// Returns { values: sorted array, wildcard, step } where `step` is set when the
// field is a single `*/n` expression.
function parseCronField(text, field) {
    const values = new Set();
    const parts = text === "?" ? ["*"] : text.split(",");
    let step = null;

    for (const part of parts) {
        const [range, stepText, extra] = part.split("/");

        if (extra !== undefined || part === "" || (stepText !== undefined && !/^\d+$/.test(stepText))) {
            throw new Error(`"${part}" is not valid for the ${field.name} field`);
        }

        const size = stepText === undefined ? 1 : Number(stepText);
        if (size < 1) throw new Error(`Step must be at least 1 in the ${field.name} field`);

        let from;
        let to;
        if (range === "*") {
            from = field.min;
            to = field.name === "day of week" ? 6 : field.max;
        } else if (range.includes("-")) {
            const [low, high, more] = range.split("-");
            if (more !== undefined) throw new Error(`"${part}" is not valid for the ${field.name} field`);
            from = parseCronValue(low, field);
            to = parseCronValue(high, field);
        } else {
            from = parseCronValue(range, field);
            to = stepText === undefined ? from : field.max;
        }

        if (from < field.min || to > field.max || from > to) {
            throw new Error(`${part} is outside ${field.min}-${field.max} for the ${field.name} field`);
        }

        for (let v = from; v <= to; v += size) {
            values.add(field.name === "day of week" && v === 7 ? 0 : v);
        }

        if (parts.length === 1 && range === "*" && stepText !== undefined) step = size;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const everything = field.name === "day of week" ? 7 : field.max - field.min + 1;

    return {
        values: sorted,
        wildcard: sorted.length === everything,
        step: step !== null && step > 1 ? step : null,
        text,
    };
}

export function parseCron(expression) {
    let source = expression.trim().replace(/\s+/g, " ");
    source = MACROS[source.toLowerCase()] ?? source;

    if (source.startsWith("@")) throw new Error(`${source.split(" ")[0]} is not supported`);

    const parts = source.split(" ");
    if (parts.length !== 5) {
        throw new Error("Expected 5 fields: minute hour day-of-month month day-of-week");
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, i) => parseCronField(part, FIELDS[i]));
    return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function ordinal(n) {
    if (n % 100 >= 11 && n % 100 <= 13) return n + "th";
    return n + (["th", "st", "nd", "rd"][n % 10] ?? "th");
}

const pad2 = (n) => String(n).padStart(2, "0");

// [1,2,3,5] -> "1 through 3 and 5"
function listPhrase(values, label = String) {
    const groups = [];

    for (let i = 0; i < values.length;) {
        let j = i;
        while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;

        if (j - i >= 2) {
            groups.push(`${label(values[i])} through ${label(values[j])}`);
        } else {
            for (let k = i; k <= j; k++) groups.push(label(values[k]));
        }

        i = j + 1;
    }

    if (groups.length <= 1) return groups.join("");
    return groups.slice(0, -1).join(", ") + " and " + groups[groups.length - 1];
}

const hoursPhrase = (hours) => `${hours.length > 1 ? "hours" : "hour"} ${listPhrase(hours)}`;

export function describeCron(cron) {
    const { minute, hour, dayOfMonth, month, dayOfWeek } = cron;
    let time;

    if (minute.wildcard && hour.wildcard) {
        time = "Every minute";
    } else if (minute.step && hour.wildcard) {
        time = `Every ${minute.step} minutes`;
    } else if (minute.wildcard) {
        time = `Every minute, during ${hoursPhrase(hour.values)}`;
    } else if (hour.wildcard) {
        time = `At minute ${listPhrase(minute.values)} past every hour`;
    } else if (hour.step) {
        time = minute.step
            ? `Every ${minute.step} minutes, past every ${ordinal(hour.step)} hour`
            : `At minute ${listPhrase(minute.values)} past every ${ordinal(hour.step)} hour`;
    } else if (minute.step) {
        time = `Every ${minute.step} minutes, during ${hoursPhrase(hour.values)}`;
    } else if (minute.values.length * hour.values.length <= 6) {
        const times = hour.values.flatMap((h) => minute.values.map((m) => `${pad2(h)}:${pad2(m)}`));
        time = "At " + listPhrase(times);
    } else {
        time = `At minute ${listPhrase(minute.values)} past hour ${listPhrase(hour.values)}`;
    }

    const clauses = [time];

    if (!dayOfMonth.wildcard) {
        clauses.push(`on day ${listPhrase(dayOfMonth.values)} of the month`);
    }

    if (!dayOfWeek.wildcard) {
        const days = `on ${listPhrase(dayOfWeek.values, (d) => DAY_NAMES[d])}`;
        clauses.push(dayOfMonth.wildcard ? days : `or ${days}`);
    }

    if (!month.wildcard) {
        clauses.push(`in ${listPhrase(month.values, (m) => MONTH_NAMES[m - 1])}`);
    }

    return clauses.join(", ");
}

// When both day fields are restricted, cron runs on days matching either one.
function dayMatches(cron, date) {
    if (!cron.month.values.includes(date.getMonth() + 1)) return false;

    const byMonthDay = cron.dayOfMonth.values.includes(date.getDate());
    const byWeekDay = cron.dayOfWeek.values.includes(date.getDay());

    if (!cron.dayOfMonth.wildcard && !cron.dayOfWeek.wildcard) return byMonthDay || byWeekDay;
    return byMonthDay && byWeekDay;
}

// The next `count` run times after `from`, in local time. Looks up to eight
// years ahead, which covers a 29 February schedule.
export function nextRuns(cron, from, count) {
    const runs = [];
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());

    for (let i = 0; i < 366 * 8 && runs.length < count; i++) {
        if (dayMatches(cron, day)) {
            for (const h of cron.hour.values) {
                for (const m of cron.minute.values) {
                    const run = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
                    if (run > from && runs.length < count) runs.push(run);
                }
            }
        }

        day.setDate(day.getDate() + 1);
    }

    return runs;
}

const CRON_EXAMPLES = ["*/15 * * * *", "0 9 * * 1-5", "30 2 1 * *", "0 0 * * 0", "@hourly"];

export function buildCron() {
    const input = textInput("minute hour day-of-month month day-of-week");
    const status = createStatus();
    const description = valueRow("Meaning");
    const runRows = Array.from({ length: 5 }, (_, i) => valueRow(i === 0 ? "Next runs" : ""));

    const run = () => {
        if (input.value.trim() === "") {
            description.set("");
            for (const row of runRows) row.set("");
            status.set("");
            return;
        }

        let cron;
        try {
            cron = parseCron(input.value);
        } catch (err) {
            description.set("");
            for (const row of runRows) row.set("");
            status.set(err.message, "error");
            return;
        }

        status.set("Valid", "ok");
        description.set(describeCron(cron));

        const now = Date.now();
        const runs = nextRuns(cron, new Date(now), runRows.length);
        runRows.forEach((row, i) => {
            row.set(runs[i] === undefined ? "" : `${runs[i].toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (${formatRelative(runs[i].getTime() - now)})`);
        });
    };

    input.on("input", throttledDebounce(run, 10, 150));

    const examples = CRON_EXAMPLES.map((example) => {
        const b = button(example);
        b.on("click", () => {
            input.value = example;
            run();
            input.focus();
        });
        return b;
    });

    return pane(
        input,
        elem("div").classes("dev-tools-toolbar").append(...examples, elem("div").classes("grow"), status.element),
        hint("Standard 5-field cron. Times are shown in your local time zone."),
        rows(description, ...runRows),
    ).withFocus(() => input.focus());
}
