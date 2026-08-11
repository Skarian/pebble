#include <assert.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../app_message_client.h"

struct AppTimer {
  uint32_t delay;
  AppTimerCallback callback;
  void *context;
  bool cancelled;
};

static struct AppTimer s_timers[96];
static size_t s_timer_count;
static AppMessageInboxReceived s_inbox_received;
static AppMessageInboxDropped s_inbox_dropped;
static AppMessageOutboxSent s_outbox_sent;
static AppMessageOutboxFailed s_outbox_failed;
static unsigned s_registration_count;
static bool s_registered_before_open;
static DictionaryIterator s_building;
static DictionaryIterator s_sent[32];
static size_t s_sent_count;
static AppMessageResult s_send_results[16];
static size_t s_send_result_count;
static size_t s_send_result_index;
static bool s_enforce_single_outbox, s_outbox_pending;
static unsigned s_busy_begins;

typedef struct {
  int key;
  uint8_t data[256];
  size_t size;
  bool used;
} Persisted;

static Persisted s_persisted[8];
static unsigned s_persist_writes;
static unsigned s_persist_failures;
static unsigned s_persist_delete_failures;
static unsigned s_error_logs;
#define NEW_REPORTER() error_reporter_create(&(ErrorReporterConfig){9000, 1536})

void test_app_log(int level, const char *format, ...) {
  if (level == APP_LOG_LEVEL_ERROR) s_error_logs++;
  (void)format;
}

static void fix_tuple_pointers(DictionaryIterator *iterator) {
  for (size_t index = 0; index < iterator->count; index++) {
    iterator->tuples[index].value = &iterator->tuples[index].storage;
  }
}

static Tuple *append_tuple(DictionaryIterator *iterator, uint32_t key) {
  assert(iterator->count < sizeof(iterator->tuples) / sizeof(iterator->tuples[0]));
  Tuple *tuple = &iterator->tuples[iterator->count++];
  memset(tuple, 0, sizeof(*tuple));
  tuple->key = key;
  tuple->value = &tuple->storage;
  return tuple;
}

Tuple *dict_find(const DictionaryIterator *iterator, uint32_t key) {
  if (!iterator) return NULL;
  for (size_t index = 0; index < iterator->count; index++) {
    if (iterator->tuples[index].key == key) {
      return (Tuple *)&iterator->tuples[index];
    }
  }
  return NULL;
}

DictionaryResult dict_write_uint8(
    DictionaryIterator *iterator, uint32_t key, uint8_t value) {
  Tuple *tuple = append_tuple(iterator, key);
  tuple->type = TUPLE_UINT;
  tuple->length = 1;
  tuple->value->uint8 = value;
  return DICT_OK;
}

DictionaryResult dict_write_uint16(
    DictionaryIterator *iterator, uint32_t key, uint16_t value) {
  Tuple *tuple = append_tuple(iterator, key);
  tuple->type = TUPLE_UINT;
  tuple->length = 2;
  tuple->value->uint16 = value;
  return DICT_OK;
}

DictionaryResult dict_write_uint32(
    DictionaryIterator *iterator, uint32_t key, uint32_t value) {
  Tuple *tuple = append_tuple(iterator, key);
  tuple->type = TUPLE_UINT;
  tuple->length = 4;
  tuple->value->uint32 = value;
  return DICT_OK;
}

DictionaryResult dict_write_cstring(
    DictionaryIterator *iterator, uint32_t key, const char *value) {
  Tuple *tuple = append_tuple(iterator, key);
  tuple->type = TUPLE_CSTRING;
  snprintf(tuple->value->cstring, sizeof(tuple->value->cstring), "%s", value);
  tuple->length = (uint16_t)strlen(tuple->value->cstring) + 1;
  return DICT_OK;
}

static Persisted *persisted(int key, bool create) {
  for (size_t index = 0; index < sizeof(s_persisted) / sizeof(s_persisted[0]); index++) {
    if (s_persisted[index].used && s_persisted[index].key == key) return &s_persisted[index];
  }
  if (!create) return NULL;
  for (size_t index = 0; index < sizeof(s_persisted) / sizeof(s_persisted[0]); index++) {
    if (!s_persisted[index].used) {
      s_persisted[index].used = true;
      s_persisted[index].key = key;
      return &s_persisted[index];
    }
  }
  return NULL;
}

bool persist_exists(int key) { return persisted(key, false) != NULL; }

int persist_get_size(int key) {
  Persisted *value = persisted(key, false);
  return value ? (int)value->size : -1;
}

int persist_read_data(int key, void *buffer, size_t size) {
  Persisted *value = persisted(key, false);
  if (!value || size < value->size) return -1;
  memcpy(buffer, value->data, value->size);
  return (int)value->size;
}

int persist_write_data(int key, const void *data, size_t size) {
  if (s_persist_failures) {
    s_persist_failures--;
    return -9;
  }
  Persisted *value = persisted(key, true);
  if (!value || size > sizeof(value->data)) return -1;
  memcpy(value->data, data, size);
  value->size = size;
  s_persist_writes++;
  return (int)size;
}

bool persist_read_bool(int key) {
  Persisted *value = persisted(key, false);
  return value && value->size == 1 && value->data[0] != 0;
}

int persist_write_bool(int key, bool value) {
  uint8_t stored = value ? 1 : 0;
  return persist_write_data(key, &stored, sizeof(stored));
}

int persist_delete(int key) {
  if (s_persist_delete_failures) {
    s_persist_delete_failures--;
    return -9;
  }
  Persisted *value = persisted(key, false);
  if (!value) return 0;
  memset(value, 0, sizeof(*value));
  return 0;
}

AppTimer *app_timer_register(
    uint32_t timeout_ms, AppTimerCallback callback, void *context) {
  assert(s_timer_count < sizeof(s_timers) / sizeof(s_timers[0]));
  AppTimer *timer = &s_timers[s_timer_count++];
  *timer = (AppTimer){.delay = timeout_ms, .callback = callback, .context = context};
  return timer;
}

void app_timer_cancel(AppTimer *timer) {
  if (timer) timer->cancelled = true;
}

static AppTimer *next_timer(void) {
  for (size_t index = 0; index < s_timer_count; index++) {
    if (!s_timers[index].cancelled && s_timers[index].callback) return &s_timers[index];
  }
  return NULL;
}

static void fire_next_timer(void) {
  AppTimer *timer = next_timer();
  assert(timer);
  AppTimerCallback callback = timer->callback;
  void *context = timer->context;
  timer->cancelled = true;
  callback(context);
}

AppMessageInboxReceived app_message_register_inbox_received(
    AppMessageInboxReceived callback) {
  AppMessageInboxReceived previous = s_inbox_received;
  s_inbox_received = callback;
  s_registration_count++;
  return previous;
}

AppMessageInboxDropped app_message_register_inbox_dropped(
    AppMessageInboxDropped callback) {
  AppMessageInboxDropped previous = s_inbox_dropped;
  s_inbox_dropped = callback;
  s_registration_count++;
  return previous;
}

AppMessageOutboxSent app_message_register_outbox_sent(
    AppMessageOutboxSent callback) {
  AppMessageOutboxSent previous = s_outbox_sent;
  s_outbox_sent = callback;
  s_registration_count++;
  return previous;
}

AppMessageOutboxFailed app_message_register_outbox_failed(
    AppMessageOutboxFailed callback) {
  AppMessageOutboxFailed previous = s_outbox_failed;
  s_outbox_failed = callback;
  s_registration_count++;
  return previous;
}

void app_message_deregister_callbacks(void) {
  s_inbox_received = NULL;
  s_inbox_dropped = NULL;
  s_outbox_sent = NULL;
  s_outbox_failed = NULL;
}

AppMessageResult app_message_open(uint32_t inbox_size, uint32_t outbox_size) {
  assert(inbox_size > 0 && outbox_size > 0);
  s_registered_before_open = s_registration_count == 4 && s_inbox_received &&
      s_inbox_dropped && s_outbox_sent && s_outbox_failed;
  return APP_MSG_OK;
}

AppMessageResult app_message_outbox_begin(DictionaryIterator **iterator) {
  if (s_enforce_single_outbox && s_outbox_pending) {
    *iterator = NULL;
    s_busy_begins++;
    return APP_MSG_BUSY;
  }
  memset(&s_building, 0, sizeof(s_building));
  *iterator = &s_building;
  return APP_MSG_OK;
}

AppMessageResult app_message_outbox_send(void) {
  assert(s_sent_count < sizeof(s_sent) / sizeof(s_sent[0]));
  s_sent[s_sent_count] = s_building;
  fix_tuple_pointers(&s_sent[s_sent_count]);
  s_sent_count++;
  AppMessageResult result = s_send_result_index < s_send_result_count
      ? s_send_results[s_send_result_index++] : APP_MSG_OK;
  if (s_enforce_single_outbox && result == APP_MSG_OK) s_outbox_pending = true;
  return result;
}

typedef struct {
  unsigned payload_writes;
  unsigned responses;
  unsigned unsolicited;
  unsigned failures;
  AppMessageResponseAction actions[8];
  size_t action_count;
  size_t action_index;
  AppMessageFailureInfo last_failure;
  char failed_id[APP_MESSAGE_CLIENT_ID_CAPACITY];
} Harness;

static DictionaryResult write_payload(
    DictionaryIterator *iterator,
    const AppMessageClientStatus *request,
    void *context) {
  (void)request;
  Harness *harness = context;
  harness->payload_writes++;
  return dict_write_uint8(iterator, 42, 7);
}

static AppMessageResponseAction receive_response(
    DictionaryIterator *iterator,
    const AppMessageClientStatus *request,
    void *context) {
  (void)iterator;
  assert(request->request_id[0]);
  Harness *harness = context;
  harness->responses++;
  if (harness->action_index < harness->action_count) {
    return harness->actions[harness->action_index++];
  }
  return APP_MESSAGE_RESPONSE_DONE;
}

static void receive_unsolicited(
    DictionaryIterator *iterator, void *context) {
  (void)iterator;
  Harness *harness = context;
  harness->unsolicited++;
}

static void request_failed(
    const AppMessageFailureInfo *failure,
    void *context) {
  Harness *harness = context;
  harness->failures++;
  harness->last_failure = *failure;
  snprintf(harness->failed_id, sizeof(harness->failed_id), "%s", failure->request_id);
  harness->last_failure.request_id = harness->failed_id;
}

static AppMessageClient *open_client(
    Harness *harness, AppMessageRequestIdCodec codec);

static AppMessageClient *open_client_with_errors(
    Harness *harness, AppMessageRequestIdCodec codec, ErrorReporter *errors) {
  AppMessageClientConfig config = {
    .inbox_size = 256,
    .outbox_size = 128,
    .protocol = {
      .protocol_key = 9,
      .command_key = 0,
      .request_id_key = 1,
      .protocol_version = 1,
      .ready_command = 19,
      .reconcile_command = 3,
      .request_id_codec = codec,
    },
    .write_payload = write_payload,
    .response_received = receive_response,
    .unsolicited_received = receive_unsolicited,
    .request_failed = request_failed,
    .errors = errors,
    .context = harness,
  };
  AppMessageResult result;
  AppMessageClient *client = app_message_client_open(&config, &result);
  assert(client && result == APP_MSG_OK && s_registered_before_open);
  return client;
}

static AppMessageClient *open_client(
    Harness *harness, AppMessageRequestIdCodec codec) {
  return open_client_with_errors(harness, codec, NULL);
}

static void reset_runtime(void) {
  memset(s_timers, 0, sizeof(s_timers));
  s_timer_count = 0;
  s_registration_count = 0;
  s_registered_before_open = false;
  memset(s_sent, 0, sizeof(s_sent));
  s_sent_count = 0;
  memset(s_send_results, 0, sizeof(s_send_results));
  s_send_result_count = 0;
  s_send_result_index = 0;
  s_enforce_single_outbox = s_outbox_pending = false;
  s_busy_begins = 0;
}

static void reset_persistence(void) {
  memset(s_persisted, 0, sizeof(s_persisted));
  s_persist_writes = 0;
  s_persist_failures = 0;
  s_persist_delete_failures = 0;
  s_error_logs = 0;
}

static const char *sent_id(size_t index) {
  Tuple *tuple = dict_find(&s_sent[index], 1);
  assert(tuple);
  static char numeric[8];
  if (tuple->type == TUPLE_CSTRING) return tuple->value->cstring;
  snprintf(numeric, sizeof(numeric), "%u", tuple->value->uint16);
  return numeric;
}

static uint8_t sent_command(size_t index) {
  Tuple *tuple = dict_find(&s_sent[index], 0);
  assert(tuple);
  return tuple->value->uint8;
}

static uint8_t sent_token(size_t index) {
  Tuple *tuple = dict_find(&s_sent[index], 255);
  assert(tuple);
  return tuple->value->uint8;
}

static void acknowledge(size_t index) {
  assert(s_outbox_sent);
  s_outbox_pending = false;
  s_outbox_sent(&s_sent[index], NULL);
}

static void reject_async(size_t index, AppMessageResult reason) {
  assert(s_outbox_failed);
  s_outbox_pending = false;
  s_outbox_failed(&s_sent[index], reason, NULL);
}

static void receive_ready(void) {
  DictionaryIterator message = {0};
  dict_write_uint8(&message, 9, 1);
  dict_write_uint8(&message, 0, 19);
  dict_write_uint8(&message, PEBBLE_ERROR_ENABLED_KEY, 1);
  s_inbox_received(&message, NULL);
}

static void receive_error_ack(size_t sent_index) {
  DictionaryIterator message = {0};
  Tuple *generation = dict_find(&s_sent[sent_index], PEBBLE_ERROR_GENERATION_KEY);
  Tuple *sequence = dict_find(&s_sent[sent_index], PEBBLE_ERROR_SEQUENCE_KEY);
  assert(generation && sequence);
  dict_write_uint8(
      &message, PEBBLE_ERROR_COMMAND_KEY, PEBBLE_ERROR_COMMAND_ACK);
  dict_write_uint32(
      &message, PEBBLE_ERROR_GENERATION_KEY, generation->value->uint32);
  dict_write_uint32(
      &message, PEBBLE_ERROR_SEQUENCE_KEY, sequence->value->uint32);
  s_inbox_received(&message, NULL);
}

static void receive_id(const char *id, AppMessageRequestIdCodec codec) {
  DictionaryIterator message = {0};
  dict_write_uint8(&message, 9, 1);
  dict_write_uint8(&message, 0, 10);
  if (codec == APP_MESSAGE_ID_CSTRING) dict_write_cstring(&message, 1, id);
  else dict_write_uint16(&message, 1, (uint16_t)atoi(id));
  s_inbox_received(&message, NULL);
}

static void test_ready_grace_and_lost_ready(void) {
  reset_runtime();
  Harness h = {0};
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_UINT16);
  assert(app_message_client_start(
      client, 1, APP_MESSAGE_OPERATION_READ, NULL, APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_STARTED);
  assert(s_sent_count == 0);
  receive_ready();
  assert(s_sent_count == 1);
  acknowledge(0);
  assert(next_timer()->delay == 30000);
  receive_id("1", APP_MESSAGE_ID_UINT16);
  assert(!app_message_client_is_active(client));
  app_message_client_close(client);

  reset_runtime();
  h = (Harness){0};
  client = open_client(&h, APP_MESSAGE_ID_UINT16);
  assert(app_message_client_start(
      client, 1, APP_MESSAGE_OPERATION_READ, NULL, APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_STARTED);
  assert(next_timer()->delay == 1500);
  fire_next_timer();
  assert(s_sent_count == 1);
  receive_ready();
  assert(s_sent_count == 1);
  acknowledge(0);
  receive_id("1", APP_MESSAGE_ID_UINT16);
  app_message_client_close(client);
}

static void test_send_failures_retry_same_identity(void) {
  reset_runtime();
  Harness h = {0};
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_CSTRING);
  receive_ready();
  s_send_results[0] = APP_MSG_BUSY;
  s_send_results[1] = APP_MSG_OK;
  s_send_result_count = 2;
  assert(app_message_client_start(
      client, 2, APP_MESSAGE_OPERATION_READ, "retry-1", APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_STARTED);
  fire_next_timer();
  reject_async(1, APP_MSG_NOT_CONNECTED);
  fire_next_timer();
  assert(s_sent_count == 3);
  assert(strcmp(sent_id(0), sent_id(1)) == 0);
  assert(strcmp(sent_id(1), sent_id(2)) == 0);
  assert(sent_token(0) != sent_token(1) && sent_token(1) != sent_token(2));
  acknowledge(2);
  receive_id("retry-1", APP_MESSAGE_ID_CSTRING);
  assert(h.failures == 0 && !app_message_client_is_active(client));
  app_message_client_close(client);
}

static void test_coalesce_stale_and_read_resend(void) {
  reset_runtime();
  Harness h = {0};
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_CSTRING);
  receive_ready();
  assert(app_message_client_start(
      client, 4, APP_MESSAGE_OPERATION_READ, "read-7", APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_STARTED);
  assert(app_message_client_start(
      client, 4, APP_MESSAGE_OPERATION_READ, "read-7", APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_COALESCED);
  assert(app_message_client_start(
      client, 4, APP_MESSAGE_OPERATION_READ, "read-8", APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_BUSY);
  acknowledge(0);
  receive_id("stale-6", APP_MESSAGE_ID_CSTRING);
  assert(h.responses == 0 && app_message_client_is_active(client));
  fire_next_timer();
  fire_next_timer();
  assert(s_sent_count == 2 && strcmp(sent_id(0), sent_id(1)) == 0);
  acknowledge(1);
  receive_id("read-7", APP_MESSAGE_ID_CSTRING);
  assert(h.responses == 1 && !app_message_client_is_active(client));
  app_message_client_close(client);
}

static void test_mutation_timeout_reconciles_without_replaying(void) {
  reset_runtime();
  Harness h = {
    .actions = {
      APP_MESSAGE_RESPONSE_MORE,
      APP_MESSAGE_RESPONSE_MORE,
      APP_MESSAGE_RESPONSE_DONE,
    },
    .action_count = 3,
  };
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_CSTRING);
  receive_ready();
  assert(app_message_client_start(
      client, 2, APP_MESSAGE_OPERATION_MUTATION, "turn-1", APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_STARTED);
  assert(sent_command(0) == 2);
  acknowledge(0);
  receive_id("turn-1", APP_MESSAGE_ID_CSTRING);  // ACCEPTED
  receive_id("turn-1", APP_MESSAGE_ID_CSTRING);  // COMMENTARY
  assert(h.responses == 2 && app_message_client_is_active(client));
  // The terminal update is lost. The shared response timeout reconciles the
  // same logical turn rather than replaying its primary mutation.
  fire_next_timer();
  assert(s_sent_count == 2);
  assert(sent_command(1) == 3);
  assert(strcmp(sent_id(0), sent_id(1)) == 0);
  acknowledge(1);
  receive_id("turn-1", APP_MESSAGE_ID_CSTRING);
  assert(h.responses == 3 && !app_message_client_is_active(client));
  assert(s_sent_count == 2);
  app_message_client_close(client);
}

static void test_more_then_done_and_late_outbox_ignored(void) {
  reset_runtime();
  Harness h = {
    .actions = {APP_MESSAGE_RESPONSE_MORE, APP_MESSAGE_RESPONSE_DONE},
    .action_count = 2,
  };
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_CSTRING);
  receive_ready();
  app_message_client_start(
      client, 1, APP_MESSAGE_OPERATION_READ, "stream-1", APP_MESSAGE_SEND_PRIMARY);
  acknowledge(0);
  receive_id("stream-1", APP_MESSAGE_ID_CSTRING);
  assert(app_message_client_is_active(client));
  receive_id("stream-1", APP_MESSAGE_ID_CSTRING);
  assert(!app_message_client_is_active(client));

  app_message_client_start(
      client, 1, APP_MESSAGE_OPERATION_READ, "late-1", APP_MESSAGE_SEND_PRIMARY);
  fire_next_timer();
  fire_next_timer();
  assert(s_sent_count == 3);
  reject_async(1, APP_MSG_NOT_CONNECTED);
  assert(app_message_client_status(client)->state == APP_MESSAGE_CLIENT_WAITING_OUTBOX);
  acknowledge(2);
  receive_id("late-1", APP_MESSAGE_ID_CSTRING);
  app_message_client_close(client);
}

static void test_failure_reports_delivery_certainty(void) {
  reset_runtime();
  Harness h = {0};
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_CSTRING);
  receive_ready();
  s_send_results[0] = APP_MSG_BUSY;
  s_send_results[1] = APP_MSG_BUSY;
  s_send_results[2] = APP_MSG_BUSY;
  s_send_result_count = 3;
  app_message_client_start(
      client, 2, APP_MESSAGE_OPERATION_MUTATION, "fail-1", APP_MESSAGE_SEND_PRIMARY);
  fire_next_timer();
  fire_next_timer();
  assert(h.failures == 1);
  assert(h.last_failure.failure == APP_MESSAGE_FAILURE_DELIVERY);
  assert(h.last_failure.delivery == APP_MESSAGE_DELIVERY_NOT_SENT);
  assert(strcmp(h.last_failure.request_id, "fail-1") == 0);
  app_message_client_close(client);
}

static void test_outbox_timeout_preserves_unknown_delivery_across_retries(void) {
  reset_runtime();
  Harness h = {0};
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_CSTRING);
  receive_ready();
  s_send_results[0] = APP_MSG_OK;
  s_send_results[1] = APP_MSG_BUSY;
  s_send_results[2] = APP_MSG_BUSY;
  s_send_results[3] = APP_MSG_BUSY;
  s_send_result_count = 4;
  app_message_client_start(
      client, 2, APP_MESSAGE_OPERATION_MUTATION, "maybe-1",
      APP_MESSAGE_SEND_PRIMARY);

  fire_next_timer();  // The first outbox callback is lost; delivery is unknown.
  fire_next_timer();  // Retry is synchronously rejected.
  fire_next_timer();
  fire_next_timer();  // Bounded BUSY contention reports the whole request.

  assert(s_sent_count == 4);
  assert(strcmp(sent_id(0), sent_id(1)) == 0);
  assert(strcmp(sent_id(1), sent_id(2)) == 0);
  assert(h.failures == 1);
  assert(h.last_failure.failure == APP_MESSAGE_FAILURE_DELIVERY);
  assert(h.last_failure.delivery == APP_MESSAGE_DELIVERY_UNKNOWN);
  assert(strcmp(h.last_failure.request_id, "maybe-1") == 0);
  app_message_client_close(client);
}

static void test_error_relay_is_durable_idempotent_and_business_first(void) {
  reset_runtime();
  reset_persistence();
  ErrorReporter *errors = NEW_REPORTER();
  assert(errors && !error_reporter_is_enabled(errors) &&
      !error_reporter_has_storage(errors));
  ERROR_REPORT(errors, ((ErrorValue){
    .function = "disabled", .code = 1,
    .symbol = "DISABLED", .message = "not stored",
  }), "testing disabled reporter");
  assert(s_persist_writes == 0 && !error_reporter_has_pending(errors));
  error_reporter_set_enabled(errors, true);
  assert(error_reporter_has_storage(errors));

  Harness h = {0};
  AppMessageClient *client = open_client_with_errors(
      &h, APP_MESSAGE_ID_CSTRING, errors);
  receive_ready();
  s_enforce_single_outbox = true;
  ERROR_REPORT(errors, ((ErrorValue){
    .function = "first_failure", .code = 17,
    .symbol = "TEST_FAILED", .message = "original failure",
  }), "running shared harness");
  assert(s_sent_count == 1);
  assert(dict_find(&s_sent[0], PEBBLE_ERROR_COMMAND_KEY)->value->uint8 ==
      PEBBLE_ERROR_COMMAND_IMPORT);
  const char *raw = dict_find(&s_sent[0], PEBBLE_ERROR_DATA_KEY)->value->cstring;
  assert(strstr(raw, "v1\tError\tfirst_failure\t17\tTEST_FAILED\t") == raw);
  assert(strstr(raw, "\tapp_message_client_harness.c\t") != NULL);
  assert(strstr(raw, "\trunning shared harness") != NULL);

  // A user operation preempts diagnostics even before the outbox callback.
  assert(app_message_client_start(
      client, 2, APP_MESSAGE_OPERATION_READ, "business-1",
      APP_MESSAGE_SEND_PRIMARY) == APP_MESSAGE_START_STARTED);
  assert(s_sent_count == 1 && s_busy_begins == 0);
  reject_async(0, APP_MSG_NOT_CONNECTED);  // Its callback releases business.
  assert(s_sent_count == 2 && sent_command(1) == 2 && s_busy_begins == 0);
  assert(error_reporter_has_pending(errors) && s_sent_count == 2);
  acknowledge(1);
  receive_id("business-1", APP_MESSAGE_ID_CSTRING);
  assert(s_sent_count == 3);
  acknowledge(2);
  receive_error_ack(2);
  assert(!error_reporter_has_pending(errors));

  // Losing the application ACK resends the same persisted generation/sequence.
  ERROR_REPORT(errors, ((ErrorValue){
    .function = "second_failure", .code = 23,
    .symbol = "SECOND_FAILED", .message = "retry me",
  }), "testing lost import acknowledgement");
  assert(s_sent_count == 4);
  acknowledge(3);
  assert(next_timer() == NULL);
  receive_ready();  // A reconnect retries the same durable record.
  assert(s_sent_count == 5);
  assert(dict_find(&s_sent[3], PEBBLE_ERROR_GENERATION_KEY)->value->uint32 ==
      dict_find(&s_sent[4], PEBBLE_ERROR_GENERATION_KEY)->value->uint32);
  assert(dict_find(&s_sent[3], PEBBLE_ERROR_SEQUENCE_KEY)->value->uint32 ==
      dict_find(&s_sent[4], PEBBLE_ERROR_SEQUENCE_KEY)->value->uint32);
  acknowledge(4);
  receive_error_ack(4);
  assert(!error_reporter_has_pending(errors));

  app_message_client_close(client);
  error_reporter_destroy(errors);
}

static void test_error_outbox_busy_never_consumes_a_business_attempt(void) {
  reset_runtime();
  reset_persistence();
  ErrorReporter *errors = NEW_REPORTER();
  error_reporter_set_enabled(errors, true);
  Harness h = {0};
  AppMessageClient *client = open_client_with_errors(
      &h, APP_MESSAGE_ID_CSTRING, errors);
  receive_ready();
  s_enforce_single_outbox = true;
  ERROR_REPORT(errors, ((ErrorValue){
    .function = "diagnostic_first", .code = 7, .symbol = "TEST_FAILURE",
  }), "testing a genuinely busy outbox");
  assert(s_sent_count == 1 && s_outbox_pending);
  assert(app_message_client_start(
      client, 2, APP_MESSAGE_OPERATION_READ, "business-busy",
      APP_MESSAGE_SEND_PRIMARY) == APP_MESSAGE_START_STARTED);

  fire_next_timer();  // The diagnostic callback is late; a real outbox is BUSY.
  assert(s_busy_begins == 1 && s_sent_count == 1 && h.failures == 0);
  s_send_results[0] = APP_MSG_NOT_CONNECTED;
  s_send_results[1] = APP_MSG_NOT_CONNECTED;
  s_send_results[2] = APP_MSG_OK;
  s_send_result_count = 3;
  reject_async(0, APP_MSG_NOT_CONNECTED);  // Frees the real outbox immediately.
  assert(s_sent_count == 2 && h.failures == 0);
  fire_next_timer();
  fire_next_timer();
  assert(s_sent_count == 4 && h.failures == 0);
  acknowledge(3);
  receive_id("business-busy", APP_MESSAGE_ID_CSTRING);
  app_message_client_close(client);
  error_reporter_destroy(errors);
}

static void test_lost_error_outbox_callback_retries_on_natural_events(void) {
  reset_runtime();
  reset_persistence();
  ErrorReporter *errors = NEW_REPORTER();
  error_reporter_set_enabled(errors, true);
  Harness h = {0};
  AppMessageClient *client = open_client_with_errors(
      &h, APP_MESSAGE_ID_CSTRING, errors);
  receive_ready();
  s_enforce_single_outbox = true;

  ERROR_REPORT(errors, ((ErrorValue){
    .function = "lost_ready", .code = 31, .symbol = "LOST_CALLBACK",
  }), "testing READY recovery");
  assert(s_sent_count == 1 && next_timer() == NULL);
  s_outbox_pending = false;  // Core completes without invoking the callback.
  receive_ready();
  assert(s_sent_count == 2);
  assert(dict_find(&s_sent[0], PEBBLE_ERROR_GENERATION_KEY)->value->uint32 ==
      dict_find(&s_sent[1], PEBBLE_ERROR_GENERATION_KEY)->value->uint32);
  assert(dict_find(&s_sent[0], PEBBLE_ERROR_SEQUENCE_KEY)->value->uint32 ==
      dict_find(&s_sent[1], PEBBLE_ERROR_SEQUENCE_KEY)->value->uint32);
  acknowledge(1);
  receive_error_ack(1);

  ERROR_REPORT(errors, ((ErrorValue){
    .function = "lost_error", .code = 37, .symbol = "LOST_CALLBACK",
  }), "testing new-error recovery");
  assert(s_sent_count == 3 && next_timer() == NULL);
  s_outbox_pending = false;
  ERROR_REPORT(errors, ((ErrorValue){
    .function = "next_error", .code = 41, .symbol = "NEXT_ERROR",
  }), "waking the relay naturally");
  assert(s_sent_count == 4);
  assert(dict_find(&s_sent[2], PEBBLE_ERROR_GENERATION_KEY)->value->uint32 ==
      dict_find(&s_sent[3], PEBBLE_ERROR_GENERATION_KEY)->value->uint32);
  assert(dict_find(&s_sent[2], PEBBLE_ERROR_SEQUENCE_KEY)->value->uint32 ==
      dict_find(&s_sent[3], PEBBLE_ERROR_SEQUENCE_KEY)->value->uint32);
  acknowledge(3);
  receive_error_ack(3);
  acknowledge(4);
  receive_error_ack(4);
  assert(!error_reporter_has_pending(errors));

  app_message_client_close(client);
  error_reporter_destroy(errors);
}

static void test_error_buffer_survives_restart_counts_overflow_and_disables(void) {
  reset_runtime();
  reset_persistence();
  ErrorReporterConfig config = {.persist_key = 9000, .storage_bytes = 1536};
  ErrorReporter *errors = error_reporter_create(&config);
  assert(errors);
  error_reporter_set_enabled(errors, true);
  for (int index = 0; index < 30; index++) {
    ERROR_REPORT(errors, ((ErrorValue){
      .function = "overflow", .code = index,
      .symbol = "TEST_FAILURE", .message = "bounded source failure",
    }), "filling the watch staging buffer");
  }
  assert(error_reporter_has_pending(errors));
  error_reporter_destroy(errors);

  errors = error_reporter_create(&config);
  assert(errors && error_reporter_has_pending(errors));
  Harness h = {0};
  AppMessageClient *client = open_client_with_errors(
      &h, APP_MESSAGE_ID_CSTRING, errors);
  receive_ready();
  assert(s_sent_count == 1);
  Tuple *dropped = dict_find(&s_sent[0], PEBBLE_ERROR_DROPPED_KEY);
  assert(dropped && dropped->value->uint32 > 0);
  app_message_client_close(client);

  s_persist_delete_failures = 32;
  error_reporter_set_enabled(errors, false);
  assert(!error_reporter_has_pending(errors) &&
      !error_reporter_has_storage(errors));
  error_reporter_destroy(errors);
  errors = error_reporter_create(&config);
  assert(errors && !error_reporter_is_enabled(errors) &&
      !error_reporter_has_pending(errors));
  error_reporter_destroy(errors);
}

static void test_odd_record_length_keeps_following_header_aligned(void) {
  reset_runtime();
  reset_persistence();
  ErrorReporter *errors = NEW_REPORTER();
  error_reporter_set_enabled(errors, true);
  ERROR_REPORT(errors, ((ErrorValue){
    .function = "odd", .code = 1, .symbol = "ODD", .message = "x",
  }), "forcing an odd record length");
  ERROR_REPORT(errors, ((ErrorValue){
    .function = "second", .code = 2, .symbol = "SECOND",
  }), "reading the aligned next record");

  Harness h = {0};
  AppMessageClient *client = open_client_with_errors(
      &h, APP_MESSAGE_ID_CSTRING, errors);
  receive_ready();
  const char *first = dict_find(&s_sent[0], PEBBLE_ERROR_DATA_KEY)->value->cstring;
  assert((12 + strlen(first) + 1) % 4 != 0);
  acknowledge(0);
  receive_error_ack(0);
  assert(strstr(dict_find(&s_sent[1], PEBBLE_ERROR_DATA_KEY)->value->cstring,
      "\tsecond\t2\tSECOND\t") != NULL);
  app_message_client_close(client);
  error_reporter_destroy(errors);
}

static void test_failed_disable_marker_falls_back_to_delete(void) {
  reset_runtime();
  reset_persistence();
  ErrorReporterConfig config = {.persist_key = 9000, .storage_bytes = 1536};
  ErrorReporter *errors = error_reporter_create(&config);
  error_reporter_set_enabled(errors, true);
  s_persist_failures = 1;
  error_reporter_set_enabled(errors, false);
  assert(!error_reporter_is_enabled(errors) && s_error_logs == 1);
  error_reporter_destroy(errors);

  errors = error_reporter_create(&config);
  assert(errors && !error_reporter_is_enabled(errors) &&
      !error_reporter_has_pending(errors));
  error_reporter_destroy(errors);
}

static void test_reporter_failure_keeps_source_and_one_health_record(void) {
  reset_runtime();
  reset_persistence();
  ErrorReporter *errors = NEW_REPORTER();
  error_reporter_set_enabled(errors, true);
  s_persist_failures = 1;
  ERROR_REPORT(errors, ((ErrorValue){
    .function = "source_failure", .code = 51,
    .symbol = "SOURCE_FAILED",
  }), "preserving the source failure");

  Harness h = {0};
  AppMessageClient *client = open_client_with_errors(
      &h, APP_MESSAGE_ID_CSTRING, errors);
  receive_ready();
  assert(strstr(dict_find(&s_sent[0], PEBBLE_ERROR_DATA_KEY)->value->cstring,
      "\tsource_failure\t51\tSOURCE_FAILED\t") != NULL);
  acknowledge(0);
  receive_error_ack(0);
  assert(s_sent_count == 2);
  assert(strstr(dict_find(&s_sent[1], PEBBLE_ERROR_DATA_KEY)->value->cstring,
      "v1\tError\tpersist_write_data\t-9\tPERSIST_FAIL\t") != NULL);
  acknowledge(1);
  receive_error_ack(1);
  assert(!error_reporter_has_pending(errors) && s_sent_count == 2);
  app_message_client_close(client);
  error_reporter_destroy(errors);
}

static void test_tuple_readers_reject_wrong_types_lengths_and_strings(void) {
  Tuple tuple = {0};
  tuple.value = &tuple.storage;
  uint32_t unsigned_value; int32_t signed_value;
  const char *text; const uint8_t *data;
  uint16_t length;

  tuple.type = TUPLE_UINT; tuple.length = 4;
  tuple.value->uint32 = 1234;
  assert(app_message_tuple_uint(&tuple, &unsigned_value) &&
      unsigned_value == 1234);
  tuple.length = 3;
  assert(!app_message_tuple_uint(&tuple, &unsigned_value));
  tuple.type = TUPLE_INT; tuple.length = 4;
  tuple.value->int32 = -7;
  assert(!app_message_tuple_uint(&tuple, &unsigned_value));
  assert(app_message_tuple_int(&tuple, &signed_value) && signed_value == -7);

  tuple.type = TUPLE_CSTRING; tuple.length = 5;
  memcpy(tuple.value->cstring, "safe", 5);
  assert(app_message_tuple_cstring(&tuple, &text) && !strcmp(text, "safe"));
  tuple.length = 4;
  assert(!app_message_tuple_cstring(&tuple, &text));
  memcpy(tuple.value->cstring, "x\0y", 4);
  assert(!app_message_tuple_cstring(&tuple, &text));
  tuple.type = TUPLE_BYTE_ARRAY; tuple.length = 4;
  assert(app_message_tuple_data(&tuple, &data, &length) &&
      data == tuple.value->data && length == 4);
  tuple.type = TUPLE_CSTRING;
  assert(!app_message_tuple_data(&tuple, &data, &length));
}

int main(void) {
  reset_persistence();
  test_ready_grace_and_lost_ready();
  test_send_failures_retry_same_identity();
  test_coalesce_stale_and_read_resend();
  test_mutation_timeout_reconciles_without_replaying();
  test_more_then_done_and_late_outbox_ignored();
  test_failure_reports_delivery_certainty();
  test_outbox_timeout_preserves_unknown_delivery_across_retries();
  test_error_relay_is_durable_idempotent_and_business_first();
  test_error_outbox_busy_never_consumes_a_business_attempt();
  test_lost_error_outbox_callback_retries_on_natural_events();
  test_error_buffer_survives_restart_counts_overflow_and_disables();
  test_odd_record_length_keeps_following_header_aligned();
  test_failed_disable_marker_falls_back_to_delete();
  test_reporter_failure_keeps_source_and_one_health_record();
  test_tuple_readers_reject_wrong_types_lengths_and_strings();
  puts("app message client behavioral scenarios passed");
  return 0;
}
