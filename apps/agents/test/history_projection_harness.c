#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "../src/c/history_projection.h"

int main(void) {
  AgentsHistoryProjection history;
  agents_history_init(&history);

  assert(agents_history_append(&history, 1, "old first", true) ==
         AGENTS_HISTORY_ACCEPTED);
  assert(agents_history_append(&history, 2, "old second", false) ==
         AGENTS_HISTORY_ACCEPTED);

  /* A retry is a whole-snapshot replay, not an append to the old prefix. */
  agents_history_restart(&history);
  assert(history.count == 0);
  assert(history.last_sequence == 0);
  assert(agents_history_append(&history, 1, "new first", true) ==
         AGENTS_HISTORY_ACCEPTED);
  assert(agents_history_append(&history, 2, "new second", false) ==
         AGENTS_HISTORY_ACCEPTED);
  assert(history.count == 2);
  assert(strcmp(history.items[0].text, "new first") == 0);
  assert(strcmp(history.items[1].text, "new second") == 0);

  /* Identical replay within one attempt is ignored without duplicating rows. */
  assert(agents_history_append(&history, 2, "new second", false) ==
         AGENTS_HISTORY_DUPLICATE);
  assert(history.count == 2);
  assert(agents_history_append(&history, 4, "gap", false) ==
         AGENTS_HISTORY_OUT_OF_ORDER);
  assert(history.count == 2);

  agents_history_restart(&history);
  puts("history snapshot replay scenarios passed");
  return 0;
}
