#include <pebble.h>

static Window *s_window;
static TextLayer *s_header_layer;
static TextLayer *s_date_layer;
static TextLayer *s_time_layer;
static TextLayer *s_weather_label_layer;
static TextLayer *s_weather_layer;
static TextLayer *s_battery_label_layer;
static TextLayer *s_battery_layer;
static TextLayer *s_hint_layer;
static Layer *s_rule_layer;

static char s_time_text[6];
static char s_date_text[20];

static void prv_rule_draw(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorOrange);
  graphics_fill_rect(ctx, GRect(10, 0, bounds.size.w - 20, 3), 0, GCornerNone);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, GRect(10, 104, bounds.size.w - 20, 2), 0, GCornerNone);
}

static TextLayer *prv_text_layer_create(Layer *parent, GRect frame, GFont font,
                                        GTextAlignment alignment, GColor color) {
  TextLayer *layer = text_layer_create(frame);
  text_layer_set_background_color(layer, GColorClear);
  text_layer_set_text_color(layer, color);
  text_layer_set_font(layer, font);
  text_layer_set_text_alignment(layer, alignment);
  layer_add_child(parent, text_layer_get_layer(layer));
  return layer;
}

static void prv_update_time(struct tm *time) {
  strftime(s_time_text, sizeof(s_time_text), clock_is_24h_style() ? "%H:%M" : "%I:%M", time);
  if (!clock_is_24h_style() && s_time_text[0] == '0') {
    memmove(s_time_text, s_time_text + 1, sizeof(s_time_text) - 1);
  }
  strftime(s_date_text, sizeof(s_date_text), "%a  %b %e", time);
  text_layer_set_text(s_time_layer, s_time_text);
  text_layer_set_text(s_date_layer, s_date_text);
}

static void prv_tick_handler(struct tm *time, TimeUnits units_changed) {
  prv_update_time(time);
}

static void prv_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);
  window_set_background_color(window, GColorWhite);

  s_header_layer = prv_text_layer_create(window_layer, GRect(10, 5, bounds.size.w - 20, 18),
      fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD), GTextAlignmentLeft, GColorBlack);
  text_layer_set_text(s_header_layer, "FIELD TIME                         TIME 2");

  s_rule_layer = layer_create(bounds);
  layer_set_update_proc(s_rule_layer, prv_rule_draw);
  layer_add_child(window_layer, s_rule_layer);

  s_date_layer = prv_text_layer_create(window_layer, GRect(0, 35, bounds.size.w, 22),
      fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GTextAlignmentCenter, GColorDarkGray);
  s_time_layer = prv_text_layer_create(window_layer, GRect(0, 56, bounds.size.w, 50),
      fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD), GTextAlignmentCenter, GColorBlack);

  s_weather_label_layer = prv_text_layer_create(window_layer, GRect(10, 116, 100, 16),
      fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD), GTextAlignmentLeft, GColorDarkGray);
  text_layer_set_text(s_weather_label_layer, "WEATHER");
  s_weather_layer = prv_text_layer_create(window_layer, GRect(10, 132, 120, 25),
      fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GTextAlignmentLeft, GColorBlack);
  text_layer_set_text(s_weather_layer, "--°  SYNC NEXT");

  s_battery_label_layer = prv_text_layer_create(window_layer, GRect(bounds.size.w - 76, 116, 66, 16),
      fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD), GTextAlignmentRight, GColorDarkGray);
  text_layer_set_text(s_battery_label_layer, "BATTERY");
  s_battery_layer = prv_text_layer_create(window_layer, GRect(bounds.size.w - 62, 132, 52, 25),
      fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GTextAlignmentRight, GColorBlack);
  text_layer_set_text(s_battery_layer, "OK");

  s_hint_layer = prv_text_layer_create(window_layer, GRect(10, bounds.size.h - 24, bounds.size.w - 20, 16),
      fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD), GTextAlignmentLeft, GColorOrange);
  text_layer_set_text(s_hint_layer, "TAP: DETAILS");
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_header_layer);
  text_layer_destroy(s_date_layer);
  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_weather_label_layer);
  text_layer_destroy(s_weather_layer);
  text_layer_destroy(s_battery_label_layer);
  text_layer_destroy(s_battery_layer);
  text_layer_destroy(s_hint_layer);
  layer_destroy(s_rule_layer);
}

static void prv_init(void) {
  // This is compiled only into the explicit local-development build.
  // Standard builds keep the watch's automatic backlight behavior.
#ifdef CASIO_EMULATOR_BACKLIGHT
  light_enable(true);
#endif
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);

  time_t now = time(NULL);
  struct tm *time = localtime(&now);
  prv_update_time(time);
  tick_timer_service_subscribe(MINUTE_UNIT, prv_tick_handler);
}

static void prv_deinit(void) {
  tick_timer_service_unsubscribe();
#ifdef CASIO_EMULATOR_BACKLIGHT
  light_enable(false);
#endif
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
