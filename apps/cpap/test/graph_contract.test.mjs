import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const watch = readFileSync(new URL('../src/c/main.c', import.meta.url), 'utf8');

test('graphs use five labeled levels and keep the average below the chart', () => {
  assert.match(watch, /AXIS_LEVELS 5/);
  assert.match(watch, /const int chart_left = 38/);
  assert.match(watch, /const int chart_bottom = 152/);
  assert.match(watch, /level \* chart_height\) \/ \(AXIS_LEVELS - 1\)/);
  assert.match(watch, /axis_font = fonts_get_system_font\(FONT_KEY_GOTHIC_18_BOLD\)/);
  assert.match(watch, /GRect\(1, y - 11, 36, 22\)/);
  assert.match(watch, /GColorLightGray/);
  assert.match(watch, /format_graph_axis/);
  assert.match(watch, /format_graph_average/);
  assert.match(watch, /GRect\(8, 174, bounds\.size\.w - 16, 28\)/);
  assert.doesNotMatch(watch, /average_y|average_marker_/);
});

test('graph maxima make four equal intervals with a zero baseline', () => {
  assert.match(watch, /VIEW_SCORE_GRAPH[\s\S]*return 100/);
  assert.match(watch, /\(maximum \+ 119\) \/ 120\) \* 120/);
  assert.match(watch, /\(maximum \+ 19\) \/ 20\) \* 20/);
  assert.match(watch, /\(maximum \+ 3\) \/ 4\) \* 4/);
  assert.match(watch, /\(maximum \+ 39\) \/ 40\) \* 40/);
  assert.match(watch, /maximum - \(level \* maximum\) \/ \(AXIS_LEVELS - 1\)/);
});
