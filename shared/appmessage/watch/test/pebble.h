#ifndef APP_MESSAGE_CLIENT_TEST_PEBBLE_H
#define APP_MESSAGE_CLIENT_TEST_PEBBLE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

typedef enum {
  APP_MSG_OK = 0,
  APP_MSG_SEND_TIMEOUT = 1 << 3,
  APP_MSG_NOT_CONNECTED = 1 << 4,
  APP_MSG_INVALID_ARGS = 1 << 5,
  APP_MSG_BUSY = 1 << 6,
  APP_MSG_BUFFER_OVERFLOW = 1 << 7,
  APP_MSG_OUT_OF_MEMORY = 1 << 12,
} AppMessageResult;

typedef enum {
  DICT_OK = 0,
  DICT_NOT_ENOUGH_STORAGE = 1 << 1,
  DICT_INVALID_ARGS = 1 << 2,
} DictionaryResult;

typedef enum { TUPLE_BYTE_ARRAY = 0, TUPLE_CSTRING = 1, TUPLE_UINT = 2, TUPLE_INT = 3 } TupleType;

typedef union {
  uint8_t uint8;
  uint16_t uint16;
  uint32_t uint32;
  int8_t int8;
  int16_t int16;
  int32_t int32;
  char cstring[65];
} TupleValue;

typedef struct {
  uint32_t key;
  TupleType type;
  uint16_t length;
  TupleValue storage;
  TupleValue *value;
} Tuple;

typedef struct DictionaryIterator {
  Tuple tuples[12];
  size_t count;
} DictionaryIterator;

Tuple *dict_find(const DictionaryIterator *iterator, uint32_t key);
DictionaryResult dict_write_uint8(DictionaryIterator *iterator, uint32_t key, uint8_t value);
DictionaryResult dict_write_uint16(DictionaryIterator *iterator, uint32_t key, uint16_t value);
DictionaryResult dict_write_cstring(DictionaryIterator *iterator, uint32_t key, const char *value);

typedef struct AppTimer AppTimer;
typedef void (*AppTimerCallback)(void *context);
AppTimer *app_timer_register(uint32_t timeout_ms, AppTimerCallback callback, void *context);
void app_timer_cancel(AppTimer *timer);

typedef void (*AppMessageInboxReceived)(DictionaryIterator *iterator, void *context);
typedef void (*AppMessageInboxDropped)(AppMessageResult reason, void *context);
typedef void (*AppMessageOutboxSent)(DictionaryIterator *iterator, void *context);
typedef void (*AppMessageOutboxFailed)(
    DictionaryIterator *iterator, AppMessageResult reason, void *context);

AppMessageInboxReceived app_message_register_inbox_received(AppMessageInboxReceived callback);
AppMessageInboxDropped app_message_register_inbox_dropped(AppMessageInboxDropped callback);
AppMessageOutboxSent app_message_register_outbox_sent(AppMessageOutboxSent callback);
AppMessageOutboxFailed app_message_register_outbox_failed(AppMessageOutboxFailed callback);
void app_message_deregister_callbacks(void);
AppMessageResult app_message_open(uint32_t inbox_size, uint32_t outbox_size);
AppMessageResult app_message_outbox_begin(DictionaryIterator **iterator);
AppMessageResult app_message_outbox_send(void);

enum { APP_LOG_LEVEL_DEBUG, APP_LOG_LEVEL_INFO, APP_LOG_LEVEL_WARNING, APP_LOG_LEVEL_ERROR };
void test_app_log(int level, const char *format, ...);
#define APP_LOG(level, ...) test_app_log(level, __VA_ARGS__)

#endif
