#ifndef AGENTS_HISTORY_PROJECTION_H
#define AGENTS_HISTORY_PROJECTION_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AGENTS_HISTORY_MAX_ITEMS 16
#define AGENTS_HISTORY_MAX_BYTES 18000

typedef struct {
  char *text;
  bool user;
  size_t bytes;
} AgentsHistoryItem;

typedef struct {
  AgentsHistoryItem items[AGENTS_HISTORY_MAX_ITEMS];
  uint8_t count;
  size_t bytes;
  uint16_t last_sequence;
} AgentsHistoryProjection;

typedef enum {
  AGENTS_HISTORY_ACCEPTED,
  AGENTS_HISTORY_DUPLICATE,
  AGENTS_HISTORY_OUT_OF_ORDER,
  AGENTS_HISTORY_NO_MEMORY,
} AgentsHistoryAppendResult;

void agents_history_init(AgentsHistoryProjection *projection);
void agents_history_restart(AgentsHistoryProjection *projection);
AgentsHistoryAppendResult agents_history_append(
    AgentsHistoryProjection *projection,
    uint16_t sequence,
    const char *text,
    bool user);

#endif
