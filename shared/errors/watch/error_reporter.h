#ifndef PEBBLE_ERROR_REPORTER_H
#define PEBBLE_ERROR_REPORTER_H

#include <pebble.h>

#define PEBBLE_ERROR_COMMAND_KEY 120
#define PEBBLE_ERROR_GENERATION_KEY 121
#define PEBBLE_ERROR_SEQUENCE_KEY 122
#define PEBBLE_ERROR_AT_KEY 123
#define PEBBLE_ERROR_DATA_KEY 124
#define PEBBLE_ERROR_DROPPED_KEY 125
#define PEBBLE_ERROR_ENABLED_KEY 126
#define PEBBLE_ERROR_OUTBOX_BYTES 256

#define PEBBLE_ERROR_COMMAND_IMPORT 1
#define PEBBLE_ERROR_COMMAND_ACK 2

typedef struct ErrorReporter ErrorReporter;

typedef struct {
  const char *function;
  int32_t code;
  const char *symbol, *message;
} ErrorValue;

typedef struct { uint32_t persist_key; uint16_t storage_bytes; } ErrorReporterConfig;

typedef void (*ErrorReporterWake)(void *context);

ErrorReporter *error_reporter_create(const ErrorReporterConfig *config);
void error_reporter_destroy(ErrorReporter *reporter);
void error_reporter_set_enabled(ErrorReporter *reporter, bool enabled);
bool error_reporter_is_enabled(const ErrorReporter *reporter);

void error_reporter_report_at(
    ErrorReporter *reporter, ErrorValue error, const char *while_doing,
    const char *file, uint16_t line);

#define ERROR_REPORT(reporter, error, while_doing) \
  error_reporter_report_at((reporter), (error), (while_doing), __FILE__, (uint16_t)__LINE__)

#define ERROR_REPORT_NULL(reporter, value, function, while_doing) do { \
  if (!(value)) ERROR_REPORT((reporter), \
      ((ErrorValue){(function), 0, "NULL_RETURN", NULL}), (while_doing)); \
} while (0)

void error_reporter_attach(ErrorReporter *reporter, ErrorReporterWake wake, void *context);
bool error_reporter_has_pending(const ErrorReporter *reporter);
DictionaryResult error_reporter_write_pending(ErrorReporter *reporter, DictionaryIterator *iterator);
bool error_reporter_accept_ack(ErrorReporter *reporter, DictionaryIterator *iterator);

#ifdef ERROR_REPORTER_TESTING
bool error_reporter_has_storage(const ErrorReporter *reporter);
#endif

#endif
