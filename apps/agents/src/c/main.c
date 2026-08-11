#include <pebble.h>
#include "history_projection.h"
#include "app_message_client.h"

#define MAX_AGENTS 16
#define MAX_AGENT_ID 32
#define MAX_AGENT_LABEL 64
#define TRANSCRIPT_BYTES 768
#define MAX_CHUNKS 8
#define CHUNK_BYTES 704
#define MAX_MESSAGE_BYTES (MAX_CHUNKS * (CHUNK_BYTES - 1))
#define CHUNK_TIMEOUT_MS 5000
#define SCROLL_STEP 28
#define SPINNER_INTERVAL_MS 125
#define MARQUEE_INTERVAL_MS 100
#define MARQUEE_LEAD_TICKS 8
#define MARQUEE_END_TICKS 6
#define PERSIST_VERSION_KEY 7200
#define PERSIST_COUNT_KEY 7201
#define PERSIST_AGENT_BASE 7210
#define PERSIST_COUNTER_KEY 7230
#define PERSIST_TURN_KEY 7231
#define PERSIST_ERRORS_KEY 7260
#define CACHE_VERSION 1
#define FLAG_HISTORY_USER 0x08
#define VALUE_MAX(a, b) ((a) > (b) ? (a) : (b))
#define VALUE_MIN(a, b) ((a) < (b) ? (a) : (b))
#define VALUE_CLAMP(value, low, high) VALUE_MIN(VALUE_MAX((value), (low)), (high))

enum {
  COMMAND_REFRESH_AGENTS = 1,
  COMMAND_SEND = 2,
  COMMAND_RECONCILE = 3,
  COMMAND_HISTORY = 4,
};

enum {
  EVENT_AGENTS = 10,
  EVENT_ACCEPTED = 11,
  EVENT_COMMENTARY = 12,
  EVENT_COMPLETED = 13,
  EVENT_FAILED = 14,
  EVENT_STATUS_UNKNOWN = 15,
  EVENT_AGENTS_FAILED = 16,
  EVENT_HISTORY_ITEM = 17,
  EVENT_HISTORY_END = 18,
  EVENT_PHONE_READY = 19,
#ifdef AGENTS_QA
  EVENT_QA_ERROR = 240,
#endif
};

typedef enum {
  SCREEN_BROWSE,
  SCREEN_SYNCING,
  SCREEN_SENDING,
  SCREEN_STREAMING,
  SCREEN_FINAL,
  SCREEN_HISTORY,
  SCREEN_HISTORY_MESSAGE,
  SCREEN_ERROR,
} Screen;

typedef enum {
  TURN_IDLE,
  TURN_SENDING,
  TURN_WORKING,
  TURN_COMPLETE,
  TURN_FAILED,
  TURN_UNKNOWN,
} TurnPhase;

typedef enum {
  ERROR_NONE,
  ERROR_NO_AGENTS,
  ERROR_PHONE_UNREACHABLE,
  ERROR_REFRESH_FAILED,
  ERROR_DICTATION_FAILED,
  ERROR_NOT_SENT,
  ERROR_DELIVERY_UNKNOWN,
  ERROR_AGENT_FAILED,
  ERROR_STREAM_LOST,
  ERROR_UPDATE_REQUIRED,
} ErrorKind;

typedef struct {
  char id[MAX_AGENT_ID + 1];
  char label[MAX_AGENT_LABEL + 1];
} Agent;

static Window *s_window;
static TextLayer *s_header_left;
static TextLayer *s_header_right;
static TextLayer *s_label_layer;
static TextLayer *s_primary_layer;
static TextLayer *s_secondary_layer;
static TextLayer *s_meta_layer;
static TextLayer *s_footer_layer;
static Layer *s_content_clip;
static TextLayer *s_message_layer;
static Layer *s_spinner_layer;
static Layer *s_history_layer;

static Agent s_agents[MAX_AGENTS];
static uint8_t s_agent_count;
static uint8_t s_page_index;
static Screen s_screen = SCREEN_BROWSE;
static Screen s_history_return_screen = SCREEN_STREAMING;
static Screen s_dictation_return_screen = SCREEN_BROWSE;
static TurnPhase s_turn_phase = TURN_IDLE;
static ErrorKind s_error = ERROR_NONE;
static uint8_t s_turn_agent_index;
static char s_turn_agent_id[MAX_AGENT_ID + 1];
static char s_turn_agent_label[MAX_AGENT_LABEL + 1];
static char s_transcript[TRANSCRIPT_BYTES];
static char s_request_id[65];
static uint16_t s_request_counter;
static uint16_t s_last_sequence;
static uint16_t s_chunk_sequence;
static uint8_t s_chunk_flags;
static char s_current_message[MAX_MESSAGE_BYTES + 1];
static char s_error_text[160];
static int16_t s_message_scroll;
static int16_t s_message_max_scroll;

static AgentsHistoryProjection s_history;
static uint8_t s_history_selected;
static int16_t s_history_first_visible;
static int16_t s_marquee_offset;
static uint16_t s_marquee_tick;
static int16_t s_marquee_max;

static char s_chunk_request_id[65];
static uint8_t s_chunk_kind;
static uint8_t s_chunk_count;
static uint16_t s_chunk_mask;
static char s_chunks[MAX_CHUNKS][CHUNK_BYTES];
static char s_last_event[MAX_MESSAGE_BYTES + 1];
static uint8_t s_last_event_kind;

static char s_history_request_id[65];
static char s_history_agent_id[MAX_AGENT_ID + 1];
static uint16_t s_history_chunk_sequence;
static uint8_t s_history_chunk_count;
static uint16_t s_history_chunk_mask;
static uint8_t s_history_chunk_flags;
static char s_history_chunks[MAX_CHUNKS][CHUNK_BYTES];
static char s_history_message[MAX_MESSAGE_BYTES + 1];
static bool s_history_loading;
static bool s_history_failed;

static DictationSession *s_dictation;
static AppTimer *s_chunk_timer;
static AppTimer *s_spinner_timer;
static AppTimer *s_marquee_timer;
static uint8_t s_spinner_frame;
static bool s_refresh_had_cache;
static bool s_reconciling;
static bool s_needs_terminal_replay;
static char s_refresh_request_id[65];
static AppMessageClient *s_phone;
static ErrorReporter *s_errors;

typedef struct {
  uint8_t version;
  uint8_t phase;
  uint16_t last_sequence;
  char request_id[65];
  char agent_id[MAX_AGENT_ID + 1];
  char agent_label[MAX_AGENT_LABEL + 1];
} PersistedTurn;

static void render(void);
static void start_dictation(void);
static void request_agents(void);
static void clear_chunk_assembly(void);
static bool start_turn_reconcile(void);

#define report_error(function, code, symbol, while_doing) \
  ERROR_REPORT(s_errors, ((ErrorValue){ \
    (function), (code), (symbol), NULL}), (while_doing))

static bool write_int(int key, int32_t value, const char *while_doing) {
  int result = persist_write_int(key, value);
  if (result == (int)sizeof(value)) return true;
  report_error("persist_write_int", result, "PERSIST_WRITE_FAILED", while_doing);
  return false;
}

static bool write_data(
    int key, const void *data, size_t size, const char *while_doing) {
  int result = persist_write_data(key, data, size);
  if (result == (int)size) return true;
  report_error("persist_write_data", result, "PERSIST_WRITE_FAILED", while_doing);
  return false;
}

static void delete_value(int key, const char *while_doing) {
  if (!persist_exists(key)) return;
  int result = persist_delete(key);
  if (result < 0) {
    report_error("persist_delete", result, "PERSIST_DELETE_FAILED", while_doing);
  }
}

static AppTimer *register_timer(
    uint32_t timeout_ms, AppTimerCallback callback, void *context,
    const char *while_doing) {
  AppTimer *timer = app_timer_register(timeout_ms, callback, context);
  ERROR_REPORT_NULL(s_errors, timer, "app_timer_register", while_doing);
  return timer;
}

static void copy_text(char *destination, size_t size, const char *source) {
  if (!destination || size == 0) return;
  snprintf(destination, size, "%s", source ? source : "");
}

static uint32_t tuple_uint(const Tuple *tuple, uint32_t fallback) {
  uint32_t value;
  return app_message_tuple_uint(tuple, &value) ? value : fallback;
}

static const char *tuple_cstring(const Tuple *tuple) {
  const char *value;
  return app_message_tuple_cstring(tuple, &value) ? value : NULL;
}

static void cancel_chunk_timer(void) {
  if (s_chunk_timer) { app_timer_cancel(s_chunk_timer); s_chunk_timer = NULL; }
}

static void persist_turn(void) {
  if (s_turn_phase == TURN_IDLE || !s_request_id[0]) {
    delete_value(PERSIST_TURN_KEY, "clearing saved agent turn");
    return;
  }
  PersistedTurn value = {.version = 1, .phase = s_turn_phase, .last_sequence = s_last_sequence};
  copy_text(value.request_id, sizeof(value.request_id), s_request_id);
  copy_text(value.agent_id, sizeof(value.agent_id), s_turn_agent_id);
  copy_text(value.agent_label, sizeof(value.agent_label), s_turn_agent_label);
  write_data(PERSIST_TURN_KEY, &value, sizeof(value), "saving agent turn");
}

static void clear_turn(void) {
  cancel_chunk_timer();
  if (app_message_client_has_request(s_phone, s_request_id)) {
    app_message_client_cancel(s_phone);
  }
  s_turn_phase = TURN_IDLE; s_request_id[0] = '\0'; s_last_sequence = 0;
  s_reconciling = false; clear_chunk_assembly();
  delete_value(PERSIST_TURN_KEY, "clearing completed agent turn");
  s_needs_terminal_replay = false;
}

static bool spinner_active(void) {
  return s_screen == SCREEN_SYNCING || s_screen == SCREEN_SENDING ||
         s_screen == SCREEN_STREAMING || (s_screen == SCREEN_HISTORY && s_history_loading);
}

static void spinner_tick(void *context) {
  s_spinner_timer = NULL;
  if (!spinner_active()) return;
  s_spinner_frame = (s_spinner_frame + 1) % 8;
  layer_mark_dirty(s_spinner_layer);
  s_spinner_timer = register_timer(
      SPINNER_INTERVAL_MS, spinner_tick, NULL, "animating working indicator");
}

static void update_spinner(void) {
  layer_set_hidden(s_spinner_layer, !spinner_active());
  if (spinner_active() && !s_spinner_timer) {
    s_spinner_timer = register_timer(
        SPINNER_INTERVAL_MS, spinner_tick, NULL, "starting working indicator");
  } else if (!spinner_active() && s_spinner_timer) {
    app_timer_cancel(s_spinner_timer);
    s_spinner_timer = NULL;
  }
}

static void spinner_draw(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  GPoint center = grect_center_point(&bounds);
  graphics_context_set_stroke_width(ctx, 2);
  for (uint8_t i = 0; i < 8; i++) {
    uint8_t distance = (i + 8 - s_spinner_frame) % 8;
    graphics_context_set_stroke_color(ctx, distance == 0 ? GColorBlack :
      distance < 3 ? GColorDarkGray : GColorLightGray);
    int32_t angle = TRIG_MAX_ANGLE * i / 8;
    GPoint start = GPoint(center.x + 4 * sin_lookup(angle) / TRIG_MAX_RATIO,
                          center.y - 4 * cos_lookup(angle) / TRIG_MAX_RATIO);
    GPoint end = GPoint(center.x + 8 * sin_lookup(angle) / TRIG_MAX_RATIO,
                        center.y - 8 * cos_lookup(angle) / TRIG_MAX_RATIO);
    graphics_draw_line(ctx, start, end);
  }
}

static void clear_layers(void) {
  text_layer_set_text(s_header_left, "");
  text_layer_set_text(s_header_right, "");
  text_layer_set_text(s_label_layer, "");
  text_layer_set_text(s_primary_layer, "");
  text_layer_set_text(s_secondary_layer, "");
  text_layer_set_text(s_meta_layer, "");
  text_layer_set_text(s_footer_layer, "");
  text_layer_set_text(s_message_layer, "");
  layer_set_hidden(s_label_layer ? text_layer_get_layer(s_label_layer) : NULL, false);
  layer_set_hidden(text_layer_get_layer(s_primary_layer), false);
  layer_set_hidden(text_layer_get_layer(s_secondary_layer), false);
  layer_set_hidden(text_layer_get_layer(s_meta_layer), false);
  layer_set_hidden(text_layer_get_layer(s_footer_layer), false);
  layer_set_hidden(s_content_clip, true);
  layer_set_hidden(s_history_layer, true);
}

static void configure_state_layout(bool title_only) {
  layer_set_frame(text_layer_get_layer(s_label_layer),
                  GRect(8, title_only ? 92 : 54, 184, 38));
  text_layer_set_font(s_label_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  layer_set_frame(text_layer_get_layer(s_primary_layer), GRect(14, 96, 172, 76));
  text_layer_set_font(s_primary_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_overflow_mode(s_primary_layer, GTextOverflowModeWordWrap);
  layer_set_frame(text_layer_get_layer(s_footer_layer), GRect(8, 190, 184, 28));
  text_layer_set_font(s_footer_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
}

static void render_state(const char *title, const char *body, const char *footer) {
  configure_state_layout(!body || !body[0]);
  text_layer_set_text(s_label_layer, title);
  text_layer_set_text(s_primary_layer, body ? body : "");
  text_layer_set_text(s_footer_layer, footer ? footer : "");
}

static void set_turn_header(void) {
  text_layer_set_text(s_header_left, s_turn_agent_label);
  text_layer_set_text(s_header_right, "");
  layer_set_frame(text_layer_get_layer(s_header_left), GRect(7, 0, 160, 28));
}

static int16_t measured_message_height(const char *text, int16_t width) {
  GSize size = graphics_text_layout_get_content_size(
    text ? text : "", fonts_get_system_font(FONT_KEY_GOTHIC_28),
    GRect(0, 0, width, 2000), GTextOverflowModeWordWrap, GTextAlignmentLeft);
  return VALUE_MAX(32, size.h + 8);
}

static void configure_message(const char *text, bool has_footer) {
  int16_t viewport_height = has_footer ? 170 : 198;
  layer_set_frame(s_content_clip, GRect(0, 30, 200, viewport_height));
  int16_t content_height = measured_message_height(text, 184);
  s_message_max_scroll = VALUE_MAX(0, content_height - viewport_height);
  s_message_scroll = VALUE_MIN(s_message_scroll, s_message_max_scroll);
  layer_set_frame(text_layer_get_layer(s_message_layer),
                  GRect(8, -s_message_scroll, 184, content_height));
  text_layer_set_text(s_message_layer, text ? text : "");
  layer_set_hidden(s_content_clip, false);
  if (has_footer) {
    layer_set_frame(text_layer_get_layer(s_footer_layer), GRect(7, 204, 186, 22));
    text_layer_set_font(s_footer_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
    text_layer_set_text(s_footer_layer, "SELECT TO REPLY");
  }
}

static void configure_summary(void) {
  static char count[8];
  snprintf(count, sizeof(count), "%u", s_agent_count);
  text_layer_set_text(s_header_left, "AGENTS");
  text_layer_set_text(s_header_right, "HOME");
  layer_set_frame(text_layer_get_layer(s_label_layer), GRect(8, 55, 184, 34));
  text_layer_set_font(s_label_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text(s_label_layer, "SAVED AGENTS");
  layer_set_frame(text_layer_get_layer(s_primary_layer), GRect(8, 91, 184, 68));
  text_layer_set_font(s_primary_layer, fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD));
  text_layer_set_text(s_primary_layer, count);
  layer_set_frame(text_layer_get_layer(s_footer_layer), GRect(7, 204, 186, 22));
  text_layer_set_font(s_footer_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text(s_footer_layer, "SELECT TO REFRESH");
}

static int8_t find_agent(const char *id) {
  if (!id) return -1;
  for (uint8_t i = 0; i < s_agent_count; i++) {
    if (strcmp(s_agents[i].id, id) == 0) return (int8_t)i;
  }
  return -1;
}

static int8_t active_agent_index(void) {
  return find_agent(s_turn_agent_id);
}

static void configure_agent(void) {
  if (s_page_index == 0 || s_page_index > s_agent_count) return;
  uint8_t index = s_page_index - 1;
  static char page[12];
  snprintf(page, sizeof(page), "%u/%u", s_page_index, s_agent_count);
  text_layer_set_text(s_header_left, "AGENTS");
  text_layer_set_text(s_header_right, page);
  layer_set_frame(text_layer_get_layer(s_label_layer), GRect(8, 46, 184, 90));
  text_layer_set_font(s_label_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_overflow_mode(s_label_layer, GTextOverflowModeTrailingEllipsis);
  text_layer_set_text(s_label_layer, s_agents[index].label);
  layer_set_frame(text_layer_get_layer(s_primary_layer), GRect(8, 145, 184, 30));
  text_layer_set_font(s_primary_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  layer_set_frame(text_layer_get_layer(s_footer_layer), GRect(7, 204, 186, 22));
  text_layer_set_font(s_footer_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  int8_t active = active_agent_index();
  if (s_turn_phase == TURN_WORKING || s_turn_phase == TURN_SENDING) {
    text_layer_set_text(s_primary_layer, active == index ? "WORKING" : "BUSY");
    text_layer_set_text(s_footer_layer, "SELECT TO VIEW");
  } else if (s_turn_phase == TURN_COMPLETE && active == index) {
    text_layer_set_text(s_primary_layer, "RESPONSE READY");
    text_layer_set_text(s_footer_layer, "SELECT TO VIEW");
  } else if (s_turn_phase == TURN_FAILED && active == index) {
    text_layer_set_text(s_primary_layer, "FAILED");
    text_layer_set_text(s_footer_layer, "SELECT TO VIEW");
  } else if (s_turn_phase == TURN_UNKNOWN && active == index) {
    text_layer_set_text(s_primary_layer, "STATUS UNKNOWN");
    text_layer_set_text(s_footer_layer, "SELECT TO VIEW");
  } else {
    text_layer_set_text(s_primary_layer, "READY");
    text_layer_set_text(s_footer_layer, "SELECT TO SPEAK");
  }
}

static const char *error_category(ErrorKind error) {
  switch (error) {
    case ERROR_NO_AGENTS: return "no_agents";
    case ERROR_PHONE_UNREACHABLE: return "phone_offline";
    case ERROR_REFRESH_FAILED: return "refresh_failed";
    case ERROR_DICTATION_FAILED: return "dictation_failed";
    case ERROR_NOT_SENT: return "not_sent";
    case ERROR_DELIVERY_UNKNOWN: return "delivery_unknown";
    case ERROR_AGENT_FAILED: return "agent_failed";
    case ERROR_STREAM_LOST: return "stream_lost";
    case ERROR_UPDATE_REQUIRED: return "update_required";
    default: return "none";
  }
}

static void show_error(ErrorKind error, const char *detail) {
  APP_LOG(APP_LOG_LEVEL_WARNING,
          "connection event=ui_error app=agents category=%s",
          error_category(error));
  s_error = error;
  copy_text(s_error_text, sizeof(s_error_text), detail);
  s_screen = SCREEN_ERROR;
  render();
}

static void render_error(void) {
  const char *title = "ERROR";
  const char *body = s_error_text;
  const char *footer = "";
  switch (s_error) {
    case ERROR_NO_AGENTS:
      title = "NO AGENTS"; body = "Please set up\nCodex Router"; footer = "SELECT TO REFRESH"; break;
    case ERROR_PHONE_UNREACHABLE:
      title = "PHONE OFFLINE"; body = "Ensure mobile\nconnection"; footer = "SELECT TO RETRY"; break;
    case ERROR_REFRESH_FAILED:
      title = "REFRESH FAILED"; body = "Showing cached agents"; footer = "SELECT TO RETRY"; break;
    case ERROR_DICTATION_FAILED:
      title = "DICTATION FAILED"; body = "Please try\nspeaking again"; footer = "SELECT TO RETRY"; break;
    case ERROR_NOT_SENT:
      title = "NOT SENT"; body = "Mobile connection\nfailed"; footer = "SELECT TO RETRY"; break;
    case ERROR_DELIVERY_UNKNOWN:
      title = "STATUS UNKNOWN"; body = "The agent may have\nreceived your message"; footer = "BACK TO AGENT"; break;
    case ERROR_AGENT_FAILED:
      title = "AGENT FAILED"; body = s_error_text[0] ? s_error_text : "Codex Router reported\nan error"; footer = "SELECT TO REPLY"; break;
    case ERROR_STREAM_LOST:
      title = "STREAM LOST"; body = "The agent may have\nreceived your message"; footer = "BACK TO AGENT"; break;
    case ERROR_UPDATE_REQUIRED:
      title = "UPDATE REQUIRED"; body = s_error_text[0] ? s_error_text : "Update Agents\non your phone"; footer = ""; break;
    default: break;
  }
  if (s_turn_agent_label[0] && s_error >= ERROR_DICTATION_FAILED) set_turn_header();
  else {
    text_layer_set_text(s_header_left, "AGENTS");
    text_layer_set_text(s_header_right, "");
  }
  render_state(title, body, footer);
}

static void reset_marquee(void) {
  s_marquee_offset = 0;
  s_marquee_tick = 0;
  s_marquee_max = 0;
  if (s_history.count > 0) {
    AgentsHistoryItem *item = &s_history.items[s_history_selected];
    GSize size = graphics_text_layout_get_content_size(
      item->text, fonts_get_system_font(FONT_KEY_GOTHIC_18),
      GRect(0, 0, 1000, 28), GTextOverflowModeFill, GTextAlignmentLeft);
    s_marquee_max = VALUE_MAX(0, size.w - 184);
  }
}

static void marquee_tick(void *context) {
  s_marquee_timer = NULL;
  if (s_screen != SCREEN_HISTORY || s_marquee_max <= 0) return;
  s_marquee_tick++;
  if (s_marquee_tick > MARQUEE_LEAD_TICKS) {
    if (s_marquee_offset < s_marquee_max) s_marquee_offset += 3;
    else if (s_marquee_tick > MARQUEE_LEAD_TICKS + s_marquee_max / 3 + MARQUEE_END_TICKS) {
      s_marquee_offset = 0;
      s_marquee_tick = 0;
    }
  }
  layer_mark_dirty(s_history_layer);
  s_marquee_timer = register_timer(
      MARQUEE_INTERVAL_MS, marquee_tick, NULL, "scrolling history preview");
}

static void update_marquee(void) {
  if (s_screen == SCREEN_HISTORY && s_marquee_max > 0 && !s_marquee_timer) {
    s_marquee_timer = register_timer(
        MARQUEE_INTERVAL_MS, marquee_tick, NULL, "starting history preview scroll");
  } else if (s_screen != SCREEN_HISTORY && s_marquee_timer) {
    app_timer_cancel(s_marquee_timer);
    s_marquee_timer = NULL;
  }
}

static void history_draw(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  GFont role_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  GFont text_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);
  for (uint8_t row = 0; row < 4; row++) {
    int16_t index = s_history_first_visible + row;
    if (index < 0 || index >= s_history.count) continue;
    int16_t y = row * 50;
    bool selected = index == s_history_selected;
    graphics_context_set_fill_color(ctx, selected ? GColorBlack : GColorWhite);
    graphics_fill_rect(ctx, GRect(0, y, 200, 50), 0, GCornerNone);
    graphics_context_set_text_color(ctx, selected ? GColorWhite : GColorBlack);
    graphics_draw_text(ctx, s_history.items[index].user ? "YOU" : "AGENT", role_font,
                       GRect(8, y + 1, 184, 18), GTextOverflowModeFill,
                       GTextAlignmentLeft, NULL);
    int16_t offset = selected ? s_marquee_offset : 0;
    graphics_draw_text(ctx, s_history.items[index].text, text_font,
                       GRect(8 - offset, y + 18, 184 + offset, 28),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }
}

static void render_history(void) {
  text_layer_set_text(s_header_left, "MESSAGES");
  if (s_history_loading) {
    text_layer_set_text(s_header_right, "");
    render_state("LOADING...", "", "BACK TO AGENT");
    return;
  }
  if (s_history_failed) {
    text_layer_set_text(s_header_right, "");
    render_state("COULD NOT LOAD", "", "SELECT TO RETRY");
    return;
  }
  if (s_history.count == 0) {
    text_layer_set_text(s_header_right, "");
    render_state("NO MESSAGES", "", "BACK TO AGENT");
    return;
  }
  static char position[12];
  snprintf(position, sizeof(position), "%u/%u", s_history_selected + 1, s_history.count);
  text_layer_set_text(s_header_right, position);
  layer_set_frame(s_history_layer, GRect(0, 28, 200, 200));
  layer_set_hidden(s_history_layer, false);
  layer_mark_dirty(s_history_layer);
}

static void render_history_message(void) {
  static char position[12];
  if (s_history_selected >= s_history.count) return;
  snprintf(position, sizeof(position), "%u/%u", s_history_selected + 1, s_history.count);
  text_layer_set_text(s_header_left, s_history.items[s_history_selected].user ? "YOU" : "AGENT");
  text_layer_set_text(s_header_right, position);
  configure_message(s_history.items[s_history_selected].text, false);
}

static void render(void) {
  if (!s_window) return;
#if PBL_API_EXISTS(light_enable_interaction)
  light_enable_interaction();
#endif
  clear_layers();
  layer_set_frame(text_layer_get_layer(s_header_left), GRect(7, 0, 132, 28));
  layer_set_frame(text_layer_get_layer(s_header_right), GRect(139, 0, 54, 28));
  text_layer_set_font(s_header_left, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_font(s_header_right, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  if (s_screen == SCREEN_BROWSE) {
    if (s_agent_count == 0) {
      s_error = ERROR_NO_AGENTS;
      render_error();
      return;
    }
    if (s_page_index == 0) configure_summary();
    else configure_agent();
  } else if (s_screen == SCREEN_SYNCING) {
    text_layer_set_text(s_header_left, "AGENTS");
    render_state("SYNCING...", "", "");
  } else if (s_screen == SCREEN_SENDING) {
    set_turn_header();
    render_state("SENDING...", "", "");
  } else if (s_screen == SCREEN_STREAMING) {
    set_turn_header();
    if (!s_current_message[0] || strcmp(s_current_message, "WORKING...") == 0) {
      render_state("WORKING...", "", "");
    } else {
      configure_message(s_current_message, false);
    }
  } else if (s_screen == SCREEN_FINAL) {
    set_turn_header();
    configure_message(s_current_message[0] ? s_current_message : "No response was returned.", true);
  } else if (s_screen == SCREEN_HISTORY) {
    render_history();
  } else if (s_screen == SCREEN_HISTORY_MESSAGE) {
    render_history_message();
  } else if (s_screen == SCREEN_ERROR) {
    render_error();
  }
  update_spinner();
  update_marquee();
}

static void clear_history(void) {
  agents_history_restart(&s_history);
  s_history_selected = 0;
  s_history_first_visible = 0;
}

static void clear_chunk_assembly(void) {
  cancel_chunk_timer();
  s_chunk_request_id[0] = '\0';
  s_chunk_kind = 0;
  s_chunk_count = 0;
  s_chunk_sequence = 0;
  s_chunk_flags = 0;
  s_chunk_mask = 0;
  for (uint8_t i = 0; i < MAX_CHUNKS; i++) s_chunks[i][0] = '\0';
}

static void chunk_timeout(void *context) {
  s_chunk_timer = NULL; clear_chunk_assembly();
  if (s_turn_phase == TURN_WORKING || s_turn_phase == TURN_SENDING) {
    if (app_message_client_has_request(s_phone, s_request_id)) {
      app_message_client_cancel(s_phone);
    }
    s_turn_phase = TURN_WORKING;
    s_reconciling = false;
    persist_turn();
    start_turn_reconcile();
  }
}

static bool request_matches(const char *request_id) {
  return request_id && s_request_id[0] && strcmp(request_id, s_request_id) == 0;
}

static void accept_logical_event(uint8_t kind, uint16_t sequence, uint8_t flags,
                                 const char *text, const char *code) {
  if (sequence <= s_last_sequence || s_turn_phase == TURN_COMPLETE || s_turn_phase == TURN_FAILED) return;
  s_last_sequence = sequence;
  s_needs_terminal_replay = false;
  s_last_event_kind = kind;
  copy_text(s_last_event, sizeof(s_last_event), text);
  if (text != s_current_message) {
    copy_text(s_current_message, sizeof(s_current_message), text);
  }
  s_message_scroll = 0;
  if (kind == EVENT_COMMENTARY) {
    s_turn_phase = TURN_WORKING;
    if (s_screen != SCREEN_HISTORY && s_screen != SCREEN_HISTORY_MESSAGE && s_screen != SCREEN_BROWSE) s_screen = SCREEN_STREAMING;
    s_reconciling = false;
  } else if (kind == EVENT_COMPLETED) {
    s_turn_phase = TURN_COMPLETE;
    if (s_screen == SCREEN_HISTORY || s_screen == SCREEN_HISTORY_MESSAGE) s_history_return_screen = SCREEN_FINAL;
    else if (s_screen != SCREEN_BROWSE) s_screen = SCREEN_FINAL;
    vibes_short_pulse();
  } else if (kind == EVENT_FAILED) {
    s_turn_phase = TURN_FAILED;
    copy_text(s_error_text, sizeof(s_error_text), text && text[0] ? text : code);
    if (s_screen == SCREEN_HISTORY || s_screen == SCREEN_HISTORY_MESSAGE) s_history_return_screen = SCREEN_ERROR;
    else if (s_screen != SCREEN_BROWSE) {
      s_error = ERROR_AGENT_FAILED;
      s_screen = SCREEN_ERROR;
    }
    vibes_double_pulse();
  } else if (kind == EVENT_STATUS_UNKNOWN) {
    s_turn_phase = TURN_UNKNOWN; s_error = ERROR_DELIVERY_UNKNOWN;
    if (s_screen == SCREEN_HISTORY || s_screen == SCREEN_HISTORY_MESSAGE) s_history_return_screen = SCREEN_ERROR;
    else if (s_screen != SCREEN_BROWSE) s_screen = SCREEN_ERROR;
    vibes_double_pulse();
  }
  persist_turn();
  if (s_screen == SCREEN_HISTORY) {
    if (s_history.count == 0) s_history_selected = 0;
    else if (s_history_selected >= s_history.count) s_history_selected = s_history.count - 1;
  }
  render();
}

static bool receive_chunk(uint8_t kind, const char *request_id, const char *text,
                          uint16_t index, uint16_t count, uint16_t sequence,
                          uint8_t flags, const char *code) {
  if (!request_matches(request_id) || sequence == 0 || sequence <= s_last_sequence) return false;
  if (count == 0 || count > MAX_CHUNKS || index >= count) {
    report_error("receive_chunk", (int32_t)count, "INVALID_CHUNK_METADATA", "assembling agent response");
    s_turn_phase = TURN_FAILED;
    persist_turn();
    show_error(ERROR_UPDATE_REQUIRED, "Invalid chunks");
    return false;
  }
  if (strcmp(s_chunk_request_id, request_id) != 0 || s_chunk_kind != kind ||
      s_chunk_count != count || s_chunk_sequence != sequence) {
    clear_chunk_assembly();
    copy_text(s_chunk_request_id, sizeof(s_chunk_request_id), request_id);
    s_chunk_kind = kind;
    s_chunk_count = count;
    s_chunk_sequence = sequence;
    s_chunk_flags = flags;
  }
  copy_text(s_chunks[index], sizeof(s_chunks[index]), text);
  s_chunk_mask |= (1u << index);
  cancel_chunk_timer();
  s_chunk_timer = register_timer(
      CHUNK_TIMEOUT_MS, chunk_timeout, NULL, "waiting for agent response chunks");
  uint16_t expected = (1u << count) - 1;
  if (s_chunk_mask != expected) return false;
  char *assembled = s_current_message;
  assembled[0] = '\0';
  size_t used = 0;
  for (uint8_t i = 0; i < count; i++) {
    size_t available = MAX_MESSAGE_BYTES - used;
    size_t length = VALUE_MIN(strlen(s_chunks[i]), available);
    memcpy(assembled + used, s_chunks[i], length);
    used += length;
    assembled[used] = '\0';
  }
  clear_chunk_assembly();
  accept_logical_event(kind, sequence, flags, assembled, code);
  return true;
}

static void clear_history_chunk_assembly(void) {
  s_history_chunk_sequence = 0;
  s_history_chunk_count = 0;
  s_history_chunk_mask = 0;
  s_history_chunk_flags = 0;
  for (uint8_t i = 0; i < MAX_CHUNKS; i++) s_history_chunks[i][0] = '\0';
}

static void fail_history(void) {
  if (app_message_client_has_request(s_phone, s_history_request_id)) {
    app_message_client_cancel(s_phone);
  }
  clear_history_chunk_assembly();
  s_history_loading = false;
  s_history_failed = true;
  if (s_screen == SCREEN_HISTORY) render();
}

static void receive_history_chunk(const char *request_id, const char *text,
                                  uint16_t index, uint16_t count, uint16_t sequence,
                                  uint8_t flags) {
  if (!s_history_loading || !request_id || strcmp(request_id, s_history_request_id) != 0) return;
  if (sequence == 0 || sequence > AGENTS_HISTORY_MAX_ITEMS ||
      count == 0 || count > MAX_CHUNKS || index >= count) {
    report_error("receive_history_chunk", (int32_t)sequence, "INVALID_HISTORY_METADATA", "assembling agent history");
    fail_history();
    return;
  }
  if (sequence <= s_history.last_sequence) {
    return;
  }
  if (s_history_chunk_sequence != sequence) {
    if (s_history_chunk_sequence != 0 || sequence != s_history.last_sequence + 1) {
      report_error("receive_history_chunk", (int32_t)sequence, "HISTORY_SEQUENCE_GAP", "assembling agent history");
      clear_history_chunk_assembly();
      return;
    }
    clear_history_chunk_assembly();
    s_history_chunk_sequence = sequence;
    s_history_chunk_count = count;
    s_history_chunk_flags = flags;
  } else if (s_history_chunk_count != count || s_history_chunk_flags != flags) {
    report_error("receive_history_chunk", (int32_t)count, "HISTORY_CHUNK_CONFLICT", "assembling agent history");
    clear_history_chunk_assembly();
    return;
  }
  uint16_t bit = 1u << index;
  if ((s_history_chunk_mask & bit) != 0) {
    if (strcmp(s_history_chunks[index], text) != 0) {
      report_error("receive_history_chunk", (int32_t)index, "HISTORY_DUPLICATE_CONFLICT", "assembling agent history");
      clear_history_chunk_assembly();
      return;
    }
    return;
  }
  copy_text(s_history_chunks[index], sizeof(s_history_chunks[index]), text);
  s_history_chunk_mask |= bit;
  uint16_t expected = (1u << count) - 1;
  if (s_history_chunk_mask != expected) return;
  s_history_message[0] = '\0';
  size_t used = 0;
  for (uint8_t i = 0; i < count; i++) {
    size_t available = sizeof(s_history_message) - used - 1;
    size_t length = VALUE_MIN(strlen(s_history_chunks[i]), available);
    memcpy(s_history_message + used, s_history_chunks[i], length);
    used += length;
    s_history_message[used] = '\0';
  }
  AgentsHistoryAppendResult append_result = agents_history_append(
      &s_history, sequence, s_history_message,
      (flags & FLAG_HISTORY_USER) != 0);
  if (append_result != AGENTS_HISTORY_ACCEPTED) {
    report_error("agents_history_append", append_result, append_result == AGENTS_HISTORY_NO_MEMORY ? "AGENTS_HISTORY_NO_MEMORY" : "AGENTS_HISTORY_REJECTED", "storing agent history");
    clear_history_chunk_assembly();
    return;
  }
  clear_history_chunk_assembly();
}

static void persist_agents(void) {
  write_int(PERSIST_VERSION_KEY, CACHE_VERSION, "saving agent cache version");
  write_int(PERSIST_COUNT_KEY, s_agent_count, "saving agent cache count");
  for (uint8_t i = 0; i < s_agent_count; i++) {
    write_data(PERSIST_AGENT_BASE + i, &s_agents[i], sizeof(Agent),
        "saving cached agent");
  }
}

static void load_agents(void) {
  if (!persist_exists(PERSIST_VERSION_KEY)) return;
  int version = persist_read_int(PERSIST_VERSION_KEY);
  if (version != CACHE_VERSION) {
    report_error("persist_read_int", version, "CACHE_VERSION_INVALID", "loading cached agents");
    return;
  }
  int count = persist_read_int(PERSIST_COUNT_KEY);
  if (count <= 0 || count > MAX_AGENTS) {
    report_error("persist_read_int", count, "CACHE_COUNT_INVALID", "loading cached agents");
    return;
  }
  for (int i = 0; i < count; i++) {
    int size = persist_get_size(PERSIST_AGENT_BASE + i);
    int result = size == (int)sizeof(Agent)
        ? persist_read_data(PERSIST_AGENT_BASE + i, &s_agents[i], sizeof(Agent))
        : size;
    if (result != (int)sizeof(Agent)) {
      report_error("persist_read_data", result, "CACHE_RECORD_INVALID", "loading cached agents");
      return;
    }
  }
  s_agent_count = count;
  s_page_index = 1;
}

static void load_turn(void) {
  if (persist_exists(PERSIST_COUNTER_KEY)) {
    int counter = persist_read_int(PERSIST_COUNTER_KEY);
    if (counter < 0 || counter > UINT16_MAX) {
      report_error("persist_read_int", counter, "REQUEST_COUNTER_INVALID", "loading agent request state");
    } else {
      s_request_counter = (uint16_t)counter;
    }
  }
  int stored_size = persist_get_size(PERSIST_TURN_KEY);
  if (stored_size < 0) return;
  if (stored_size != (int)sizeof(PersistedTurn)) {
    report_error("persist_get_size", stored_size, "TURN_RECORD_INVALID", "loading saved agent turn");
    return;
  }
  PersistedTurn value;
  int result = persist_read_data(PERSIST_TURN_KEY, &value, sizeof(value));
  if (result != (int)sizeof(value) || value.version != 1 ||
      value.phase == TURN_IDLE || value.phase > TURN_UNKNOWN) {
    report_error("persist_read_data", result, "TURN_RECORD_INVALID", "loading saved agent turn");
    return;
  }
  s_turn_phase = value.phase; s_last_sequence = value.last_sequence;
  s_needs_terminal_replay = value.phase == TURN_COMPLETE || value.phase == TURN_FAILED || value.phase == TURN_UNKNOWN;
  copy_text(s_request_id, sizeof(s_request_id), value.request_id);
  copy_text(s_turn_agent_id, sizeof(s_turn_agent_id), value.agent_id);
  copy_text(s_turn_agent_label, sizeof(s_turn_agent_label), value.agent_label);
}

static DictionaryResult write_request(
    DictionaryIterator *out,
    const AppMessageClientStatus *request,
    void *context) {
  (void)context;
  if (request->operation == COMMAND_HISTORY) {
    clear_history();
    clear_history_chunk_assembly();
  }
  if (request->operation == COMMAND_SEND &&
      request->send_kind == APP_MESSAGE_SEND_PRIMARY) {
    if (dict_write_cstring(out, MESSAGE_KEY_AGENT_ID, s_turn_agent_id) != DICT_OK ||
        dict_write_cstring(out, MESSAGE_KEY_TEXT, s_transcript) != DICT_OK ||
        dict_write_uint8(out, MESSAGE_KEY_MODE, 1) != DICT_OK) {
      return DICT_NOT_ENOUGH_STORAGE;
    }
  } else if (request->send_kind == APP_MESSAGE_SEND_RECONCILE) {
    if (dict_write_uint16(out, MESSAGE_KEY_EVENT_SEQUENCE, s_last_sequence) != DICT_OK) {
      return DICT_NOT_ENOUGH_STORAGE;
    }
  } else if (request->operation == COMMAND_HISTORY) {
    if (dict_write_cstring(out, MESSAGE_KEY_AGENT_ID, s_history_agent_id) != DICT_OK) {
      return DICT_NOT_ENOUGH_STORAGE;
    }
  }
  return DICT_OK;
}

static void phone_state_changed(
    const AppMessageClientStatus *status,
    void *context) {
  (void)context;
  if (status->state == APP_MESSAGE_CLIENT_WAITING_RESPONSE &&
      status->operation == COMMAND_SEND) {
    if (status->send_kind == APP_MESSAGE_SEND_PRIMARY &&
        s_turn_phase == TURN_SENDING) {
      s_turn_phase = TURN_WORKING;
      s_reconciling = false;
      copy_text(s_current_message, sizeof(s_current_message), "WORKING...");
      if (s_screen == SCREEN_SENDING) s_screen = SCREEN_STREAMING;
      persist_turn();
    } else if (status->send_kind == APP_MESSAGE_SEND_RECONCILE) {
      s_reconciling = true;
      persist_turn();
    }
  }
  if (s_window) render();
}

static void phone_request_failed(
    const AppMessageFailureInfo *failure,
    void *context) {
  (void)context;
  if (failure->operation == COMMAND_REFRESH_AGENTS) {
    s_refresh_request_id[0] = '\0';
    show_error(s_refresh_had_cache ? ERROR_REFRESH_FAILED : ERROR_PHONE_UNREACHABLE, "");
  } else if (failure->operation == COMMAND_HISTORY) {
    clear_history_chunk_assembly();
    s_history_loading = false;
    s_history_failed = true;
    if (s_screen == SCREEN_HISTORY) render();
  } else {
    s_reconciling = false;
    bool definitely_unsent =
        failure->delivery == APP_MESSAGE_DELIVERY_NOT_SENT;
    if (failure->send_kind == APP_MESSAGE_SEND_PRIMARY && definitely_unsent) {
      s_turn_phase = TURN_SENDING;
      persist_turn();
      show_error(ERROR_NOT_SENT, "");
    } else {
      s_turn_phase = TURN_UNKNOWN;
      persist_turn();
      show_error(failure->send_kind == APP_MESSAGE_SEND_PRIMARY
          ? ERROR_DELIVERY_UNKNOWN : ERROR_STREAM_LOST, "");
    }
  }
}

static bool start_turn_reconcile(void) {
  if (!s_request_id[0]) return false;
  if (app_message_client_is_active(s_phone)) return false;
  AppMessageStartResult result = app_message_client_start(
      s_phone, COMMAND_SEND, APP_MESSAGE_OPERATION_MUTATION,
      s_request_id, APP_MESSAGE_SEND_RECONCILE);
  if (result != APP_MESSAGE_START_STARTED &&
      result != APP_MESSAGE_START_COALESCED) {
    report_error("app_message_client_start", result, "APP_MESSAGE_RECONCILE_START_FAILED", "reconciling agent turn");
    s_turn_phase = TURN_UNKNOWN;
    persist_turn();
    show_error(ERROR_STREAM_LOST, "");
    return false;
  }
  s_reconciling = true;
  persist_turn();
  return true;
}

static void request_agents(void) {
  if (app_message_client_is_active(s_phone)) return;
  s_request_counter++;
  write_int(PERSIST_COUNTER_KEY, s_request_counter, "saving refresh request counter");
  snprintf(s_refresh_request_id, sizeof(s_refresh_request_id), "refresh-%lu-%u",
           (unsigned long)time(NULL), s_request_counter);
  s_refresh_had_cache = s_agent_count > 0;
  s_screen = SCREEN_SYNCING;
  AppMessageStartResult result = app_message_client_start(
      s_phone, COMMAND_REFRESH_AGENTS, APP_MESSAGE_OPERATION_READ,
      s_refresh_request_id, APP_MESSAGE_SEND_PRIMARY);
  if (result != APP_MESSAGE_START_STARTED &&
      result != APP_MESSAGE_START_COALESCED) {
    report_error("app_message_client_start", result, "APP_MESSAGE_START_FAILED", "refreshing agent list");
    s_refresh_request_id[0] = '\0';
    show_error(s_refresh_had_cache ? ERROR_REFRESH_FAILED : ERROR_PHONE_UNREACHABLE, "");
    return;
  }
  render();
}

static void send_transcript(bool retry) {
  if (!retry) {
    bool new_root = s_turn_phase == TURN_IDLE;
    s_request_counter++;
    write_int(PERSIST_COUNTER_KEY, s_request_counter, "saving send request counter");
    snprintf(s_request_id, sizeof(s_request_id), "%lu-%u",
             (unsigned long)time(NULL), s_request_counter);
    if (new_root) clear_history();
    s_last_event[0] = '\0';
    s_last_event_kind = 0;
    s_last_sequence = 0;
    s_needs_terminal_replay = false;
  }
  s_turn_phase = TURN_SENDING;
  s_screen = SCREEN_SENDING;
  s_current_message[0] = '\0';
  s_message_scroll = 0;
  persist_turn();
  AppMessageStartResult result = app_message_client_start(
      s_phone, COMMAND_SEND, APP_MESSAGE_OPERATION_MUTATION,
      s_request_id, APP_MESSAGE_SEND_PRIMARY);
  if (result != APP_MESSAGE_START_STARTED &&
      result != APP_MESSAGE_START_COALESCED) {
    report_error("app_message_client_start", result, "APP_MESSAGE_START_FAILED", "sending dictation to agent");
    show_error(ERROR_NOT_SENT, "");
    return;
  }
  render();
}

static void dictation_callback(DictationSession *session, DictationSessionStatus status,
                               char *transcription, void *context) {
  if (status == DictationSessionStatusSuccess && transcription && transcription[0]) {
    copy_text(s_transcript, sizeof(s_transcript), transcription);
    send_transcript(false);
    return;
  }
  if (status == DictationSessionStatusFailureTranscriptionRejected ||
      status == DictationSessionStatusFailureTranscriptionRejectedWithError) {
    report_error("dictation_callback", status, "DICTATION_REJECTED", "transcribing voice input");
    s_screen = s_dictation_return_screen;
    render();
    return;
  }
  report_error("dictation_callback", status, "DICTATION_FAILED", "transcribing voice input");
  show_error(ERROR_DICTATION_FAILED, "");
}

static void start_dictation(void) {
  if (!s_dictation) {
    ERROR_REPORT_NULL(s_errors, s_dictation, "dictation_session_create",
        "starting voice input");
    show_error(ERROR_DICTATION_FAILED, "");
    return;
  }
  s_dictation_return_screen = s_screen == SCREEN_FINAL ? SCREEN_FINAL : SCREEN_BROWSE;
  DictationSessionStatus status = dictation_session_start(s_dictation);
  if (status != DictationSessionStatusSuccess) {
    report_error("dictation_session_start", status, "DICTATION_START_FAILED", "starting voice input");
    show_error(ERROR_DICTATION_FAILED, "");
  }
}

static AppMessageResponseAction accept_agents(
    DictionaryIterator *iterator, bool correlated) {
  uint32_t raw_count = tuple_uint(dict_find(iterator, MESSAGE_KEY_AGENT_COUNT), 255);
  if (raw_count > MAX_AGENTS) {
    report_error("accept_agents", (int32_t)raw_count, "AGENT_COUNT_INVALID", "parsing agent list");
    show_error(ERROR_UPDATE_REQUIRED, "Too many agents");
    return correlated ? APP_MESSAGE_RESPONSE_DONE : APP_MESSAGE_RESPONSE_IGNORE;
  }
  uint8_t count = raw_count;
  uint8_t flags = tuple_uint(dict_find(iterator, MESSAGE_KEY_FLAGS), 0);
  bool completes_refresh = correlated && !(flags & 4);
  if (count == 0 && s_agent_count > 0 && !completes_refresh) {
    return correlated ? APP_MESSAGE_RESPONSE_MORE : APP_MESSAGE_RESPONSE_IGNORE;
  }
  Agent staging[MAX_AGENTS];
  memset(staging, 0, sizeof(staging));
  for (uint8_t i = 0; i < count; i++) {
    const char *id = tuple_cstring(dict_find(iterator, 100 + i * 2));
    const char *label = tuple_cstring(dict_find(iterator, 101 + i * 2));
    if (!id || !id[0] || strlen(id) > MAX_AGENT_ID || !label || !label[0] || strlen(label) > MAX_AGENT_LABEL) {
      report_error("accept_agents", i, "AGENT_RECORD_INVALID", "parsing agent list");
      show_error(ERROR_UPDATE_REQUIRED, "Invalid agent");
      return correlated ? APP_MESSAGE_RESPONSE_DONE : APP_MESSAGE_RESPONSE_IGNORE;
    }
    for (uint8_t j = 0; j < i; j++) {
      if (strcmp(staging[j].id, id) == 0) {
        report_error("accept_agents", i, "AGENT_ID_DUPLICATE", "parsing agent list");
        show_error(ERROR_UPDATE_REQUIRED, "Duplicate agent");
        return correlated ? APP_MESSAGE_RESPONSE_DONE : APP_MESSAGE_RESPONSE_IGNORE;
      }
    }
    copy_text(staging[i].id, sizeof(staging[i].id), id);
    copy_text(staging[i].label, sizeof(staging[i].label), label);
  }
  char selected_id[MAX_AGENT_ID + 1] = "";
  if (s_page_index > 0 && s_page_index <= s_agent_count) {
    copy_text(selected_id, sizeof(selected_id), s_agents[s_page_index - 1].id);
  }
  memcpy(s_agents, staging, sizeof(staging));
  s_agent_count = count;
  persist_agents();
  if (completes_refresh) {
    s_refresh_request_id[0] = '\0';
  }
  if (count == 0) {
    if (completes_refresh || s_agent_count == 0) { s_page_index = 0; show_error(ERROR_NO_AGENTS, ""); }
    return correlated ? (completes_refresh ? APP_MESSAGE_RESPONSE_DONE
                                           : APP_MESSAGE_RESPONSE_MORE)
                      : APP_MESSAGE_RESPONSE_IGNORE;
  }
  int8_t selected = find_agent(selected_id);
  s_page_index = selected >= 0 ? selected + 1 : 1;
  if (completes_refresh && s_screen == SCREEN_SYNCING) { s_screen = SCREEN_BROWSE; s_error = ERROR_NONE; }
  render();
  return correlated ? (completes_refresh ? APP_MESSAGE_RESPONSE_DONE
                                         : APP_MESSAGE_RESPONSE_MORE)
                    : APP_MESSAGE_RESPONSE_IGNORE;
}

static bool protocol_valid(DictionaryIterator *iterator, uint8_t kind) {
  uint32_t protocol = tuple_uint(dict_find(iterator, MESSAGE_KEY_PROTOCOL), 0);
  if (protocol == 1) return true;
  static char mismatch[40];
  snprintf(mismatch, sizeof(mismatch), "Protocol %lu event %u",
           (unsigned long)protocol, kind);
  report_error("protocol_valid", (int32_t)protocol, "PROTOCOL_VERSION_MISMATCH", "parsing phone response");
  show_error(ERROR_UPDATE_REQUIRED, mismatch);
  return false;
}

static void receive_unsolicited(
    DictionaryIterator *iterator, void *context) {
  (void)context;
  uint32_t raw_kind;
  if (!app_message_tuple_uint(
          dict_find(iterator, MESSAGE_KEY_KIND), &raw_kind) || raw_kind > UINT8_MAX) {
    report_error("receive_unsolicited", 0, "EVENT_KIND_INVALID",
        "parsing unsolicited phone response");
    return;
  }
  uint8_t kind = (uint8_t)raw_kind;
#ifdef AGENTS_QA
  if (kind == EVENT_QA_ERROR) {
    uint8_t error = tuple_uint(dict_find(iterator, MESSAGE_KEY_ERROR_CODE), ERROR_NONE);
    if (error > ERROR_NONE && error <= ERROR_UPDATE_REQUIRED) {
      show_error((ErrorKind)error, "");
    }
    return;
  }
#endif
  if (!protocol_valid(iterator, kind)) return;
  if (kind == EVENT_AGENTS) accept_agents(iterator, false);
}

static AppMessageResponseAction receive_response(
    DictionaryIterator *iterator,
    const AppMessageClientStatus *request,
    void *context) {
  (void)context;
  uint32_t raw_kind;
  if (!app_message_tuple_uint(
          dict_find(iterator, MESSAGE_KEY_KIND), &raw_kind) || raw_kind > UINT8_MAX) {
    report_error("receive_response", 0, "EVENT_KIND_INVALID",
        "parsing phone response");
    return APP_MESSAGE_RESPONSE_DONE;
  }
  uint8_t kind = (uint8_t)raw_kind;
  if (!protocol_valid(iterator, kind)) return APP_MESSAGE_RESPONSE_DONE;
  if (kind < EVENT_AGENTS || kind > EVENT_HISTORY_END) {
    return APP_MESSAGE_RESPONSE_IGNORE;
  }
  if (kind == EVENT_AGENTS) {
    return request->operation == COMMAND_REFRESH_AGENTS
        ? accept_agents(iterator, true) : APP_MESSAGE_RESPONSE_IGNORE;
  }
  const char *request_id = request->request_id;
  uint32_t raw_sequence = tuple_uint(dict_find(iterator, MESSAGE_KEY_EVENT_SEQUENCE), 0);
  if (kind == EVENT_HISTORY_ITEM) {
    if (request->operation != COMMAND_HISTORY) return APP_MESSAGE_RESPONSE_IGNORE;
    const char *text = tuple_cstring(dict_find(iterator, MESSAGE_KEY_TEXT));
    uint32_t index = tuple_uint(dict_find(iterator, MESSAGE_KEY_CHUNK_INDEX), 0);
    uint32_t count = tuple_uint(dict_find(iterator, MESSAGE_KEY_CHUNK_COUNT), 1);
    uint32_t flags = tuple_uint(dict_find(iterator, MESSAGE_KEY_FLAGS), 0);
    if (raw_sequence > 65535 || index > 65535 || count > 65535 || flags > 255) {
      report_error("receive_response", (int32_t)raw_sequence, "HISTORY_METADATA_OVERFLOW", "parsing agent history response");
      fail_history();
      return APP_MESSAGE_RESPONSE_IGNORE;
    }
    receive_history_chunk(request_id, text ? text : "", index, count, raw_sequence, flags);
    return APP_MESSAGE_RESPONSE_MORE;
  }
  if (kind == EVENT_HISTORY_END) {
    if (request->operation != COMMAND_HISTORY || !s_history_loading ||
        strcmp(request_id, s_history_request_id) != 0) {
      return APP_MESSAGE_RESPONSE_IGNORE;
    }
    if (raw_sequence != s_history.last_sequence ||
        s_history_chunk_sequence != 0 || s_history.count != raw_sequence) {
      report_error("receive_response", (int32_t)raw_sequence, "HISTORY_END_MISMATCH", "finishing agent history response");
      clear_history_chunk_assembly();
      return APP_MESSAGE_RESPONSE_IGNORE;
    }
    s_history_loading = false;
    s_history_failed = false;
    s_history_selected = s_history.count > 0 ? s_history.count - 1 : 0;
    s_history_first_visible = s_history.count > 0 ? VALUE_MAX(0, s_history.count - 4) : 0;
    render();
    return APP_MESSAGE_RESPONSE_DONE;
  }
  if (kind == EVENT_ACCEPTED) {
    if (request->operation != COMMAND_SEND || !request_matches(request_id) ||
        raw_sequence == 0 || raw_sequence > 65535) {
      return APP_MESSAGE_RESPONSE_IGNORE;
    }
    if (raw_sequence == s_last_sequence && s_reconciling) {
      if (s_turn_phase == TURN_UNKNOWN) {
        s_turn_phase = TURN_WORKING;
        s_error = ERROR_NONE;
        s_reconciling = false;
        persist_turn();
        if (s_screen == SCREEN_ERROR) s_screen = SCREEN_STREAMING;
        render();
        return APP_MESSAGE_RESPONSE_MORE;
      }
      s_reconciling = false;
      return APP_MESSAGE_RESPONSE_MORE;
    }
    if (raw_sequence < s_last_sequence) return APP_MESSAGE_RESPONSE_MORE;
    s_last_sequence = raw_sequence;
    s_turn_phase = TURN_WORKING;
    s_reconciling = false; persist_turn();
    copy_text(s_current_message, sizeof(s_current_message), "WORKING...");
    if (s_screen != SCREEN_BROWSE) s_screen = SCREEN_STREAMING;
    render();
    return APP_MESSAGE_RESPONSE_MORE;
  }
  if (kind == EVENT_COMMENTARY || kind == EVENT_COMPLETED || kind == EVENT_FAILED || kind == EVENT_STATUS_UNKNOWN) {
    if (request->operation != COMMAND_SEND) return APP_MESSAGE_RESPONSE_IGNORE;
    const char *text = tuple_cstring(dict_find(iterator, MESSAGE_KEY_TEXT));
    const char *code = tuple_cstring(dict_find(iterator, MESSAGE_KEY_ERROR_CODE));
    uint32_t index = tuple_uint(dict_find(iterator, MESSAGE_KEY_CHUNK_INDEX), 0);
    uint32_t count = tuple_uint(dict_find(iterator, MESSAGE_KEY_CHUNK_COUNT), 1);
    uint32_t flags = tuple_uint(dict_find(iterator, MESSAGE_KEY_FLAGS), 0);
    if (request_matches(request_id) && raw_sequence == s_last_sequence && s_reconciling) {
      if (s_needs_terminal_replay && (kind == EVENT_COMPLETED || kind == EVENT_FAILED || kind == EVENT_STATUS_UNKNOWN)) {
        if (s_last_sequence > 0) s_last_sequence--;
        s_turn_phase = TURN_WORKING;
        s_needs_terminal_replay = false;
      } else {
        s_reconciling = false;
        return kind == EVENT_COMMENTARY ? APP_MESSAGE_RESPONSE_MORE
                                        : APP_MESSAGE_RESPONSE_DONE;
      }
    }
    if (raw_sequence > 65535 || index > 65535 || count > 65535 || flags > 255) {
      report_error("receive_response", (int32_t)raw_sequence, "EVENT_METADATA_OVERFLOW", "parsing agent response");
      show_error(ERROR_UPDATE_REQUIRED, "Invalid metadata");
      return APP_MESSAGE_RESPONSE_DONE;
    }
    bool complete = receive_chunk(kind, request_id, text ? text : "", index,
                                  count, raw_sequence, flags, code);
    return complete && kind != EVENT_COMMENTARY
        ? APP_MESSAGE_RESPONSE_DONE : APP_MESSAGE_RESPONSE_MORE;
  }
  if (kind == EVENT_AGENTS_FAILED) {
    if (request->operation == COMMAND_REFRESH_AGENTS &&
        strcmp(request_id, s_refresh_request_id) == 0) {
      s_refresh_request_id[0] = '\0';
      show_error(s_agent_count ? ERROR_REFRESH_FAILED : ERROR_PHONE_UNREACHABLE, "");
      return APP_MESSAGE_RESPONSE_DONE;
    }
    return APP_MESSAGE_RESPONSE_IGNORE;
  }
  return APP_MESSAGE_RESPONSE_IGNORE;
}

static void scroll_message(int16_t delta) {
  s_message_scroll = VALUE_CLAMP(s_message_scroll + delta, 0, s_message_max_scroll);
  render();
}

static void update_history_window(void) {
  if (s_history.count == 0) return;
  if (s_history_selected < s_history_first_visible) s_history_first_visible = s_history_selected;
  if (s_history_selected >= s_history_first_visible + 4) {
    s_history_first_visible = s_history_selected - 3;
  }
  s_history_first_visible = VALUE_MAX(
      0, VALUE_MIN(s_history_first_visible, VALUE_MAX(0, s_history.count - 4)));
  reset_marquee();
  render();
}

static void open_history(void) {
  if (s_screen != SCREEN_HISTORY) {
    s_history_return_screen = s_screen;
    const char *agent_id = s_screen == SCREEN_BROWSE && s_page_index > 0
      ? s_agents[s_page_index - 1].id : s_turn_agent_id;
    copy_text(s_history_agent_id, sizeof(s_history_agent_id), agent_id);
  }
  clear_history();
  clear_history_chunk_assembly();
  s_history_loading = true;
  s_history_failed = false;
  reset_marquee();
  s_screen = SCREEN_HISTORY;
  s_request_counter++;
  write_int(PERSIST_COUNTER_KEY, s_request_counter, "saving history request counter");
  snprintf(s_history_request_id, sizeof(s_history_request_id), "history-%lu-%u",
           (unsigned long)time(NULL), s_request_counter);
  if (!s_history_agent_id[0] || app_message_client_is_active(s_phone)) {
    fail_history();
    return;
  }
  AppMessageStartResult result = app_message_client_start(
      s_phone, COMMAND_HISTORY, APP_MESSAGE_OPERATION_READ,
      s_history_request_id, APP_MESSAGE_SEND_PRIMARY);
  if (result != APP_MESSAGE_START_STARTED &&
      result != APP_MESSAGE_START_COALESCED) {
    report_error("app_message_client_start", result, "APP_MESSAGE_START_FAILED", "loading agent history");
    fail_history();
    return;
  }
  render();
}

static void open_history_message(void) {
  if (s_history_selected >= s_history.count) return;
  s_message_scroll = 0;
  s_screen = SCREEN_HISTORY_MESSAGE;
  render();
}

static void up_click(ClickRecognizerRef recognizer, void *context) {
  if (s_screen == SCREEN_BROWSE) {
    if (s_page_index > 0) s_page_index--;
    render();
  } else if (s_screen == SCREEN_STREAMING || s_screen == SCREEN_FINAL ||
             s_screen == SCREEN_HISTORY_MESSAGE) {
    scroll_message(-SCROLL_STEP);
  } else if (s_screen == SCREEN_HISTORY && s_history_selected > 0) {
    s_history_selected--;
    update_history_window();
  }
}

static void down_click(ClickRecognizerRef recognizer, void *context) {
  if (s_screen == SCREEN_BROWSE) {
    if (s_page_index < s_agent_count) s_page_index++;
    render();
  } else if (s_screen == SCREEN_STREAMING || s_screen == SCREEN_FINAL ||
             s_screen == SCREEN_HISTORY_MESSAGE) {
    scroll_message(SCROLL_STEP);
  } else if (s_screen == SCREEN_HISTORY && s_history_selected + 1 < s_history.count) {
    s_history_selected++;
    update_history_window();
  }
}

static void view_active_turn(void) {
  int8_t active = active_agent_index();
  if (active >= 0) s_page_index = active + 1;
  if (s_turn_phase == TURN_COMPLETE) s_screen = SCREEN_FINAL;
  else if (s_turn_phase == TURN_FAILED) {
    s_error = ERROR_AGENT_FAILED;
    s_screen = SCREEN_ERROR;
  } else if (s_turn_phase == TURN_UNKNOWN) {
    if (s_error != ERROR_STREAM_LOST) s_error = ERROR_DELIVERY_UNKNOWN;
    s_screen = SCREEN_ERROR;
  } else if (s_turn_phase == TURN_SENDING) {
    if (app_message_client_is_active(s_phone)) {
      s_screen = SCREEN_SENDING;
    } else {
      s_error = ERROR_NOT_SENT;
      s_screen = SCREEN_ERROR;
    }
  }
  else s_screen = SCREEN_STREAMING;
  render();
}

static void select_click(ClickRecognizerRef recognizer, void *context) {
  if (s_screen == SCREEN_HISTORY) {
    if (s_history_failed) open_history();
    else if (!s_history_loading) open_history_message();
    return;
  }
  if (s_screen == SCREEN_SYNCING || s_screen == SCREEN_SENDING ||
      s_screen == SCREEN_STREAMING || s_screen == SCREEN_HISTORY_MESSAGE) return;
  if (s_screen == SCREEN_BROWSE) {
    if (s_page_index == 0) { request_agents(); return; }
    uint8_t index = s_page_index - 1;
    if (s_turn_phase != TURN_IDLE) {
      view_active_turn();
      return;
    }
    s_turn_agent_index = index;
    copy_text(s_turn_agent_id, sizeof(s_turn_agent_id), s_agents[index].id);
    copy_text(s_turn_agent_label, sizeof(s_turn_agent_label), s_agents[index].label);
    start_dictation();
    return;
  }
  if (s_screen == SCREEN_FINAL) {
    start_dictation();
    return;
  }
  if (s_screen == SCREEN_ERROR) {
    if (s_error == ERROR_NO_AGENTS || s_error == ERROR_PHONE_UNREACHABLE ||
        s_error == ERROR_REFRESH_FAILED) request_agents();
    else if (s_error == ERROR_DICTATION_FAILED || s_error == ERROR_AGENT_FAILED) start_dictation();
    else if (s_error == ERROR_NOT_SENT) send_transcript(true);
  }
}

static void long_select(ClickRecognizerRef recognizer, void *context) {
  if (s_screen == SCREEN_STREAMING || s_screen == SCREEN_FINAL) {
    open_history();
    return;
  }
  if (s_screen == SCREEN_ERROR &&
      (s_error == ERROR_NOT_SENT || s_error == ERROR_DELIVERY_UNKNOWN ||
       s_error == ERROR_AGENT_FAILED || s_error == ERROR_STREAM_LOST)) {
    open_history();
    return;
  }
  if (s_screen == SCREEN_BROWSE && s_page_index > 0) {
    open_history();
  }
}

static void back_click(ClickRecognizerRef recognizer, void *context) {
  if (s_screen == SCREEN_HISTORY_MESSAGE) {
    reset_marquee();
    s_screen = SCREEN_HISTORY;
    render();
    return;
  }
  if (s_screen == SCREEN_HISTORY) {
    if (app_message_client_has_request(s_phone, s_history_request_id)) {
      app_message_client_cancel(s_phone);
    }
    s_history_loading = false;
    s_screen = s_history_return_screen;
    render();
    return;
  }
  if (s_screen == SCREEN_STREAMING || s_screen == SCREEN_SENDING) {
    s_screen = SCREEN_BROWSE;
    render();
    return;
  }
  if (s_screen == SCREEN_FINAL) {
    clear_turn();
    s_screen = SCREEN_BROWSE;
    render();
    return;
  }
  if (s_screen == SCREEN_ERROR) {
    if (s_turn_phase == TURN_FAILED || s_turn_phase == TURN_UNKNOWN) clear_turn();
    s_screen = SCREEN_BROWSE;
    render();
    return;
  }
  window_stack_pop(true);
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
  window_single_click_subscribe(BUTTON_ID_BACK, back_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, 0, long_select, NULL);
}

static TextLayer *make_text(Layer *parent, GRect frame, const char *font,
                            GTextAlignment alignment) {
  TextLayer *layer = text_layer_create(frame);
  ERROR_REPORT_NULL(s_errors, layer, "text_layer_create", "creating Agents screen");
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
  s_header_left = make_text(root, GRect(7, 0, 132, 28), FONT_KEY_GOTHIC_24_BOLD,
                            GTextAlignmentLeft);
  s_header_right = make_text(root, GRect(139, 0, 54, 28), FONT_KEY_GOTHIC_24_BOLD,
                             GTextAlignmentRight);
  s_label_layer = make_text(root, GRect(8, 46, 184, 90), FONT_KEY_GOTHIC_28_BOLD,
                            GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_label_layer, GTextOverflowModeTrailingEllipsis);
  s_primary_layer = make_text(root, GRect(8, 145, 184, 30), FONT_KEY_GOTHIC_24_BOLD,
                              GTextAlignmentCenter);
  s_secondary_layer = make_text(root, GRect(8, 130, 184, 30), FONT_KEY_GOTHIC_24_BOLD,
                                GTextAlignmentCenter);
  s_meta_layer = make_text(root, GRect(8, 164, 184, 26), FONT_KEY_GOTHIC_18_BOLD,
                           GTextAlignmentCenter);
  s_footer_layer = make_text(root, GRect(7, 204, 186, 22), FONT_KEY_GOTHIC_18_BOLD,
                             GTextAlignmentCenter);
  s_content_clip = layer_create(GRect(0, 30, bounds.size.w, bounds.size.h - 30));
  ERROR_REPORT_NULL(s_errors, s_content_clip, "layer_create", "creating Agents screen");
  layer_set_clips(s_content_clip, true);
  layer_add_child(root, s_content_clip);
  s_message_layer = make_text(s_content_clip, GRect(8, 0, 184, 198), FONT_KEY_GOTHIC_28,
                              GTextAlignmentLeft);
  text_layer_set_overflow_mode(s_message_layer, GTextOverflowModeWordWrap);
  s_spinner_layer = layer_create(GRect(175, 4, 20, 20));
  ERROR_REPORT_NULL(s_errors, s_spinner_layer, "layer_create", "creating Agents screen");
  layer_set_update_proc(s_spinner_layer, spinner_draw);
  layer_add_child(root, s_spinner_layer);
  s_history_layer = layer_create(GRect(0, 28, bounds.size.w, bounds.size.h - 28));
  ERROR_REPORT_NULL(s_errors, s_history_layer, "layer_create", "creating Agents screen");
  layer_set_update_proc(s_history_layer, history_draw);
  layer_add_child(root, s_history_layer);
  render();
}

static void window_unload(Window *window) {
  text_layer_destroy(s_header_left);
  text_layer_destroy(s_header_right);
  text_layer_destroy(s_label_layer);
  text_layer_destroy(s_primary_layer);
  text_layer_destroy(s_secondary_layer);
  text_layer_destroy(s_meta_layer);
  text_layer_destroy(s_footer_layer);
  text_layer_destroy(s_message_layer);
  layer_destroy(s_content_clip);
  layer_destroy(s_spinner_layer);
  layer_destroy(s_history_layer);
}

static void init(void) {
  s_errors = error_reporter_create(&(ErrorReporterConfig){
    .persist_key = PERSIST_ERRORS_KEY,
    .storage_bytes = 1536,
  });
  if (!s_errors) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "pebble-errors source=agents/watch reporter=create_failed");
  }
  agents_history_init(&s_history);
  load_agents();
  load_turn();
  AppMessageClientConfig phone_config = {
    .inbox_size = 2048,
    .outbox_size = 1024,
    .protocol = {
      .protocol_key = MESSAGE_KEY_PROTOCOL,
      .command_key = MESSAGE_KEY_KIND,
      .request_id_key = MESSAGE_KEY_REQUEST_ID,
      .protocol_version = 1,
      .ready_command = EVENT_PHONE_READY,
      .reconcile_command = COMMAND_RECONCILE,
      .request_id_codec = APP_MESSAGE_ID_CSTRING,
    },
    .write_payload = write_request,
    .response_received = receive_response,
    .unsolicited_received = receive_unsolicited,
    .state_changed = phone_state_changed,
    .request_failed = phone_request_failed,
    .errors = s_errors,
  };
  s_window = window_create();
  ERROR_REPORT_NULL(s_errors, s_window, "window_create", "creating Agents screen");
  window_set_background_color(s_window, GColorWhite);
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = window_load,
    .unload = window_unload,
  });
  window_set_click_config_provider(s_window, click_config_provider);
  window_stack_push(s_window, true);

  s_dictation = dictation_session_create(TRANSCRIPT_BYTES, dictation_callback, NULL);
  if (s_dictation) {
    dictation_session_enable_confirmation(s_dictation, true);
    dictation_session_enable_error_dialogs(s_dictation, true);
  } else {
    ERROR_REPORT_NULL(s_errors, s_dictation, "dictation_session_create",
        "initializing voice input");
  }

  AppMessageResult open_result;
  s_phone = app_message_client_open(&phone_config, &open_result);
  if (open_result != APP_MSG_OK) {
    show_error(s_agent_count ? ERROR_REFRESH_FAILED : ERROR_PHONE_UNREACHABLE, "");
    return;
  }
  if (s_turn_phase != TURN_IDLE && s_request_id[0]) {
    start_turn_reconcile();
  } else {
    request_agents();
  }
}

static void deinit(void) {
  cancel_chunk_timer();
  app_message_client_close(s_phone);
  if (s_spinner_timer) app_timer_cancel(s_spinner_timer);
  if (s_marquee_timer) app_timer_cancel(s_marquee_timer);
  if (s_dictation) dictation_session_destroy(s_dictation);
  agents_history_restart(&s_history);
  window_destroy(s_window);
  error_reporter_destroy(s_errors);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
