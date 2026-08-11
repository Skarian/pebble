#include "error_reporter.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define STORE_MAGIC 0x4552
#define STORE_VERSION 1
#define PERSIST_CHUNK_BYTES 256
#define MIN_STORAGE_BYTES 256
#define MAX_STORAGE_BYTES 2048
#define MAX_PERSIST_CHUNKS (MAX_STORAGE_BYTES / PERSIST_CHUNK_BYTES)
#define ENABLED_KEY_OFFSET 12
#define PAYLOAD_BYTES 196
#define TRUNCATED "[TRUNCATED]"

typedef struct {
  uint16_t magic;
  uint8_t version;
  uint8_t reserved;
  uint32_t generation;
  uint32_t next_sequence;
  uint32_t dropped;
  uint16_t used;
  uint16_t capacity;
} StoreHeader;

typedef struct {
  uint32_t sequence;
  uint32_t at;
  uint16_t payload_bytes;
} RecordHeader;

_Static_assert(sizeof(StoreHeader) == 20, "StoreHeader layout changed");
_Static_assert(sizeof(RecordHeader) == 12, "RecordHeader layout changed");
// Dictionary header + six tuple headers + all values, including the NUL.
_Static_assert(1 + 6 * 7 + 17 + PAYLOAD_BYTES <= PEBBLE_ERROR_OUTBOX_BYTES,
    "diagnostic record exceeds the shared AppMessage outbox");

struct ErrorReporter {
  ErrorReporterConfig config;
  uint8_t *data;
  StoreHeader store;
  bool enabled;
  bool health_reported;
  ErrorReporterWake wake;
  void *wake_context;
};

static int data_key(const ErrorReporter *reporter, uint8_t index) { return (int)reporter->config.persist_key + 1 + index; }

static int enabled_key(const ErrorReporter *reporter) { return (int)reporter->config.persist_key + ENABLED_KEY_OFFSET; }

static void reset_store(ErrorReporter *reporter) {
  reporter->store = (StoreHeader){
      .magic = STORE_MAGIC,
      .version = STORE_VERSION,
      .generation = (uint32_t)time(NULL) ^ reporter->config.persist_key,
      .next_sequence = 1,
      .capacity = reporter->config.storage_bytes,
  };
  if (!reporter->store.generation) reporter->store.generation = 1;
}

static bool allocate_store(ErrorReporter *reporter) {
  if (reporter->data) return true;
  reporter->data = calloc(1, reporter->config.storage_bytes);
  if (reporter->data) return true;
  APP_LOG(APP_LOG_LEVEL_ERROR, "pebble-errors calloc %u",
      (unsigned)reporter->config.storage_bytes);
  return false;
}

static uint16_t first_record_bytes(const ErrorReporter *reporter) {
  if (reporter->store.used < sizeof(RecordHeader)) return 0;
  const RecordHeader *record = (const RecordHeader *)reporter->data;
  uint16_t bytes = sizeof(*record) + record->payload_bytes;
  return bytes <= reporter->store.used ? (uint16_t)bytes : 0;
}

static void drop_first(ErrorReporter *reporter, bool overflow) {
  uint16_t bytes = first_record_bytes(reporter);
  if (!bytes) {
    reset_store(reporter);
    return;
  }
  memmove(reporter->data, reporter->data + bytes, reporter->store.used - bytes);
  reporter->store.used -= bytes;
  if (overflow) reporter->store.dropped++;
}

static void append(ErrorReporter *reporter, uint32_t at, const char *payload) {
  if (!reporter->data) return;
  uint16_t payload_bytes = strlen(payload) + 1;
  uint16_t maximum = reporter->config.storage_bytes - sizeof(RecordHeader);
  if (payload_bytes > maximum) payload_bytes = maximum;
  uint16_t stored_bytes = (uint16_t)((payload_bytes + 3u) & ~3u);
  uint16_t bytes = sizeof(RecordHeader) + stored_bytes;
  while (reporter->store.used && reporter->store.used + bytes > reporter->config.storage_bytes) {
    drop_first(reporter, true);
  }
  RecordHeader *record = (RecordHeader *)(reporter->data + reporter->store.used);
  *record = (RecordHeader){
      .sequence = reporter->store.next_sequence++,
      .at = at,
      .payload_bytes = stored_bytes,
  };
  if (!reporter->store.next_sequence) reporter->store.next_sequence = 1;
  char *stored = (char *)(record + 1);
  memcpy(stored, payload, payload_bytes);
  stored[payload_bytes - 1] = '\0';
  reporter->store.used += bytes;
}

static void note_health(ErrorReporter *reporter, const char *function, int result) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "pebble-errors %s %d", function, result);
  if (!reporter->enabled || reporter->health_reported) return;
  reporter->health_reported = true;
  char payload[PAYLOAD_BYTES];
  snprintf(payload, sizeof(payload),
           "v1\tError\t%s\t%d\tPERSIST_FAIL\t\t"
           "error_reporter.c\t0\tsaving",
           function, result);
  append(reporter, (uint32_t)time(NULL), payload);
}

static bool save(ErrorReporter *reporter) {
  if (!reporter->data) return false;
  uint8_t chunks = (reporter->store.used + PERSIST_CHUNK_BYTES - 1) / PERSIST_CHUNK_BYTES;
  for (uint8_t index = 0; index < chunks; index++) {
    uint16_t offset = index * PERSIST_CHUNK_BYTES;
    uint16_t length = reporter->store.used - offset;
    if (length > PERSIST_CHUNK_BYTES) length = PERSIST_CHUNK_BYTES;
    int result = persist_write_data(data_key(reporter, index), reporter->data + offset, length);
    if (result != length) {
      note_health(reporter, "persist_write_data", result);
      return false;
    }
  }
  int result = persist_write_data((int)reporter->config.persist_key, &reporter->store, sizeof(reporter->store));
  if (result != (int)sizeof(reporter->store)) {
    note_health(reporter, "persist_write_data", result);
    return false;
  }
  return true;
}

static bool records_valid(const ErrorReporter *reporter) {
  uint16_t offset = 0;
  while (offset < reporter->store.used) {
    if (reporter->store.used - offset < (uint16_t)sizeof(RecordHeader)) return false;
    const RecordHeader *record = (const RecordHeader *)(reporter->data + offset);
    uint16_t bytes = sizeof(*record) + record->payload_bytes;
    if (!record->payload_bytes || (record->payload_bytes & 3u) ||
        bytes > reporter->store.used - offset) {
      return false;
    }
    offset += bytes;
  }
  return offset == reporter->store.used;
}

static bool load(ErrorReporter *reporter) {
  if (!reporter->data) return false;
  int size = persist_get_size((int)reporter->config.persist_key);
  if (size < 0) return true;
  int result = size == (int)sizeof(reporter->store)
                   ? persist_read_data((int)reporter->config.persist_key, &reporter->store, sizeof(reporter->store))
                   : size;
  if (result != (int)sizeof(reporter->store) || reporter->store.magic != STORE_MAGIC || reporter->store.version != STORE_VERSION ||
      reporter->store.capacity != reporter->config.storage_bytes || !reporter->store.generation || !reporter->store.next_sequence ||
      reporter->store.used > reporter->config.storage_bytes)
    return false;
  uint8_t chunks = (reporter->store.used + PERSIST_CHUNK_BYTES - 1) / PERSIST_CHUNK_BYTES;
  for (uint8_t index = 0; index < chunks; index++) {
    uint16_t offset = index * PERSIST_CHUNK_BYTES;
    uint16_t length = reporter->store.used - offset;
    if (length > PERSIST_CHUNK_BYTES) length = PERSIST_CHUNK_BYTES;
    if (persist_get_size(data_key(reporter, index)) != length ||
        persist_read_data(data_key(reporter, index), reporter->data + offset, length) != length) {
      return false;
    }
  }
  return records_valid(reporter);
}

static void mark_truncated(char *text, size_t size) {
  size_t marker = sizeof(TRUNCATED);
  if (size >= marker) memcpy(text + size - marker, TRUNCATED, marker);
}

static void copy_field(char *out, size_t size, const char *value) {
  value = value ? value : "";
  size_t index = 0;
  while (*value && index + 1 < size) {
    if (*value == '\t' || *value == '\r' || *value == '\n' || *value == '\\') {
      if (index + 2 >= size) break;
      out[index++] = '\\';
      out[index++] = *value == '\t' ? 't' : *value == '\r' ? 'r' : *value == '\n' ? 'n' : '\\';
    } else {
      out[index++] = *value;
    }
    value++;
  }
  out[index] = '\0';
  if (*value) mark_truncated(out, size);
}

ErrorReporter *error_reporter_create(const ErrorReporterConfig *config) {
  if (!config || config->storage_bytes < MIN_STORAGE_BYTES || config->storage_bytes > MAX_STORAGE_BYTES ||
      config->persist_key > INT_MAX - ENABLED_KEY_OFFSET)
    return NULL;
  ErrorReporter *reporter = calloc(1, sizeof(*reporter));
  if (!reporter) return NULL;
  reporter->config = *config;
  bool enabled = persist_exists(enabled_key(reporter)) &&
      persist_read_bool(enabled_key(reporter));
  reset_store(reporter);
  if (enabled && allocate_store(reporter)) {
    reporter->enabled = true;
  }
  if (reporter->enabled && !load(reporter)) {
    reset_store(reporter);
    note_health(reporter, "loading diagnostic queue", -1);
  }
  return reporter;
}

void error_reporter_destroy(ErrorReporter *reporter) {
  if (!reporter) return;
  free(reporter->data);
  free(reporter);
}

void error_reporter_set_enabled(ErrorReporter *reporter, bool enabled) {
  if (!reporter) return;
  if (reporter->enabled == enabled) return;
  if (enabled) {
    if (!allocate_store(reporter)) return;
    reporter->enabled = true;
    reset_store(reporter);
    reporter->health_reported = false;
    int result = persist_write_bool(enabled_key(reporter), true);
    if (result < 0) note_health(reporter, "persist_write_bool", result);
    save(reporter);
    return;
  }
  reporter->enabled = false;
  reporter->health_reported = false;
  // A durable false tombstone makes stale queue data harmless if cleanup fails.
  int result = persist_write_bool(enabled_key(reporter), false);
  if (result < 0) {
    note_health(reporter, "persist_write_bool", result);
    result = persist_delete(enabled_key(reporter));
    if (result < 0) note_health(reporter, "persist_delete", result);
  }
  for (uint8_t index = 0; index < MAX_PERSIST_CHUNKS; index++) {
    persist_delete(data_key(reporter, index));
  }
  persist_delete((int)reporter->config.persist_key);
  free(reporter->data);
  reporter->data = NULL;
  reset_store(reporter);
}

bool error_reporter_is_enabled(const ErrorReporter *reporter) { return reporter && reporter->enabled; }

void error_reporter_report_at(ErrorReporter *reporter, ErrorValue error, const char *while_doing, const char *file, uint16_t line) {
  if (!reporter || !reporter->enabled || !reporter->data) return;
  char function[28], symbol[24], message[48], source_file[40], action[40];
  copy_field(function, sizeof(function), error.function);
  copy_field(symbol, sizeof(symbol), error.symbol);
  copy_field(message, sizeof(message), error.message);
  const char *base = file ? strrchr(file, '/') : NULL;
  copy_field(source_file, sizeof(source_file), base ? base + 1 : file);
  copy_field(action, sizeof(action), while_doing);
  char payload[PAYLOAD_BYTES];
  int length = snprintf(payload, sizeof(payload), "v1\tError\t%s\t%ld\t%s\t%s\t%s\t%u\t%s", function, (long)error.code, symbol, message,
                        source_file, (unsigned)line, action);
  if (length < 0) {
    snprintf(payload, sizeof(payload), "v1\tError\tsnprintf\t%d\tFORMAT_ERROR\t\t%s\t%u\tcapturing watch error", length, source_file,
             (unsigned)line);
  } else if ((size_t)length >= sizeof(payload)) {
    mark_truncated(payload, sizeof(payload));
  }
  append(reporter, (uint32_t)time(NULL), payload);
  save(reporter);
  if (reporter->wake) reporter->wake(reporter->wake_context);
}

void error_reporter_attach(ErrorReporter *reporter, ErrorReporterWake wake, void *context) {
  if (!reporter) return;
  reporter->wake = wake;
  reporter->wake_context = context;
}

bool error_reporter_has_pending(const ErrorReporter *reporter) {
  return reporter && reporter->enabled && reporter->data && reporter->store.used;
}

DictionaryResult error_reporter_write_pending(ErrorReporter *reporter, DictionaryIterator *iterator) {
  if (!error_reporter_has_pending(reporter) || !iterator) return DICT_INVALID_ARGS;
  DictionaryResult result = dict_write_uint8(iterator, PEBBLE_ERROR_COMMAND_KEY, PEBBLE_ERROR_COMMAND_IMPORT);
  if (result == DICT_OK) result = dict_write_uint32(iterator, PEBBLE_ERROR_GENERATION_KEY, reporter->store.generation);
  if (result == DICT_OK) result = dict_write_uint32(iterator, PEBBLE_ERROR_SEQUENCE_KEY, ((RecordHeader *)reporter->data)->sequence);
  if (result == DICT_OK) result = dict_write_uint32(iterator, PEBBLE_ERROR_AT_KEY, ((RecordHeader *)reporter->data)->at);
  if (result == DICT_OK) result = dict_write_cstring(iterator, PEBBLE_ERROR_DATA_KEY, (char *)(((RecordHeader *)reporter->data) + 1));
  if (result == DICT_OK) result = dict_write_uint32(iterator, PEBBLE_ERROR_DROPPED_KEY, reporter->store.dropped);
  return result;
}

bool error_reporter_accept_ack(ErrorReporter *reporter, DictionaryIterator *iterator) {
  if (!error_reporter_has_pending(reporter) || !iterator) return false;
  const RecordHeader *record = (const RecordHeader *)reporter->data;
  Tuple *command = dict_find(iterator, PEBBLE_ERROR_COMMAND_KEY);
  Tuple *generation = dict_find(iterator, PEBBLE_ERROR_GENERATION_KEY);
  Tuple *sequence = dict_find(iterator, PEBBLE_ERROR_SEQUENCE_KEY);
  if (!command || command->type != TUPLE_UINT || command->length != 1 ||
      command->value->uint8 != PEBBLE_ERROR_COMMAND_ACK || !generation ||
      generation->type != TUPLE_UINT || generation->length != 4 ||
      generation->value->uint32 != reporter->store.generation || !sequence ||
      sequence->type != TUPLE_UINT || sequence->length != 4 ||
      sequence->value->uint32 != record->sequence) {
    return false;
  }
  drop_first(reporter, false);
  reporter->store.dropped = 0;
  save(reporter);
  return true;
}

#ifdef ERROR_REPORTER_TESTING
bool error_reporter_has_storage(const ErrorReporter *reporter) {
  return reporter && reporter->data;
}
#endif
