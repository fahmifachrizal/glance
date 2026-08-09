import { setupPopovers } from './popover.js';
import { setupMasonries } from './masonry.js';
import { throttledDebounce, isElementVisible, openURLInNewTab } from './utils.js';
import { elem, find, findAll } from './templating.js';

async function fetchPageContent(pageData) {
    // TODO: handle non 200 status codes/time outs
    // TODO: add retries
    const response = await fetch(`${pageData.baseURL}/api/pages/${pageData.slug}/content/`);
    const content = await response.text();
    const outdatedWidgetIDs = (response.headers.get("X-Outdated-Widget-IDs") || "")
        .split(",")
        .map(id => id.trim())
        .filter(id => id.length > 0);

    return { content, outdatedWidgetIDs };
}

// Widgets that need to fetch their own data (weather, RSS, etc.) can be slow.
// Rather than block the whole page behind a loading spinner until every
// widget is ready, the server renders the page immediately with whatever's
// cached (or a loading placeholder), and tells us via `outdatedWidgetIDs`
// which specific widgets still need to be fetched. We then fetch and patch
// in just those widgets, independently of each other and of the rest of the
// page - so a slow widget only ever delays itself, never the search bar or
// any other widget.
async function fetchAndPatchWidget(pageData, widgetID) {
    const target = document.querySelector(`[data-widget-id="${widgetID}"]`);
    if (target == null) {
        return;
    }

    const response = await fetch(`${pageData.baseURL}/api/pages/${pageData.slug}/widgets/${widgetID}/content/`);
    if (response.status !== 200) {
        return;
    }

    const html = await response.text();
    const replacement = elem("div").html(html).firstElementChild;
    if (replacement == null) {
        return;
    }

    target.replaceWith(replacement);
    initializeWidgetElement(replacement);
}

function refreshOutdatedWidgets(pageData, widgetIDs) {
    for (let i = 0; i < widgetIDs.length; i++) {
        fetchAndPatchWidget(pageData, widgetIDs[i]);
    }
}

function setupCarousels(root = document) {
    const carouselElements = root.getElementsByClassName("carousel-container");

    if (carouselElements.length == 0) {
        return;
    }

    for (let i = 0; i < carouselElements.length; i++) {
        const carousel = carouselElements[i];
        carousel.classList.add("show-right-cutoff");
        const itemsContainer = carousel.getElementsByClassName("carousel-items-container")[0];

        const determineSideCutoffs = () => {
            if (itemsContainer.scrollLeft != 0) {
                carousel.classList.add("show-left-cutoff");
            } else {
                carousel.classList.remove("show-left-cutoff");
            }

            if (Math.ceil(itemsContainer.scrollLeft) + itemsContainer.clientWidth < itemsContainer.scrollWidth) {
                carousel.classList.add("show-right-cutoff");
            } else {
                carousel.classList.remove("show-right-cutoff");
            }
        }

        const determineSideCutoffsRateLimited = throttledDebounce(determineSideCutoffs, 20, 100);

        itemsContainer.addEventListener("scroll", determineSideCutoffsRateLimited);
        window.addEventListener("resize", determineSideCutoffsRateLimited);

        afterContentReady(determineSideCutoffs);
    }
}

const minuteInSeconds = 60;
const hourInSeconds = minuteInSeconds * 60;
const dayInSeconds = hourInSeconds * 24;
const monthInSeconds = dayInSeconds * 30.4;
const yearInSeconds = dayInSeconds * 365;

function timestampToRelativeTime(timestamp) {
    let delta = Math.round((Date.now() / 1000) - timestamp);
    let prefix = "";

    if (delta < 0) {
        delta = -delta;
        prefix = "in ";
    }

    if (delta < minuteInSeconds) {
        return prefix + "1m";
    }
    if (delta < hourInSeconds) {
        return prefix + Math.floor(delta / minuteInSeconds) + "m";
    }
    if (delta < dayInSeconds) {
        return prefix + Math.floor(delta / hourInSeconds) + "h";
    }
    if (delta < monthInSeconds) {
        return prefix + Math.floor(delta / dayInSeconds) + "d";
    }
    if (delta < yearInSeconds) {
        return prefix + Math.floor(delta / monthInSeconds) + "mo";
    }

    return prefix + Math.floor(delta / yearInSeconds) + "y";
}

function updateRelativeTimeForElements(elements)
{
    for (let i = 0; i < elements.length; i++)
    {
        const element = elements[i];
        const timestamp = element.dataset.dynamicRelativeTime;

        if (timestamp === undefined)
            continue

        element.textContent = timestampToRelativeTime(timestamp);
    }
}

// Matches "example.com", "sub.example.co.uk/path?x=1" and "https://example.com",
// but not plain words or multi-word queries.
const urlLikePattern = /^https?:\/\/\S+$|^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9-]+)+([\/?#]\S*)?$/i;

function isLikelyURL(value) {
    if (value.length == 0 || value.includes(" ")) {
        return false;
    }

    return urlLikePattern.test(value);
}

function collectLoadedBookmarks() {
    const links = document.querySelectorAll("a.bookmarks-link");
    const bookmarks = [];

    for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const iconElement = link.parentElement.querySelector("img.bookmarks-icon");

        bookmarks.push({
            title: link.textContent.trim(),
            url: link.href,
            iconSrc: iconElement != null ? iconElement.src : null,
        });
    }

    return bookmarks;
}

function setupSearchBoxes() {
    const searchWidgets = document.getElementsByClassName("search");

    if (searchWidgets.length == 0) {
        return;
    }

    const loadedBookmarks = collectLoadedBookmarks();

    for (let i = 0; i < searchWidgets.length; i++) {
        const widget = searchWidgets[i];
        const mode = widget.dataset.mode || "bangs";
        const defaultSearchUrl = widget.dataset.defaultSearchUrl;
        const target = widget.dataset.target || "_blank";
        const newTab = widget.dataset.newTab === "true";
        const hideSuggestions = widget.dataset.hideSuggestions === "true" || loadedBookmarks.length == 0;
        const inputElement = widget.getElementsByClassName("search-input")[0];
        const bangElement = widget.getElementsByClassName("search-bang")[0];
        const bangs = widget.querySelectorAll(".search-bangs > input");
        const bangsMap = {};
        const engines = widget.querySelectorAll(".search-engines > input");
        const engineTagElement = widget.getElementsByClassName("search-engine-tag")[0];
        const suggestionsElement = widget.getElementsByClassName("search-suggestions")[0];
        const kbdElement = widget.getElementsByTagName("kbd")[0];
        let currentBang = null;
        let currentEngineIndex = 0;
        let currentSuggestions = [];
        let selectedSuggestionIndex = -1;
        let lastQuery = "";

        for (let j = 0; j < bangs.length; j++) {
            const bang = bangs[j];
            bangsMap[bang.dataset.shortcut] = bang;
        }

        const setEngineIndex = (index) => {
            currentEngineIndex = index;
            if (engineTagElement != null) {
                engineTagElement.textContent = engines[currentEngineIndex].dataset.title;
            }
        };

        if (mode == "tab" && engines.length > 0) {
            setEngineIndex(0);
        }

        const renderSuggestions = () => {
            suggestionsElement.innerHTML = "";

            for (let j = 0; j < currentSuggestions.length; j++) {
                const bookmark = currentSuggestions[j];
                const row = elem().classes("search-suggestion");

                if (j == selectedSuggestionIndex) {
                    row.classList.add("search-suggestion-selected");
                }

                if (bookmark.iconSrc != null) {
                    elem("img").classes("search-suggestion-icon").attrs({ src: bookmark.iconSrc, alt: "" }).appendTo(row);
                }

                elem("span").classes("search-suggestion-title").text(bookmark.title).appendTo(row);

                row.addEventListener("mouseenter", () => {
                    selectedSuggestionIndex = j;
                    renderSuggestions();
                });

                row.addEventListener("mousedown", (event) => {
                    event.preventDefault();
                    navigateToBookmark(bookmark);
                });

                suggestionsElement.appendChild(row);
            }

            suggestionsElement.classList.toggle("search-suggestions-visible", currentSuggestions.length > 0);
        };

        const updateSuggestions = (query) => {
            if (hideSuggestions || query.length == 0) {
                currentSuggestions = [];
                selectedSuggestionIndex = -1;
                renderSuggestions();
                return;
            }

            const needle = query.toLowerCase();
            currentSuggestions = loadedBookmarks
                .filter((bookmark) => bookmark.title.toLowerCase().includes(needle))
                .slice(0, 5);
            // Auto-select the top match so pressing Enter opens it directly,
            // without requiring the user to arrow down to it first.
            selectedSuggestionIndex = currentSuggestions.length > 0 ? 0 : -1;
            renderSuggestions();
        };

        const closeSuggestions = () => {
            currentSuggestions = [];
            selectedSuggestionIndex = -1;
            renderSuggestions();
        };

        const navigateToBookmark = (bookmark) => {
            closeSuggestions();
            inputElement.value = "";
            inputElement.blur();

            if (newTab) {
                openURLInNewTab(bookmark.url);
            } else {
                window.location.href = bookmark.url;
            }
        };

        const openResult = (url, event) => {
            if (newTab && !event.ctrlKey || !newTab && event.ctrlKey) {
                window.open(url, target).focus();
            } else {
                window.location.href = url;
            }
        };

        const submitSearch = (event) => {
            const input = inputElement.value.trim();

            if (input.length > 0 && currentBang == null && isLikelyURL(input)) {
                const url = /^https?:\/\//i.test(input) ? input : `https://${input}`;
                openResult(url, event);

                lastQuery = input;
                inputElement.value = "";
                closeSuggestions();
                return;
            }

            let query;
            let searchUrlTemplate;

            if (mode == "tab" && engines.length > 0) {
                query = input;
                searchUrlTemplate = engines[currentEngineIndex].dataset.url;
            } else if (currentBang != null) {
                query = input.slice(currentBang.dataset.shortcut.length + 1);
                searchUrlTemplate = currentBang.dataset.url;
            } else {
                query = input;
                searchUrlTemplate = defaultSearchUrl;
            }

            if (query.length == 0 && currentBang == null) {
                return;
            }

            const url = searchUrlTemplate.replace("!QUERY!", encodeURIComponent(query));
            openResult(url, event);

            lastQuery = query;
            inputElement.value = "";
            closeSuggestions();
        };

        const handleKeyDown = (event) => {
            if (event.key == "Escape") {
                closeSuggestions();
                inputElement.blur();
                return;
            }

            if (event.key == "Tab" && mode == "tab" && engines.length > 0) {
                event.preventDefault();
                setEngineIndex((currentEngineIndex + 1) % engines.length);
                return;
            }

            if (event.key == "Enter") {
                event.preventDefault();

                if (selectedSuggestionIndex >= 0 && currentSuggestions[selectedSuggestionIndex]) {
                    navigateToBookmark(currentSuggestions[selectedSuggestionIndex]);
                    return;
                }

                submitSearch(event);
                return;
            }

            if (event.key == "ArrowDown") {
                if (currentSuggestions.length > 0) {
                    event.preventDefault();
                    selectedSuggestionIndex = (selectedSuggestionIndex + 1) % currentSuggestions.length;
                    renderSuggestions();
                }
                return;
            }

            if (event.key == "ArrowUp") {
                if (currentSuggestions.length > 0) {
                    event.preventDefault();
                    selectedSuggestionIndex = selectedSuggestionIndex <= 0
                        ? currentSuggestions.length - 1
                        : selectedSuggestionIndex - 1;
                    renderSuggestions();
                    return;
                }

                if (lastQuery.length > 0) {
                    inputElement.value = lastQuery;
                }
                return;
            }
        };

        const changeCurrentBang = (bang) => {
            currentBang = bang;
            bangElement.textContent = bang != null ? bang.dataset.title : "";
        }

        const updateURLHint = (value) => {
            bangElement.textContent = isLikelyURL(value) ? "Go to site ↵" : "";
        };

        const handleInput = (event) => {
            const value = event.target.value.trim();

            updateSuggestions(value);

            if (mode == "tab") {
                updateURLHint(value);
                return;
            }

            if (value in bangsMap) {
                changeCurrentBang(bangsMap[value]);
                return;
            }

            const words = value.split(" ");
            if (words.length >= 2 && words[0] in bangsMap) {
                changeCurrentBang(bangsMap[words[0]]);
                return;
            }

            changeCurrentBang(null);
            updateURLHint(value);
        };

        const attachActiveListeners = () => {
            document.addEventListener("keydown", handleKeyDown);
            document.addEventListener("input", handleInput);
        };
        const detachActiveListeners = () => {
            document.removeEventListener("keydown", handleKeyDown);
            document.removeEventListener("input", handleInput);
            closeSuggestions();
        };

        inputElement.addEventListener("focus", attachActiveListeners);
        inputElement.addEventListener("blur", detachActiveListeners);

        // If the input has the `autofocus` attribute, the browser focuses it
        // the moment it's inserted into the DOM, which can happen before this
        // point (e.g. there are several `await`s between the content being
        // inserted and this code running) - meaning the "focus" event above
        // has already fired and been missed. Catch that case explicitly.
        if (document.activeElement === inputElement) {
            attachActiveListeners();
        }

        document.addEventListener("keydown", (event) => {
            if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
            if (event.code != "KeyS") return;

            inputElement.focus();
            event.preventDefault();
        });

        kbdElement.addEventListener("mousedown", () => {
            requestAnimationFrame(() => inputElement.focus());
        });
    }
}

function setupDynamicRelativeTime() {
    const updateInterval = 60 * 1000;
    let lastUpdateTime = Date.now();

    // Queried fresh on every tick (rather than once up-front) so that
    // elements patched in later, after a per-widget refresh, are picked up
    // too without needing to re-run this whole setup function again.
    updateRelativeTimeForElements(document.querySelectorAll("[data-dynamic-relative-time]"));

    const updateElementsAndTimestamp = () => {
        updateRelativeTimeForElements(document.querySelectorAll("[data-dynamic-relative-time]"));
        lastUpdateTime = Date.now();
    };

    const scheduleRepeatingUpdate = () => setInterval(updateElementsAndTimestamp, updateInterval);

    if (document.hidden === undefined) {
        scheduleRepeatingUpdate();
        return;
    }

    let timeout = scheduleRepeatingUpdate();

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            clearTimeout(timeout);
            return;
        }

        const delta = Date.now() - lastUpdateTime;

        if (delta >= updateInterval) {
            updateElementsAndTimestamp();
            timeout = scheduleRepeatingUpdate();
            return;
        }

        timeout = setTimeout(() => {
            updateElementsAndTimestamp();
            timeout = scheduleRepeatingUpdate();
        }, updateInterval - delta);
    });
}

function setupGroups(root = document) {
    const groups = root.getElementsByClassName("widget-type-group");

    if (groups.length == 0) {
        return;
    }

    for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        const titles = group.getElementsByClassName("widget-header")[0].children;
        const tabs = group.getElementsByClassName("widget-group-contents")[0].children;
        let current = 0;

        for (let t = 0; t < titles.length; t++) {
            const title = titles[t];

            if (title.dataset.titleUrl !== undefined) {
                title.addEventListener("mousedown", (event) => {
                    if (event.button != 1) {
                        return;
                    }

                    openURLInNewTab(title.dataset.titleUrl, false);
                    event.preventDefault();
                });
            }

            title.addEventListener("click", () => {
                if (t == current) {
                    if (title.dataset.titleUrl !== undefined) {
                        openURLInNewTab(title.dataset.titleUrl);
                    }

                    return;
                }

                for (let i = 0; i < titles.length; i++) {
                    titles[i].classList.remove("widget-group-title-current");
                    titles[i].setAttribute("aria-selected", "false");
                    tabs[i].classList.remove("widget-group-content-current");
                    tabs[i].setAttribute("aria-hidden", "true");
                }

                if (current < t) {
                    tabs[t].dataset.direction = "right";
                } else {
                    tabs[t].dataset.direction = "left";
                }

                current = t;

                title.classList.add("widget-group-title-current");
                title.setAttribute("aria-selected", "true");
                tabs[t].classList.add("widget-group-content-current");
                tabs[t].setAttribute("aria-hidden", "false");
            });
        }
    }
}

function setupLazyImages(root = document) {
    const images = root.querySelectorAll("img[loading=lazy]");

    if (images.length == 0) {
        return;
    }

    function imageFinishedTransition(image) {
        image.classList.add("finished-transition");
    }

    afterContentReady(() => {
        setTimeout(() => {
            for (let i = 0; i < images.length; i++) {
                const image = images[i];

                if (image.complete) {
                    image.classList.add("cached");
                    setTimeout(() => imageFinishedTransition(image), 1);
                } else {
                    // TODO: also handle error event
                    image.addEventListener("load", () => {
                        image.classList.add("loaded");
                        setTimeout(() => imageFinishedTransition(image), 400);
                    });
                }
            }
        }, 1);
    });
}

function attachExpandToggleButton(collapsibleContainer) {
    const showMoreText = "Show more";
    const showLessText = "Show less";

    let expanded = false;
    const button = document.createElement("button");
    const icon = document.createElement("span");
    icon.classList.add("expand-toggle-button-icon");
    const textNode = document.createTextNode(showMoreText);
    button.classList.add("expand-toggle-button");
    button.append(textNode, icon);
    button.addEventListener("click", () => {
        expanded = !expanded;

        if (expanded) {
            collapsibleContainer.classList.add("container-expanded");
            button.classList.add("container-expanded");
            textNode.nodeValue = showLessText;
            return;
        }

        const topBefore = button.getClientRects()[0].top;

        collapsibleContainer.classList.remove("container-expanded");
        button.classList.remove("container-expanded");
        textNode.nodeValue = showMoreText;

        const topAfter = button.getClientRects()[0].top;

        if (topAfter > 0)
            return;

        window.scrollBy({
            top: topAfter - topBefore,
            behavior: "instant"
        });
    });

    collapsibleContainer.after(button);

    return button;
};


function setupCollapsibleLists(root = document) {
    const collapsibleLists = root.querySelectorAll(".list.collapsible-container");

    if (collapsibleLists.length == 0) {
        return;
    }

    for (let i = 0; i < collapsibleLists.length; i++) {
        const list = collapsibleLists[i];

        if (list.dataset.collapseAfter === undefined) {
            continue;
        }

        const collapseAfter = parseInt(list.dataset.collapseAfter);

        if (collapseAfter == -1) {
            continue;
        }

        if (list.children.length <= collapseAfter) {
            continue;
        }

        attachExpandToggleButton(list);

        for (let c = collapseAfter; c < list.children.length; c++) {
            const child = list.children[c];
            child.classList.add("collapsible-item");
            child.style.animationDelay = ((c - collapseAfter) * 20).toString() + "ms";
        }
    }
}

function setupCollapsibleGrids(root = document) {
    const collapsibleGridElements = root.querySelectorAll(".cards-grid.collapsible-container");

    if (collapsibleGridElements.length == 0) {
        return;
    }

    for (let i = 0; i < collapsibleGridElements.length; i++) {
        const gridElement = collapsibleGridElements[i];

        if (gridElement.dataset.collapseAfterRows === undefined) {
            continue;
        }

        const collapseAfterRows = parseInt(gridElement.dataset.collapseAfterRows);

        if (collapseAfterRows == -1) {
            continue;
        }

        const getCardsPerRow = () => {
            return parseInt(getComputedStyle(gridElement).getPropertyValue('--cards-per-row'));
        };

        const button = attachExpandToggleButton(gridElement);

        let cardsPerRow;

        const resolveCollapsibleItems = () => requestAnimationFrame(() => {
            const hideItemsAfterIndex = cardsPerRow * collapseAfterRows;

            if (hideItemsAfterIndex >= gridElement.children.length) {
                button.style.display = "none";
            } else {
                button.style.removeProperty("display");
            }

            let row = 0;

            for (let i = 0; i < gridElement.children.length; i++) {
                const child = gridElement.children[i];

                if (i >= hideItemsAfterIndex) {
                    child.classList.add("collapsible-item");
                    child.style.animationDelay = (row * 40).toString() + "ms";

                    if (i % cardsPerRow + 1 == cardsPerRow) {
                        row++;
                    }
                } else {
                    child.classList.remove("collapsible-item");
                    child.style.removeProperty("animation-delay");
                }
            }
        });

        const observer = new ResizeObserver(() => {
            if (!isElementVisible(gridElement)) {
                return;
            }

            const newCardsPerRow = getCardsPerRow();

            if (cardsPerRow == newCardsPerRow) {
                return;
            }

            cardsPerRow = newCardsPerRow;
            resolveCollapsibleItems();
        });

        afterContentReady(() => observer.observe(gridElement));
    }
}

let contentReadyCallbacks = [];

function afterContentReady(callback) {
    contentReadyCallbacks.push(callback);
}

function runContentReadyCallbacks() {
    const callbacks = contentReadyCallbacks;
    contentReadyCallbacks = [];

    for (let i = 0; i < callbacks.length; i++) {
        callbacks[i]();
    }
}

const weekDayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function makeSettableTimeElement(element, hourFormat) {
    const fragment = document.createDocumentFragment();
    const hour = document.createElement('span');
    const minute = document.createElement('span');
    const amPm = document.createElement('span');
    fragment.append(hour, document.createTextNode(':'), minute);

    if (hourFormat == '12h') {
        fragment.append(document.createTextNode(' '), amPm);
    }

    element.append(fragment);

    return (date) => {
        const hours = date.getHours();

        if (hourFormat == '12h') {
            amPm.textContent = hours < 12 ? 'AM' : 'PM';
            hour.textContent = hours % 12 || 12;
        } else {
            hour.textContent = hours < 10 ? '0' + hours : hours;
        }

        const minutes = date.getMinutes();
        minute.textContent = minutes < 10 ? '0' + minutes : minutes;
    };
};

function timeInZone(now, zone) {
    let timeInZone;

    try {
        timeInZone = new Date(now.toLocaleString('en-US', { timeZone: zone }));
    } catch (e) {
        // TODO: indicate to the user that this is an invalid timezone
        console.error(e);
        timeInZone = now
    }

    const diffInMinutes = Math.round((timeInZone.getTime() - now.getTime()) / 1000 / 60);

    return { time: timeInZone, diffInMinutes: diffInMinutes };
}

function zoneDiffText(diffInMinutes) {
    if (diffInMinutes == 0) {
        return "";
    }

    const sign = diffInMinutes < 0 ? "-" : "+";
    const signText = diffInMinutes < 0 ? "behind" : "ahead";

    diffInMinutes = Math.abs(diffInMinutes);

    const hours = Math.floor(diffInMinutes / 60);
    const minutes = diffInMinutes % 60;
    const hourSuffix = hours == 1 ? "" : "s";

    if (minutes == 0) {
        return { text: `${sign}${hours}h`, title: `${hours} hour${hourSuffix} ${signText}` };
    }

    if (hours == 0) {
        return { text: `${sign}${minutes}m`, title: `${minutes} minutes ${signText}` };
    }

    return { text: `${sign}${hours}h~`, title: `${hours} hour${hourSuffix} and ${minutes} minutes ${signText}` };
}

function setupClocks() {
    const clocks = document.getElementsByClassName('clock');

    if (clocks.length == 0) {
        return;
    }

    const updateCallbacks = [];

    for (var i = 0; i < clocks.length; i++) {
        const clock = clocks[i];
        const hourFormat = clock.dataset.hourFormat;
        const localTimeContainer = clock.querySelector('[data-local-time]');
        const localDateElement = localTimeContainer.querySelector('[data-date]');
        const localWeekdayElement = localTimeContainer.querySelector('[data-weekday]');
        const localYearElement = localTimeContainer.querySelector('[data-year]');
        const timeZoneContainers = clock.querySelectorAll('[data-time-in-zone]');

        const setLocalTime = makeSettableTimeElement(
            localTimeContainer.querySelector('[data-time]'),
            hourFormat
        );

        updateCallbacks.push((now) => {
            setLocalTime(now);
            localDateElement.textContent = now.getDate() + ' ' + monthNames[now.getMonth()];
            localWeekdayElement.textContent = weekDayNames[now.getDay()];
            localYearElement.textContent = now.getFullYear();
        });

        for (var z = 0; z < timeZoneContainers.length; z++) {
            const timeZoneContainer = timeZoneContainers[z];
            const diffElement = timeZoneContainer.querySelector('[data-time-diff]');

            const setZoneTime = makeSettableTimeElement(
                timeZoneContainer.querySelector('[data-time]'),
                hourFormat
            );

            updateCallbacks.push((now) => {
                const { time, diffInMinutes } = timeInZone(now, timeZoneContainer.dataset.timeInZone);
                setZoneTime(time);
                const { text, title } = zoneDiffText(diffInMinutes);
                diffElement.textContent = text;
                diffElement.title = title;
            });
        }
    }

    const updateClocks = () => {
        const now = new Date();

        for (var i = 0; i < updateCallbacks.length; i++)
            updateCallbacks[i](now);

        setTimeout(updateClocks, (60 - now.getSeconds()) * 1000);
    };

    updateClocks();
}

async function setupCalendars(root = document) {
    const elems = root.getElementsByClassName("calendar");
    if (elems.length == 0) return;

    // TODO: implement prefetching, currently loads as a nasty waterfall of requests
    const calendar = await import ('./calendar.js');

    for (let i = 0; i < elems.length; i++)
        calendar.default(elems[i]);
}

async function setupTodos(root = document) {
    const elems = Array.from(root.getElementsByClassName("todo"));
    if (elems.length == 0) return;

    const todo = await import ('./todo.js');

    for (let i = 0; i < elems.length; i++){
        todo.default(elems[i]);
    }
}

function setupTruncatedElementTitles(root = document) {
    const elements = root.querySelectorAll(".text-truncate, .single-line-titles .title, .text-truncate-2-lines, .text-truncate-3-lines");

    if (elements.length == 0) {
        return;
    }

    for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        if (element.getAttribute("title") === null)
            element.title = element.innerText.trim().replace(/\s+/g, " ");
    }
}

async function changeTheme(key, onChanged) {
    const themeStyleElem = find("#theme-style");

    const response = await fetch(`${pageData.baseURL}/api/set-theme/${key}`, {
        method: "POST",
    });

    if (response.status != 200) {
        alert("Failed to set theme: " + response.statusText);
        return;
    }
    const newThemeStyle = await response.text();

    const tempStyle = elem("style")
        .html("* { transition: none !important; }")
        .appendTo(document.head);

    themeStyleElem.html(newThemeStyle);
    document.documentElement.setAttribute("data-theme", key);
    document.documentElement.setAttribute("data-scheme", response.headers.get("X-Scheme"));
    typeof onChanged == "function" && onChanged();
    setTimeout(() => { tempStyle.remove(); }, 10);
}

function initThemePicker() {
    const themeChoicesInMobileNav = find(".mobile-navigation .theme-choices");
    if (!themeChoicesInMobileNav) return;

    const themeChoicesInHeader = find(".header-container .theme-choices");

    if (themeChoicesInHeader) {
        themeChoicesInHeader.replaceWith(
            themeChoicesInMobileNav.cloneNode(true)
        );
    }

    const presetElems = findAll(".theme-choices .theme-preset");
    let themePreviewElems = document.getElementsByClassName("current-theme-preview");
    let isLoading = false;

    presetElems.forEach((presetElement) => {
        const themeKey = presetElement.dataset.key;

        if (themeKey === undefined) {
            return;
        }

        if (themeKey == pageData.theme) {
            presetElement.classList.add("current");
        }

        presetElement.addEventListener("click", () => {
            if (themeKey == pageData.theme) return;
            if (isLoading) return;

            isLoading = true;
            changeTheme(themeKey, function() {
                isLoading = false;
                pageData.theme = themeKey;
                presetElems.forEach((e) => { e.classList.remove("current"); });

                Array.from(themePreviewElems).forEach((preview) => {
                    preview.querySelector(".theme-preset").replaceWith(
                        presetElement.cloneNode(true)
                    );
                })

                presetElems.forEach((e) => {
                    if (e.dataset.key != themeKey) return;
                    e.classList.add("current");
                });
            });
        });
    })
}

function initializeContentBehaviors() {
    setupSearchBoxes();
    setupPopovers();
    setupClocks()
    setupCarousels();
    setupCollapsibleLists();
    setupCollapsibleGrids();
    setupGroups();
    setupMasonries();
    setupDynamicRelativeTime();
    setupLazyImages();

    // These do their own dynamic import() plus client-side rendering
    // (calendar/to-do widgets). Don't await them here - the page (and
    // especially the search bar) shouldn't wait on that round trip to
    // become interactive; they'll populate themselves whenever ready.
    setupCalendars().catch(console.error);
    setupTodos().catch(console.error);
}

// Wires up behavior for a single widget element that was just patched in by
// fetchAndPatchWidget, scoped to that element only so it doesn't touch (or
// double-initialize) anything else on the page - most importantly, the
// search bar, which never goes through this path at all.
function initializeWidgetElement(root) {
    setupPopovers(root);
    setupCarousels(root);
    setupCollapsibleLists(root);
    setupCollapsibleGrids(root);
    setupGroups(root);
    setupMasonries(root);
    setupLazyImages(root);
    setupTruncatedElementTitles(root);
    updateRelativeTimeForElements(root.querySelectorAll("[data-dynamic-relative-time]"));

    // A patched calendar/to-do widget comes back from the server as the raw
    // placeholder markup - it needs to go through the same client-side
    // upgrade as on initial load to become the interactive widget again.
    setupCalendars(root).catch(console.error);
    setupTodos(root).catch(console.error);
}

async function setupPage() {
    initThemePicker();

    const pageElement = document.getElementById("page");
    const pageContentElement = document.getElementById("page-content");
    const { content, outdatedWidgetIDs } = await fetchPageContent(pageData);

    pageContentElement.innerHTML = content;

    try {
        initializeContentBehaviors();
    } finally {
        pageElement.classList.add("content-ready");
        pageElement.setAttribute("aria-busy", "false");

        runContentReadyCallbacks();

        setTimeout(() => {
            setupTruncatedElementTitles();
        }, 50);

        setTimeout(() => {
            document.body.classList.add("page-columns-transitioned");
        }, 300);

        refreshOutdatedWidgets(pageData, outdatedWidgetIDs);
    }
}

setupPage();
