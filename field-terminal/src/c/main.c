#include <pebble.h>

#define COLOR_SHADOW GColorDarkGreen
#define COLOR_DIM GColorIslamicGreen
#define COLOR_MID GColorGreen
#define COLOR_PRIMARY GColorBrightGreen
#define COLOR_BRIGHT GColorMintGreen

typedef struct {
  char time_text[8];
  char am_pm_text[3];
  char compact_date[12];
  char expanded_date[24];
  char battery_text[5];
  int hour;
  int minute;
  uint8_t battery_percent;
  bool is_24h;
  bool is_charging;
  bool is_plugged;
} FaceState;

static Window *s_window;
static Layer *s_canvas_layer;
static GFont s_time_font;
static GFont s_battery_font;
static GFont s_label_bold_font;
static GFont s_label_font;
static FaceState s_state;
static AppTimer *s_animation_timer;
static int8_t s_animation_frame = -1;

enum {
  ANIMATION_INTERVAL_MS = 50,
  ANIMATION_LAST_FRAME = 6,
  BACKLIGHT_RGB = 0x0000FF00
};

static void prv_uppercase(char *text) {
  if (!text) {
    return;
  }

  for (char *cursor = text; *cursor; ++cursor) {
    if (*cursor >= 'a' && *cursor <= 'z') {
      *cursor -= 'a' - 'A';
    }
  }
}

static void prv_draw_text(GContext *ctx, const char *text, GFont font,
                          GRect frame, GColor color,
                          GTextAlignment alignment) {
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text, font, frame,
                     GTextOverflowModeTrailingEllipsis, alignment, NULL);
}

static void prv_draw_glow_text(GContext *ctx, const char *text, GFont font,
                               GRect frame, GTextAlignment alignment) {
  GRect shadow = frame;
  shadow.origin.x += 1;
  shadow.origin.y += 1;
  prv_draw_text(ctx, text, font, shadow, COLOR_DIM, alignment);
  prv_draw_text(ctx, text, font, frame, COLOR_BRIGHT, alignment);
}

static void prv_draw_chassis(GContext *ctx) {
  graphics_context_set_stroke_width(ctx, 2);
  graphics_context_set_stroke_color(ctx, COLOR_PRIMARY);
  graphics_draw_rect(ctx, GRect(4, 4, 192, 220));

  graphics_context_set_stroke_width(ctx, 1);
  graphics_context_set_stroke_color(ctx, COLOR_DIM);
  graphics_draw_rect(ctx, GRect(7, 7, 186, 214));

  const GPoint screws[] = {
    GPoint(7, 7), GPoint(193, 7),
    GPoint(7, 221), GPoint(193, 221)
  };

  for (unsigned int i = 0; i < ARRAY_LENGTH(screws); ++i) {
    graphics_context_set_stroke_color(ctx, COLOR_PRIMARY);
    graphics_draw_circle(ctx, screws[i], 1);
    graphics_draw_line(ctx,
                       GPoint(screws[i].x - 1, screws[i].y + 1),
                       GPoint(screws[i].x + 1, screws[i].y - 1));
  }
}

static void prv_draw_scanlines(GContext *ctx) {
  graphics_context_set_stroke_width(ctx, 1);
  graphics_context_set_stroke_color(ctx, COLOR_SHADOW);

  for (int y = 8; y <= 220; y += 8) {
    graphics_draw_line(ctx, GPoint(8, y), GPoint(192, y));
  }
}

static void prv_draw_panels(GContext *ctx) {
  graphics_context_set_fill_color(ctx, COLOR_SHADOW);
  graphics_fill_rect(ctx, GRect(10, 10, 180, 20), 0, GCornerNone);

  graphics_context_set_stroke_width(ctx, 1);
  graphics_context_set_stroke_color(ctx, COLOR_PRIMARY);
  graphics_draw_rect(ctx, GRect(10, 10, 180, 20));
  graphics_draw_rect(ctx, GRect(10, 34, 180, 64));
  graphics_draw_rect(ctx, GRect(10, 102, 180, 50));
  graphics_draw_rect(ctx, GRect(10, 156, 180, 58));
  graphics_draw_line(ctx, GPoint(10, 29), GPoint(190, 29));

  graphics_context_set_stroke_color(ctx, COLOR_DIM);
  graphics_draw_line(ctx, GPoint(15, 94), GPoint(185, 94));
  for (int x = 15; x <= 185; x += 17) {
    graphics_draw_line(ctx, GPoint(x, 92), GPoint(x, 96));
  }
}

static void prv_draw_scope(GContext *ctx) {
  graphics_context_set_stroke_width(ctx, 1);
  graphics_context_set_stroke_color(ctx, COLOR_DIM);
  graphics_draw_line(ctx, GPoint(14, 133), GPoint(186, 133));

  for (int x = 42; x <= 182; x += 28) {
    graphics_draw_line(ctx, GPoint(x, 121), GPoint(x, 145));
  }

  graphics_context_set_stroke_color(ctx, COLOR_MID);
  graphics_draw_line(ctx, GPoint(14, 120), GPoint(20, 120));
  graphics_draw_line(ctx, GPoint(14, 120), GPoint(14, 126));
  graphics_draw_line(ctx, GPoint(180, 120), GPoint(186, 120));
  graphics_draw_line(ctx, GPoint(186, 120), GPoint(186, 126));
  graphics_draw_line(ctx, GPoint(14, 140), GPoint(14, 146));
  graphics_draw_line(ctx, GPoint(14, 146), GPoint(20, 146));
  graphics_draw_line(ctx, GPoint(180, 146), GPoint(186, 146));
  graphics_draw_line(ctx, GPoint(186, 140), GPoint(186, 146));

  const int seed = s_state.hour * 7 + s_state.minute;
  GPoint previous = GPoint(16, 133 + ((seed % 17) - 8));
  for (int i = 1; i <= 12; ++i) {
    const GPoint current = GPoint(
      16 + i * 14,
      133 + (((seed + i * 11 + i * i * 3) % 17) - 8)
    );
    graphics_draw_line(ctx, previous, current);
    previous = current;
  }

  graphics_context_set_fill_color(ctx, COLOR_BRIGHT);
  graphics_fill_circle(ctx, previous, 1);
}

static void prv_draw_battery(GContext *ctx) {
  graphics_context_set_stroke_width(ctx, 1);
  graphics_context_set_stroke_color(ctx, COLOR_PRIMARY);
  graphics_draw_rect(ctx, GRect(72, 163, 114, 17));

  int filled_segments = 0;
  if (s_state.battery_percent > 0) {
    filled_segments = (s_state.battery_percent + 9) / 10;
  }
  if (filled_segments > 10) {
    filled_segments = 10;
  }

  for (int i = 0; i < 10; ++i) {
    const GRect segment = GRect(75 + i * 11, 166, 9, 11);
    if (i < filled_segments) {
      graphics_context_set_fill_color(ctx, COLOR_BRIGHT);
      graphics_fill_rect(ctx, segment, 0, GCornerNone);
    } else {
      graphics_context_set_stroke_color(ctx, COLOR_DIM);
      graphics_draw_rect(ctx, segment);
    }
  }

  graphics_context_set_stroke_color(ctx, COLOR_DIM);
  graphics_draw_line(ctx, GPoint(72, 202), GPoint(186, 202));

  if (s_state.is_charging) {
    graphics_context_set_stroke_color(ctx, COLOR_BRIGHT);
    graphics_draw_line(ctx, GPoint(21, 202), GPoint(27, 202));
    graphics_draw_line(ctx, GPoint(27, 202), GPoint(24, 207));
    graphics_draw_line(ctx, GPoint(24, 207), GPoint(30, 207));
    graphics_draw_line(ctx, GPoint(30, 207), GPoint(23, 212));
  }
}

static void prv_draw_labels(GContext *ctx) {
  prv_draw_text(ctx, "FIELD TERMINAL", s_label_bold_font,
                GRect(14, 10, 102, 18), COLOR_BRIGHT,
                GTextAlignmentLeft);
  prv_draw_text(ctx, s_state.compact_date, s_label_bold_font,
                GRect(116, 10, 70, 18), COLOR_BRIGHT,
                GTextAlignmentRight);

  prv_draw_text(ctx, "TIME // LOCAL", s_label_bold_font,
                GRect(14, 35, 110, 16), COLOR_MID,
                GTextAlignmentLeft);

  const GRect time_frame = s_state.is_24h
    ? GRect(14, 47, 172, 44)
    : GRect(14, 47, 144, 44);
  prv_draw_glow_text(ctx, s_state.time_text, s_time_font,
                     time_frame, GTextAlignmentCenter);

  if (!s_state.is_24h) {
    prv_draw_text(ctx, s_state.am_pm_text, s_label_bold_font,
                  GRect(160, 63, 24, 18), COLOR_BRIGHT,
                  GTextAlignmentCenter);
  }

  prv_draw_text(ctx, "CHRONO SIGNAL", s_label_bold_font,
                GRect(14, 103, 106, 16), COLOR_MID,
                GTextAlignmentLeft);
  prv_draw_text(ctx, "STABLE", s_label_bold_font,
                GRect(128, 103, 58, 16), COLOR_BRIGHT,
                GTextAlignmentRight);

  prv_draw_text(ctx, "CELL", s_label_bold_font,
                GRect(14, 158, 52, 14), COLOR_MID,
                GTextAlignmentLeft);
  prv_draw_glow_text(ctx, s_state.battery_text, s_battery_font,
                     GRect(14, 171, 52, 29), GTextAlignmentLeft);

  const char *power_label = s_state.is_charging
    ? "CHG"
    : (s_state.is_plugged ? "FULL" : "NOM");
  prv_draw_text(ctx, power_label, s_label_font,
                GRect(14, 199, 52, 14), COLOR_BRIGHT,
                GTextAlignmentLeft);

  prv_draw_text(ctx, s_state.expanded_date, s_label_bold_font,
                GRect(72, 183, 114, 18), COLOR_BRIGHT,
                GTextAlignmentRight);
  prv_draw_text(ctx,
                s_state.is_plugged ? "EXTERNAL POWER" : "INTERNAL POWER",
                s_label_font, GRect(72, 201, 114, 13),
                COLOR_MID, GTextAlignmentRight);
}

static void prv_draw_animation(GContext *ctx) {
  if (s_animation_frame < 0) {
    return;
  }

  const int y = 36 + s_animation_frame * 28;
  int bright_x = 15 + ((s_state.minute * 13
                       + s_animation_frame * 19) % 151);
  if (bright_x > 167) {
    bright_x = 167;
  }

  graphics_context_set_stroke_width(ctx, 1);
  graphics_context_set_stroke_color(ctx, COLOR_DIM);
  graphics_draw_line(ctx, GPoint(12, y - 2), GPoint(188, y - 2));

  graphics_context_set_stroke_color(ctx, COLOR_MID);
  graphics_draw_line(ctx, GPoint(12, y), GPoint(188, y));

  graphics_context_set_stroke_width(ctx, 2);
  graphics_context_set_stroke_color(ctx, COLOR_BRIGHT);
  graphics_draw_line(ctx, GPoint(bright_x, y),
                     GPoint(bright_x + 18, y));
}

static void prv_canvas_update_proc(Layer *layer, GContext *ctx) {
  const GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  prv_draw_scanlines(ctx);
  prv_draw_chassis(ctx);
  prv_draw_panels(ctx);
  prv_draw_scope(ctx);
  prv_draw_battery(ctx);
  prv_draw_labels(ctx);
  prv_draw_animation(ctx);
}

static void prv_update_time(struct tm *tick_time) {
  if (!tick_time) {
    return;
  }

  s_state.hour = tick_time->tm_hour;
  s_state.minute = tick_time->tm_min;
  s_state.is_24h = clock_is_24h_style();

  if (s_state.is_24h) {
    strftime(s_state.time_text, sizeof(s_state.time_text), "%H:%M",
             tick_time);
    s_state.am_pm_text[0] = '\0';
  } else {
    strftime(s_state.time_text, sizeof(s_state.time_text), "%I:%M",
             tick_time);
    if (s_state.time_text[0] == '0') {
      memmove(s_state.time_text, s_state.time_text + 1,
              sizeof(s_state.time_text) - 1);
    }
    strftime(s_state.am_pm_text, sizeof(s_state.am_pm_text), "%p",
             tick_time);
  }

  strftime(s_state.compact_date, sizeof(s_state.compact_date),
           "%a %m/%d", tick_time);
  strftime(s_state.expanded_date, sizeof(s_state.expanded_date),
           "%a // %b %d", tick_time);
  prv_uppercase(s_state.compact_date);
  prv_uppercase(s_state.expanded_date);
}

static void prv_update_battery(BatteryChargeState charge_state) {
  s_state.battery_percent = charge_state.charge_percent;
  s_state.is_charging = charge_state.is_charging;
  s_state.is_plugged = charge_state.is_plugged;
  snprintf(s_state.battery_text, sizeof(s_state.battery_text), "%u%%",
           s_state.battery_percent);
}

static void prv_animation_timer_callback(void *context) {
  (void)context;
  s_animation_timer = NULL;

  if (s_animation_frame < ANIMATION_LAST_FRAME) {
    ++s_animation_frame;
    if (s_canvas_layer) {
      layer_mark_dirty(s_canvas_layer);
    }
    s_animation_timer = app_timer_register(
      ANIMATION_INTERVAL_MS, prv_animation_timer_callback, NULL);
    return;
  }

  s_animation_frame = -1;
  if (s_canvas_layer) {
    layer_mark_dirty(s_canvas_layer);
  }
}

static void prv_start_animation(void) {
  if (s_animation_timer) {
    app_timer_cancel(s_animation_timer);
    s_animation_timer = NULL;
  }

  s_animation_frame = 0;
  if (s_canvas_layer) {
    layer_mark_dirty(s_canvas_layer);
  }
  s_animation_timer = app_timer_register(
    ANIMATION_INTERVAL_MS, prv_animation_timer_callback, NULL);
}

static void prv_tick_handler(struct tm *tick_time,
                             TimeUnits units_changed) {
  (void)units_changed;
  prv_update_time(tick_time);
  prv_start_animation();
}

static void prv_battery_handler(BatteryChargeState charge_state) {
  prv_update_battery(charge_state);
  if (s_canvas_layer) {
    layer_mark_dirty(s_canvas_layer);
  }
}

static void prv_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  const GRect bounds = layer_get_bounds(window_layer);

  s_canvas_layer = layer_create(bounds);
  if (!s_canvas_layer) {
    return;
  }

  layer_set_update_proc(s_canvas_layer, prv_canvas_update_proc);
  layer_add_child(window_layer, s_canvas_layer);
}

static void prv_window_appear(Window *window) {
  (void)window;
  light_set_color_rgb888(BACKLIGHT_RGB);
}

static void prv_window_unload(Window *window) {
  (void)window;
  if (s_canvas_layer) {
    layer_destroy(s_canvas_layer);
    s_canvas_layer = NULL;
  }
}

static void prv_init(void) {
  light_set_color_rgb888(BACKLIGHT_RGB);

#ifdef FIELD_TERMINAL_EMULATOR_BACKLIGHT
  light_enable(true);
#endif

  s_time_font = fonts_get_system_font(FONT_KEY_LECO_32_BOLD_NUMBERS);
  s_battery_font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  s_label_bold_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  s_label_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);

  time_t now = time(NULL);
  struct tm *current_time = localtime(&now);
  prv_update_time(current_time);
  prv_update_battery(battery_state_service_peek());

  s_window = window_create();
  if (!s_window) {
    return;
  }

  window_set_background_color(s_window, GColorBlack);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .appear = prv_window_appear,
    .unload = prv_window_unload
  });
  window_stack_push(s_window, true);

  tick_timer_service_subscribe(MINUTE_UNIT, prv_tick_handler);
  battery_state_service_subscribe(prv_battery_handler);
}

static void prv_deinit(void) {
  if (s_animation_timer) {
    app_timer_cancel(s_animation_timer);
    s_animation_timer = NULL;
  }
  tick_timer_service_unsubscribe();
  battery_state_service_unsubscribe();

#ifdef FIELD_TERMINAL_EMULATOR_BACKLIGHT
  light_enable(false);
#endif
  light_set_system_color();

  if (s_window) {
    window_destroy(s_window);
    s_window = NULL;
  }
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
