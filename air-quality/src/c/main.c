#include <pebble.h>
#include <limits.h>

#define DAYS 7
#define METRICS 4
#define PAGE_COUNT 5
#define CACHE_VERSION 3
#define PERSIST_KEY_CACHE 4102
#define UNAVAILABLE INT32_MIN
#define RESPONSE_TIMEOUT_MS 30000

enum { COMMAND_FETCH = 1, COMMAND_PHONE_READY = 2, COMMAND_SCALE = 3 };
enum { SCALE_HOUR = 0, SCALE_DAY = 1, SCALE_WEEK = 2, SCALE_COUNT = 3 };
enum {
  STATUS_OK = 0, STATUS_SETUP = 1, STATUS_COMPANION = 2,
  STATUS_BLUETOOTH = 3, STATUS_PERMISSION = 4, STATUS_SENSOR = 5,
  STATUS_TIMEOUT = 6, STATUS_SERVICE = 7, STATUS_PARTIAL = 8,
  STATUS_LOADING = 9
};

typedef struct {
  uint8_t version;
  uint8_t flags;
  uint8_t co2_state;
  uint8_t battery;
  uint8_t scale;
  uint32_t observed_at;
  char location[32];
  int32_t current[METRICS];
  uint32_t dates[DAYS];
  int32_t history[METRICS][DAYS];
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
static uint8_t s_scale;

static const char *METRIC_NAMES[] = {"CO2", "TEMP", "RH", "PRESS"};
static const char *GRAPH_NAMES[] = {"CO2", "TEMP", "HUMIDITY", "PRESS"};
static const char *WEEKDAYS[] = {"S", "M", "T", "W", "T", "F", "S"};
static const char *SCALE_NAMES[] = {"1 HOUR", "1 DAY", "1 WEEK"};

static void draw_text(GContext *ctx, const char *text, GFont font, GRect frame,
                      GTextAlignment align, GColor color) {
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text, font, frame, GTextOverflowModeTrailingEllipsis,
                     align, NULL);
}

static void draw_face(GContext *ctx, uint8_t state) {
  const GPoint center = GPoint(33, 60);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_context_set_stroke_width(ctx, 2);
  graphics_draw_circle(ctx, center, 24);
  if (state == 1) {
    graphics_draw_arc(ctx, GRect(21, 50, 8, 8), GOvalScaleModeFitCircle,
                      DEG_TO_TRIGANGLE(270), DEG_TO_TRIGANGLE(450));
    graphics_draw_arc(ctx, GRect(37, 50, 8, 8), GOvalScaleModeFitCircle,
                      DEG_TO_TRIGANGLE(270), DEG_TO_TRIGANGLE(450));
    graphics_draw_arc(ctx, GRect(23, 56, 20, 20), GOvalScaleModeFitCircle,
                      DEG_TO_TRIGANGLE(105), DEG_TO_TRIGANGLE(255));
  } else {
    graphics_fill_circle(ctx, GPoint(25, 53), 2);
    graphics_fill_circle(ctx, GPoint(41, 53), 2);
    if (state == 3) {
      graphics_draw_line(ctx, GPoint(20, 49), GPoint(28, 46));
      graphics_draw_line(ctx, GPoint(38, 46), GPoint(46, 49));
      graphics_draw_arc(ctx, GRect(22, 61, 22, 22), GOvalScaleModeFitCircle,
                        DEG_TO_TRIGANGLE(290), DEG_TO_TRIGANGLE(430));
    } else {
      graphics_draw_line(ctx, GPoint(23, 66), GPoint(43, 66));
    }
  }
  graphics_context_set_stroke_width(ctx, 1);
}

static void format_metric(char *buffer, size_t size, int metric, int32_t value) {
  if (value == UNAVAILABLE) {
    snprintf(buffer, size, "--");
  } else if (metric == 0) {
    snprintf(buffer, size, "%ld ppm", (long)value);
  } else if (metric == 1) {
    int32_t fahrenheit = (value * 9 + (value >= 0 ? 2 : -2)) / 5 + 320;
    long whole = fahrenheit / 10;
    long fraction = labs(fahrenheit % 10);
    snprintf(buffer, size, "%ld.%ld F", whole, fraction);
  } else if (metric == 2) {
    snprintf(buffer, size, "%ld.%ld %%", (long)(value / 10), (long)labs(value % 10));
  } else {
    snprintf(buffer, size, "%ld.%ld hPa", (long)(value / 10), (long)labs(value % 10));
  }
}

static void format_age(char *buffer, size_t size) {
  if (!s_cache.observed_at) { snprintf(buffer, size, "Updated --"); return; }
  time_t now = time(NULL);
  uint32_t age = now > (time_t)s_cache.observed_at ?
    (uint32_t)(now - s_cache.observed_at) : 0;
  if (age < 60) snprintf(buffer, size, "Updated just now");
  else if (age < 3600) snprintf(buffer, size, "Updated %lum ago", (unsigned long)(age / 60));
  else if (age < 86400) snprintf(buffer, size, "Updated %luh ago", (unsigned long)(age / 3600));
  else if (age < 604800) snprintf(buffer, size, "Updated %lud ago", (unsigned long)(age / 86400));
  else snprintf(buffer, size, "Updated %luw ago", (unsigned long)(age / 604800));
}

static void draw_header(GContext *ctx, GRect bounds, const char *left, const char *right) {
  draw_text(ctx, left, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(8, 0, 118, 28), GTextAlignmentLeft, GColorBlack);
  draw_text(ctx, right, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(122, 0, bounds.size.w - 130, 28), GTextAlignmentRight, GColorBlack);
}

static const char *short_error(void) {
  if (s_status == STATUS_COMPANION) return "OPEN PHONE APP";
  if (s_status == STATUS_BLUETOOTH) return "BLUETOOTH OFF";
  if (s_status == STATUS_PERMISSION) return "ALLOW NEARBY DEVICES";
  if (s_status == STATUS_SENSOR) return "SENSOR NOT FOUND";
  if (s_status == STATUS_TIMEOUT) return "REFRESH TIMED OUT";
  if (s_status == STATUS_SERVICE) return "TRY AGAIN";
  return "";
}

static void draw_footer(GContext *ctx, GRect bounds) {
  char footer[48];
  if (s_loading) snprintf(footer, sizeof(footer), "SYNCING...");
  else if (s_status >= STATUS_COMPANION && s_status <= STATUS_SERVICE)
    snprintf(footer, sizeof(footer), "%s  SELECT RETRY", short_error());
  else format_age(footer, sizeof(footer));
  draw_text(ctx, footer, fonts_get_system_font(FONT_KEY_GOTHIC_18),
            GRect(5, bounds.size.h - 22, bounds.size.w - 10, 22),
            GTextAlignmentCenter, GColorBlack);
}

static void draw_state(GContext *ctx, GRect bounds) {
  const char *title = "SYNCING...";
  const char *body = "";
  const char *footer = "";
  if (s_status == STATUS_SETUP) {
    title = "SETUP REQUIRED"; body = "Open AirQuality on phone\nand choose your sensor";
  } else if (s_status == STATUS_COMPANION) {
    title = "OPEN PHONE APP"; body = "AirQuality companion\nis not ready"; footer = "PRESS SELECT TO RETRY";
  } else if (s_status == STATUS_BLUETOOTH) {
    title = "BLUETOOTH OFF"; body = "Turn on Bluetooth"; footer = "PRESS SELECT TO RETRY";
  } else if (s_status == STATUS_PERMISSION) {
    title = "PERMISSION NEEDED"; body = "Allow nearby devices\nin AirQuality"; footer = "PRESS SELECT TO RETRY";
  } else if (s_status == STATUS_SENSOR) {
    title = "SENSOR NOT FOUND"; body = "Keep Aranet4 nearby"; footer = "PRESS SELECT TO RETRY";
  } else if (s_status == STATUS_TIMEOUT) {
    title = "REFRESH TIMED OUT"; body = "Keep phone and sensor nearby"; footer = "PRESS SELECT TO RETRY";
  } else if (s_status == STATUS_SERVICE) {
    title = "TRY AGAIN"; body = "Open AirQuality on phone"; footer = "PRESS SELECT TO RETRY";
  }
  draw_header(ctx, bounds, "AIRQUALITY", "");
  bool title_only = body[0] == '\0' && footer[0] == '\0';
  draw_text(ctx, title, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD),
            GRect(8, title_only ? 92 : 68, bounds.size.w - 16, 36),
            GTextAlignmentCenter, GColorBlack);
  draw_text(ctx, body, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
            GRect(14, 108, bounds.size.w - 28, 58), GTextAlignmentCenter, GColorBlack);
  draw_text(ctx, footer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
            GRect(8, 184, bounds.size.w - 16, 28), GTextAlignmentCenter, GColorBlack);
}

static void draw_current(GContext *ctx, GRect bounds) {
  char value[28];
  char primary[16];
  draw_header(ctx, bounds, s_cache.location, "CO2");
  if (s_cache.current[0] == UNAVAILABLE) snprintf(primary, sizeof(primary), "--");
  else snprintf(primary, sizeof(primary), "%ld", (long)s_cache.current[0]);
  draw_face(ctx, s_cache.co2_state);
  draw_text(ctx, primary, fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD),
            GRect(82, 35, bounds.size.w - 90, 54), GTextAlignmentRight, GColorBlack);
  draw_text(ctx, "ppm", fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
            GRect(82, 77, bounds.size.w - 90, 22), GTextAlignmentRight, GColorBlack);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_draw_line(ctx, GPoint(8, 99), GPoint(bounds.size.w - 8, 99));
  for (int metric = 1; metric < METRICS; metric++) {
    int y = 99 + (metric - 1) * 26;
    draw_text(ctx, METRIC_NAMES[metric], fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
              GRect(8, y, 76, 28), GTextAlignmentLeft, GColorBlack);
    format_metric(value, sizeof(value), metric, s_cache.current[metric]);
    draw_text(ctx, value, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
              GRect(78, y, bounds.size.w - 86, 28), GTextAlignmentRight, GColorBlack);
  }
  snprintf(value, sizeof(value), s_cache.battery <= 100 ? "%u %%" : "--", s_cache.battery);
  draw_text(ctx, "BATT", fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(8, 177, 76, 28), GTextAlignmentLeft, GColorBlack);
  draw_text(ctx, value, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(78, 177, bounds.size.w - 86, 28), GTextAlignmentRight, GColorBlack);
  draw_footer(ctx, bounds);
}

static void graph_range(int metric, int32_t *minimum, int32_t *maximum) {
  int32_t low = INT32_MAX, high = INT32_MIN;
  for (int day = 0; day < DAYS; day++) {
    int32_t value = s_cache.history[metric][day];
    if (value == UNAVAILABLE) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (low == INT32_MAX) { *minimum = 0; *maximum = 1; return; }
  if (metric == 0 && s_scale == SCALE_WEEK) {
    *minimum = 0; *maximum = ((high + 499) / 500) * 500;
  } else if (metric == 2 && s_scale == SCALE_WEEK) {
    *minimum = 0; *maximum = ((high + 99) / 100) * 100;
  } else {
    int32_t step = metric == 0 ? 100 : 50;
    *minimum = (low / step) * step;
    *maximum = ((high + step - 1) / step) * step;
  }
  if (*maximum <= *minimum) *maximum = *minimum + (metric == 0 ? 500 : 50);
}

static void format_point_label(char *buffer, size_t size, uint32_t timestamp) {
  if (!timestamp) { snprintf(buffer, size, "?"); return; }
  time_t value = (time_t)timestamp;
  struct tm *local = localtime(&value);
  if (!local) { snprintf(buffer, size, "?"); return; }
  if (s_scale == SCALE_WEEK) {
    snprintf(buffer, size, "%s", WEEKDAYS[local->tm_wday]);
  } else if (s_scale == SCALE_DAY) {
    int hour = local->tm_hour % 12;
    snprintf(buffer, size, "%d%c", hour ? hour : 12,
             local->tm_hour < 12 ? 'A' : 'P');
  } else {
    snprintf(buffer, size, "%02d", local->tm_min);
  }
}

static void draw_chart(GContext *ctx, GRect bounds) {
  int metric = s_page - 1;
  char range_text[48];
  char stat[48];
  draw_header(ctx, bounds, s_cache.location, GRAPH_NAMES[metric]);
  int32_t minimum, maximum;
  graph_range(metric, &minimum, &maximum);
  if (metric == 0) {
    if (minimum == 0) snprintf(range_text, sizeof(range_text), "%ld ppm", (long)maximum);
    else snprintf(range_text, sizeof(range_text), "%ld-%ld", (long)minimum, (long)maximum);
  } else if (metric == 1) {
    int32_t low_f = (minimum * 9) / 5 + 320;
    int32_t high_f = (maximum * 9) / 5 + 320;
    snprintf(range_text, sizeof(range_text), "%ld-%ld F", (long)(low_f / 10), (long)(high_f / 10));
  } else if (metric == 2) {
    snprintf(range_text, sizeof(range_text), "%ld-%ld%%",
             (long)(minimum / 10), (long)(maximum / 10));
  } else {
    snprintf(range_text, sizeof(range_text), "%ld-%ld",
             (long)(minimum / 10), (long)(maximum / 10));
  }
  draw_text(ctx, SCALE_NAMES[s_scale], fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
            GRect(8, 32, 70, 24), GTextAlignmentLeft, GColorBlack);
  draw_text(ctx, range_text, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(70, 30, bounds.size.w - 78, 28), GTextAlignmentRight, GColorBlack);
  const int left = 9, right = bounds.size.w - 9, top = 58, bottom = 151;
  int slot = (right - left) / DAYS;
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_draw_line(ctx, GPoint(left, top), GPoint(right, top));
  graphics_draw_line(ctx, GPoint(left, bottom), GPoint(right, bottom));
  int64_t total = 0; int count = 0;
  GPoint previous = GPointZero;
  bool has_previous = false;
  for (int column = 0; column < DAYS; column++) {
    int day = DAYS - 1 - column;
    int32_t value = s_cache.history[metric][day];
    int center = left + column * slot + slot / 2;
    if (value == UNAVAILABLE) {
      graphics_draw_line(ctx, GPoint(center - 4, bottom - 5), GPoint(center + 4, bottom - 5));
      has_previous = false;
    } else {
      int height = (int)(((int64_t)(value - minimum) * (bottom - top)) / (maximum - minimum));
      if (height < 0) height = 0;
      if (height > bottom - top) height = bottom - top;
      int y = bottom - height;
      if (s_scale == SCALE_WEEK) {
        if (height) graphics_fill_rect(ctx, GRect(center - 7, y, 14, height), 0, GCornerNone);
        else graphics_draw_line(ctx, GPoint(center - 7, bottom - 1), GPoint(center + 7, bottom - 1));
      } else {
        GPoint point = GPoint(center, y);
        if (has_previous) graphics_draw_line(ctx, previous, point);
        graphics_fill_circle(ctx, point, 3);
        previous = point;
        has_previous = true;
      }
      total += value; count++;
    }
    char label[6];
    format_point_label(label, sizeof(label), s_cache.dates[day]);
    draw_text(ctx, label, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
              GRect(center - slot / 2, bottom + 1, slot, 22),
              GTextAlignmentCenter, GColorBlack);
  }
  if (count) {
    char avg[24]; format_metric(avg, sizeof(avg), metric, (int32_t)(total / count));
    snprintf(stat, sizeof(stat), "AVG %s", avg);
  } else snprintf(stat, sizeof(stat), "NO HISTORY");
  draw_text(ctx, stat, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(8, 174, bounds.size.w - 16, 28), GTextAlignmentCenter, GColorBlack);
  draw_footer(ctx, bounds);
}

static void canvas_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  if (s_loading) draw_state(ctx, bounds);
  else if (s_status >= STATUS_SETUP && s_status <= STATUS_SERVICE) draw_state(ctx, bounds);
  else if (!s_has_cache) draw_state(ctx, bounds);
  else if (s_page == 0) draw_current(ctx, bounds);
  else draw_chart(ctx, bounds);
}

static void refresh_timeout(void *context) {
  s_timer = NULL; s_loading = false; s_status = STATUS_TIMEOUT;
  layer_mark_dirty(s_canvas);
}

static void request_data(uint8_t command) {
  if (s_loading) return;
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    s_status = STATUS_COMPANION; layer_mark_dirty(s_canvas); return;
  }
  s_request_id++;
  dict_write_uint8(iter, MESSAGE_KEY_PROTOCOL, 1);
  dict_write_uint8(iter, MESSAGE_KEY_COMMAND, command);
  dict_write_uint16(iter, MESSAGE_KEY_REQUEST_ID, s_request_id);
  dict_write_uint8(iter, MESSAGE_KEY_SCALE, s_scale);
  if (app_message_outbox_send() != APP_MSG_OK) {
    s_status = STATUS_COMPANION; layer_mark_dirty(s_canvas); return;
  }
  s_loading = true; s_status = STATUS_LOADING;
  if (s_timer) app_timer_cancel(s_timer);
  s_timer = app_timer_register(RESPONSE_TIMEOUT_MS, refresh_timeout, NULL);
  layer_mark_dirty(s_canvas);
}

static void request_refresh(void) { request_data(COMMAND_FETCH); }

static int32_t tuple_i32(DictionaryIterator *iter, uint32_t key, int32_t fallback) {
  Tuple *tuple = dict_find(iter, key);
  return tuple ? tuple->value->int32 : fallback;
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
  if (!request || request->value->uint16 != s_request_id) return;
  if (s_timer) { app_timer_cancel(s_timer); s_timer = NULL; }
  s_loading = false;
  s_status = status->value->uint8;
  if (s_status == STATUS_OK || s_status == STATUS_PARTIAL) {
    Tuple *observed = dict_find(iter, MESSAGE_KEY_OBSERVED_AT);
    Tuple *location = dict_find(iter, MESSAGE_KEY_LOCATION);
    if (!observed || !location || !dict_find(iter, MESSAGE_KEY_CO2)) {
      s_status = STATUS_SERVICE; layer_mark_dirty(s_canvas); return;
    }
    if (s_has_cache && observed->value->uint32 < s_cache.observed_at) {
      s_status = STATUS_OK; layer_mark_dirty(s_canvas); return;
    }
    AirCache next;
    memset(&next, 0, sizeof(next)); next.version = CACHE_VERSION;
    next.flags = (uint8_t)tuple_i32(iter, MESSAGE_KEY_FLAGS, 0);
    next.co2_state = (uint8_t)tuple_i32(iter, MESSAGE_KEY_CO2_STATE, 0);
    int32_t battery = tuple_i32(iter, MESSAGE_KEY_BATTERY, 255);
    next.battery = battery >= 0 && battery <= 100 ? (uint8_t)battery : 255;
    next.scale = (uint8_t)tuple_i32(iter, MESSAGE_KEY_SCALE, s_scale);
    if (next.scale >= SCALE_COUNT) next.scale = SCALE_HOUR;
    s_scale = next.scale;
    next.observed_at = observed->value->uint32;
    snprintf(next.location, sizeof(next.location), "%s", location->value->cstring);
    const uint32_t current_keys[] = {MESSAGE_KEY_CO2, MESSAGE_KEY_TEMP_X10,
      MESSAGE_KEY_HUMIDITY_X10, MESSAGE_KEY_PRESSURE_X10};
    const uint32_t date_keys[] = {MESSAGE_KEY_DAY0_DATE, MESSAGE_KEY_DAY1_DATE,
      MESSAGE_KEY_DAY2_DATE, MESSAGE_KEY_DAY3_DATE, MESSAGE_KEY_DAY4_DATE,
      MESSAGE_KEY_DAY5_DATE, MESSAGE_KEY_DAY6_DATE};
    const uint32_t history_keys[METRICS][DAYS] = {
      {MESSAGE_KEY_DAY0_CO2,MESSAGE_KEY_DAY1_CO2,MESSAGE_KEY_DAY2_CO2,MESSAGE_KEY_DAY3_CO2,MESSAGE_KEY_DAY4_CO2,MESSAGE_KEY_DAY5_CO2,MESSAGE_KEY_DAY6_CO2},
      {MESSAGE_KEY_DAY0_TEMP_X10,MESSAGE_KEY_DAY1_TEMP_X10,MESSAGE_KEY_DAY2_TEMP_X10,MESSAGE_KEY_DAY3_TEMP_X10,MESSAGE_KEY_DAY4_TEMP_X10,MESSAGE_KEY_DAY5_TEMP_X10,MESSAGE_KEY_DAY6_TEMP_X10},
      {MESSAGE_KEY_DAY0_HUMIDITY_X10,MESSAGE_KEY_DAY1_HUMIDITY_X10,MESSAGE_KEY_DAY2_HUMIDITY_X10,MESSAGE_KEY_DAY3_HUMIDITY_X10,MESSAGE_KEY_DAY4_HUMIDITY_X10,MESSAGE_KEY_DAY5_HUMIDITY_X10,MESSAGE_KEY_DAY6_HUMIDITY_X10},
      {MESSAGE_KEY_DAY0_PRESSURE_X10,MESSAGE_KEY_DAY1_PRESSURE_X10,MESSAGE_KEY_DAY2_PRESSURE_X10,MESSAGE_KEY_DAY3_PRESSURE_X10,MESSAGE_KEY_DAY4_PRESSURE_X10,MESSAGE_KEY_DAY5_PRESSURE_X10,MESSAGE_KEY_DAY6_PRESSURE_X10}
    };
    for (int metric = 0; metric < METRICS; metric++) {
      next.current[metric] = tuple_i32(iter, current_keys[metric], UNAVAILABLE);
      for (int day = 0; day < DAYS; day++)
        next.history[metric][day] = tuple_i32(iter, history_keys[metric][day], UNAVAILABLE);
    }
    for (int day = 0; day < DAYS; day++) {
      Tuple *date = dict_find(iter, date_keys[day]);
      next.dates[day] = date ? date->value->uint32 : 0;
    }
    s_cache = next; s_has_cache = true;
    persist_write_data(PERSIST_KEY_CACHE, &s_cache, sizeof(s_cache));
  }
  layer_mark_dirty(s_canvas);
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  if (s_timer) { app_timer_cancel(s_timer); s_timer = NULL; }
  s_loading = false; s_status = STATUS_COMPANION; layer_mark_dirty(s_canvas);
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  if (s_timer) { app_timer_cancel(s_timer); s_timer = NULL; }
  s_loading = false; s_status = STATUS_COMPANION; layer_mark_dirty(s_canvas);
}

static void select_click(ClickRecognizerRef recognizer, void *context) {
  if (s_loading) return;
  if (s_status >= STATUS_SETUP && s_status <= STATUS_SERVICE) {
    request_refresh();
  } else if (s_page == 0) {
    request_refresh();
  } else {
    s_scale = (s_scale + 1) % SCALE_COUNT;
    request_data(COMMAND_SCALE);
  }
}
static void up_click(ClickRecognizerRef recognizer, void *context) {
  if (s_page > 0) { s_page--; layer_mark_dirty(s_canvas); }
}
static void down_click(ClickRecognizerRef recognizer, void *context) {
  if (s_page + 1 < PAGE_COUNT) { s_page++; layer_mark_dirty(s_canvas); }
}
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
      persist_read_data(PERSIST_KEY_CACHE, &s_cache, sizeof(s_cache)) == sizeof(s_cache) &&
      s_cache.version == CACHE_VERSION) {
    s_has_cache = true; s_status = STATUS_OK;
    s_scale = s_cache.scale < SCALE_COUNT ? s_cache.scale : SCALE_HOUR;
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
