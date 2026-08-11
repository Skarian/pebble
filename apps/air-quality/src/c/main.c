#include <pebble.h>
#include <limits.h>
#include <app_message_client.h>
#include <stdlib.h>

#define METRICS 4
#define GRAPH_COLUMNS 56
#define AXIS_LEVELS 5
#define PAGE_COUNT 5
#define CACHE_VERSION 6
#define PERSIST_KEY_CACHE 4102
#define PERSIST_ERRORS_KEY 4160
#define UNAVAILABLE INT32_MIN
#define PROTOCOL_VERSION 2
#define FLAG_STALE 0x01
#define FLAG_CACHED 0x02

enum { COMMAND_FETCH = 1, COMMAND_PHONE_READY = 2, COMMAND_SCALE = 3 };
enum { SCALE_HOUR = 0, SCALE_DAY = 1, SCALE_WEEK = 2, SCALE_COUNT = 3 };
#define DEFAULT_SCALE SCALE_DAY
enum {
  STATUS_OK = 0, STATUS_SETUP = 1, STATUS_COMPANION = 2,
  STATUS_BLUETOOTH = 3, STATUS_PERMISSION = 4, STATUS_SENSOR = 5,
  STATUS_TIMEOUT = 6, STATUS_SERVICE = 7, STATUS_PARTIAL = 8,
  STATUS_LOADING = 9, STATUS_RESPONSE_TIMEOUT = 10
};

typedef struct {
  uint8_t version;
  uint8_t flags;
  uint8_t co2_state;
  uint8_t battery;
  uint8_t scale;
  uint8_t point_count;
  uint32_t observed_at;
  uint32_t window_start;
  char location[32];
  int32_t current[METRICS];
  int32_t average[METRICS];
  int16_t series[METRICS][GRAPH_COLUMNS];
} AirCache;

static Window *s_window;
static Layer *s_canvas;
static AppMessageClient *s_phone;
static ErrorReporter *s_errors;
static AirCache s_cache;
static bool s_has_cache;
static bool s_loading;
static bool s_scale_loading;
static uint8_t s_status = STATUS_LOADING;
static uint8_t s_page;
static uint8_t s_scale = DEFAULT_SCALE;
static uint8_t s_pending_scale = DEFAULT_SCALE;
#define report_error(function, code, symbol, while_doing) \
  ERROR_REPORT(s_errors, ((ErrorValue){ \
    (function), (code), (symbol), NULL}), (while_doing))

static const char *METRIC_NAMES[] = {"CO2", "TEMP", "RH", "PRESSURE"};
static const char *GRAPH_NAMES[] = {"CO2", "TEMP", "HUMIDITY", "PRESSURE"};
static const char *GRAPH_UNITS[] = {"ppm", "F", "%", "hPa"};
static const char *SCALE_NAMES[] = {"1 HOUR", "1 DAY", "1 WEEK"};
static const char *AXIS_LEFT[] = {"-1 HR", "-1 DAY", "-1 WEEK"};
static const char *AXIS_MIDDLE[] = {"-30 MIN", "-12 HR", "-3 DAYS"};

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
  bool wide_right = strcmp(right, "PRESSURE") == 0;
  int right_x = wide_right ? 100 : 122;
  draw_text(ctx, left, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(8, 0, wide_right ? 88 : 118, 28), GTextAlignmentLeft, GColorBlack);
  draw_text(ctx, right, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(right_x, 0, bounds.size.w - right_x - 8, 28), GTextAlignmentRight, GColorBlack);
}

static void draw_footer(GContext *ctx, GRect bounds) {
  char footer[48];
  format_age(footer, sizeof(footer));
  draw_text(ctx, footer, fonts_get_system_font(FONT_KEY_GOTHIC_18),
            GRect(5, bounds.size.h - 22, bounds.size.w - 10, 22),
            GTextAlignmentCenter, GColorBlack);
}

static bool is_error_status(uint8_t status) {
  return (status >= STATUS_SETUP && status <= STATUS_SERVICE) ||
      status == STATUS_RESPONSE_TIMEOUT;
}

static void draw_state(GContext *ctx, GRect bounds) {
  const char *title = "SYNCING...";
  const char *body = "";
  const char *footer = "";
  if (s_status == STATUS_SETUP) {
    title = "SETUP REQUIRED"; body = "Choose your sensor\nin AirQuality on phone";
    footer = "SELECT WHEN READY";
  } else if (s_status == STATUS_COMPANION) {
    title = "PHONE OFFLINE"; body = "Open AirQuality on phone"; footer = "PRESS SELECT TO RETRY";
  } else if (s_status == STATUS_BLUETOOTH) {
    title = "BLUETOOTH OFF"; body = "Turn on Bluetooth"; footer = "PRESS SELECT TO RETRY";
  } else if (s_status == STATUS_PERMISSION) {
    title = "PERMISSION NEEDED"; body = "Allow Nearby Devices\nin AirQuality"; footer = "PRESS SELECT TO RETRY";
  } else if (s_status == STATUS_SENSOR) {
    title = "SENSOR NOT FOUND"; body = "Keep Aranet4 nearby"; footer = "PRESS SELECT TO RETRY";
  } else if (s_status == STATUS_TIMEOUT) {
    title = "SENSOR TIMED OUT"; body = "Keep Aranet4 nearby"; footer = "PRESS SELECT TO RETRY";
  } else if (s_status == STATUS_SERVICE) {
    title = "SERVICE ERROR"; body = "Open AirQuality on phone"; footer = "PRESS SELECT TO RETRY";
  } else if (s_status == STATUS_RESPONSE_TIMEOUT) {
    title = "SYNC TIMED OUT"; body = "No reply from phone"; footer = "PRESS SELECT TO RETRY";
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
    int value_x = metric == 3 ? 104 : 78;
    draw_text(ctx, METRIC_NAMES[metric], fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
              GRect(8, y, metric == 3 ? 96 : 76, 28), GTextAlignmentLeft, GColorBlack);
    format_metric(value, sizeof(value), metric, s_cache.current[metric]);
    draw_text(ctx, value, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
              GRect(value_x, y, bounds.size.w - value_x - 8, 28), GTextAlignmentRight, GColorBlack);
  }
  snprintf(value, sizeof(value), s_cache.battery <= 100 ? "%u %%" : "--", s_cache.battery);
  draw_text(ctx, "BATT", fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(8, 177, 76, 28), GTextAlignmentLeft, GColorBlack);
  draw_text(ctx, value, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(78, 177, bounds.size.w - 86, 28), GTextAlignmentRight, GColorBlack);
  draw_footer(ctx, bounds);
}

static int32_t graph_display_value(int metric, int32_t value) {
  return metric == 1 ? (value * 9 + (value >= 0 ? 2 : -2)) / 5 + 320 : value;
}

static int32_t floor_to_step(int32_t value, int32_t step) {
  return value >= 0 ? (value / step) * step
                    : -(((-value + step - 1) / step) * step);
}

static bool graph_range(int metric, int32_t *minimum, int32_t *maximum) {
  int32_t low = INT32_MAX, high = INT32_MIN;
  for (int column = 0; column < GRAPH_COLUMNS; column++) {
    int16_t value = s_cache.series[metric][column];
    if (value == INT16_MIN) continue;
    value = graph_display_value(metric, value);
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (low == INT32_MAX) { *minimum = 0; *maximum = 1; return false; }
  const int32_t quantums[] = {50, 10, 10, 10};
  int32_t quantum = quantums[metric];
  if (low == high) {
    *minimum = floor_to_step(low, quantum) - 2 * quantum;
    *maximum = *minimum + (AXIS_LEVELS - 1) * quantum;
    return true;
  }
  int32_t target = (high - low + AXIS_LEVELS - 2) / (AXIS_LEVELS - 1);
  int32_t step = ((target + quantum - 1) / quantum) * quantum;
  do {
    *minimum = floor_to_step(low, step);
    *maximum = *minimum + (AXIS_LEVELS - 1) * step;
    if (*maximum >= high) break;
    step += quantum;
  } while (true);
  return true;
}

static int graph_y(int32_t value, int32_t minimum, int32_t maximum,
                   int top, int bottom) {
  int height = (int)(((int64_t)(value - minimum) * (bottom - top)) /
                     (maximum - minimum));
  if (height < 0) height = 0;
  if (height > bottom - top) height = bottom - top;
  return bottom - height;
}

static void format_axis_value(char *buffer, size_t size, int metric, int32_t value) {
  if (metric == 0) snprintf(buffer, size, "%ld", (long)value);
  else snprintf(buffer, size, "%ld", (long)(value / 10));
}

static void draw_chart_guide(GContext *ctx, int left, int right, int y,
                             bool boundary) {
  graphics_context_set_stroke_color(ctx, boundary ? GColorBlack : GColorLightGray);
  if (boundary) {
    graphics_draw_line(ctx, GPoint(left, y), GPoint(right, y));
    return;
  }
  for (int x = left; x <= right; x += 6) {
    int end = x + 2 < right ? x + 2 : right;
    graphics_draw_line(ctx, GPoint(x, y), GPoint(end, y));
  }
}

static void draw_chart(GContext *ctx, GRect bounds) {
  int metric = s_page - 1;
  char stat[48];
  draw_header(ctx, bounds, s_cache.location, GRAPH_NAMES[metric]);
  int32_t minimum, maximum;
  bool has_history = graph_range(metric, &minimum, &maximum);
  draw_text(ctx, SCALE_NAMES[s_scale], fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
            GRect(8, 32, 70, 24), GTextAlignmentLeft, GColorBlack);
  draw_text(ctx, GRAPH_UNITS[metric], fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(70, 30, bounds.size.w - 78, 28), GTextAlignmentRight, GColorBlack);
  const int left = 36, right = bounds.size.w - 2, top = 66, bottom = 174;
  graphics_context_set_fill_color(ctx, GColorBlack);
  if (has_history) {
    GFont axis_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
    char axis_text[16];
    for (int level = 0; level < AXIS_LEVELS; level++) {
      int y = top + (level * (bottom - top)) / (AXIS_LEVELS - 1);
      int32_t value = maximum - (level * (maximum - minimum)) / (AXIS_LEVELS - 1);
      draw_chart_guide(ctx, left, right, y, level == 0 || level == AXIS_LEVELS - 1);
      format_axis_value(axis_text, sizeof(axis_text), metric, value);
      draw_text(ctx, axis_text, axis_font, GRect(0, y - 10, 36, 22),
                GTextAlignmentRight, GColorBlack);
    }
  } else {
    draw_chart_guide(ctx, left, right, top, true);
    draw_chart_guide(ctx, left, right, bottom, true);
  }
  graphics_context_set_stroke_color(ctx, GColorBlack);
  GPoint previous = GPointZero;
  bool has_previous = false;
  for (int column = 0; column < GRAPH_COLUMNS; column++) {
    int16_t value = s_cache.series[metric][column];
    int x = left + (column * (right - left)) / (GRAPH_COLUMNS - 1);
    if (value != INT16_MIN) {
      GPoint point = GPoint(x, graph_y(graph_display_value(metric, value),
                                       minimum, maximum, top, bottom));
      bool connects_previous = has_previous;
      int next_column = column + 1;
      while (next_column < GRAPH_COLUMNS && s_cache.series[metric][next_column] == INT16_MIN)
        next_column++;
      bool connects_next = next_column < GRAPH_COLUMNS;
      if (connects_previous) {
        graphics_draw_line(ctx, previous, point);
      } else if (!connects_next) {
        int tick_left = point.x > left + 2 ? point.x - 2 : left;
        int tick_right = point.x < right - 2 ? point.x + 2 : right;
        graphics_draw_line(ctx, GPoint(tick_left, point.y), GPoint(tick_right, point.y));
      }
      previous = point;
      has_previous = true;
    }
  }
  int middle_x = s_scale == SCALE_WEEK ? left + (4 * (right - left)) / 7
                                       : (left + right) / 2;
  graphics_draw_line(ctx, GPoint(left, bottom), GPoint(left, bottom - 4));
  graphics_draw_line(ctx, GPoint(middle_x, bottom), GPoint(middle_x, bottom - 4));
  graphics_draw_line(ctx, GPoint(right, bottom), GPoint(right, bottom - 4));
  GFont time_axis_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  draw_text(ctx, AXIS_LEFT[s_scale], time_axis_font,
            GRect(left, bottom + 1, 68, 22), GTextAlignmentLeft, GColorBlack);
  draw_text(ctx, AXIS_MIDDLE[s_scale], time_axis_font,
            GRect(middle_x - 34, bottom + 1, 68, 22),
            GTextAlignmentCenter, GColorBlack);
  draw_text(ctx, "LAST", time_axis_font,
            GRect(right - 45, bottom + 1, 45, 22), GTextAlignmentRight, GColorBlack);
  if (s_cache.average[metric] != UNAVAILABLE) {
    char avg[24]; format_metric(avg, sizeof(avg), metric, s_cache.average[metric]);
    snprintf(stat, sizeof(stat), "AVG %s", avg);
  } else snprintf(stat, sizeof(stat), "NO HISTORY");
  draw_text(ctx, stat, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
            GRect(8, 198, bounds.size.w - 16, 28), GTextAlignmentCenter, GColorBlack);
}

static void canvas_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  if (s_loading || is_error_status(s_status)) draw_state(ctx, bounds);
  else if (!s_has_cache) draw_state(ctx, bounds);
  else if (s_page == 0) draw_current(ctx, bounds);
  else draw_chart(ctx, bounds);
}

static DictionaryResult write_request(
    DictionaryIterator *iter,
    const AppMessageClientStatus *request,
    void *context) {
  (void)context;
  return dict_write_uint8(iter, MESSAGE_KEY_SCALE,
      request->operation == COMMAND_SCALE ? s_pending_scale : s_scale);
}

static void phone_request_failed(
    const AppMessageFailureInfo *failure,
    void *context) {
  (void)context;
  s_loading = false;
  s_scale_loading = false;
  s_status = failure->failure == APP_MESSAGE_FAILURE_RESPONSE_TIMEOUT
      ? STATUS_RESPONSE_TIMEOUT : STATUS_COMPANION;
  layer_mark_dirty(s_canvas);
}

static void request_data(uint8_t command) {
  if (app_message_client_is_active(s_phone)) return;
  if (command == COMMAND_SCALE) s_scale_loading = true;
  else { s_loading = true; s_status = STATUS_LOADING; }
  AppMessageStartResult result = app_message_client_start(
      s_phone, command, APP_MESSAGE_OPERATION_READ,
      NULL, APP_MESSAGE_SEND_PRIMARY);
  if (result != APP_MESSAGE_START_STARTED &&
      result != APP_MESSAGE_START_COALESCED) {
    report_error("app_message_client_start", result, "APP_MESSAGE_START_FAILED", command == COMMAND_SCALE ? "changing Air Quality chart scale" : "refreshing Air Quality data");
    s_loading = false;
    s_scale_loading = false;
    s_status = STATUS_COMPANION;
  }
  layer_mark_dirty(s_canvas);
}

static void request_refresh(void) { request_data(COMMAND_FETCH); }

static int32_t tuple_i32(
    DictionaryIterator *iter, uint32_t key, int32_t fallback, bool *valid) {
  Tuple *tuple = dict_find(iter, key);
  if (!tuple) return fallback;
  int32_t value;
  if (app_message_tuple_int(tuple, &value)) return value;
  if (valid) *valid = false;
  return fallback;
}

static uint32_t tuple_u32(
    DictionaryIterator *iter, uint32_t key, uint32_t fallback, bool *valid) {
  Tuple *tuple = dict_find(iter, key);
  if (!tuple) return fallback;
  uint32_t value;
  if (app_message_tuple_uint(tuple, &value)) return value;
  if (valid) *valid = false;
  return fallback;
}

static AppMessageResponseAction receive_response(
    DictionaryIterator *iter,
    const AppMessageClientStatus *request,
    void *context) {
  (void)context;
  Tuple *protocol = dict_find(iter, MESSAGE_KEY_PROTOCOL);
  uint32_t protocol_value;
  bool protocol_parsed = app_message_tuple_uint(protocol, &protocol_value);
  if (!protocol_parsed || protocol_value != PROTOCOL_VERSION) {
    report_error("receive_response", protocol_parsed ? (int32_t)protocol_value : -1,
        "PROTOCOL_VERSION_MISMATCH", "parsing Air Quality response");
    return APP_MESSAGE_RESPONSE_IGNORE;
  }
  Tuple *status = dict_find(iter, MESSAGE_KEY_STATUS);
  uint32_t status_value;
  bool status_parsed = app_message_tuple_uint(status, &status_value);
  if (!status_parsed || status_value > STATUS_PARTIAL) {
    report_error("receive_response", status_parsed ? (int32_t)status_value : -1,
        status ? "STATUS_INVALID" : "STATUS_MISSING",
        "parsing Air Quality response");
    return APP_MESSAGE_RESPONSE_IGNORE;
  }
  bool scale_response = request->operation == COMMAND_SCALE;
  bool cached_progress = false;
  s_status = (uint8_t)status_value;
  if (scale_response && s_status != STATUS_OK && s_status != STATUS_PARTIAL) {
    s_scale_loading = false;
    s_loading = false;
    s_pending_scale = s_scale;
    layer_mark_dirty(s_canvas);
    return APP_MESSAGE_RESPONSE_DONE;
  }
  if (s_status == STATUS_OK || s_status == STATUS_PARTIAL) {
    Tuple *observed = dict_find(iter, MESSAGE_KEY_OBSERVED_AT);
    Tuple *location = dict_find(iter, MESSAGE_KEY_LOCATION);
    uint32_t observed_at;
    const char *location_text;
    if (!app_message_tuple_uint(observed, &observed_at) ||
        !app_message_tuple_cstring(location, &location_text) ||
        location->length > sizeof(s_cache.location) ||
        !dict_find(iter, MESSAGE_KEY_CO2)) {
      report_error("receive_response", s_status, "SNAPSHOT_FIELDS_MISSING", "parsing Air Quality snapshot");
      s_scale_loading = false;
      s_loading = false;
      if (scale_response) s_pending_scale = s_scale;
      s_status = STATUS_SERVICE;
      layer_mark_dirty(s_canvas);
      return APP_MESSAGE_RESPONSE_DONE;
    }
    bool fields_valid = true;
    int32_t raw_flags = tuple_i32(
        iter, MESSAGE_KEY_FLAGS, 0, &fields_valid);
    if (raw_flags < 0 || raw_flags > UINT8_MAX) fields_valid = false;
    uint8_t response_flags = fields_valid ? (uint8_t)raw_flags : 0;
    cached_progress = !scale_response && (response_flags & FLAG_CACHED);
    if (s_has_cache && observed_at < s_cache.observed_at) {
      if (cached_progress) {
        s_loading = true;
      } else {
        s_loading = false;
        s_scale_loading = false;
      }
      s_status = STATUS_OK;
      layer_mark_dirty(s_canvas);
      return cached_progress ? APP_MESSAGE_RESPONSE_MORE : APP_MESSAGE_RESPONSE_DONE;
    }
    AirCache next;
    memset(&next, 0, sizeof(next)); next.version = CACHE_VERSION;
    next.flags = response_flags;
    int32_t co2_state = tuple_i32(
        iter, MESSAGE_KEY_CO2_STATE, 0, &fields_valid);
    if (co2_state < 0 || co2_state > UINT8_MAX) fields_valid = false;
    next.co2_state = fields_valid ? (uint8_t)co2_state : 0;
    int32_t battery = tuple_i32(
        iter, MESSAGE_KEY_BATTERY, 255, &fields_valid);
    next.battery = battery >= 0 && battery <= 100 ? (uint8_t)battery : 255;
    int32_t raw_scale = tuple_i32(
        iter, MESSAGE_KEY_SCALE, s_scale, &fields_valid);
    if (raw_scale < 0 || raw_scale >= SCALE_COUNT) fields_valid = false;
    next.scale = fields_valid ? (uint8_t)raw_scale : DEFAULT_SCALE;
    next.observed_at = observed_at;
    next.window_start = tuple_u32(
        iter, MESSAGE_KEY_WINDOW_START, 0, &fields_valid);
    int32_t point_count = tuple_i32(
        iter, MESSAGE_KEY_POINT_COUNT, 0, &fields_valid);
    if (point_count < 0 || point_count > UINT8_MAX) fields_valid = false;
    next.point_count = fields_valid ? (uint8_t)point_count : 0;
    snprintf(next.location, sizeof(next.location), "%s", location_text);
    const uint32_t current_keys[] = {MESSAGE_KEY_CO2, MESSAGE_KEY_TEMP_X10,
      MESSAGE_KEY_HUMIDITY_X10, MESSAGE_KEY_PRESSURE_X10};
    const uint32_t series_keys[] = {MESSAGE_KEY_SERIES_CO2,
      MESSAGE_KEY_SERIES_TEMP_X10, MESSAGE_KEY_SERIES_HUMIDITY_X10,
      MESSAGE_KEY_SERIES_PRESSURE_X10};
    const uint32_t average_keys[] = {MESSAGE_KEY_AVG_CO2,
      MESSAGE_KEY_AVG_TEMP_X10, MESSAGE_KEY_AVG_HUMIDITY_X10,
      MESSAGE_KEY_AVG_PRESSURE_X10};
    bool chart_valid = next.point_count == GRAPH_COLUMNS;
    for (int metric = 0; metric < METRICS; metric++) {
      next.current[metric] = tuple_i32(
          iter, current_keys[metric], UNAVAILABLE, &fields_valid);
      next.average[metric] = tuple_i32(
          iter, average_keys[metric], UNAVAILABLE, &fields_valid);
      Tuple *series = dict_find(iter, series_keys[metric]);
      const uint8_t *bytes;
      uint16_t series_length;
      if (!app_message_tuple_data(series, &bytes, &series_length) ||
          series->length != GRAPH_COLUMNS * 2) {
        if (series) {
          report_error("receive_response", series->length,
              "SERIES_TYPE_OR_LENGTH_INVALID", "parsing Air Quality history");
        } else {
          report_error("receive_response", metric, "SERIES_MISSING", "parsing Air Quality history");
        }
        chart_valid = false;
        continue;
      }
      for (int column = 0; column < GRAPH_COLUMNS; column++) {
        int offset = column * 2;
        uint16_t raw = (uint16_t)bytes[offset] | ((uint16_t)bytes[offset + 1] << 8);
        next.series[metric][column] = (int16_t)raw;
      }
    }
    if (!fields_valid) {
      report_error("receive_response", s_status, "SNAPSHOT_FIELD_INVALID",
          "parsing Air Quality snapshot");
      chart_valid = false;
    }
    if (!chart_valid) {
      s_scale_loading = false;
      s_loading = false;
      if (scale_response) s_pending_scale = s_scale;
      s_status = STATUS_SERVICE;
      layer_mark_dirty(s_canvas);
      return APP_MESSAGE_RESPONSE_DONE;
    }
    s_scale = next.scale;
    s_cache = next; s_has_cache = true;
    int written = persist_write_data(PERSIST_KEY_CACHE, &s_cache, sizeof(s_cache));
    if (written != (int)sizeof(s_cache)) {
      report_error("persist_write_data", written, "PERSIST_WRITE_FAILED", "saving Air Quality response");
    }
    if (cached_progress) {
      s_loading = true;
      s_scale_loading = false;
    } else {
      s_loading = false;
      s_scale_loading = false;
    }
  } else {
    s_loading = false;
    s_scale_loading = false;
  }
  layer_mark_dirty(s_canvas);
  return cached_progress ? APP_MESSAGE_RESPONSE_MORE : APP_MESSAGE_RESPONSE_DONE;
}

static void select_click(ClickRecognizerRef recognizer, void *context) {
  if (s_loading || s_scale_loading) return;
  if (is_error_status(s_status)) {
    request_refresh();
  } else if (s_page == 0) {
    request_refresh();
  } else {
    s_pending_scale = (s_scale + 1) % SCALE_COUNT;
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
  ERROR_REPORT_NULL(s_errors, s_canvas, "layer_create", "creating Air Quality screen");
  layer_set_update_proc(s_canvas, canvas_update);
  layer_add_child(root, s_canvas);
}

static void window_unload(Window *window) { layer_destroy(s_canvas); }

static void init(void) {
  s_errors = error_reporter_create(&(ErrorReporterConfig){
    .persist_key = PERSIST_ERRORS_KEY,
    .storage_bytes = 2048,
  });
  if (!s_errors) {
    APP_LOG(APP_LOG_LEVEL_ERROR,
        "pebble-errors source=air-quality/watch reporter=create_failed");
  }
  if (persist_exists(PERSIST_KEY_CACHE)) {
    int size = persist_get_size(PERSIST_KEY_CACHE);
    int result = size == (int)sizeof(s_cache)
        ? persist_read_data(PERSIST_KEY_CACHE, &s_cache, sizeof(s_cache)) : size;
    if (result == (int)sizeof(s_cache) && s_cache.version == CACHE_VERSION) {
      s_has_cache = true; s_status = STATUS_OK;
      s_scale = s_cache.scale < SCALE_COUNT ? s_cache.scale : DEFAULT_SCALE;
    } else {
      report_error("persist_read_data", result, "CACHE_RECORD_INVALID", "loading Air Quality cache");
    }
  }
  s_window = window_create();
  ERROR_REPORT_NULL(s_errors, s_window, "window_create", "creating Air Quality screen");
  window_set_background_color(s_window, GColorWhite);
  window_set_window_handlers(s_window,
      (WindowHandlers){.load = window_load, .unload = window_unload});
  window_set_click_config_provider(s_window, click_config);
  AppMessageClientConfig phone_config = {
    .app_name = "air-quality",
    .inbox_size = 2048,
    .outbox_size = PEBBLE_ERROR_OUTBOX_BYTES,
    .protocol = {
      .protocol_key = MESSAGE_KEY_PROTOCOL,
      .command_key = MESSAGE_KEY_COMMAND,
      .request_id_key = MESSAGE_KEY_REQUEST_ID,
      .protocol_version = PROTOCOL_VERSION,
      .ready_command = COMMAND_PHONE_READY,
      .request_id_codec = APP_MESSAGE_ID_UINT16,
    },
    .write_payload = write_request,
    .response_received = receive_response,
    .request_failed = phone_request_failed,
    .errors = s_errors,
  };
  AppMessageResult open_result;
  s_phone = app_message_client_open(&phone_config, &open_result);
  window_stack_push(s_window, true);
  if (open_result == APP_MSG_OK) request_refresh();
  else {
    s_loading = false;
    s_status = STATUS_COMPANION;
    layer_mark_dirty(s_canvas);
  }
}

static void deinit(void) {
  app_message_client_close(s_phone);
  window_destroy(s_window);
  error_reporter_destroy(s_errors);
}

int main(void) { init(); app_event_loop(); deinit(); }
