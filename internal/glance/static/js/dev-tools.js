import { elem } from "./templating.js";
import { TOOLS } from "./dev-tools-list.js";
import { buildJSONFormat, buildJSONDiff } from "./dev-tools-json.js";
import { buildTextDiff, buildCase, buildRegex } from "./dev-tools-text.js";
import { buildBase64, buildURL, buildJWT } from "./dev-tools-encoding.js";
import { buildHash, buildUUID, buildPassword } from "./dev-tools-crypto.js";
import { buildTimestamp, buildCron } from "./dev-tools-time.js";
import { buildBase, buildColor } from "./dev-tools-convert.js";
import { buildMarkdown, buildYAML } from "./dev-tools-markup.js";

// Panes are only built the first time their tab is shown.
const BUILDERS = {
    "json": buildJSONFormat,
    "json-diff": buildJSONDiff,
    "text-diff": buildTextDiff,
    "base64": buildBase64,
    "url": buildURL,
    "jwt": buildJWT,
    "hash": buildHash,
    "uuid": buildUUID,
    "password": buildPassword,
    "timestamp": buildTimestamp,
    "cron": buildCron,
    "case": buildCase,
    "base": buildBase,
    "color": buildColor,
    "regex": buildRegex,
    "markdown": buildMarkdown,
    "yaml": buildYAML,
};

let instance = null;

// Without a known tool the overlay reopens on whichever one was used last.
export default function openDevTools(toolID) {
    if (instance === null) {
        instance = buildOverlay();
        document.body.appendChild(instance.element);
    }

    instance.open(toolID);
}

function buildOverlay() {
    const panes = {};
    const tabs = {};
    let current = TOOLS[0].id;

    const body = elem("div").classes("dev-tools-body");
    const tabBar = elem("div").classes("dev-tools-tabs").attr("role", "tablist");

    const selectTool = (id) => {
        if (!(id in BUILDERS)) id = current;

        if (!(id in panes)) {
            panes[id] = BUILDERS[id]();
            body.appendChild(panes[id].element);
        }

        current = id;

        for (const [tabID, tab] of Object.entries(tabs)) {
            tab.classesIf(tabID === id, "dev-tools-tab-current");
            tab.attr("aria-selected", String(tabID === id));
        }

        for (const [paneID, pane] of Object.entries(panes)) {
            pane.element.showIf(paneID === id);
        }
    };

    for (const tool of TOOLS) {
        tabs[tool.id] = elem("button")
            .classes("dev-tools-tab")
            .attrs({ type: "button", role: "tab" })
            .on("click", () => {
                selectTool(tool.id);
                panes[tool.id].focus();
            })
            .appendTo(tabBar);

        tabs[tool.id].textContent = tool.label;
    }

    const closeButton = elem("button")
        .classes("dev-tools-close")
        .attrs({ type: "button", title: "Close (Esc)" })
        .html(`<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`);

    const panel = elem("div").classes("dev-tools-panel").append(
        elem("div").classes("dev-tools-header").append(
            elem("div").classes("dev-tools-title").text("Tools"),
            tabBar,
            closeButton,
        ),
        body,
    );

    const element = elem("div").classes("dev-tools-overlay").append(panel);

    const close = () => {
        element.classList.remove("dev-tools-overlay-visible");
        document.body.classList.remove("dev-tools-open");
    };

    closeButton.on("click", close);

    element.on("mousedown", (event) => {
        if (event.target === element) close();
    });

    // On the document rather than the overlay so Escape still closes it when
    // focus has moved outside the panel.
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!element.classList.contains("dev-tools-overlay-visible")) return;

        event.stopPropagation();
        close();
    });

    selectTool(current);

    return {
        element,
        open: (toolID) => {
            document.body.classList.add("dev-tools-open");
            element.classList.add("dev-tools-overlay-visible");
            selectTool(toolID);
            panes[current].focus();
        },
    };
}
