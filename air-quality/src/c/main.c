#include <pebble.h>

#define DAYS 7
#define METRICS 5
#define PAGE_COUNT 6
#define CACHE_VERSION 1
#define PERSIST_KEY_CACHE 4101
#define UNAVAILABLE 65535
#define RESPONSE_TIMEOUT_MS 30000

enum { COMMAND_FETCH = 1, COMMAND_PHONE_READY = 2 };
enum {
  STATUS_OK = 0, STATUS_UNCONFIGURED = 1, STATUS_AUTH = 2,
  STATUS_RATE = 3, STATUS_PHONE = 4, STATUS_NETWORK = 5,
  STATUS_TIMEOUT = 6, STATUS_SERVICE = 7, STATUS_PARTIAL = 8,
  STATUS_LOADING = 9
};
enum { FLAG_STALE = 1 };

typedef struct {
  uint8_t version;
  uint8_t flags;
  uint32_t fetched_at;
  char location[32];
  uint16_t current[METRICS];
  uint32_t dates[DAYS];
  uint16_t history[METRICS][DAYS];
} AirCache;

static Window *s_window;
static Layer *s_canvas;
static AppTimer *s_timer;
static AirCache s_cache;
static bool s_has_cache;
static bool s_loading;
static uint8_t s_status = STATUS_LOADING;
static uint8_t s_page;
static uint16_t s_request_id;
static char s_error[49];

static const char *METRIC_NAMES[] = {"AQI", "PM2.5", "CO2", "TEMP", "HUMIDITY"};
static const char *METRIC_UNITS[] = {"", "ug/m3", "ppm", "C", "%"};

static void draw_text(GContext *ctx, const char *text, GFont font, GRect frame,
                      GTextAlignment align, GColor color) {
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text, font, frame, GTextOverflowModeTrailingEllipsis,
                     align, NULL);
}

static const char *category(uint16_t aqi) {
  if (aqi == UNAVAILABLE) return "NO AQI";
  if (aqi <= 50) return "HEALTHY";
  if (aqi <= 100) return "MODERATE";
  if (aqi <= 150) return "ELEVATED";
  if (aqi <= 300) return "UNHEALTHY";
  return "HAZARDOUS";
}

static void format_metric(char *buffer, size_t size, int metric, uint16_t value) {
  if (value == UNAVAILABLE) {
    snprintf(buffer, size, "--");
  } else if (metric == 1 || metric == 3 || metric == 4) {
    snprintf(buffer, size, "%u.%u %s", value / 10, value % 10, METRIC_UNITS[metric]);
  } else {
    snprintf(buffer, size, "%u%s%s", value, METRIC_UNITS[metric][0] ? " " : "",
             METRIC_UNITS[metric]);
  }
}

static void format_age(char *buffer, size_t size) {
  if (!s_cache.fetched_at) { snprintf(buffer, size, "SAVED DATA"); return; }
  time_t now = time(NULL);
  uint32_t age = now > (time_t)s_cache.fetched_at ? (uint32_t)(now - s_cache.fetched_at) : 0;
  if (age < 60) snprintf(buffer, size, "UPDATED NOW");
  else if (age < 3600) snprintf(buffer, size, "UPDATED %lum AGO", (unsigned long)(age / 60));
  else if (age < 86400) snprintf(buffer, size, "UPDATED %luh AGO", (unsigned long)(age / 3600));
  else snprintf(buffer, size, "UPDATED %lud AGO", (unsigned long)(age / 86400));
}

static void draw_header(GContext *ctx, GRect bounds, const char *title) {
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, GRect(0, 0, bounds.size.w, 30), 0, GCornerNone);
  draw_text(ctx, title, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(8, -1, bounds.size.w - 16, 30), GTextAlignmentCenter, GColorWhite);
}

static void draw_footer(GContext *ctx, GRect bounds) {
  char age[32];
  char footer[48];
  format_age(age, sizeof(age));
  if (s_loading) snprintf(footer, sizeof(footer), "SYNCING...");
  else if (s_status >= STATUS_AUTH && s_status <= STATUS_SERVICE)
    snprintf(footer, sizeof(footer), "ERROR  PRESS SELECT TO RETRY");
  else if (s_status == STATUS_PARTIAL) snprintf(footer, sizeof(footer), "PARTIAL  %s", age);
  else if (s_cache.flags & FLAG_STALE) snprintf(footer, sizeof(footer), "STALE  %s", age);
  else snprintf(footer, sizeof(footer), "%s", age);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_draw_line(ctx, GPoint(8, bounds.size.h - 23), GPoint(bounds.size.w - 8, bounds.size.h - 23));
  draw_text(ctx, footer, fonts_get_system_font(FONT_KEY_GOTHIC_14),
            GRect(5, bounds.size.h - 22, bounds.size.w - 10, 22), GTextAlignmentCenter, GColorBlack);
}

static void draw_state(GContext *ctx, GRect bounds) {
  const char *title = "SYNCING...";
  const char *body = "";
  const char *footer = "";
  if (s_status == STATUS_UNCONFIGURED) { title = "SETUP REQUIRED"; body = "Go to AirQuality settings\nin the Pebble app"; }
  else if (s_status == STATUS_AUTH) { title = "ERROR"; body = "Open AirQuality settings\nto reconnect Aranet"; footer = "PRESS SELECT TO RETRY"; }
  else if (s_status == STATUS_RATE) { title = "ERROR"; body = "Try again later"; footer = "PRESS SELECT TO RETRY"; }
  else if (s_status == STATUS_PHONE || s_status == STATUS_NETWORK) { title = "ERROR"; body = "Phone cannot be reached"; footer = "PRESS SELECT TO RETRY"; }
  else if (s_status == STATUS_TIMEOUT) { title = "ERROR"; body = "Refresh timed out"; footer = "PRESS SELECT TO RETRY"; }
  else if (s_status == STATUS_SERVICE) { title = "ERROR"; body = "Aranet is unavailable"; footer = "PRESS SELECT TO RETRY"; }
  draw_header(ctx, bounds, "AIR QUALITY");
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_context_set_stroke_width(ctx, 3);
  graphics_draw_circle(ctx, GPoint(bounds.size.w / 2, 69), 18);
  graphics_draw_line(ctx, GPoint(bounds.size.w / 2 - 8, 69), GPoint(bounds.size.w / 2 + 8, 69));
  draw_text(ctx, title, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(8, 91, bounds.size.w - 16, 34), GTextAlignmentCenter, GColorBlack);
  draw_text(ctx, body, fonts_get_system_font(FONT_KEY_GOTHIC_18),
            GRect(15, 126, bounds.size.w - 30, 62), GTextAlignmentCenter, GColorBlack);
  draw_text(ctx, footer, fonts_get_system_font(FONT_KEY_GOTHIC_14),
            GRect(8, bounds.size.h - 28, bounds.size.w - 16, 24), GTextAlignmentCenter, GColorBlack);
}

static void draw_current(GContext *ctx, GRect bounds) {
  char value[28];
  char primary[16];
  draw_header(ctx, bounds, "AIR QUALITY");
  draw_text(ctx, s_cache.location, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
            GRect(8, 31, bounds.size.w - 16, 24), GTextAlignmentCenter, GColorBlack);
  if (s_cache.current[0] == UNAVAILABLE) snprintf(primary, sizeof(primary), "--");
  else snprintf(primary, sizeof(primary), "%u", s_cache.current[0]);
  draw_text(ctx, "AQI", fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
            GRect(8, 54, 55, 24), GTextAlignmentCenter, GColorBlack);
  draw_text(ctx, primary, fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD),
            GRect(4, 68, 96, 55), GTextAlignmentCenter, GColorBlack);
  draw_text(ctx, category(s_cache.current[0]), fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(96, 69, bounds.size.w - 102, 52), GTextAlignmentCenter, GColorBlack);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_draw_line(ctx, GPoint(8, 121), GPoint(bounds.size.w - 8, 121));
  for (int metric = 1; metric < METRICS; metric++) {
    int y = 124 + (metric - 1) * 19;
    draw_text(ctx, METRIC_NAMES[metric], fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
              GRect(9, y, 72, 20), GTextAlignmentLeft, GColorBlack);
    format_metric(value, sizeof(value), metric, s_cache.current[metric]);
    draw_text(ctx, value, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
              GRect(76, y - 2, bounds.size.w - 85, 22), GTextAlignmentRight, GColorBlack);
  }
  draw_footer(ctx, bounds);
}

static uint16_t graph_maximum(int metric) {
  uint16_t maximum = 0;
  for (int day = 0; day < DAYS; day++) {
    uint16_t value = s_cache.history[metric][day];
    if (value != UNAVAILABLE && value > maximum) maximum = value;
  }
  if (!maximum) return 1;
  uint16_t step = metric == 0 ? 50 : 100;
  return (uint16_t)(((maximum + step - 1) / step) * step);
}

static void draw_chart(GContext *ctx, GRect bounds) {
  int metric = s_page - 1;
  char title[24];
  char max_text[24];
  char stat[48];
  snprintf(title, sizeof(title), "7-DAY %s", METRIC_NAMES[metric]);
  draw_header(ctx, bounds, title);
  uint16_t maximum = graph_maximum(metric);
  format_metric(max_text, sizeof(max_text), metric, maximum);
  draw_text(ctx, max_text, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
            GRect(8, 31, bounds.size.w - 16, 24), GTextAlignmentRight, GColorBlack);
  const int left = 9, right = bounds.size.w - 9, top = 58, bottom = 165;
  int slot = (right - left) / DAYS;
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_draw_line(ctx, GPoint(left, top), GPoint(right, top));
  graphics_draw_line(ctx, GPoint(left, bottom), GPoint(right, bottom));
  uint32_t total = 0; int count = 0;
  for (int column = 0; column < DAYS; column++) {
    int day = DAYS - 1 - column;
    uint16_t value = s_cache.history[metric][day];
    int center = left + column * slot + slot / 2;
    if (value == UNAVAILABLE) {
      graphics_draw_line(ctx, GPoint(center - 4, bottom - 5), GPoint(center + 4, bottom - 5));
    } else {
      int height = (int)(((uint32_t)value * (bottom - top)) / maximum);
      if (height > bottom - top) height = bottom - top;
      if (height) graphics_fill_rect(ctx, GRect(center - 7, bottom - height, 14, height), 0, GCornerNone);
      else graphics_draw_line(ctx, GPoint(center - 7, bottom - 1), GPoint(center + 7, bottom - 1));
      total += value; count++;
    }
    char label[2] = {(char)('1' + column), '\0'};
    draw_text(ctx, label, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
              GRect(center - 10, bottom + 1, 20, 22), GTextAlignmentCenter, GColorBlack);
  }
  if (count) {
    char avg[22]; format_metric(avg, sizeof(avg), metric, (uint16_t)(total / count));
    snprintf(stat, sizeof(stat), "AVG %s  %d/7 DAYS", avg, count);
  } else snprintf(stat, sizeof(stat), "NO HISTORY  0/7 DAYS");
  draw_text(ctx, stat, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
            GRect(8, 187, bounds.size.w - 16, 25), GTextAlignmentCenter, GColorBlack);
  draw_footer(ctx, bounds);
}

static void canvas_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  if (!s_has_cache) draw_state(ctx, bounds);
  else if (s_page == 0) draw_current(ctx, bounds);
  else draw_chart(ctx, bounds);
}

static void refresh_timeout(void *context) {
  s_timer = NULL; s_loading = false; s_status = STATUS_TIMEOUT;
  snprintf(s_error, sizeof(s_error), "Phone did not reply");
  layer_mark_dirty(s_canvas);
}

static void request_refresh(void) {
  if (s_loading) return;
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    s_status = STATUS_PHONE; layer_mark_dirty(s_canvas); return;
  }
  s_request_id++;
  dict_write_uint8(iter, MESSAGE_KEY_PROTOCOL, 1);
  dict_write_uint8(iter, MESSAGE_KEY_COMMAND, COMMAND_FETCH);
  dict_write_uint16(iter, MESSAGE_KEY_REQUEST_ID, s_request_id);
  if (app_message_outbox_send() != APP_MSG_OK) {
    s_status = STATUS_PHONE; layer_mark_dirty(s_canvas); return;
  }
  s_loading = true; s_status = STATUS_LOADING;
  if (s_timer) app_timer_cancel(s_timer);
  s_timer = app_timer_register(RESPONSE_TIMEOUT_MS, refresh_timeout, NULL);
  layer_mark_dirty(s_canvas);
}

static uint16_t tuple_u16(DictionaryIterator *iter, uint32_t key, uint16_t fallback) {
  Tuple *tuple = dict_find(iter, key);
  return tuple ? (uint16_t)tuple->value->uint32 : fallback;
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *protocol = dict_find(iter, MESSAGE_KEY_PROTOCOL);
  if (!protocol || protocol->value->uint8 != 1) return;
  Tuple *command = dict_find(iter, MESSAGE_KEY_COMMAND);
  if (command && command->value->uint8 == COMMAND_PHONE_READY) {
    if (s_loading) {
      if (s_timer) { app_timer_cancel(s_timer); s_timer = NULL; }
      s_loading = false;
      request_refresh();
    }
    return;
  }
  Tuple *status = dict_find(iter, MESSAGE_KEY_STATUS);
  if (!status) return;
  Tuple *request = dict_find(iter, MESSAGE_KEY_REQUEST_ID);
  if (request && request->value->uint16 && request->value->uint16 != s_request_id) return;
  if (s_timer) { app_timer_cancel(s_timer); s_timer = NULL; }
  s_loading = false;
  s_status = status->value->uint8;
  Tuple *error = dict_find(iter, MESSAGE_KEY_ERROR_TEXT);
  snprintf(s_error, sizeof(s_error), "%s", error ? error->value->cstring : "");
  if (s_status == STATUS_OK || s_status == STATUS_PARTIAL) {
    Tuple *fetched = dict_find(iter, MESSAGE_KEY_FETCHED_AT);
    Tuple *location = dict_find(iter, MESSAGE_KEY_LOCATION);
    if (!fetched || !location || !dict_find(iter, MESSAGE_KEY_AQI)) {
      s_status = STATUS_SERVICE;
      snprintf(s_error, sizeof(s_error), "Incomplete phone response");
      layer_mark_dirty(s_canvas); return;
    }
    AirCache next;
    memset(&next, 0, sizeof(next)); next.version = CACHE_VERSION;
    next.flags = tuple_u16(iter, MESSAGE_KEY_FLAGS, 0);
    next.fetched_at = fetched->value->uint32;
    snprintf(next.location, sizeof(next.location), "%s", location->value->cstring);
    const uint32_t current_keys[] = {MESSAGE_KEY_AQI, MESSAGE_KEY_PM25_X10, MESSAGE_KEY_CO2,
      MESSAGE_KEY_TEMP_X10, MESSAGE_KEY_HUMIDITY_X10};
    const uint32_t date_keys[] = {MESSAGE_KEY_DAY0_DATE, MESSAGE_KEY_DAY1_DATE, MESSAGE_KEY_DAY2_DATE, MESSAGE_KEY_DAY3_DATE, MESSAGE_KEY_DAY4_DATE, MESSAGE_KEY_DAY5_DATE, MESSAGE_KEY_DAY6_DATE};
    const uint32_t history_keys[METRICS][DAYS] = {
      {MESSAGE_KEY_DAY0_AQI,MESSAGE_KEY_DAY1_AQI,MESSAGE_KEY_DAY2_AQI,MESSAGE_KEY_DAY3_AQI,MESSAGE_KEY_DAY4_AQI,MESSAGE_KEY_DAY5_AQI,MESSAGE_KEY_DAY6_AQI},
      {MESSAGE_KEY_DAY0_PM25_X10,MESSAGE_KEY_DAY1_PM25_X10,MESSAGE_KEY_DAY2_PM25_X10,MESSAGE_KEY_DAY3_PM25_X10,MESSAGE_KEY_DAY4_PM25_X10,MESSAGE_KEY_DAY5_PM25_X10,MESSAGE_KEY_DAY6_PM25_X10},
      {MESSAGE_KEY_DAY0_CO2,MESSAGE_KEY_DAY1_CO2,MESSAGE_KEY_DAY2_CO2,MESSAGE_KEY_DAY3_CO2,MESSAGE_KEY_DAY4_CO2,MESSAGE_KEY_DAY5_CO2,MESSAGE_KEY_DAY6_CO2},
      {MESSAGE_KEY_DAY0_TEMP_X10,MESSAGE_KEY_DAY1_TEMP_X10,MESSAGE_KEY_DAY2_TEMP_X10,MESSAGE_KEY_DAY3_TEMP_X10,MESSAGE_KEY_DAY4_TEMP_X10,MESSAGE_KEY_DAY5_TEMP_X10,MESSAGE_KEY_DAY6_TEMP_X10},
      {MESSAGE_KEY_DAY0_HUMIDITY_X10,MESSAGE_KEY_DAY1_HUMIDITY_X10,MESSAGE_KEY_DAY2_HUMIDITY_X10,MESSAGE_KEY_DAY3_HUMIDITY_X10,MESSAGE_KEY_DAY4_HUMIDITY_X10,MESSAGE_KEY_DAY5_HUMIDITY_X10,MESSAGE_KEY_DAY6_HUMIDITY_X10}
    };
    for (int metric = 0; metric < METRICS; metric++) {
      next.current[metric] = tuple_u16(iter, current_keys[metric], UNAVAILABLE);
      for (int day = 0; day < DAYS; day++) next.history[metric][day] = tuple_u16(iter, history_keys[metric][day], UNAVAILABLE);
    }
    for (int day = 0; day < DAYS; day++) {
      Tuple *date = dict_find(iter, date_keys[day]); next.dates[day] = date ? date->value->uint32 : 0;
    }
    s_cache = next; s_has_cache = true;
    persist_write_data(PERSIST_KEY_CACHE, &s_cache, sizeof(s_cache));
  }
  layer_mark_dirty(s_canvas);
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  if (s_timer) { app_timer_cancel(s_timer); s_timer = NULL; }
  s_loading = false; s_status = STATUS_PHONE;
  snprintf(s_error, sizeof(s_error), "Phone message too large");
  layer_mark_dirty(s_canvas);
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  if (s_timer) { app_timer_cancel(s_timer); s_timer = NULL; }
  s_loading = false; s_status = STATUS_PHONE;
  snprintf(s_error, sizeof(s_error), "Phone delivery failed");
  layer_mark_dirty(s_canvas);
}

static void select_click(ClickRecognizerRef recognizer, void *context) { request_refresh(); }
static void up_click(ClickRecognizerRef recognizer, void *context) { if (s_page > 0) { s_page--; layer_mark_dirty(s_canvas); } }
static void down_click(ClickRecognizerRef recognizer, void *context) { if (s_page + 1 < PAGE_COUNT) { s_page++; layer_mark_dirty(s_canvas); } }
static void click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
  window_single_click_subscribe(BUTTON_ID_UP, up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_canvas = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_canvas, canvas_update);
  layer_add_child(root, s_canvas);
}

static void window_unload(Window *window) { layer_destroy(s_canvas); }

static void init(void) {
  if (persist_exists(PERSIST_KEY_CACHE) && persist_get_size(PERSIST_KEY_CACHE) == sizeof(s_cache) &&
      persist_read_data(PERSIST_KEY_CACHE, &s_cache, sizeof(s_cache)) == sizeof(s_cache) && s_cache.version == CACHE_VERSION) {
    s_has_cache = true; s_status = STATUS_OK;
  }
  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_window_handlers(s_window, (WindowHandlers){.load = window_load, .unload = window_unload});
  window_set_click_config_provider(s_window, click_config);
  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(2048, 64);
  window_stack_push(s_window, true);
  request_refresh();
}

static void deinit(void) {
  if (s_timer) app_timer_cancel(s_timer);
  app_message_deregister_callbacks();
  window_destroy(s_window);
}

int main(void) { init(); app_event_loop(); deinit(); }
