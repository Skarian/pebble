#include <pebble.h>

#define MAX_AGENTS 16
#define MAX_AGENT_ID 32
#define MAX_AGENT_LABEL 64
#define TRANSCRIPT_BYTES 768
#define MAX_CHUNKS 8
#define CHUNK_BYTES 704
#define MAX_MESSAGE_BYTES (MAX_CHUNKS * (CHUNK_BYTES - 1))
#define MAX_HISTORY 16
#define MAX_HISTORY_BYTES 18000
#define RESPONSE_TIMEOUT_MS 30000
#define SCROLL_STEP 28
#define SPINNER_INTERVAL_MS 125
#define MARQUEE_INTERVAL_MS 100
#define MARQUEE_LEAD_TICKS 8
#define MARQUEE_END_TICKS 6
#define PERSIST_VERSION_KEY 7200
#define PERSIST_COUNT_KEY 7201
#define PERSIST_AGENT_BASE 7210
#define CACHE_VERSION 1
#define VALUE_MAX(a, b) ((a) > (b) ? (a) : (b))
#define VALUE_MIN(a, b) ((a) < (b) ? (a) : (b))
#define VALUE_CLAMP(value, low, high) VALUE_MIN(VALUE_MAX((value), (low)), (high))

enum {
  COMMAND_REFRESH_AGENTS = 1,
  COMMAND_SEND = 2,
};

enum {
  EVENT_AGENTS = 10,
  EVENT_ACCEPTED = 11,
  EVENT_COMMENTARY = 12,
  EVENT_COMPLETED = 13,
  EVENT_FAILED = 14,
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
  SCREEN_ERROR,
} Screen;

typedef enum {
  TURN_IDLE,
  TURN_SENDING,
  TURN_WORKING,
  TURN_COMPLETE,
  TURN_FAILED,
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

typedef struct {
  char *text;
  bool user;
  size_t bytes;
} HistoryItem;

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
static char s_current_message[MAX_MESSAGE_BYTES + 1];
static char s_error_text[160];
static int16_t s_message_scroll;
static int16_t s_message_max_scroll;

static HistoryItem s_history[MAX_HISTORY];
static uint8_t s_history_count;
static size_t s_history_bytes;
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

static DictationSession *s_dictation;
static AppTimer *s_response_timer;
static AppTimer *s_spinner_timer;
static AppTimer *s_marquee_timer;
static uint8_t s_spinner_frame;
static bool s_refresh_had_cache;

static void render(void);
static void start_dictation(void);
static void request_agents(void);

static void copy_text(char *destination, size_t size, const char *source) {
  if (!destination || size == 0) return;
  snprintf(destination, size, "%s", source ? source : "");
}

static uint32_t tuple_uint(const Tuple *tuple, uint32_t fallback) {
  if (!tuple) return fallback;
  switch (tuple->type) {
    case TUPLE_UINT: return tuple->value->uint32;
    case TUPLE_INT: return (uint32_t)tuple->value->int32;
    default: return fallback;
  }
}

static const char *tuple_cstring(const Tuple *tuple) {
  return tuple && tuple->type == TUPLE_CSTRING ? tuple->value->cstring : NULL;
}

static void cancel_response_timer(void) {
  if (s_response_timer) {
    app_timer_cancel(s_response_timer);
    s_response_timer = NULL;
  }
}

static bool spinner_active(void) {
  return s_screen == SCREEN_SYNCING || s_screen == SCREEN_SENDING ||
         s_screen == SCREEN_STREAMING;
}

static void spinner_tick(void *context) {
  s_spinner_timer = NULL;
  if (!spinner_active()) return;
  s_spinner_frame = (s_spinner_frame + 1) % 8;
  layer_mark_dirty(s_spinner_layer);
  s_spinner_timer = app_timer_register(SPINNER_INTERVAL_MS, spinner_tick, NULL);
}

static void update_spinner(void) {
  layer_set_hidden(s_spinner_layer, !spinner_active());
  if (spinner_active() && !s_spinner_timer) {
    s_spinner_timer = app_timer_register(SPINNER_INTERVAL_MS, spinner_tick, NULL);
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
    text ? text : "", fonts_get_system_font(FONT_KEY_GOTHIC_24),
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
  if (has_footer) text_layer_set_text(s_footer_layer, "SELECT TO REPLY");
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
  } else {
    text_layer_set_text(s_primary_layer, "READY");
    text_layer_set_text(s_footer_layer, "SELECT TO SPEAK");
  }
}

static void show_error(ErrorKind error, const char *detail) {
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
      title = "UPDATE REQUIRED"; body = "Update Agents\non your phone"; footer = ""; break;
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
  if (s_history_count > 0) {
    HistoryItem *item = &s_history[s_history_selected];
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
  s_marquee_timer = app_timer_register(MARQUEE_INTERVAL_MS, marquee_tick, NULL);
}

static void update_marquee(void) {
  if (s_screen == SCREEN_HISTORY && s_marquee_max > 0 && !s_marquee_timer) {
    s_marquee_timer = app_timer_register(MARQUEE_INTERVAL_MS, marquee_tick, NULL);
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
    if (index < 0 || index >= s_history_count) continue;
    int16_t y = row * 50;
    bool selected = index == s_history_selected;
    graphics_context_set_fill_color(ctx, selected ? GColorBlack : GColorWhite);
    graphics_fill_rect(ctx, GRect(0, y, 200, 50), 0, GCornerNone);
    graphics_context_set_text_color(ctx, selected ? GColorWhite : GColorBlack);
    graphics_draw_text(ctx, s_history[index].user ? "YOU" : "AGENT", role_font,
                       GRect(8, y + 1, 184, 18), GTextOverflowModeFill,
                       GTextAlignmentLeft, NULL);
    int16_t offset = selected ? s_marquee_offset : 0;
    graphics_draw_text(ctx, s_history[index].text, text_font,
                       GRect(8 - offset, y + 18, 184 + offset, 28),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }
}

static void render_history(void) {
  static char position[12];
  snprintf(position, sizeof(position), "%u/%u", s_history_selected + 1, s_history_count);
  text_layer_set_text(s_header_left, "MESSAGES");
  text_layer_set_text(s_header_right, position);
  layer_set_frame(s_history_layer, GRect(0, 28, 200, 200));
  layer_set_hidden(s_history_layer, false);
  layer_mark_dirty(s_history_layer);
}

static void render(void) {
  if (!s_window) return;
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
  } else if (s_screen == SCREEN_ERROR) {
    render_error();
  }
  update_spinner();
  update_marquee();
}

static void free_history_item(uint8_t index) {
  if (index >= s_history_count || !s_history[index].text) return;
  free(s_history[index].text);
  s_history[index].text = NULL;
}

static void drop_oldest_history(void) {
  if (s_history_count == 0) return;
  s_history_bytes -= s_history[0].bytes;
  free_history_item(0);
  for (uint8_t i = 1; i < s_history_count; i++) s_history[i - 1] = s_history[i];
  s_history_count--;
  if (s_history_selected > 0) s_history_selected--;
}

static void append_history(const char *text, bool user) {
  if (!text || !text[0]) return;
  size_t bytes = strlen(text) + 1;
  while (s_history_count >= MAX_HISTORY ||
         (s_history_count > 0 && s_history_bytes + bytes > MAX_HISTORY_BYTES)) {
    drop_oldest_history();
  }
  char *copy = malloc(bytes);
  if (!copy) return;
  memcpy(copy, text, bytes);
  s_history[s_history_count] = (HistoryItem){.text = copy, .user = user, .bytes = bytes};
  s_history_count++;
  s_history_bytes += bytes;
}

static void clear_chunk_assembly(void) {
  s_chunk_request_id[0] = '\0';
  s_chunk_kind = 0;
  s_chunk_count = 0;
  s_chunk_mask = 0;
  for (uint8_t i = 0; i < MAX_CHUNKS; i++) s_chunks[i][0] = '\0';
}

static bool request_matches(const char *request_id) {
  return request_id && s_request_id[0] && strcmp(request_id, s_request_id) == 0;
}

static void accept_logical_event(uint8_t kind, const char *text, const char *code) {
  if (kind == s_last_event_kind && strcmp(text, s_last_event) == 0) return;
  s_last_event_kind = kind;
  copy_text(s_last_event, sizeof(s_last_event), text);
  copy_text(s_current_message, sizeof(s_current_message), text);
  s_message_scroll = 0;
  if (kind == EVENT_COMMENTARY) {
    append_history(text, false);
    s_turn_phase = TURN_WORKING;
    if (s_screen != SCREEN_HISTORY && s_screen != SCREEN_BROWSE) s_screen = SCREEN_STREAMING;
  } else if (kind == EVENT_COMPLETED) {
    append_history(text, false);
    s_turn_phase = TURN_COMPLETE;
    if (s_screen == SCREEN_HISTORY) s_history_return_screen = SCREEN_FINAL;
    else if (s_screen != SCREEN_BROWSE) s_screen = SCREEN_FINAL;
    vibes_short_pulse();
  } else if (kind == EVENT_FAILED) {
    s_turn_phase = TURN_FAILED;
    copy_text(s_error_text, sizeof(s_error_text), text && text[0] ? text : code);
    if (s_screen == SCREEN_HISTORY) s_history_return_screen = SCREEN_ERROR;
    else if (s_screen != SCREEN_BROWSE) {
      s_error = ERROR_AGENT_FAILED;
      s_screen = SCREEN_ERROR;
    }
    vibes_double_pulse();
  }
  if (s_screen == SCREEN_HISTORY) {
    if (s_history_selected >= s_history_count) s_history_selected = s_history_count - 1;
  }
  render();
}

static void receive_chunk(uint8_t kind, const char *request_id, const char *text,
                          uint8_t index, uint8_t count, const char *code) {
  if (!request_matches(request_id) || count == 0 || count > MAX_CHUNKS || index >= count) return;
  if (strcmp(s_chunk_request_id, request_id) != 0 || s_chunk_kind != kind ||
      s_chunk_count != count || (s_chunk_mask == 0 && index == 0)) {
    clear_chunk_assembly();
    copy_text(s_chunk_request_id, sizeof(s_chunk_request_id), request_id);
    s_chunk_kind = kind;
    s_chunk_count = count;
  }
  copy_text(s_chunks[index], sizeof(s_chunks[index]), text);
  s_chunk_mask |= (1u << index);
  uint16_t expected = (1u << count) - 1;
  if (s_chunk_mask != expected) return;
  static char assembled[MAX_MESSAGE_BYTES + 1];
  assembled[0] = '\0';
  size_t used = 0;
  for (uint8_t i = 0; i < count; i++) {
    size_t available = sizeof(assembled) - used - 1;
    size_t length = VALUE_MIN(strlen(s_chunks[i]), available);
    memcpy(assembled + used, s_chunks[i], length);
    used += length;
    assembled[used] = '\0';
  }
  clear_chunk_assembly();
  accept_logical_event(kind, assembled, code);
}

static void persist_agents(void) {
  persist_write_int(PERSIST_VERSION_KEY, CACHE_VERSION);
  persist_write_int(PERSIST_COUNT_KEY, s_agent_count);
  for (uint8_t i = 0; i < s_agent_count; i++) {
    persist_write_data(PERSIST_AGENT_BASE + i, &s_agents[i], sizeof(Agent));
  }
}

static void load_agents(void) {
  if (!persist_exists(PERSIST_VERSION_KEY) ||
      persist_read_int(PERSIST_VERSION_KEY) != CACHE_VERSION) return;
  int count = persist_read_int(PERSIST_COUNT_KEY);
  if (count <= 0 || count > MAX_AGENTS) return;
  for (int i = 0; i < count; i++) {
    if (persist_get_size(PERSIST_AGENT_BASE + i) != (int)sizeof(Agent) ||
        persist_read_data(PERSIST_AGENT_BASE + i, &s_agents[i], sizeof(Agent)) !=
        (int)sizeof(Agent)) return;
  }
  s_agent_count = count;
  s_page_index = 1;
}

static void response_timeout(void *context) {
  s_response_timer = NULL;
  if (s_screen == SCREEN_SYNCING) {
    show_error(s_refresh_had_cache ? ERROR_REFRESH_FAILED : ERROR_PHONE_UNREACHABLE, "");
  } else if (s_screen == SCREEN_SENDING) {
    s_turn_phase = TURN_WORKING;
    show_error(ERROR_DELIVERY_UNKNOWN, "");
  }
}

static void begin_timeout(void) {
  cancel_response_timer();
  s_response_timer = app_timer_register(RESPONSE_TIMEOUT_MS, response_timeout, NULL);
}

static void request_agents(void) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    show_error(s_agent_count ? ERROR_REFRESH_FAILED : ERROR_PHONE_UNREACHABLE, "");
    return;
  }
  dict_write_uint8(out, MESSAGE_KEY_KIND, COMMAND_REFRESH_AGENTS);
  if (app_message_outbox_send() != APP_MSG_OK) {
    show_error(s_agent_count ? ERROR_REFRESH_FAILED : ERROR_PHONE_UNREACHABLE, "");
    return;
  }
  s_refresh_had_cache = s_agent_count > 0;
  s_screen = SCREEN_SYNCING;
  begin_timeout();
  render();
}

static void send_transcript(bool retry) {
  if (!retry) {
    s_request_counter++;
    snprintf(s_request_id, sizeof(s_request_id), "%lu-%u",
             (unsigned long)time(NULL), s_request_counter);
    append_history(s_transcript, true);
    s_last_event[0] = '\0';
    s_last_event_kind = 0;
  }
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    show_error(ERROR_NOT_SENT, "");
    return;
  }
  dict_write_uint8(out, MESSAGE_KEY_KIND, COMMAND_SEND);
  dict_write_cstring(out, MESSAGE_KEY_REQUEST_ID, s_request_id);
  dict_write_cstring(out, MESSAGE_KEY_AGENT_ID, s_turn_agent_id);
  dict_write_cstring(out, MESSAGE_KEY_TEXT, s_transcript);
  dict_write_uint8(out, MESSAGE_KEY_MODE, 1);
  if (app_message_outbox_send() != APP_MSG_OK) {
    show_error(ERROR_NOT_SENT, "");
    return;
  }
  s_turn_phase = TURN_SENDING;
  s_screen = SCREEN_SENDING;
  s_current_message[0] = '\0';
  s_message_scroll = 0;
  begin_timeout();
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
    s_screen = s_dictation_return_screen;
    render();
    return;
  }
  show_error(ERROR_DICTATION_FAILED, "");
}

static void start_dictation(void) {
  if (!s_dictation) {
    show_error(ERROR_DICTATION_FAILED, "");
    return;
  }
  s_dictation_return_screen = s_screen == SCREEN_FINAL ? SCREEN_FINAL : SCREEN_BROWSE;
  DictationSessionStatus status = dictation_session_start(s_dictation);
  if (status != DictationSessionStatusSuccess) show_error(ERROR_DICTATION_FAILED, "");
}

static void accept_agents(DictionaryIterator *iterator) {
  uint8_t count = tuple_uint(dict_find(iterator, MESSAGE_KEY_AGENT_COUNT), 255);
  if (count > MAX_AGENTS) {
    show_error(ERROR_UPDATE_REQUIRED, "");
    return;
  }
  Agent staging[MAX_AGENTS];
  memset(staging, 0, sizeof(staging));
  for (uint8_t i = 0; i < count; i++) {
    const char *id = tuple_cstring(dict_find(iterator, 100 + i * 2));
    const char *label = tuple_cstring(dict_find(iterator, 101 + i * 2));
    if (!id || !id[0] || !label || !label[0]) return;
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
  cancel_response_timer();
  if (count == 0) {
    s_page_index = 0;
    show_error(ERROR_NO_AGENTS, "");
    return;
  }
  int8_t selected = find_agent(selected_id);
  s_page_index = selected >= 0 ? selected + 1 : 1;
  s_screen = SCREEN_BROWSE;
  s_error = ERROR_NONE;
  render();
}

static void inbox_received(DictionaryIterator *iterator, void *context) {
  uint8_t kind = tuple_uint(dict_find(iterator, MESSAGE_KEY_KIND), 0);
  if (kind == EVENT_AGENTS) {
    accept_agents(iterator);
    return;
  }
  const char *request_id = tuple_cstring(dict_find(iterator, MESSAGE_KEY_REQUEST_ID));
  if (kind == EVENT_ACCEPTED) {
    if (!request_matches(request_id)) return;
    cancel_response_timer();
    s_turn_phase = TURN_WORKING;
    copy_text(s_current_message, sizeof(s_current_message), "WORKING...");
    if (s_screen != SCREEN_BROWSE) s_screen = SCREEN_STREAMING;
    render();
    return;
  }
  if (kind == EVENT_COMMENTARY || kind == EVENT_COMPLETED || kind == EVENT_FAILED) {
    const char *text = tuple_cstring(dict_find(iterator, MESSAGE_KEY_TEXT));
    const char *code = tuple_cstring(dict_find(iterator, MESSAGE_KEY_ERROR_CODE));
    uint8_t index = tuple_uint(dict_find(iterator, MESSAGE_KEY_CHUNK_INDEX), 0);
    uint8_t count = tuple_uint(dict_find(iterator, MESSAGE_KEY_CHUNK_COUNT), 1);
    receive_chunk(kind, request_id, text ? text : "", index, count, code);
    return;
  }
#ifdef AGENTS_QA
  if (kind == EVENT_QA_ERROR) {
    uint8_t error = tuple_uint(dict_find(iterator, MESSAGE_KEY_ERROR_CODE), ERROR_NONE);
    if (error > ERROR_NONE && error <= ERROR_UPDATE_REQUIRED) show_error((ErrorKind)error, "");
  }
#endif
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  if (s_screen == SCREEN_STREAMING) show_error(ERROR_STREAM_LOST, "");
}

static void outbox_failed(DictionaryIterator *iterator, AppMessageResult reason, void *context) {
  cancel_response_timer();
  if (s_screen == SCREEN_SYNCING) {
    show_error(s_refresh_had_cache ? ERROR_REFRESH_FAILED : ERROR_PHONE_UNREACHABLE, "");
  } else if (s_screen == SCREEN_SENDING) {
    s_turn_phase = TURN_IDLE;
    show_error(ERROR_NOT_SENT, "");
  }
}

static void scroll_message(int16_t delta) {
  s_message_scroll = VALUE_CLAMP(s_message_scroll + delta, 0, s_message_max_scroll);
  render();
}

static void update_history_window(void) {
  if (s_history_count == 0) return;
  if (s_history_selected < s_history_first_visible) s_history_first_visible = s_history_selected;
  if (s_history_selected >= s_history_first_visible + 4) {
    s_history_first_visible = s_history_selected - 3;
  }
  s_history_first_visible = VALUE_MAX(
      0, VALUE_MIN(s_history_first_visible, VALUE_MAX(0, s_history_count - 4)));
  reset_marquee();
  render();
}

static void open_history(void) {
  if (s_history_count == 0) return;
  s_history_return_screen = s_screen;
  s_history_selected = s_history_count - 1;
  s_history_first_visible = VALUE_MAX(0, s_history_count - 4);
  reset_marquee();
  s_screen = SCREEN_HISTORY;
  render();
}

static void up_click(ClickRecognizerRef recognizer, void *context) {
  if (s_screen == SCREEN_BROWSE) {
    if (s_page_index > 0) s_page_index--;
    render();
  } else if (s_screen == SCREEN_STREAMING || s_screen == SCREEN_FINAL) {
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
  } else if (s_screen == SCREEN_STREAMING || s_screen == SCREEN_FINAL) {
    scroll_message(SCROLL_STEP);
  } else if (s_screen == SCREEN_HISTORY && s_history_selected + 1 < s_history_count) {
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
  } else if (s_turn_phase == TURN_SENDING) s_screen = SCREEN_SENDING;
  else s_screen = SCREEN_STREAMING;
  render();
}

static void select_click(ClickRecognizerRef recognizer, void *context) {
  if (s_screen == SCREEN_SYNCING || s_screen == SCREEN_SENDING ||
      s_screen == SCREEN_STREAMING || s_screen == SCREEN_HISTORY) return;
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
  if (s_screen == SCREEN_STREAMING || s_screen == SCREEN_FINAL) open_history();
}

static void back_click(ClickRecognizerRef recognizer, void *context) {
  if (s_screen == SCREEN_HISTORY) {
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
    s_turn_phase = TURN_IDLE;
    s_screen = SCREEN_BROWSE;
    render();
    return;
  }
  if (s_screen == SCREEN_ERROR) {
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
  layer_set_clips(s_content_clip, true);
  layer_add_child(root, s_content_clip);
  s_message_layer = make_text(s_content_clip, GRect(8, 0, 184, 198), FONT_KEY_GOTHIC_24,
                              GTextAlignmentLeft);
  text_layer_set_overflow_mode(s_message_layer, GTextOverflowModeWordWrap);
  s_spinner_layer = layer_create(GRect(175, 4, 20, 20));
  layer_set_update_proc(s_spinner_layer, spinner_draw);
  layer_add_child(root, s_spinner_layer);
  s_history_layer = layer_create(GRect(0, 28, bounds.size.w, bounds.size.h - 28));
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
  load_agents();
  s_window = window_create();
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
  }

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(2048, 1024);
  if (s_agent_count == 0) request_agents();
}

static void deinit(void) {
  cancel_response_timer();
  if (s_spinner_timer) app_timer_cancel(s_spinner_timer);
  if (s_marquee_timer) app_timer_cancel(s_marquee_timer);
  if (s_dictation) dictation_session_destroy(s_dictation);
  for (uint8_t i = 0; i < s_history_count; i++) free_history_item(i);
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
