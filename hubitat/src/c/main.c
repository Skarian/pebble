#include <pebble.h>

#define MAX_DEVICES 6
#define CACHE_VERSION 1
#define PERSIST_HEADER_KEY 7300
#define PERSIST_DEVICE_KEY_BASE 7310
#define RESPONSE_TIMEOUT_MS 30000
#define TEXT_LABEL 25
#define TEXT_VALUE 25

enum {
  CMD_REFRESH = 1, CMD_PHONE_READY = 2, CMD_DATA_BEGIN = 3, CMD_DEVICE = 4,
  CMD_DATA_END = 5, CMD_CONTROL = 6, CMD_RESULT = 7
};

enum {
  STATUS_OK = 0, STATUS_SETUP = 1, STATUS_AUTH = 2, STATUS_NETWORK = 3,
  STATUS_SERVICE = 4, STATUS_TIMEOUT = 5, STATUS_LOADING = 6,
  STATUS_PARTIAL = 7, STATUS_COMMAND_PENDING = 8,
  STATUS_COMMAND_SUCCESS = 9, STATUS_COMMAND_FAILURE = 10
};

enum { KIND_UNKNOWN = 0, KIND_MOTION = 1, KIND_CONTACT = 2, KIND_TEMPERATURE = 3,
       KIND_SWITCH = 4, KIND_LOCK = 5 };
enum { CONTROL_ON = 1, CONTROL_OFF = 2, CONTROL_LOCK = 4, CONTROL_UNLOCK = 8 };
enum { PAGE_STATUS = 0, PAGE_DETAIL = 1, PAGE_CONTROL = 2 };

typedef struct {
  char id[12];
  char label[TEXT_LABEL];
  char primary[TEXT_VALUE];
  char secondary[TEXT_VALUE];
  uint8_t kind;
  uint8_t battery;
  uint8_t control_flags;
} DeviceState;

typedef struct {
  uint8_t version;
  uint8_t count;
  uint8_t partial;
  uint32_t fetched_at;
} CacheHeader;

static Window *s_window;
static TextLayer *s_brand_layer;
static TextLayer *s_page_layer;
static TextLayer *s_label_layer;
static TextLayer *s_primary_layer;
static TextLayer *s_secondary_layer;
static TextLayer *s_meta_layer;
static TextLayer *s_footer_layer;
static Layer *s_rules_layer;
static AppTimer *s_response_timer;

static CacheHeader s_header;
static CacheHeader s_staging_header;
static DeviceState s_devices[MAX_DEVICES];
static DeviceState s_staging[MAX_DEVICES];
static bool s_has_cache;
static bool s_staging_active;
static bool s_loading;
static bool s_confirming;
static uint8_t s_status;
static uint8_t s_page_index;
static uint16_t s_request_id;
static char s_error_text[48];
static char s_action[10];

static void render(void);

static void copy_text(char *destination, size_t size, Tuple *tuple) {
  if (!tuple || tuple->type != TUPLE_CSTRING) {
    destination[0] = '\0';
    return;
  }
  snprintf(destination, size, "%s", tuple->value->cstring);
}

static uint32_t tuple_uint(DictionaryIterator *iterator, uint32_t key, uint32_t fallback) {
  Tuple *tuple = dict_find(iterator, key);
  return tuple ? tuple->value->uint32 : fallback;
}

static bool device_has_control(const DeviceState *device) {
  return device->control_flags != 0;
}

static uint8_t page_count(void) {
  uint8_t count = 1;
  for (uint8_t i = 0; i < s_header.count; i++) {
    count += device_has_control(&s_devices[i]) ? 3 : 2;
  }
  return count;
}

static bool decode_page(uint8_t page, uint8_t *device_index, uint8_t *page_type) {
  if (page == 0) return false;
  uint8_t cursor = 1;
  for (uint8_t i = 0; i < s_header.count; i++) {
    uint8_t pages = device_has_control(&s_devices[i]) ? 3 : 2;
    if (page < cursor + pages) {
      *device_index = i;
      *page_type = page - cursor;
      return true;
    }
    cursor += pages;
  }
  return false;
}

static uint8_t control_page_for(uint8_t device_index) {
  uint8_t page = 1;
  for (uint8_t i = 0; i < device_index; i++) {
    page += device_has_control(&s_devices[i]) ? 3 : 2;
  }
  return page + PAGE_CONTROL;
}

static void persist_cache(void) {
  persist_write_data(PERSIST_HEADER_KEY, &s_header, sizeof(s_header));
  for (uint8_t i = 0; i < s_header.count; i++) {
    persist_write_data(PERSIST_DEVICE_KEY_BASE + i, &s_devices[i], sizeof(DeviceState));
  }
}

static void cancel_response_timer(void) {
  if (s_response_timer) {
    app_timer_cancel(s_response_timer);
    s_response_timer = NULL;
  }
}

static void show_failure(uint8_t status, const char *text) {
  cancel_response_timer();
  s_loading = false;
  s_staging_active = false;
  s_status = status;
  snprintf(s_error_text, sizeof(s_error_text), "%s", text ? text : "");
  render();
}

static void response_timeout(void *context) {
  s_response_timer = NULL;
  if (s_loading) show_failure(STATUS_TIMEOUT, "Phone response timed out");
}

static void request_refresh(void) {
  if (s_loading) return;
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    show_failure(STATUS_NETWORK, "Cannot contact phone");
    return;
  }
  s_request_id += 1;
  dict_write_uint8(out, MESSAGE_KEY_PROTOCOL, 1);
  dict_write_uint8(out, MESSAGE_KEY_COMMAND, CMD_REFRESH);
  dict_write_uint16(out, MESSAGE_KEY_REQUEST_ID, s_request_id);
  app_message_outbox_send();
  s_loading = true;
  s_status = STATUS_OK;
  s_confirming = false;
  cancel_response_timer();
  s_response_timer = app_timer_register(RESPONSE_TIMEOUT_MS, response_timeout, NULL);
  render();
}

static const char *kind_name(uint8_t kind) {
  switch (kind) {
    case KIND_MOTION: return "MOTION";
    case KIND_CONTACT: return "CONTACT";
    case KIND_TEMPERATURE: return "TEMPERATURE";
    case KIND_SWITCH: return "SWITCH";
    case KIND_LOCK: return "LOCK";
    default: return "DEVICE";
  }
}

static const char *desired_action(const DeviceState *device) {
  if (device->kind == KIND_SWITCH) {
    if (strcmp(device->primary, "on") == 0 && (device->control_flags & CONTROL_OFF)) return "off";
    if (device->control_flags & CONTROL_ON) return "on";
  }
  if (device->kind == KIND_LOCK) {
    if (strcmp(device->primary, "locked") == 0 && (device->control_flags & CONTROL_UNLOCK)) return "unlock";
    if (device->control_flags & CONTROL_LOCK) return "lock";
  }
  return "";
}

static const char *action_label(const char *action, bool switch_action) {
  if (strcmp(action, "on") == 0) return switch_action ? "TURN ON" : "ON";
  if (strcmp(action, "off") == 0) return switch_action ? "TURN OFF" : "OFF";
  if (strcmp(action, "lock") == 0) return "LOCK";
  if (strcmp(action, "unlock") == 0) return "UNLOCK";
  return "UNAVAILABLE";
}

static const char *result_label(const char *action) {
  if (strcmp(action, "on") == 0) return "ON";
  if (strcmp(action, "off") == 0) return "OFF";
  if (strcmp(action, "lock") == 0) return "LOCKED";
  if (strcmp(action, "unlock") == 0) return "UNLOCKED";
  return "COMPLETE";
}

static void send_control(uint8_t device_index) {
  DeviceState *device = &s_devices[device_index];
  const char *action = desired_action(device);
  if (!action[0]) return;
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    show_failure(STATUS_COMMAND_FAILURE, "Cannot contact phone");
    return;
  }
  s_request_id += 1;
  snprintf(s_action, sizeof(s_action), "%s", action);
  dict_write_uint8(out, MESSAGE_KEY_PROTOCOL, 1);
  dict_write_uint8(out, MESSAGE_KEY_COMMAND, CMD_CONTROL);
  dict_write_uint16(out, MESSAGE_KEY_REQUEST_ID, s_request_id);
  dict_write_cstring(out, MESSAGE_KEY_DEVICE_ID, device->id);
  dict_write_cstring(out, MESSAGE_KEY_ACTION, action);
  app_message_outbox_send();
  s_confirming = false;
  s_loading = true;
  s_status = STATUS_COMMAND_PENDING;
  snprintf(s_error_text, sizeof(s_error_text), "%s pending", action);
  cancel_response_timer();
  s_response_timer = app_timer_register(RESPONSE_TIMEOUT_MS, response_timeout, NULL);
  render();
}

static void rules_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_draw_line(ctx, GPoint(6, 29), GPoint(bounds.size.w - 7, 29));
  graphics_draw_line(ctx, GPoint(6, bounds.size.h - 25), GPoint(bounds.size.w - 7, bounds.size.h - 25));
}

static void set_text(const char *page, const char *label, const char *primary,
                     const char *secondary, const char *meta, const char *footer) {
  text_layer_set_text(s_page_layer, page);
  text_layer_set_text(s_label_layer, label);
  text_layer_set_text(s_primary_layer, primary);
  text_layer_set_text(s_secondary_layer, secondary);
  text_layer_set_text(s_meta_layer, meta);
  text_layer_set_text(s_footer_layer, footer);
}

static void format_age(char *buffer, size_t size) {
  uint32_t now = time(NULL);
  uint32_t age = now >= s_header.fetched_at ? now - s_header.fetched_at : 0;
  if (!s_header.fetched_at) snprintf(buffer, size, "UPDATED --");
  else if (age < 60) snprintf(buffer, size, "UPDATED NOW");
  else if (age < 3600) snprintf(buffer, size, "UPDATED %lum AGO", (unsigned long)(age / 60));
  else if (age < 86400) snprintf(buffer, size, "%s %luh AGO", age >= 21600 ? "STALE" : "UPDATED", (unsigned long)(age / 3600));
  else snprintf(buffer, size, "STALE %lud AGO", (unsigned long)(age / 86400));
}

static void render_state(const char *title, const char *body, const char *footer) {
  set_text("", title, body, "", "", footer);
}

static void render(void) {
  if (!s_window) return;
  static char page[18], primary[32], secondary[32], meta[32], footer[32];
  if (s_loading && s_status != STATUS_COMMAND_PENDING) {
    render_state("", "SYNCING...", "");
    return;
  }
  if (s_status == STATUS_COMMAND_PENDING) {
    render_state("", "WORKING...", "");
    return;
  }
  if (s_status == STATUS_COMMAND_SUCCESS) {
    render_state("DONE", result_label(s_action), "UP / DOWN TO RETURN");
    return;
  }
  if (s_status == STATUS_COMMAND_FAILURE) {
    render_state("ERROR", "Command failed", "UP / DOWN TO RETURN");
    return;
  }
  if (s_status != STATUS_OK && s_status != STATUS_PARTIAL) {
    const char *title = s_status == STATUS_SETUP ? "SETUP REQUIRED" : "ERROR";
    const char *body = s_status == STATUS_SETUP ? "Open settings in\nthe Pebble app" :
      s_status == STATUS_AUTH ? "Open settings\nto reconnect" :
      s_status == STATUS_NETWORK ? "Phone cannot be reached" :
      s_status == STATUS_TIMEOUT ? "Hubitat timed out" : "Hubitat is unavailable";
    const char *footer_text = s_status == STATUS_SETUP ? "PHONE SETUP REQUIRED" : "PRESS SELECT TO RETRY";
    render_state(title, body, footer_text);
    return;
  }
  if (!s_has_cache || s_header.count == 0) {
    render_state("NO DEVICES", "Choose devices in\nthe Pebble app", "OPEN PHONE SETTINGS");
    return;
  }

  snprintf(page, sizeof(page), "%u / %u", s_page_index + 1, page_count());
  if (s_page_index == 0) {
    uint8_t sensors = 0, controls = 0, low = 0;
    for (uint8_t i = 0; i < s_header.count; i++) {
      if (s_devices[i].kind >= KIND_MOTION && s_devices[i].kind <= KIND_TEMPERATURE) sensors += 1;
      if (device_has_control(&s_devices[i])) controls += 1;
      if (s_devices[i].battery != 255 && s_devices[i].battery < 25) low += 1;
    }
    snprintf(primary, sizeof(primary), "%u DEVICES", s_header.count);
    snprintf(secondary, sizeof(secondary), "%u sensors  %u controls", sensors, controls);
    if (s_header.partial) snprintf(meta, sizeof(meta), "PARTIAL DATA");
    else if (low) snprintf(meta, sizeof(meta), "%u LOW BATTERY", low);
    else meta[0] = '\0';
    format_age(footer, sizeof(footer));
    set_text(page, "OVERVIEW", primary, secondary, meta, footer);
    return;
  }

  uint8_t device_index = 0, page_type = 0;
  if (!decode_page(s_page_index, &device_index, &page_type)) return;
  DeviceState *device = &s_devices[device_index];
  if (page_type == PAGE_STATUS) {
    snprintf(meta, sizeof(meta), "%s", device->secondary);
    snprintf(footer, sizeof(footer), device->battery == 255 ? "BATTERY --" : "BATTERY %u%%", device->battery);
    set_text(page, device->kind <= KIND_TEMPERATURE ? "SENSOR" : "DEVICE", device->label,
             device->primary[0] ? device->primary : "MISSING", meta, footer);
  } else if (page_type == PAGE_DETAIL) {
    snprintf(secondary, sizeof(secondary), "%s", kind_name(device->kind));
    if (device->battery == 255) snprintf(meta, sizeof(meta), "BATTERY --");
    else snprintf(meta, sizeof(meta), "BATTERY %u%%", device->battery);
    format_age(footer, sizeof(footer));
    set_text(page, "DETAIL", device->label, secondary, meta, footer);
  } else {
    const char *action = desired_action(device);
    snprintf(secondary, sizeof(secondary), "%s", action_label(action, device->kind == KIND_SWITCH));
    if (device->kind == KIND_LOCK && s_confirming) {
      set_text(page, "CONFIRM", device->label, secondary, "", "PRESS SELECT AGAIN");
    } else if (device->kind == KIND_LOCK) {
      set_text(page, "CONTROL", device->label, secondary, "", "PRESS SELECT");
    } else {
      set_text(page, "CONTROL", device->label, secondary, "", "PRESS SELECT");
    }
  }
}

static void inbox_received(DictionaryIterator *iterator, void *context) {
  Tuple *protocol = dict_find(iterator, MESSAGE_KEY_PROTOCOL);
  if (protocol && protocol->value->uint8 != 1) return;
  Tuple *command_tuple = dict_find(iterator, MESSAGE_KEY_COMMAND);
  uint8_t command = command_tuple ? command_tuple->value->uint8 : 0;
  if (command == CMD_PHONE_READY) return;
  Tuple *response_id = dict_find(iterator, MESSAGE_KEY_REQUEST_ID);
  if (response_id && response_id->value->uint16 != s_request_id) return;

  Tuple *status_tuple = dict_find(iterator, MESSAGE_KEY_STATUS);
  uint8_t status = status_tuple ? status_tuple->value->uint8 : STATUS_OK;
  Tuple *error = dict_find(iterator, MESSAGE_KEY_ERROR_TEXT);

  if (status == STATUS_LOADING) {
    s_loading = true;
    s_status = STATUS_OK;
    cancel_response_timer();
    s_response_timer = app_timer_register(RESPONSE_TIMEOUT_MS, response_timeout, NULL);
    render();
    return;
  }
  if (command == CMD_DATA_BEGIN) {
    memset(&s_staging_header, 0, sizeof(s_staging_header));
    memset(s_staging, 0, sizeof(s_staging));
    s_staging_header.version = CACHE_VERSION;
    s_staging_header.count = tuple_uint(iterator, MESSAGE_KEY_COUNT, 0);
    if (s_staging_header.count > MAX_DEVICES) s_staging_header.count = MAX_DEVICES;
    s_staging_header.fetched_at = tuple_uint(iterator, MESSAGE_KEY_FETCHED_AT, 0);
    s_staging_active = true;
    return;
  }
  if (command == CMD_DEVICE && s_staging_active) {
    uint8_t index = tuple_uint(iterator, MESSAGE_KEY_DEVICE_INDEX, MAX_DEVICES);
    if (index >= s_staging_header.count || index >= MAX_DEVICES) return;
    DeviceState *device = &s_staging[index];
    copy_text(device->id, sizeof(device->id), dict_find(iterator, MESSAGE_KEY_DEVICE_ID));
    copy_text(device->label, sizeof(device->label), dict_find(iterator, MESSAGE_KEY_DEVICE_LABEL));
    copy_text(device->primary, sizeof(device->primary), dict_find(iterator, MESSAGE_KEY_PRIMARY_VALUE));
    copy_text(device->secondary, sizeof(device->secondary), dict_find(iterator, MESSAGE_KEY_SECONDARY_VALUE));
    device->kind = tuple_uint(iterator, MESSAGE_KEY_DEVICE_KIND, KIND_UNKNOWN);
    device->battery = tuple_uint(iterator, MESSAGE_KEY_BATTERY, 255);
    device->control_flags = tuple_uint(iterator, MESSAGE_KEY_CONTROL_FLAGS, 0);
    return;
  }
  if (command == CMD_DATA_END && s_staging_active) {
    cancel_response_timer();
    s_loading = false;
    s_staging_active = false;
    s_staging_header.partial = tuple_uint(iterator, MESSAGE_KEY_PARTIAL, status == STATUS_PARTIAL);
    if (s_staging_header.count > 0) {
      s_header = s_staging_header;
      memcpy(s_devices, s_staging, sizeof(s_devices));
      s_has_cache = true;
      persist_cache();
      s_page_index = 0;
    }
    s_status = status;
    render();
    return;
  }
  if (command == CMD_RESULT) {
    cancel_response_timer();
    s_loading = false;
    s_status = status;
    copy_text(s_error_text, sizeof(s_error_text), error);
    render();
    return;
  }
  if (status != STATUS_OK) {
    char text[48];
    copy_text(text, sizeof(text), error);
    show_failure(status, text);
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Hubitat inbox dropped: %d", reason);
}

static void outbox_failed(DictionaryIterator *iterator, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Hubitat outbox failed: %d", reason);
  show_failure(s_status == STATUS_COMMAND_PENDING ? STATUS_COMMAND_FAILURE : STATUS_NETWORK,
               "Phone delivery failed");
}

static void clear_result(void) {
  if (s_status >= STATUS_COMMAND_SUCCESS) {
    s_status = STATUS_OK;
    s_error_text[0] = '\0';
  }
}

static void up_click(ClickRecognizerRef recognizer, void *context) {
  clear_result();
  if (s_status != STATUS_OK && s_status != STATUS_PARTIAL) return;
  s_confirming = false;
  if (s_page_index > 0) s_page_index -= 1;
  render();
}

static void down_click(ClickRecognizerRef recognizer, void *context) {
  clear_result();
  if (s_status != STATUS_OK && s_status != STATUS_PARTIAL) {
    if (s_has_cache) { s_status = STATUS_OK; s_page_index = 0; render(); }
    return;
  }
  s_confirming = false;
  if (s_page_index + 1 < page_count()) s_page_index += 1;
  render();
}

static void select_click(ClickRecognizerRef recognizer, void *context) {
  if (s_loading) return;
  if (s_status != STATUS_OK && s_status != STATUS_PARTIAL) { request_refresh(); return; }
  if (s_page_index == 0) { request_refresh(); return; }
  uint8_t device_index = 0, page_type = 0;
  if (!decode_page(s_page_index, &device_index, &page_type)) return;
  if (page_type != PAGE_CONTROL && device_has_control(&s_devices[device_index])) {
    s_page_index = control_page_for(device_index);
    s_confirming = false;
    render();
    return;
  }
  if (page_type != PAGE_CONTROL) return;
  if (s_devices[device_index].kind == KIND_LOCK && !s_confirming) {
    s_confirming = true;
    render();
    return;
  }
  send_control(device_index);
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
}

static TextLayer *make_text(Layer *parent, GRect frame, const char *font,
                            GTextAlignment alignment) {
  TextLayer *layer = text_layer_create(frame);
  text_layer_set_background_color(layer, GColorClear);
  text_layer_set_text_color(layer, GColorBlack);
  text_layer_set_font(layer, fonts_get_system_font(font));
  text_layer_set_text_alignment(layer, alignment);
  text_layer_set_overflow_mode(layer, GTextOverflowModeTrailingEllipsis);
  layer_add_child(parent, text_layer_get_layer(layer));
  return layer;
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  s_rules_layer = layer_create(bounds);
  layer_set_update_proc(s_rules_layer, rules_update_proc);
  layer_add_child(root, s_rules_layer);
  s_brand_layer = make_text(root, GRect(7, 0, 110, 28), FONT_KEY_GOTHIC_24_BOLD, GTextAlignmentLeft);
  s_page_layer = make_text(root, GRect(118, 2, bounds.size.w - 125, 24), FONT_KEY_GOTHIC_18_BOLD, GTextAlignmentRight);
  s_label_layer = make_text(root, GRect(8, 36, bounds.size.w - 16, 32), FONT_KEY_GOTHIC_24_BOLD, GTextAlignmentCenter);
  s_primary_layer = make_text(root, GRect(8, 66, bounds.size.w - 16, 54), FONT_KEY_GOTHIC_28_BOLD, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_primary_layer, GTextOverflowModeWordWrap);
  s_secondary_layer = make_text(root, GRect(8, 119, bounds.size.w - 16, 30), FONT_KEY_GOTHIC_24_BOLD, GTextAlignmentCenter);
  s_meta_layer = make_text(root, GRect(8, 153, bounds.size.w - 16, 44), FONT_KEY_GOTHIC_18_BOLD, GTextAlignmentCenter);
  s_footer_layer = make_text(root, GRect(7, 204, bounds.size.w - 14, 22), FONT_KEY_GOTHIC_18_BOLD, GTextAlignmentCenter);
  text_layer_set_text(s_brand_layer, "HUBITAT");
  render();
}

static void window_unload(Window *window) {
  text_layer_destroy(s_brand_layer); text_layer_destroy(s_page_layer);
  text_layer_destroy(s_label_layer); text_layer_destroy(s_primary_layer);
  text_layer_destroy(s_secondary_layer); text_layer_destroy(s_meta_layer);
  text_layer_destroy(s_footer_layer); layer_destroy(s_rules_layer);
}

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  if (s_has_cache && !s_loading) render();
}

static void load_cache(void) {
  if (!persist_exists(PERSIST_HEADER_KEY) ||
      persist_get_size(PERSIST_HEADER_KEY) != (int)sizeof(CacheHeader) ||
      persist_read_data(PERSIST_HEADER_KEY, &s_header, sizeof(s_header)) != (int)sizeof(s_header) ||
      s_header.version != CACHE_VERSION || s_header.count == 0 || s_header.count > MAX_DEVICES) return;
  for (uint8_t i = 0; i < s_header.count; i++) {
    if (persist_get_size(PERSIST_DEVICE_KEY_BASE + i) != (int)sizeof(DeviceState) ||
        persist_read_data(PERSIST_DEVICE_KEY_BASE + i, &s_devices[i], sizeof(DeviceState)) != (int)sizeof(DeviceState)) return;
  }
  s_has_cache = true;
}

static void init(void) {
  memset(&s_header, 0, sizeof(s_header));
  memset(s_devices, 0, sizeof(s_devices));
  s_status = STATUS_OK;
  load_cache();
  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_window_handlers(s_window, (WindowHandlers){.load = window_load, .unload = window_unload});
  window_set_click_config_provider(s_window, click_config_provider);
  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(1024, 256);
  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
  window_stack_push(s_window, true);
  if (!s_has_cache) request_refresh();
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
