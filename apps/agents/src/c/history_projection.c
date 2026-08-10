#include "history_projection.h"

#include <stdlib.h>
#include <string.h>

static void drop_oldest(AgentsHistoryProjection *projection) {
  if (!projection || projection->count == 0) return;
  projection->bytes -= projection->items[0].bytes;
  free(projection->items[0].text);
  for (uint8_t index = 1; index < projection->count; index++) {
    projection->items[index - 1] = projection->items[index];
  }
  projection->count--;
  projection->items[projection->count] = (AgentsHistoryItem){0};
}

void agents_history_init(AgentsHistoryProjection *projection) {
  if (!projection) return;
  memset(projection, 0, sizeof(*projection));
}

void agents_history_restart(AgentsHistoryProjection *projection) {
  if (!projection) return;
  while (projection->count > 0) drop_oldest(projection);
  projection->bytes = 0;
  projection->last_sequence = 0;
}

AgentsHistoryAppendResult agents_history_append(
    AgentsHistoryProjection *projection,
    uint16_t sequence,
    const char *text,
    bool user) {
  if (!projection || !text || !text[0] || sequence == 0 ||
      sequence != projection->last_sequence + 1) {
    return projection && sequence <= projection->last_sequence
        ? AGENTS_HISTORY_DUPLICATE : AGENTS_HISTORY_OUT_OF_ORDER;
  }

  size_t bytes = strlen(text) + 1;
  while (projection->count >= AGENTS_HISTORY_MAX_ITEMS ||
         (projection->count > 0 &&
          projection->bytes + bytes > AGENTS_HISTORY_MAX_BYTES)) {
    drop_oldest(projection);
  }
  char *copy = malloc(bytes);
  if (!copy) return AGENTS_HISTORY_NO_MEMORY;
  memcpy(copy, text, bytes);
  projection->items[projection->count] = (AgentsHistoryItem){
    .text = copy,
    .user = user,
    .bytes = bytes,
  };
  projection->count++;
  projection->bytes += bytes;
  projection->last_sequence = sequence;
  return AGENTS_HISTORY_ACCEPTED;
}
