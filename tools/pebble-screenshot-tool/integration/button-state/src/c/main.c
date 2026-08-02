#include <pebble.h>

static Window *s_window;
static Layer *s_state_layer;
static uint8_t s_state;

static void draw_state(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  const int cell = 10;
  const int gap = 2;
  const int total = 6 * cell + 5 * gap;
  const int start_x = (bounds.size.w - total) / 2;

  for (int bit = 0; bit < 6; ++bit) {
    GRect box = GRect(start_x + bit * (cell + gap), 8, cell, cell);
    bool set = s_state & (1 << (5 - bit));
    graphics_context_set_fill_color(ctx, set ? GColorBlack : GColorWhite);
    graphics_fill_rect(ctx, box, 0, GCornerNone);
    graphics_context_set_stroke_color(ctx, GColorBlack);
    graphics_draw_rect(ctx, box);
  }
}

static void show_state(void) {
#ifdef PBL_COLOR
  window_set_background_color(s_window, (GColor){.argb = (uint8_t)(0xC0 | s_state)});
#else
  window_set_background_color(s_window, GColorWhite);
#endif
  layer_mark_dirty(s_state_layer);
}

static void apply(uint8_t code) {
  if (s_state == 0 && code == 3) {
    return;
  }
  s_state = (uint8_t)((s_state * 13 + code) & 63);
  show_state();
}

static void up_click(ClickRecognizerRef recognizer, void *context) {
  apply(1);
}

static void select_click(ClickRecognizerRef recognizer, void *context) {
  apply(2);
}

static void down_click(ClickRecognizerRef recognizer, void *context) {
  apply(3);
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click);
}

static void init(void) {
  s_window = window_create();
  Layer *root = window_get_root_layer(s_window);
  s_state_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_state_layer, draw_state);
  layer_add_child(root, s_state_layer);
  window_set_click_config_provider(s_window, click_config_provider);
  show_state();
  window_stack_push(s_window, true);
}

static void deinit(void) {
  layer_destroy(s_state_layer);
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
  return 0;
}
