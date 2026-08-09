package glance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var calendarWidgetTemplate = mustParseTemplate("calendar.html", "widget-base.html")

var calendarWeekdaysToInt = map[string]time.Weekday{
	"sunday":    time.Sunday,
	"monday":    time.Monday,
	"tuesday":   time.Tuesday,
	"wednesday": time.Wednesday,
	"thursday":  time.Thursday,
	"friday":    time.Friday,
	"saturday":  time.Saturday,
}

type calendarWidget struct {
	widgetBase      `yaml:",inline"`
	FirstDayOfWeek  string `yaml:"first-day-of-week"`
	FirstDay        int    `yaml:"-"`
	HolidayCalendar string `yaml:"holiday-calendar"`
	HolidaysJSON    string `yaml:"-"`
}

func (widget *calendarWidget) initialize() error {
	widget.withTitle("Calendar").withError(nil)

	if widget.FirstDayOfWeek == "" {
		widget.FirstDayOfWeek = "monday"
	} else if _, ok := calendarWeekdaysToInt[widget.FirstDayOfWeek]; !ok {
		return errors.New("invalid first day of week")
	}

	widget.FirstDay = int(calendarWeekdaysToInt[widget.FirstDayOfWeek])

	if widget.HolidayCalendar != "" {
		widget.withCacheDuration(24 * time.Hour)
	}

	return nil
}

func (widget *calendarWidget) update(ctx context.Context) {
	if widget.HolidayCalendar == "" {
		return
	}

	events, err := fetchICSHolidayEvents(widget.HolidayCalendar)

	if !widget.canContinueUpdateAfterHandlingErr(err) {
		return
	}

	now := time.Now()
	minYear, maxYear := now.Year()-1, now.Year()+2
	holidays := make(map[string]string)

	for i := range events {
		year, err := strconv.Atoi(events[i].Date[:4])
		if err != nil || year < minYear || year > maxYear {
			continue
		}

		holidays[events[i].Date] = events[i].Summary
	}

	holidaysJSON, err := json.Marshal(holidays)
	if err != nil {
		widget.withError(err)
		return
	}

	widget.HolidaysJSON = string(holidaysJSON)
}

func (widget *calendarWidget) Render() template.HTML {
	return widget.renderTemplate(widget, calendarWidgetTemplate)
}

type icsEvent struct {
	Date    string // YYYY-MM-DD
	Summary string
}

// holidayCalendarICSURL turns a Google Calendar ID (like the one used to
// subscribe to a public holiday calendar in Google/Apple Calendar, e.g.
// "en.indonesian#holiday@group.v.calendar.google.com") into its public ICS
// feed URL. A full http(s):// URL is passed through as-is, so any other
// public ICS calendar can be used too.
func holidayCalendarICSURL(calendar string) string {
	if strings.HasPrefix(calendar, "http://") || strings.HasPrefix(calendar, "https://") {
		return calendar
	}

	return "https://calendar.google.com/calendar/ical/" + url.QueryEscape(calendar) + "/public/basic.ics"
}

func fetchICSHolidayEvents(calendar string) ([]icsEvent, error) {
	request, err := http.NewRequest("GET", holidayCalendarICSURL(calendar), nil)
	if err != nil {
		return nil, err
	}

	response, err := defaultHTTPClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status code %d fetching holiday calendar", response.StatusCode)
	}

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}

	return parseICSEvents(body), nil
}

// parseICSEvents does a minimal extraction of DTSTART + SUMMARY from an
// iCalendar (RFC 5545) feed's VEVENT blocks - enough for a flat list of
// holidays, without needing a full ICS/RRULE parsing library.
func parseICSEvents(body []byte) []icsEvent {
	lines := unfoldICSLines(body)

	var events []icsEvent
	var inEvent bool
	var date, summary string

	for _, line := range lines {
		switch {
		case line == "BEGIN:VEVENT":
			inEvent = true
			date, summary = "", ""
		case line == "END:VEVENT":
			if inEvent && date != "" && summary != "" {
				events = append(events, icsEvent{Date: date, Summary: summary})
			}
			inEvent = false
		case inEvent && strings.HasPrefix(line, "DTSTART"):
			date = parseICSDate(line)
		case inEvent && strings.HasPrefix(line, "SUMMARY"):
			if idx := strings.Index(line, ":"); idx != -1 {
				summary = unescapeICSText(line[idx+1:])
			}
		}
	}

	return events
}

func parseICSDate(line string) string {
	idx := strings.LastIndex(line, ":")
	if idx == -1 {
		return ""
	}

	raw := line[idx+1:]
	if len(raw) < 8 {
		return ""
	}

	return raw[0:4] + "-" + raw[4:6] + "-" + raw[6:8]
}

// unfoldICSLines joins continuation lines (RFC 5545 line folding, where a
// line starting with a space/tab is a continuation of the previous one).
func unfoldICSLines(body []byte) []string {
	rawLines := strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n")

	lines := make([]string, 0, len(rawLines))
	for _, line := range rawLines {
		if len(line) > 0 && (line[0] == ' ' || line[0] == '\t') && len(lines) > 0 {
			lines[len(lines)-1] += line[1:]
		} else {
			lines = append(lines, line)
		}
	}

	return lines
}

var icsTextEscapeReplacer = strings.NewReplacer(`\,`, `,`, `\;`, `;`, `\n`, " ", `\N`, " ", `\\`, `\`)

func unescapeICSText(s string) string {
	return icsTextEscapeReplacer.Replace(strings.TrimSpace(s))
}
