#include <pebble.h>

#define DAYS 7
#define CACHE_VERSION 3
#define PERSIST_KEY_CACHE 100
#define RESPONSE_TIMEOUT_MS 30000
#define SCORE_UNAVAILABLE 255
#define METRIC_UNAVAILABLE 65535
#define COUNT_UNAVAILABLE 255
#define METRIC_ROWS 4

enum {
  COMMAND_FETCH = 1,
};

enum {
  STATUS_OK = 0,
  STATUS_UNCONFIGURED = 1,
  STATUS_AUTH_REQUIRED = 2,
  STATUS_NETWORK_ERROR = 3,
  STATUS_SERVICE_ERROR = 4,
  STATUS_PARTIAL = 5,
  STATUS_SYNCING = 6,
};

enum {
  VIEW_DAY = 0,
  VIEW_SCORE_GRAPH = 1,
  VIEW_USAGE_GRAPH = 2,
  VIEW_EVENTS_GRAPH = 3,
  VIEW_MASK_GRAPH = 4,
  VIEW_LEAK_GRAPH = 5,
};

typedef struct {
  uint8_t version;
  uint8_t count;
  uint32_t fetched_at;
  uint32_t dates[DAYS];
  uint8_t scores[DAYS];
  uint16_t usage_minutes[DAYS];
  uint16_t ahi_x10[DAYS];
  uint8_t mask_off[DAYS];
  uint16_t leak_x10[DAYS];
} ScoreCache;

static Window *s_window;
static TextLayer *s_title_layer;
static TextLayer *s_date_layer;
static TextLayer *s_score_label_layer;
static TextLayer *s_score_layer;
static TextLayer *s_metric_label_layers[METRIC_ROWS];
static TextLayer *s_metric_value_layers[METRIC_ROWS];
static TextLayer *s_updated_layer;
static TextLayer *s_state_title_layer;
static TextLayer *s_state_body_layer;
static TextLayer *s_state_footer_layer;
static Layer *s_ring_layer;
static Layer *s_graph_layer;
static AppTimer *s_response_timer;

static ScoreCache s_cache;
static uint8_t s_selected_day;
static uint8_t s_view;
static uint16_t s_request_id;
static bool s_has_cache;
static bool s_loading;
static uint8_t s_status;
static char s_error_text[49];

static const char *WEEKDAYS[] = {
  "SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"
};

static const char *GRAPH_TITLES[] = {
  "", "SCORE", "USAGE", "EVENTS", "MASK OFF", "LEAK"
};

static void request_scores(void);
static void render(void);

static int day_of_week(int year, int month, int day) {
  static const int offsets[] = {0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4};
  if (month < 3) {
    year -= 1;
  }
  return (year + year / 4 - year / 100 + year / 400 +
          offsets[month - 1] + day) % 7;
}

static void parse_date(uint32_t packed, int *year, int *month, int *day) {
  *year = packed / 10000;
  *month = (packed / 100) % 100;
  *day = packed % 100;
}

static uint32_t packed_yesterday(void) {
  time_t now = time(NULL);
  struct tm yesterday = *localtime(&now);
  yesterday.tm_mday -= 1;
  yesterday.tm_hour = 12;
  mktime(&yesterday);
  return (uint32_t)(yesterday.tm_year + 1900) * 10000 +
         (uint32_t)(yesterday.tm_mon + 1) * 100 + yesterday.tm_mday;
}

static bool cache_has_yesterday(void) {
  return s_has_cache && s_cache.count == DAYS &&
         s_cache.dates[0] == packed_yesterday() &&
         s_cache.scores[0] <= 100;
}

static void set_layer_hidden(TextLayer *layer, bool hidden) {
  layer_set_hidden(text_layer_get_layer(layer), hidden);
}

static void set_data_layers_hidden(bool hidden) {
  set_layer_hidden(s_date_layer, hidden);
  set_layer_hidden(s_score_label_layer, hidden);
  set_layer_hidden(s_score_layer, hidden);
  set_layer_hidden(s_updated_layer, hidden);
  for (int i = 0; i < METRIC_ROWS; i++) {
    set_layer_hidden(s_metric_label_layers[i], hidden);
    set_layer_hidden(s_metric_value_layers[i], hidden);
  }
  layer_set_hidden(s_ring_layer, hidden);
  layer_set_hidden(s_graph_layer, hidden);
}

static void set_detail_layers_hidden(bool hidden) {
  set_layer_hidden(s_score_label_layer, hidden);
  set_layer_hidden(s_score_layer, hidden);
  set_layer_hidden(s_updated_layer, hidden);
  for (int i = 0; i < METRIC_ROWS; i++) {
    set_layer_hidden(s_metric_label_layers[i], hidden);
    set_layer_hidden(s_metric_value_layers[i], hidden);
  }
  layer_set_hidden(s_ring_layer, hidden);
}

static void set_state_layers_hidden(bool hidden) {
  set_layer_hidden(s_state_title_layer, hidden);
  set_layer_hidden(s_state_body_layer, hidden);
  set_layer_hidden(s_state_footer_layer, hidden);
}

static void ring_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_context_set_stroke_width(ctx, 1);
  graphics_draw_circle(ctx, GPoint(bounds.size.w / 2, bounds.size.h / 2),
                       bounds.size.w / 2 - 1);

  uint8_t score = s_cache.scores[s_selected_day];
  if (score <= 100 && score > 0) {
    graphics_context_set_fill_color(ctx, GColorBlack);
    int32_t end_angle = ((int32_t)TRIG_MAX_ANGLE * score) / 100;
    graphics_fill_radial(ctx, bounds, GOvalScaleModeFitCircle, 7, 0, end_angle);
  }
}

static uint32_t graph_value(uint8_t view, int day, bool *available) {
  uint32_t value = 0;
  *available = true;
  switch (view) {
    case VIEW_SCORE_GRAPH:
      if (s_cache.scores[day] > 100) *available = false;
      else value = s_cache.scores[day];
      break;
    case VIEW_USAGE_GRAPH:
      if (s_cache.usage_minutes[day] == METRIC_UNAVAILABLE) *available = false;
      else value = s_cache.usage_minutes[day];
      break;
    case VIEW_EVENTS_GRAPH:
      if (s_cache.ahi_x10[day] == METRIC_UNAVAILABLE) *available = false;
      else value = s_cache.ahi_x10[day];
      break;
    case VIEW_MASK_GRAPH:
      if (s_cache.mask_off[day] == COUNT_UNAVAILABLE) *available = false;
      else value = s_cache.mask_off[day];
      break;
    case VIEW_LEAK_GRAPH:
      if (s_cache.leak_x10[day] == METRIC_UNAVAILABLE) *available = false;
      else value = s_cache.leak_x10[day];
      break;
    default:
      *available = false;
      break;
  }
  return value;
}

static uint32_t graph_scale_max(uint8_t view) {
  uint32_t maximum = 0;
  for (int i = 0; i < DAYS; i++) {
    bool available = false;
    uint32_t value = graph_value(view, i, &available);
    if (available && value > maximum) maximum = value;
  }
  if (view == VIEW_SCORE_GRAPH) {
    maximum = maximum ? ((maximum + 9) / 10) * 10 : 10;
    return maximum > 100 ? 100 : maximum;
  }
  if (view == VIEW_USAGE_GRAPH) {
    return maximum ? ((maximum + 59) / 60) * 60 : 60;
  }
  if (view == VIEW_EVENTS_GRAPH) {
    if (!maximum) return 1;
    uint32_t step = maximum <= 10 ? 1 : maximum <= 50 ? 5 : 10;
    return ((maximum + step - 1) / step) * step;
  }
  if (view == VIEW_LEAK_GRAPH) {
    return maximum ? ((maximum + 9) / 10) * 10 : 10;
  }
  return maximum ? maximum : 1;
}

static void format_graph_max(char *buffer, size_t size, uint8_t view, uint32_t maximum) {
  if (view == VIEW_USAGE_GRAPH) {
    snprintf(buffer, size, "%luh", (unsigned long)(maximum / 60));
  } else if (view == VIEW_EVENTS_GRAPH) {
    snprintf(buffer, size, "%lu.%lu/hr", (unsigned long)(maximum / 10),
             (unsigned long)(maximum % 10));
  } else if (view == VIEW_LEAK_GRAPH) {
    snprintf(buffer, size, "%lu L/m", (unsigned long)(maximum / 10));
  } else {
    snprintf(buffer, size, "%lu", (unsigned long)maximum);
  }
}

static void format_graph_average(char *buffer, size_t size, uint8_t view,
                                 uint32_t total, uint8_t days) {
  if (!days) {
    snprintf(buffer, size, "AVG --");
    return;
  }
  uint32_t average = (total + days / 2) / days;
  if (view == VIEW_USAGE_GRAPH) {
    snprintf(buffer, size, "AVG %luh %02lum", (unsigned long)(average / 60),
             (unsigned long)(average % 60));
  } else if (view == VIEW_EVENTS_GRAPH) {
    snprintf(buffer, size, "AVG %lu.%lu/hr", (unsigned long)(average / 10),
             (unsigned long)(average % 10));
  } else if (view == VIEW_MASK_GRAPH) {
    uint32_t average_x10 = (total * 10 + days / 2) / days;
    snprintf(buffer, size, "AVG %lu.%lu", (unsigned long)(average_x10 / 10),
             (unsigned long)(average_x10 % 10));
  } else if (view == VIEW_LEAK_GRAPH) {
    snprintf(buffer, size, "AVG %lu.%lu L/min", (unsigned long)(average / 10),
             (unsigned long)(average % 10));
  } else {
    snprintf(buffer, size, "AVG %lu", (unsigned long)average);
  }
}

static void graph_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  const int chart_left = 8;
  const int chart_right = bounds.size.w - 8;
  const int chart_top = 32;
  const int chart_bottom = 151;
  const int chart_height = chart_bottom - chart_top;
  const int slot_width = (chart_right - chart_left) / DAYS;
  const int bar_width = 16;
  const int average_marker_tip = bounds.size.w - 13;
  const int average_marker_base = average_marker_tip + 6;
  const int average_marker_bar = average_marker_base + 2;
  GFont label_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GFont stat_font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  uint32_t maximum = graph_scale_max(s_view);
  uint32_t average_total = 0;
  uint8_t average_days = 0;
  static char max_text[16];
  static char average_text[24];
  static char weekday_text[2];

  for (int day = 0; day < DAYS; day++) {
    bool available = false;
    uint32_t value = graph_value(s_view, day, &available);
    if (available) {
      average_total += value;
      average_days++;
    }
  }
  int average_y = average_days && maximum
    ? chart_bottom - (int)((average_total * chart_height) /
                           ((uint32_t)average_days * maximum)) : -1;

  graphics_context_set_text_color(ctx, GColorBlack);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_context_set_fill_color(ctx, GColorBlack);
  format_graph_max(max_text, sizeof(max_text), s_view, maximum);
  graphics_draw_text(ctx, max_text, stat_font,
                     GRect(chart_left, 0, chart_right - chart_left, 28),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
  graphics_draw_line(ctx, GPoint(chart_left, chart_top),
                     GPoint(chart_right, chart_top));
  graphics_draw_line(ctx, GPoint(chart_left, chart_bottom),
                     GPoint(chart_right, chart_bottom));
  for (int x = chart_left; average_y >= 0 && x < average_marker_tip; x += 6) {
    graphics_draw_line(ctx, GPoint(x, average_y),
                       GPoint(x + 2 < average_marker_tip ? x + 2 : average_marker_tip,
                              average_y));
  }

  for (int column = 0; column < DAYS; column++) {
    int day_index = DAYS - 1 - column;
    int center_x = chart_left + column * slot_width + slot_width / 2;
    bool available = false;
    uint32_t value = graph_value(s_view, day_index, &available);
    if (available) {
      int height = maximum ? (int)((value * chart_height) / maximum) : 0;
      if (height > chart_height) height = chart_height;
      if (height > 0) {
        graphics_fill_rect(ctx, GRect(center_x - bar_width / 2,
                                      chart_bottom - height, bar_width, height),
                           0, GCornerNone);
      } else {
        graphics_draw_line(ctx, GPoint(center_x - bar_width / 2, chart_bottom - 1),
                           GPoint(center_x + bar_width / 2, chart_bottom - 1));
      }
    } else {
      graphics_draw_line(ctx, GPoint(center_x - 3, chart_bottom - 5),
                         GPoint(center_x + 3, chart_bottom - 5));
    }

    uint32_t packed = s_cache.dates[day_index];
    int year = 0;
    int month = 0;
    int day = 0;
    parse_date(packed, &year, &month, &day);
    weekday_text[0] = month >= 1 && month <= 12 && day >= 1 && day <= 31
      ? WEEKDAYS[day_of_week(year, month, day)][0] : '?';
    weekday_text[1] = '\0';
    graphics_draw_text(ctx, weekday_text, label_font,
                       GRect(center_x - slot_width / 2, chart_bottom, slot_width, 22),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }

  if (average_y >= 0) {
    for (int x = 0; x <= average_marker_base - average_marker_tip; x++) {
      int half_height = x < 5 ? x : 5;
      graphics_draw_line(ctx,
                         GPoint(average_marker_tip + x, average_y - half_height),
                         GPoint(average_marker_tip + x, average_y + half_height));
    }
    graphics_fill_rect(ctx, GRect(average_marker_bar, average_y - 5, 3, 11),
                       0, GCornerNone);
  }

  format_graph_average(average_text, sizeof(average_text), s_view,
                       average_total, average_days);
  graphics_draw_text(ctx, average_text, stat_font, GRect(8, 174, bounds.size.w - 16, 28),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void render_state(const char *title, const char *body, const char *footer) {
  set_data_layers_hidden(true);
  set_state_layers_hidden(false);
  bool title_only = body[0] == '\0' && footer[0] == '\0';
  layer_set_frame(text_layer_get_layer(s_state_title_layer),
                  GRect(8, title_only ? 92 : 68, 184, 36));
  text_layer_set_text(s_state_title_layer, title);
  text_layer_set_text(s_state_body_layer, body);
  text_layer_set_text(s_state_footer_layer, footer);
}

static void format_updated(char *buffer, size_t size) {
  uint32_t now = time(NULL);
  uint32_t elapsed = now >= s_cache.fetched_at ? now - s_cache.fetched_at : 0;
  if (s_cache.fetched_at == 0) {
    snprintf(buffer, size, "Updated --");
  } else if (elapsed < 60) {
    snprintf(buffer, size, "Updated just now");
  } else if (elapsed < 3600) {
    snprintf(buffer, size, "Updated %lum ago", (unsigned long)(elapsed / 60));
  } else if (elapsed < 86400) {
    snprintf(buffer, size, "Updated %luh ago", (unsigned long)(elapsed / 3600));
  } else {
    snprintf(buffer, size, "Updated %lud ago", (unsigned long)(elapsed / 86400));
  }
}

static void render_data(void) {
  set_state_layers_hidden(true);
  set_data_layers_hidden(false);
  layer_set_hidden(s_graph_layer, true);

  static char date_text[24];
  static char score_text[8];
  static char usage_text[16];
  static char events_text[16];
  static char mask_text[8];
  static char leak_text[16];
  static char updated_text[24];

  uint32_t packed_date = s_cache.dates[s_selected_day];
  int year = 0;
  int month = 0;
  int day = 0;
  parse_date(packed_date, &year, &month, &day);
  if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
    snprintf(date_text, sizeof(date_text), "%02d/%02d", month, day);
  } else {
    snprintf(date_text, sizeof(date_text), "DAY %d", s_selected_day + 1);
  }
  text_layer_set_text(s_date_layer, date_text);

  uint8_t score = s_cache.scores[s_selected_day];
  if (score <= 100) {
    snprintf(score_text, sizeof(score_text), "%u", score);
  } else {
    snprintf(score_text, sizeof(score_text), "--");
  }
  text_layer_set_text(s_score_layer, score_text);

  uint16_t usage = s_cache.usage_minutes[s_selected_day];
  if (usage == METRIC_UNAVAILABLE) snprintf(usage_text, sizeof(usage_text), "--");
  else snprintf(usage_text, sizeof(usage_text), "%uh %02um", usage / 60, usage % 60);

  uint16_t ahi = s_cache.ahi_x10[s_selected_day];
  if (ahi == METRIC_UNAVAILABLE) snprintf(events_text, sizeof(events_text), "--");
  else snprintf(events_text, sizeof(events_text), "%u.%u/hr", ahi / 10, ahi % 10);

  uint8_t mask = s_cache.mask_off[s_selected_day];
  if (mask == COUNT_UNAVAILABLE) snprintf(mask_text, sizeof(mask_text), "--");
  else snprintf(mask_text, sizeof(mask_text), "%u", mask);

  uint16_t leak = s_cache.leak_x10[s_selected_day];
  if (leak == METRIC_UNAVAILABLE) snprintf(leak_text, sizeof(leak_text), "--");
  else if (leak % 10 == 0) snprintf(leak_text, sizeof(leak_text), "%u L/min", leak / 10);
  else snprintf(leak_text, sizeof(leak_text), "%u.%u L/min", leak / 10, leak % 10);

  text_layer_set_text(s_metric_value_layers[0], usage_text);
  text_layer_set_text(s_metric_value_layers[1], events_text);
  text_layer_set_text(s_metric_value_layers[2], mask_text);
  text_layer_set_text(s_metric_value_layers[3], leak_text);
  format_updated(updated_text, sizeof(updated_text));
  text_layer_set_text(s_updated_layer, updated_text);

  layer_mark_dirty(s_ring_layer);
}

static void render_graph(void) {
  set_state_layers_hidden(true);
  set_data_layers_hidden(false);
  set_detail_layers_hidden(true);
  layer_set_hidden(s_graph_layer, false);
  text_layer_set_text(s_date_layer, GRAPH_TITLES[s_view]);
  layer_mark_dirty(s_graph_layer);
}

static void render(void) {
  if (s_loading) {
    render_state("SYNCING...", "", "");
    return;
  }

  switch (s_status) {
    case STATUS_UNCONFIGURED:
      render_state("SETUP REQUIRED", "Go to CPAP settings\nin the Pebble app",
                   "RESMED SIGN-IN REQUIRED");
      break;
    case STATUS_AUTH_REQUIRED:
      render_state("ERROR", "Open CPAP settings\nto reconnect ResMed",
                   "PRESS SELECT TO RETRY");
      break;
    case STATUS_NETWORK_ERROR:
      render_state("ERROR", "Phone cannot be reached",
                   "PRESS SELECT TO RETRY");
      break;
    case STATUS_SERVICE_ERROR:
      render_state("ERROR", s_error_text[0] ? s_error_text : "ResMed is unavailable",
                   "PRESS SELECT TO RETRY");
      break;
    default:
      if (s_has_cache && s_view != VIEW_DAY) render_graph();
      else if (s_has_cache) render_data();
      else render_state("SYNCING...", "", "");
      break;
  }
}

static void response_timeout(void *context) {
  s_response_timer = NULL;
  if (!s_loading) {
    return;
  }
  s_loading = false;
  s_status = STATUS_NETWORK_ERROR;
  render();
}

static void cancel_response_timer(void) {
  if (s_response_timer) {
    app_timer_cancel(s_response_timer);
    s_response_timer = NULL;
  }
}

static void request_scores(void) {
  DictionaryIterator *out;
  AppMessageResult result = app_message_outbox_begin(&out);
  if (result != APP_MSG_OK) {
    s_loading = false;
    s_status = STATUS_NETWORK_ERROR;
    render();
    return;
  }

  s_request_id += 1;
  dict_write_uint8(out, MESSAGE_KEY_PROTOCOL, 1);
  dict_write_uint8(out, MESSAGE_KEY_COMMAND, COMMAND_FETCH);
  dict_write_uint16(out, MESSAGE_KEY_REQUEST_ID, s_request_id);
  app_message_outbox_send();

  s_loading = true;
  s_status = STATUS_OK;
  cancel_response_timer();
  s_response_timer = app_timer_register(RESPONSE_TIMEOUT_MS, response_timeout, NULL);
  render();
}

static uint32_t tuple_uint32(DictionaryIterator *iterator, uint32_t key, uint32_t fallback) {
  Tuple *tuple = dict_find(iterator, key);
  return tuple ? tuple->value->uint32 : fallback;
}

static void inbox_received(DictionaryIterator *iterator, void *context) {
  Tuple *protocol = dict_find(iterator, MESSAGE_KEY_PROTOCOL);
  if (protocol && protocol->value->uint8 != 1) {
    return;
  }

  Tuple *response_id = dict_find(iterator, MESSAGE_KEY_REQUEST_ID);
  if (response_id && response_id->value->uint16 != s_request_id) {
    return;
  }

  Tuple *status = dict_find(iterator, MESSAGE_KEY_STATUS);
  if (status && status->value->uint8 == STATUS_SYNCING) {
    cancel_response_timer();
    s_loading = true;
    s_status = STATUS_OK;
    s_response_timer = app_timer_register(RESPONSE_TIMEOUT_MS, response_timeout, NULL);
    render();
    return;
  }

  cancel_response_timer();
  s_loading = false;

  s_status = status ? status->value->uint8 : STATUS_SERVICE_ERROR;

  Tuple *error = dict_find(iterator, MESSAGE_KEY_ERROR_TEXT);
  if (error && error->type == TUPLE_CSTRING) {
    snprintf(s_error_text, sizeof(s_error_text), "%s", error->value->cstring);
  } else {
    s_error_text[0] = '\0';
  }

  if (s_status == STATUS_OK || s_status == STATUS_PARTIAL) {
    const uint32_t date_keys[DAYS] = {
      MESSAGE_KEY_DAY0_DATE, MESSAGE_KEY_DAY1_DATE, MESSAGE_KEY_DAY2_DATE,
      MESSAGE_KEY_DAY3_DATE, MESSAGE_KEY_DAY4_DATE, MESSAGE_KEY_DAY5_DATE,
      MESSAGE_KEY_DAY6_DATE
    };
    const uint32_t score_keys[DAYS] = {
      MESSAGE_KEY_DAY0_SCORE, MESSAGE_KEY_DAY1_SCORE, MESSAGE_KEY_DAY2_SCORE,
      MESSAGE_KEY_DAY3_SCORE, MESSAGE_KEY_DAY4_SCORE, MESSAGE_KEY_DAY5_SCORE,
      MESSAGE_KEY_DAY6_SCORE
    };
    const uint32_t usage_keys[DAYS] = {
      MESSAGE_KEY_DAY0_USAGE, MESSAGE_KEY_DAY1_USAGE, MESSAGE_KEY_DAY2_USAGE,
      MESSAGE_KEY_DAY3_USAGE, MESSAGE_KEY_DAY4_USAGE, MESSAGE_KEY_DAY5_USAGE,
      MESSAGE_KEY_DAY6_USAGE
    };
    const uint32_t ahi_keys[DAYS] = {
      MESSAGE_KEY_DAY0_AHI_X10, MESSAGE_KEY_DAY1_AHI_X10, MESSAGE_KEY_DAY2_AHI_X10,
      MESSAGE_KEY_DAY3_AHI_X10, MESSAGE_KEY_DAY4_AHI_X10, MESSAGE_KEY_DAY5_AHI_X10,
      MESSAGE_KEY_DAY6_AHI_X10
    };
    const uint32_t mask_keys[DAYS] = {
      MESSAGE_KEY_DAY0_MASK_OFF, MESSAGE_KEY_DAY1_MASK_OFF, MESSAGE_KEY_DAY2_MASK_OFF,
      MESSAGE_KEY_DAY3_MASK_OFF, MESSAGE_KEY_DAY4_MASK_OFF, MESSAGE_KEY_DAY5_MASK_OFF,
      MESSAGE_KEY_DAY6_MASK_OFF
    };
    const uint32_t leak_keys[DAYS] = {
      MESSAGE_KEY_DAY0_LEAK_X10, MESSAGE_KEY_DAY1_LEAK_X10, MESSAGE_KEY_DAY2_LEAK_X10,
      MESSAGE_KEY_DAY3_LEAK_X10, MESSAGE_KEY_DAY4_LEAK_X10, MESSAGE_KEY_DAY5_LEAK_X10,
      MESSAGE_KEY_DAY6_LEAK_X10
    };

    ScoreCache next = {0};
    next.version = CACHE_VERSION;
    next.count = DAYS;
    next.fetched_at = tuple_uint32(iterator, MESSAGE_KEY_FETCHED_AT, 0);
    for (int i = 0; i < DAYS; i++) {
      next.dates[i] = tuple_uint32(iterator, date_keys[i], 0);
      uint32_t raw_score = tuple_uint32(iterator, score_keys[i], SCORE_UNAVAILABLE);
      next.scores[i] = raw_score <= 100 ? raw_score : SCORE_UNAVAILABLE;
      uint32_t raw_usage = tuple_uint32(iterator, usage_keys[i], METRIC_UNAVAILABLE);
      uint32_t raw_ahi = tuple_uint32(iterator, ahi_keys[i], METRIC_UNAVAILABLE);
      uint32_t raw_mask = tuple_uint32(iterator, mask_keys[i], COUNT_UNAVAILABLE);
      uint32_t raw_leak = tuple_uint32(iterator, leak_keys[i], METRIC_UNAVAILABLE);
      next.usage_minutes[i] = raw_usage < METRIC_UNAVAILABLE ? raw_usage : METRIC_UNAVAILABLE;
      next.ahi_x10[i] = raw_ahi < METRIC_UNAVAILABLE ? raw_ahi : METRIC_UNAVAILABLE;
      next.mask_off[i] = raw_mask < COUNT_UNAVAILABLE ? raw_mask : COUNT_UNAVAILABLE;
      next.leak_x10[i] = raw_leak < METRIC_UNAVAILABLE ? raw_leak : METRIC_UNAVAILABLE;
    }

    s_cache = next;
    s_has_cache = true;
    persist_write_data(PERSIST_KEY_CACHE, &s_cache, sizeof(s_cache));
  }

  render();
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Inbox dropped: %d", reason);
}

static void outbox_failed(DictionaryIterator *iterator, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Outbox failed: %d", reason);
  cancel_response_timer();
  s_loading = false;
  s_status = STATUS_NETWORK_ERROR;
  render();
}

static void up_click(ClickRecognizerRef recognizer, void *context) {
  if (!s_has_cache) return;
  if (s_view == VIEW_DAY && s_selected_day < DAYS - 1) {
    s_selected_day += 1;
    render();
  } else if (s_view == VIEW_SCORE_GRAPH) {
    s_view = VIEW_DAY;
    s_selected_day = 0;
    render();
  } else if (s_view > VIEW_SCORE_GRAPH) {
    s_view -= 1;
    render();
  }
}

static void down_click(ClickRecognizerRef recognizer, void *context) {
  if (!s_has_cache) return;
  if (s_view == VIEW_DAY && s_selected_day > 0) {
    s_selected_day -= 1;
    render();
  } else if (s_view == VIEW_DAY) {
    s_view = VIEW_SCORE_GRAPH;
    render();
  } else if (s_view < VIEW_LEAK_GRAPH) {
    s_view += 1;
    render();
  }
}

static void select_click(ClickRecognizerRef recognizer, void *context) {
  if (!s_loading) request_scores();
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
}

static TextLayer *create_text_layer(Layer *parent, GRect frame, const char *font_key,
                                    GTextAlignment alignment, GColor color) {
  TextLayer *layer = text_layer_create(frame);
  text_layer_set_background_color(layer, GColorClear);
  text_layer_set_text_color(layer, color);
  text_layer_set_font(layer, fonts_get_system_font(font_key));
  text_layer_set_text_alignment(layer, alignment);
  layer_add_child(parent, text_layer_get_layer(layer));
  return layer;
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_title_layer = create_text_layer(root, GRect(8, 0, 60, 28),
                                    FONT_KEY_GOTHIC_24_BOLD, GTextAlignmentLeft, GColorBlack);
  text_layer_set_text(s_title_layer, "CPAP");

  s_date_layer = create_text_layer(root, GRect(64, 0, bounds.size.w - 72, 28),
                                   FONT_KEY_GOTHIC_24_BOLD, GTextAlignmentRight, GColorBlack);

  s_graph_layer = layer_create(GRect(0, 26, bounds.size.w, bounds.size.h - 26));
  layer_set_update_proc(s_graph_layer, graph_update_proc);
  layer_add_child(root, s_graph_layer);

  s_ring_layer = layer_create(GRect(bounds.size.w / 2 - 48, 20, 96, 96));
  layer_set_update_proc(s_ring_layer, ring_update_proc);
  layer_add_child(root, s_ring_layer);

  s_score_label_layer = create_text_layer(root, GRect(60, 32, 80, 22),
                                          FONT_KEY_GOTHIC_18_BOLD, GTextAlignmentCenter, GColorBlack);
  text_layer_set_text(s_score_label_layer, "SCORE");
  s_score_layer = create_text_layer(root, GRect(40, 48, 120, 54),
                                    FONT_KEY_BITHAM_42_BOLD, GTextAlignmentCenter, GColorBlack);

  static const char *metric_labels[METRIC_ROWS] = {"Usage", "Events", "Mask Off", "Leak"};
  for (int i = 0; i < METRIC_ROWS; i++) {
    int y = 111 + i * 23;
    s_metric_label_layers[i] = create_text_layer(root, GRect(8, y, 82, 28),
                                                  FONT_KEY_GOTHIC_24_BOLD, GTextAlignmentLeft, GColorBlack);
    s_metric_value_layers[i] = create_text_layer(root, GRect(82, y, bounds.size.w - 90, 28),
                                                  FONT_KEY_GOTHIC_24_BOLD, GTextAlignmentRight, GColorBlack);
    text_layer_set_text(s_metric_label_layers[i], metric_labels[i]);
  }
  s_updated_layer = create_text_layer(root, GRect(8, 210, bounds.size.w - 16, 18),
                                      FONT_KEY_GOTHIC_14, GTextAlignmentCenter, GColorBlack);

  s_state_title_layer = create_text_layer(root, GRect(8, 68, bounds.size.w - 16, 36),
                                          FONT_KEY_GOTHIC_28_BOLD, GTextAlignmentCenter, GColorBlack);
  s_state_body_layer = create_text_layer(root, GRect(14, 108, bounds.size.w - 28, 58),
                                         FONT_KEY_GOTHIC_18_BOLD, GTextAlignmentCenter, GColorBlack);
  s_state_footer_layer = create_text_layer(root, GRect(8, 184, bounds.size.w - 16, 28),
                                           FONT_KEY_GOTHIC_18_BOLD, GTextAlignmentCenter, GColorBlack);

  render();
}

static void window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_date_layer);
  text_layer_destroy(s_score_label_layer);
  text_layer_destroy(s_score_layer);
  for (int i = 0; i < METRIC_ROWS; i++) {
    text_layer_destroy(s_metric_label_layers[i]);
    text_layer_destroy(s_metric_value_layers[i]);
  }
  text_layer_destroy(s_updated_layer);
  text_layer_destroy(s_state_title_layer);
  text_layer_destroy(s_state_body_layer);
  text_layer_destroy(s_state_footer_layer);
  layer_destroy(s_ring_layer);
  layer_destroy(s_graph_layer);
}

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  if (s_has_cache && !s_loading) {
    render();
  }
}

static void init(void) {
  memset(&s_cache, 0, sizeof(s_cache));
  for (int i = 0; i < DAYS; i++) {
    s_cache.scores[i] = SCORE_UNAVAILABLE;
    s_cache.usage_minutes[i] = METRIC_UNAVAILABLE;
    s_cache.ahi_x10[i] = METRIC_UNAVAILABLE;
    s_cache.mask_off[i] = COUNT_UNAVAILABLE;
    s_cache.leak_x10[i] = METRIC_UNAVAILABLE;
  }
  s_status = STATUS_OK;
  s_selected_day = 0;
  s_view = VIEW_DAY;

  if (persist_exists(PERSIST_KEY_CACHE) &&
      persist_get_size(PERSIST_KEY_CACHE) == (int)sizeof(s_cache) &&
      persist_read_data(PERSIST_KEY_CACHE, &s_cache, sizeof(s_cache)) == (int)sizeof(s_cache) &&
      s_cache.version == CACHE_VERSION) {
    s_has_cache = true;
  }
  bool refresh_on_launch = !cache_has_yesterday();
  s_loading = refresh_on_launch;

  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
  window_set_click_config_provider(s_window, click_config_provider);

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(1024, 64);
  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
  window_stack_push(s_window, true);
  if (refresh_on_launch) request_scores();
}

static void deinit(void) {
  cancel_response_timer();
  tick_timer_service_unsubscribe();
  app_message_deregister_callbacks();
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
  return 0;
}
