#include <pebble.h>
#include <app_message_client.h>

#define MAX_DEVICES 32
#define CACHE_VERSION 1
#define PERSIST_HEADER_KEY 7300
#define PERSIST_DEVICE_KEY_BASE 7310
#define PERSIST_ERRORS_KEY 7400
#define ERROR_STORAGE_BYTES 1024
#define ERROR_STORAGE_METADATA_BYTES 21
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

_Static_assert(sizeof(CacheHeader) + MAX_DEVICES * sizeof(DeviceState) +
    ERROR_STORAGE_BYTES + ERROR_STORAGE_METADATA_BYTES <= 4096,
    "Hubitat cache and diagnostics exceed Pebble persistent storage");

static Window *s_window;
static TextLayer *s_brand_layer;
static TextLayer *s_page_layer;
static TextLayer *s_label_layer;
static TextLayer *s_primary_layer;
static TextLayer *s_secondary_layer;
static TextLayer *s_meta_layer;
static TextLayer *s_footer_layer;
static AppMessageClient *s_phone;
static ErrorReporter *s_errors;

static CacheHeader s_header;
static CacheHeader s_staging_header;
static DeviceState s_devices[MAX_DEVICES];
static DeviceState s_staging[MAX_DEVICES];
static bool s_has_cache;
static bool s_staging_active;
static uint32_t s_staging_received;
static bool s_loading;
static bool s_confirming;
static uint8_t s_status;
static uint8_t s_page_index;
static uint8_t s_command_device_index;
static char s_error_text[48];
static char s_action[10];

static void render(void);

#define report_error(function, code, symbol, while_doing) \
  ERROR_REPORT(s_errors, ((ErrorValue){ \
    (function), (code), (symbol), NULL}), (while_doing))

static bool copy_text(char *destination, size_t size, Tuple *tuple) {
  const char *value;
  if (!app_message_tuple_cstring(tuple, &value) || tuple->length > size) {
    destination[0] = '\0';
    return false;
  }
  snprintf(destination, size, "%s", value);
  return true;
}

static bool device_has_control(const DeviceState *device) {
  return device->control_flags != 0;
}

static bool device_valid(const DeviceState *device) {
  return memchr(device->id, '\0', sizeof(device->id)) &&
      memchr(device->label, '\0', sizeof(device->label)) &&
      memchr(device->primary, '\0', sizeof(device->primary)) &&
      memchr(device->secondary, '\0', sizeof(device->secondary)) &&
      device->kind <= KIND_LOCK &&
      (device->battery <= 100 || device->battery == 255) &&
      device->control_flags <= 15;
}

static uint8_t page_count(void) {
  return 1 + s_header.count;
}

static bool decode_page(uint8_t page, uint8_t *device_index) {
  if (page == 0 || page > s_header.count) return false;
  *device_index = page - 1;
  return true;
}

static uint8_t device_page_for(uint8_t device_index) {
  return device_index + 1;
}

static void persist_cache(void) {
  int result = persist_write_data(PERSIST_HEADER_KEY, &s_header, sizeof(s_header));
  if (result != (int)sizeof(s_header)) {
    report_error("persist_write_data", result, "PERSIST_WRITE_FAILED",
        "saving Hubitat device cache");
  }
  for (uint8_t i = 0; i < s_header.count; i++) {
    result = persist_write_data(
        PERSIST_DEVICE_KEY_BASE + i, &s_devices[i], sizeof(DeviceState));
    if (result != (int)sizeof(DeviceState)) {
      report_error("persist_write_data", result, "PERSIST_WRITE_FAILED",
          "saving Hubitat device cache");
    }
  }
}

static void show_failure(uint8_t status, const char *text) {
  s_loading = false;
  s_staging_active = false;
  s_status = status;
  snprintf(s_error_text, sizeof(s_error_text), "%s", text ? text : "");
  render();
}

static void request_refresh(void) {
  if (s_loading || app_message_client_is_active(s_phone)) return;
  s_loading = true;
  s_status = STATUS_OK;
  s_confirming = false;
  AppMessageStartResult result = app_message_client_start(
      s_phone, CMD_REFRESH, APP_MESSAGE_OPERATION_READ, NULL,
      APP_MESSAGE_SEND_PRIMARY);
  if (result != APP_MESSAGE_START_STARTED &&
      result != APP_MESSAGE_START_COALESCED) {
    report_error("app_message_client_start", result, "APP_MESSAGE_START_FAILED",
        "refreshing Hubitat devices");
    show_failure(STATUS_NETWORK, "Cannot contact phone");
  }
  render();
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

static const char *action_label(const char *action) {
  if (strcmp(action, "on") == 0) return "ON";
  if (strcmp(action, "off") == 0) return "OFF";
  if (strcmp(action, "lock") == 0) return "LOCK";
  if (strcmp(action, "unlock") == 0) return "UNLOCK";
  return "UNAVAILABLE";
}

static const char *action_instruction(const char *action) {
  if (strcmp(action, "on") == 0) return "SELECT: TURN ON";
  if (strcmp(action, "off") == 0) return "SELECT: TURN OFF";
  if (strcmp(action, "lock") == 0) return "SELECT: LOCK";
  if (strcmp(action, "unlock") == 0) return "SELECT: UNLOCK";
  return "";
}

static void send_control(uint8_t device_index) {
  DeviceState *device = &s_devices[device_index];
  const char *action = desired_action(device);
  if (!action[0]) return;
  s_command_device_index = device_index;
  snprintf(s_action, sizeof(s_action), "%s", action);
  s_confirming = false;
  s_loading = true;
  s_status = STATUS_COMMAND_PENDING;
  snprintf(s_error_text, sizeof(s_error_text), "%s pending", action);
  AppMessageStartResult result = app_message_client_start(
      s_phone, CMD_CONTROL, APP_MESSAGE_OPERATION_MUTATION, NULL,
      APP_MESSAGE_SEND_PRIMARY);
  if (result != APP_MESSAGE_START_STARTED &&
      result != APP_MESSAGE_START_COALESCED) {
    report_error("app_message_client_start", result, "APP_MESSAGE_START_FAILED",
        "controlling a Hubitat device");
    show_failure(STATUS_COMMAND_FAILURE, "Cannot contact phone");
  }
  render();
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

static void configure_data_layout(bool has_secondary, bool has_meta, bool has_footer) {
  const int content_top = 28;
  const int content_bottom = has_footer ? 204 : 228;
  const int total_height = 36 + 52 + (has_secondary ? 30 : 0) + (has_meta ? 26 : 0);
  int y = content_top + (content_bottom - content_top - total_height) / 2;
  layer_set_frame(text_layer_get_layer(s_label_layer), GRect(8, y, 184, 36));
  text_layer_set_font(s_label_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_overflow_mode(s_label_layer, GTextOverflowModeTrailingEllipsis);
  y += 36;
  layer_set_frame(text_layer_get_layer(s_primary_layer), GRect(8, y, 184, 52));
  text_layer_set_font(s_primary_layer, fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD));
  text_layer_set_overflow_mode(s_primary_layer, GTextOverflowModeTrailingEllipsis);
  y += 52;
  layer_set_frame(text_layer_get_layer(s_secondary_layer), GRect(8, y, 184, has_secondary ? 30 : 1));
  text_layer_set_font(s_secondary_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  if (has_secondary) y += 30;
  layer_set_frame(text_layer_get_layer(s_meta_layer), GRect(8, y, 184, has_meta ? 26 : 1));
  text_layer_set_font(s_meta_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  layer_set_frame(text_layer_get_layer(s_footer_layer), GRect(7, 204, 186, 22));
  text_layer_set_font(s_footer_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
}

static void configure_overview_layout(void) {
  layer_set_frame(text_layer_get_layer(s_label_layer), GRect(8, 47, 184, 22));
  text_layer_set_font(s_label_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_overflow_mode(s_label_layer, GTextOverflowModeTrailingEllipsis);
  layer_set_frame(text_layer_get_layer(s_primary_layer), GRect(8, 65, 184, 54));
  text_layer_set_font(s_primary_layer, fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD));
  text_layer_set_overflow_mode(s_primary_layer, GTextOverflowModeTrailingEllipsis);
  layer_set_frame(text_layer_get_layer(s_secondary_layer), GRect(8, 130, 184, 30));
  text_layer_set_font(s_secondary_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  layer_set_frame(text_layer_get_layer(s_meta_layer), GRect(8, 160, 184, 30));
  text_layer_set_font(s_meta_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  layer_set_frame(text_layer_get_layer(s_footer_layer), GRect(7, 210, 186, 18));
  text_layer_set_font(s_footer_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
}

static void configure_state_layout(bool title_only) {
  layer_set_frame(text_layer_get_layer(s_label_layer),
                  GRect(8, title_only ? 92 : 68, 184, 36));
  text_layer_set_font(s_label_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_overflow_mode(s_label_layer, GTextOverflowModeTrailingEllipsis);
  layer_set_frame(text_layer_get_layer(s_primary_layer), GRect(14, 108, 172, 58));
  text_layer_set_font(s_primary_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_overflow_mode(s_primary_layer, GTextOverflowModeWordWrap);
  layer_set_frame(text_layer_get_layer(s_secondary_layer), GRect(8, 150, 184, 1));
  layer_set_frame(text_layer_get_layer(s_meta_layer), GRect(8, 152, 184, 1));
  layer_set_frame(text_layer_get_layer(s_footer_layer), GRect(8, 184, 184, 28));
}

static void render_state(const char *title, const char *body, const char *footer) {
  configure_state_layout(body[0] == '\0');
  set_text("", title, body, "", "", footer);
}

static void render(void) {
  if (!s_window || !s_page_layer || !s_label_layer || !s_primary_layer ||
      !s_secondary_layer || !s_meta_layer || !s_footer_layer) return;
  static char primary[32], secondary[32], meta[32], footer[32];
  primary[0] = secondary[0] = meta[0] = footer[0] = '\0';
  if (s_loading && s_status != STATUS_COMMAND_PENDING) {
    render_state("SYNCING...", "", "");
    return;
  }
  if (s_status == STATUS_COMMAND_PENDING) {
    render_state("WORKING...", "", "");
    return;
  }
  if (s_status == STATUS_COMMAND_FAILURE) {
    configure_data_layout(true, false, true);
    DeviceState *device = &s_devices[s_command_device_index];
    set_text("ERROR", device->label, action_label(s_action), "SELECT TO RETRY", "",
             "UP / DOWN TO RETURN");
    return;
  }
  if (s_status != STATUS_OK && s_status != STATUS_PARTIAL) {
    const char *title = s_status == STATUS_SETUP ? "SETUP REQUIRED" : "ERROR";
    const char *body = s_status == STATUS_SETUP ? "Go to Hubitat settings\nin the Pebble app" :
      s_status == STATUS_AUTH ? "Open Hubitat settings\nto reconnect" :
      s_status == STATUS_NETWORK ? "Phone cannot be reached" :
      s_status == STATUS_TIMEOUT ? "Hubitat timed out" : "Hubitat is unavailable";
    const char *footer_text = s_status == STATUS_SETUP ? "ACCESS TOKEN REQUIRED" : "PRESS SELECT TO RETRY";
    render_state(title, body, footer_text);
    return;
  }
  if (!s_has_cache || s_header.count == 0) {
    render_state("NO DEVICES", "Authorize devices\nin Maker API", "PRESS SELECT TO RETRY");
    return;
  }

  if (s_page_index == 0) {
    configure_overview_layout();
    uint8_t sensors = 0, controls = 0;
    for (uint8_t i = 0; i < s_header.count; i++) {
      if (s_devices[i].kind <= KIND_TEMPERATURE) sensors += 1;
      if (device_has_control(&s_devices[i])) controls += 1;
    }
    snprintf(primary, sizeof(primary), "%u", s_header.count);
    snprintf(secondary, sizeof(secondary), "SENSORS %u", sensors);
    if (s_header.partial) snprintf(meta, sizeof(meta), "PARTIAL DATA");
    else snprintf(meta, sizeof(meta), "CONTROLS %u", controls);
    set_text("HOME", "DEVICES", primary, secondary, meta, "UPDATED NOW");
    return;
  }

  uint8_t device_index = 0;
  if (!decode_page(s_page_index, &device_index)) return;
  DeviceState *device = &s_devices[device_index];
  const char *action = desired_action(device);
  if (device->kind == KIND_LOCK && s_confirming) {
    configure_data_layout(false, false, true);
    set_text("CONFIRM", device->label, action_label(action), "", "", "PRESS SELECT AGAIN");
  } else if (device_has_control(device)) {
    bool has_battery = device->battery != 255;
    if (has_battery) snprintf(meta, sizeof(meta), "BATTERY %u%%", device->battery);
    configure_data_layout(has_battery, false, true);
    set_text("DEVICE", device->label, device->primary[0] ? device->primary : "MISSING",
             meta, "", action_instruction(action));
  } else {
    bool has_battery = device->battery != 255;
    snprintf(meta, sizeof(meta), "%s", device->secondary);
    if (has_battery) snprintf(footer, sizeof(footer), "BATTERY %u%%", device->battery);
    configure_data_layout(meta[0] != '\0', false, has_battery);
    set_text(device->kind <= KIND_TEMPERATURE ? "SENSOR" : "DEVICE", device->label,
             device->primary[0] ? device->primary : "MISSING", meta, "", footer);
  }
}

static DictionaryResult write_request(
    DictionaryIterator *iterator,
    const AppMessageClientStatus *request,
    void *context) {
  (void)context;
  if (request->operation != CMD_CONTROL) return DICT_OK;
  if (s_command_device_index >= s_header.count) return DICT_INVALID_ARGS;
  DictionaryResult result = dict_write_cstring(
      iterator, MESSAGE_KEY_DEVICE_ID, s_devices[s_command_device_index].id);
  if (result == DICT_OK) {
    result = dict_write_cstring(iterator, MESSAGE_KEY_ACTION, s_action);
  }
  return result;
}

static bool required_uint(
    DictionaryIterator *iterator, uint32_t key, uint32_t *value) {
  return app_message_tuple_uint(dict_find(iterator, key), value);
}

static AppMessageResponseAction invalid_response(
    int32_t code, const char *symbol, const char *while_doing) {
  report_error("receive_response", code, symbol, while_doing);
  show_failure(STATUS_SERVICE, "Hubitat is unavailable");
  return APP_MESSAGE_RESPONSE_DONE;
}

static AppMessageResponseAction receive_response(
    DictionaryIterator *iterator,
    const AppMessageClientStatus *request,
    void *context) {
  (void)context;
  uint32_t protocol = 0, command = 0;
  if (!required_uint(iterator, MESSAGE_KEY_PROTOCOL, &protocol) || protocol != 1) {
    return invalid_response((int32_t)protocol, "PROTOCOL_VERSION_MISMATCH",
        "parsing Hubitat response");
  }
  if (!required_uint(iterator, MESSAGE_KEY_COMMAND, &command) || command > CMD_RESULT) {
    return invalid_response((int32_t)command, "COMMAND_INVALID",
        "parsing Hubitat response");
  }
  uint32_t status = STATUS_OK;
  Tuple *status_tuple = dict_find(iterator, MESSAGE_KEY_STATUS);
  if (status_tuple && (!app_message_tuple_uint(status_tuple, &status) ||
      status > STATUS_COMMAND_FAILURE)) {
    return invalid_response((int32_t)status, "STATUS_INVALID",
        "parsing Hubitat response");
  }

  if (status == STATUS_LOADING && command == 0 &&
      request->operation == CMD_REFRESH) {
    s_loading = true;
    s_status = STATUS_OK;
    render();
    return APP_MESSAGE_RESPONSE_MORE;
  }
  if (command == CMD_DATA_BEGIN && request->operation == CMD_REFRESH &&
      status == STATUS_OK) {
    uint32_t count = 0, fetched_at = 0;
    if (!required_uint(iterator, MESSAGE_KEY_COUNT, &count) || count > MAX_DEVICES ||
        !required_uint(iterator, MESSAGE_KEY_FETCHED_AT, &fetched_at)) {
      return invalid_response((int32_t)count, "SNAPSHOT_HEADER_INVALID",
          "parsing Hubitat device snapshot");
    }
    memset(&s_staging_header, 0, sizeof(s_staging_header));
    memset(s_staging, 0, sizeof(s_staging));
    s_staging_header.version = CACHE_VERSION;
    s_staging_header.count = (uint8_t)count;
    s_staging_header.fetched_at = fetched_at;
    s_staging_received = 0;
    s_staging_active = true;
    return APP_MESSAGE_RESPONSE_MORE;
  }
  if (command == CMD_DEVICE && request->operation == CMD_REFRESH) {
    uint32_t index = 0, kind = 0, battery = 0, flags = 0;
    bool valid = status == STATUS_OK && s_staging_active &&
        required_uint(iterator, MESSAGE_KEY_DEVICE_INDEX, &index) &&
        index < s_staging_header.count && index < MAX_DEVICES &&
        required_uint(iterator, MESSAGE_KEY_DEVICE_KIND, &kind) && kind <= KIND_LOCK &&
        required_uint(iterator, MESSAGE_KEY_BATTERY, &battery) &&
        (battery <= 100 || battery == 255) &&
        required_uint(iterator, MESSAGE_KEY_CONTROL_FLAGS, &flags) && flags <= 15;
    if (!valid) {
      return invalid_response(-1, "DEVICE_FIELDS_INVALID",
          "parsing Hubitat device snapshot");
    }
    DeviceState candidate = {0};
    valid = copy_text(candidate.id, sizeof(candidate.id),
        dict_find(iterator, MESSAGE_KEY_DEVICE_ID)) &&
      copy_text(candidate.label, sizeof(candidate.label),
        dict_find(iterator, MESSAGE_KEY_DEVICE_LABEL)) &&
      copy_text(candidate.primary, sizeof(candidate.primary),
        dict_find(iterator, MESSAGE_KEY_PRIMARY_VALUE)) &&
      copy_text(candidate.secondary, sizeof(candidate.secondary),
        dict_find(iterator, MESSAGE_KEY_SECONDARY_VALUE));
    if (!valid) {
      return invalid_response((int32_t)index, "DEVICE_TEXT_INVALID",
          "parsing Hubitat device snapshot");
    }
    candidate.kind = (uint8_t)kind;
    candidate.battery = (uint8_t)battery;
    candidate.control_flags = (uint8_t)flags;
    uint32_t bit = (uint32_t)1 << index;
    if (s_staging_received & bit) {
      if (memcmp(&s_staging[index], &candidate, sizeof(candidate)) == 0) {
        return APP_MESSAGE_RESPONSE_MORE;
      }
      return invalid_response((int32_t)index, "DEVICE_CONFLICT",
          "parsing Hubitat device snapshot");
    }
    s_staging[index] = candidate;
    s_staging_received |= bit;
    return APP_MESSAGE_RESPONSE_MORE;
  }
  if (command == CMD_DATA_END && request->operation == CMD_REFRESH) {
    uint32_t partial;
    uint32_t expected = s_staging_header.count == 32 ? UINT32_MAX :
        (((uint32_t)1 << s_staging_header.count) - 1);
    if (!s_staging_active || (status != STATUS_OK && status != STATUS_PARTIAL) ||
        !required_uint(iterator, MESSAGE_KEY_PARTIAL, &partial) || partial > 1 ||
        ((status == STATUS_PARTIAL) != (partial == 1)) ||
        s_staging_received != expected) {
      return invalid_response((int32_t)s_staging_received,
          "SNAPSHOT_SEQUENCE_INVALID", "parsing Hubitat device snapshot");
    }
    s_loading = false;
    s_staging_active = false;
    s_staging_header.partial = (uint8_t)partial;
    if (s_staging_header.count > 0) {
      s_header = s_staging_header;
      memcpy(s_devices, s_staging, sizeof(s_devices));
      s_has_cache = true;
      persist_cache();
      s_page_index = 0;
    }
    s_status = (uint8_t)status;
    render();
    return APP_MESSAGE_RESPONSE_DONE;
  }
  if (command == CMD_RESULT && request->operation == CMD_CONTROL) {
    if (status == STATUS_COMMAND_PENDING) {
      s_loading = true;
      s_status = STATUS_COMMAND_PENDING;
      render();
      return APP_MESSAGE_RESPONSE_MORE;
    }
    if (status != STATUS_COMMAND_SUCCESS && status != STATUS_COMMAND_FAILURE) {
      return invalid_response((int32_t)status, "COMMAND_RESULT_INVALID",
          "parsing Hubitat control response");
    }
    s_loading = false;
    Tuple *error = dict_find(iterator, MESSAGE_KEY_ERROR_TEXT);
    if (error && !copy_text(s_error_text, sizeof(s_error_text), error)) {
      return invalid_response(error->length, "ERROR_TEXT_INVALID",
          "parsing Hubitat control response");
    }
    if (!error) s_error_text[0] = '\0';
    if (status == STATUS_COMMAND_SUCCESS && s_command_device_index < s_header.count) {
      DeviceState *device = &s_devices[s_command_device_index];
      if (strcmp(s_action, "on") == 0) snprintf(device->primary, sizeof(device->primary), "on");
      else if (strcmp(s_action, "off") == 0) snprintf(device->primary, sizeof(device->primary), "off");
      else if (strcmp(s_action, "lock") == 0) snprintf(device->primary, sizeof(device->primary), "locked");
      else if (strcmp(s_action, "unlock") == 0) snprintf(device->primary, sizeof(device->primary), "unlocked");
      persist_cache();
      s_status = STATUS_OK;
    } else {
      s_status = STATUS_COMMAND_FAILURE;
    }
    s_page_index = device_page_for(s_command_device_index);
    render();
    return APP_MESSAGE_RESPONSE_DONE;
  }
  if (command == 0 && status >= STATUS_SETUP && status <= STATUS_TIMEOUT) {
    char text[48] = "";
    Tuple *error = dict_find(iterator, MESSAGE_KEY_ERROR_TEXT);
    if (error && !copy_text(text, sizeof(text), error)) {
      return invalid_response(error->length, "ERROR_TEXT_INVALID",
          "parsing Hubitat error response");
    }
    show_failure((uint8_t)status, text);
    return APP_MESSAGE_RESPONSE_DONE;
  }
  return invalid_response((int32_t)command, "RESPONSE_SEQUENCE_INVALID",
      "parsing Hubitat response");
}

static void unsolicited_response(DictionaryIterator *iterator, void *context) {
  (void)iterator; (void)context;
  report_error("receive_response", 0, "REQUEST_ID_MISSING",
      "correlating Hubitat response");
}

static void phone_request_failed(
    const AppMessageFailureInfo *failure,
    void *context) {
  (void)context;
  bool control = failure->operation == CMD_CONTROL;
  bool timeout = failure->failure == APP_MESSAGE_FAILURE_RESPONSE_TIMEOUT ||
      failure->failure == APP_MESSAGE_FAILURE_RECONCILE_TIMEOUT;
  show_failure(control ? STATUS_COMMAND_FAILURE : timeout ? STATUS_TIMEOUT : STATUS_NETWORK,
      timeout ? "Phone response timed out" : "Phone delivery failed");
}

static void clear_result(void) {
  if (s_status >= STATUS_COMMAND_SUCCESS) {
    s_status = STATUS_OK;
    s_error_text[0] = '\0';
  }
}

static void up_click(ClickRecognizerRef recognizer, void *context) {
  clear_result();
  if (s_status != STATUS_OK && s_status != STATUS_PARTIAL) {
    if (s_has_cache) { s_status = STATUS_OK; s_page_index = 0; render(); }
    return;
  }
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
  if (s_status == STATUS_COMMAND_FAILURE) { send_control(s_command_device_index); return; }
  if (s_status != STATUS_OK && s_status != STATUS_PARTIAL) { request_refresh(); return; }
  if (s_page_index == 0) { request_refresh(); return; }
  uint8_t device_index = 0;
  if (!decode_page(s_page_index, &device_index) || !device_has_control(&s_devices[device_index])) return;
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
  ERROR_REPORT_NULL(s_errors, layer, "text_layer_create", "creating Hubitat screen");
  if (!layer) return NULL;
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
  s_brand_layer = make_text(root, GRect(7, 0, 100, 28), FONT_KEY_GOTHIC_24_BOLD, GTextAlignmentLeft);
  s_page_layer = make_text(root, GRect(106, 0, bounds.size.w - 113, 28), FONT_KEY_GOTHIC_24_BOLD, GTextAlignmentRight);
  s_label_layer = make_text(root, GRect(8, 36, bounds.size.w - 16, 32), FONT_KEY_GOTHIC_24_BOLD, GTextAlignmentCenter);
  s_primary_layer = make_text(root, GRect(8, 66, bounds.size.w - 16, 54), FONT_KEY_GOTHIC_28_BOLD, GTextAlignmentCenter);
  s_secondary_layer = make_text(root, GRect(8, 119, bounds.size.w - 16, 30), FONT_KEY_GOTHIC_24_BOLD, GTextAlignmentCenter);
  s_meta_layer = make_text(root, GRect(8, 153, bounds.size.w - 16, 44), FONT_KEY_GOTHIC_18_BOLD, GTextAlignmentCenter);
  s_footer_layer = make_text(root, GRect(7, 204, bounds.size.w - 14, 22), FONT_KEY_GOTHIC_18_BOLD, GTextAlignmentCenter);
  if (!s_brand_layer || !s_page_layer || !s_label_layer || !s_primary_layer ||
      !s_secondary_layer || !s_meta_layer || !s_footer_layer) return;
  text_layer_set_overflow_mode(s_primary_layer, GTextOverflowModeWordWrap);
  text_layer_set_text(s_brand_layer, "HUBITAT");
  render();
}

static void window_unload(Window *window) {
  if (s_brand_layer) text_layer_destroy(s_brand_layer);
  if (s_page_layer) text_layer_destroy(s_page_layer);
  if (s_label_layer) text_layer_destroy(s_label_layer);
  if (s_primary_layer) text_layer_destroy(s_primary_layer);
  if (s_secondary_layer) text_layer_destroy(s_secondary_layer);
  if (s_meta_layer) text_layer_destroy(s_meta_layer);
  if (s_footer_layer) text_layer_destroy(s_footer_layer);
}

static void load_cache(void) {
  if (!persist_exists(PERSIST_HEADER_KEY)) return;
  int size = persist_get_size(PERSIST_HEADER_KEY);
  int result = size == (int)sizeof(CacheHeader)
      ? persist_read_data(PERSIST_HEADER_KEY, &s_header, sizeof(s_header)) : size;
  if (result != (int)sizeof(s_header) || s_header.version != CACHE_VERSION ||
      s_header.count == 0 || s_header.count > MAX_DEVICES || s_header.partial > 1) {
    report_error("persist_read_data", result, "CACHE_HEADER_INVALID",
        "loading Hubitat device cache");
    return;
  }
  for (uint8_t i = 0; i < s_header.count; i++) {
    size = persist_get_size(PERSIST_DEVICE_KEY_BASE + i);
    result = size == (int)sizeof(DeviceState) ? persist_read_data(
        PERSIST_DEVICE_KEY_BASE + i, &s_devices[i], sizeof(DeviceState)) : size;
    if (result != (int)sizeof(DeviceState) || !device_valid(&s_devices[i])) {
      report_error("persist_read_data", result, "CACHE_DEVICE_INVALID",
          "loading Hubitat device cache");
      return;
    }
  }
  s_has_cache = true;
}

static void init(void) {
  s_errors = error_reporter_create(&(ErrorReporterConfig){
    .persist_key = PERSIST_ERRORS_KEY,
    .storage_bytes = ERROR_STORAGE_BYTES,
  });
  if (!s_errors) {
    APP_LOG(APP_LOG_LEVEL_ERROR,
        "pebble-errors source=hubitat/watch reporter=create_failed");
  }
  memset(&s_header, 0, sizeof(s_header));
  memset(s_devices, 0, sizeof(s_devices));
  s_status = STATUS_OK;
  load_cache();
  s_window = window_create();
  ERROR_REPORT_NULL(s_errors, s_window, "window_create", "creating Hubitat screen");
  if (!s_window) return;
  window_set_background_color(s_window, GColorWhite);
  window_set_window_handlers(s_window, (WindowHandlers){.load = window_load, .unload = window_unload});
  window_set_click_config_provider(s_window, click_config_provider);
  AppMessageClientConfig phone_config = {
    .inbox_size = 1024,
    .outbox_size = PEBBLE_ERROR_OUTBOX_BYTES,
    .protocol = {
      .protocol_key = MESSAGE_KEY_PROTOCOL,
      .command_key = MESSAGE_KEY_COMMAND,
      .request_id_key = MESSAGE_KEY_REQUEST_ID,
      .protocol_version = 1,
      .ready_command = CMD_PHONE_READY,
      .request_id_codec = APP_MESSAGE_ID_UINT16,
    },
    .write_payload = write_request,
    .response_received = receive_response,
    .unsolicited_received = unsolicited_response,
    .request_failed = phone_request_failed,
    .errors = s_errors,
  };
  AppMessageResult open_result;
  s_phone = app_message_client_open(&phone_config, &open_result);
  window_stack_push(s_window, true);
  if (open_result == APP_MSG_OK) request_refresh();
  else show_failure(STATUS_NETWORK, "Cannot contact phone");
}

static void deinit(void) {
  app_message_client_close(s_phone);
  if (s_window) window_destroy(s_window);
  error_reporter_destroy(s_errors);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
  return 0;
}
