package glance

import (
	"fmt"
	"html/template"
	"strings"
)

var searchWidgetTemplate = mustParseTemplate("search.html", "widget-base.html")

type SearchBang struct {
	Title    string
	Shortcut string
	URL      string
}

type SearchEngineOption struct {
	Title string
	URL   string
}

type searchWidget struct {
	widgetBase      `yaml:",inline"`
	cachedHTML      template.HTML        `yaml:"-"`
	SearchEngine    string               `yaml:"search-engine"`
	Bangs           []SearchBang         `yaml:"bangs"`
	Mode            string               `yaml:"mode"`
	Engines         []SearchEngineOption `yaml:"engines"`
	HideSuggestions bool                 `yaml:"hide-suggestions"`
	NewTab          bool                 `yaml:"new-tab"`
	Target          string               `yaml:"target"`
	Autofocus       bool                 `yaml:"autofocus"`
	Placeholder     string               `yaml:"placeholder"`
}

func convertSearchUrl(url string) string {
	// Go's template is being stubborn and continues to escape the curlies in the
	// URL regardless of what the type of the variable is so this is my way around it
	return strings.ReplaceAll(url, "{QUERY}", "!QUERY!")
}

var searchEngines = map[string]string{
	"duckduckgo": "https://duckduckgo.com/?q={QUERY}",
	"google":     "https://www.google.com/search?q={QUERY}",
	"bing":       "https://www.bing.com/search?q={QUERY}",
	"perplexity": "https://www.perplexity.ai/search?q={QUERY}",
	"kagi": "https://kagi.com/search?q={QUERY}",
	"startpage": "https://www.startpage.com/search?q={QUERY}",
}

func (widget *searchWidget) initialize() error {
	widget.withTitle("Search").withError(nil)

	if widget.SearchEngine == "" {
		widget.SearchEngine = "duckduckgo"
	}

	if widget.Placeholder == "" {
		widget.Placeholder = "Type here to search…"
	}

	if url, ok := searchEngines[widget.SearchEngine]; ok {
		widget.SearchEngine = url
	}

	widget.SearchEngine = convertSearchUrl(widget.SearchEngine)

	if widget.Mode == "" {
		widget.Mode = "bangs"
	}

	if widget.Mode != "bangs" && widget.Mode != "tab" {
		return fmt.Errorf("search widget has invalid mode %q, must be either \"bangs\" or \"tab\"", widget.Mode)
	}

	if widget.Mode == "tab" && len(widget.Engines) == 0 {
		return fmt.Errorf("search widget has mode: tab but no engines defined")
	}

	for i := range widget.Bangs {
		if widget.Bangs[i].Shortcut == "" {
			return fmt.Errorf("search bang #%d has no shortcut", i+1)
		}

		if widget.Bangs[i].URL == "" {
			return fmt.Errorf("search bang #%d has no URL", i+1)
		}

		widget.Bangs[i].URL = convertSearchUrl(widget.Bangs[i].URL)
	}

	for i := range widget.Engines {
		if widget.Engines[i].Title == "" {
			return fmt.Errorf("search engine #%d has no title", i+1)
		}

		if widget.Engines[i].URL == "" {
			return fmt.Errorf("search engine #%d has no URL", i+1)
		}

		if url, ok := searchEngines[widget.Engines[i].URL]; ok {
			widget.Engines[i].URL = url
		}

		widget.Engines[i].URL = convertSearchUrl(widget.Engines[i].URL)
	}

	widget.cachedHTML = widget.renderTemplate(widget, searchWidgetTemplate)
	return nil
}

func (widget *searchWidget) Render() template.HTML {
	return widget.cachedHTML
}
