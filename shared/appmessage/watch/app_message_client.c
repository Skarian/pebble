#include "app_message_client.h"

#include <stdlib.h>
#include <string.h>

#define APP_MESSAGE_INTERNAL_ATTEMPT_KEY 255
#define READY_GRACE_MS 1500
#define OUTBOX_TIMEOUT_MS 5000
#define RESPONSE_TIMEOUT_MS 30000
#define RETRY_BACKOFF_MS 400
#define MAX_PRIMARY_ATTEMPTS 3
#define MAX_RECONCILE_ATTEMPTS 2
#define MAX_BUSY_RETRIES 3

typedef enum {
  ERROR_IDLE = 0,
  ERROR_OUTBOX,
  ERROR_WAITING_ACK,
} ErrorSendState;

struct AppMessageClient {
  AppMessageClientConfig config;
  AppMessageClientStatus status;
  AppMessageOperationType operation_type;
  AppTimer *timer;
  uint16_t next_numeric_id;
  uint8_t primary_attempts;
  uint8_t reconcile_attempts;
  uint8_t attempt_token;
  bool active;
  bool opened;
  bool phone_ready;
  bool acknowledged;
  bool delivery_unknown;
  ErrorSendState error_state;
  uint8_t busy_retries;
  char request_id[APP_MESSAGE_CLIENT_ID_CAPACITY];
};

static AppMessageClient *s_open_client;

static void timer_fired(void *context);
static void try_send_error(AppMessageClient *client);
static void send_attempt(AppMessageClient *client);
static void fail_request(
    AppMessageClient *client, AppMessageClientFailure failure,
    AppMessageResult result);

static void cancel_timer(AppMessageClient *client) {
  if (!client->timer) return;
  app_timer_cancel(client->timer);
  client->timer = NULL;
}

#define SYMBOL_CASE(value) case value: return #value

static const char *app_message_symbol(AppMessageResult result) {
  switch (result) {
    SYMBOL_CASE(APP_MSG_SEND_TIMEOUT); SYMBOL_CASE(APP_MSG_SEND_REJECTED);
    SYMBOL_CASE(APP_MSG_NOT_CONNECTED); SYMBOL_CASE(APP_MSG_APP_NOT_RUNNING);
    SYMBOL_CASE(APP_MSG_INVALID_ARGS); SYMBOL_CASE(APP_MSG_BUSY);
    SYMBOL_CASE(APP_MSG_BUFFER_OVERFLOW); SYMBOL_CASE(APP_MSG_ALREADY_RELEASED);
    SYMBOL_CASE(APP_MSG_CALLBACK_ALREADY_REGISTERED);
    SYMBOL_CASE(APP_MSG_CALLBACK_NOT_REGISTERED); SYMBOL_CASE(APP_MSG_OUT_OF_MEMORY);
    SYMBOL_CASE(APP_MSG_CLOSED);
    default: return "APP_MSG_UNKNOWN";
  }
}

static const char *dictionary_symbol(DictionaryResult result) {
  switch (result) {
    SYMBOL_CASE(DICT_NOT_ENOUGH_STORAGE); SYMBOL_CASE(DICT_INVALID_ARGS);
    SYMBOL_CASE(DICT_INTERNAL_INCONSISTENCY); SYMBOL_CASE(DICT_MALLOC_FAILED);
    default: return "DICT_UNKNOWN";
  }
}

static void report_source(
    AppMessageClient *client, ErrorValue error, const char *while_doing) {
  if (client && client->config.errors) {
    error_reporter_report_at(client->config.errors, error, while_doing,
        __FILE__, (uint16_t)__LINE__);
  }
}

static void report_app_message(
    AppMessageClient *client, const char *function, AppMessageResult result,
    const char *while_doing) {
  report_source(client, (ErrorValue){
    .function = function, .code = result,
    .symbol = app_message_symbol(result),
  }, while_doing);
}

static void notify_state(AppMessageClient *client, AppMessageClientState state) {
  client->status.state = state;
  if (client->config.state_changed) {
    client->config.state_changed(&client->status, client->config.context);
  }
}

static bool arm_timer(AppMessageClient *client, uint32_t delay_ms) {
  cancel_timer(client);
  client->timer = app_timer_register(delay_ms ? delay_ms : 1, timer_fired, client);
  if (client->timer) return true;
  report_source(client, (ErrorValue){
    .function = "app_timer_register", .code = 0,
    .symbol = "NULL_RETURN",
  }, "scheduling AppMessage timeout");
  if (client->active) {
    fail_request(client, APP_MESSAGE_FAILURE_DELIVERY, APP_MSG_OUT_OF_MEMORY);
  }
  return false;
}

static uint8_t attempts(const AppMessageClient *client) {
  return client->status.send_kind == APP_MESSAGE_SEND_RECONCILE
      ? client->reconcile_attempts : client->primary_attempts;
}

static uint8_t max_attempts(const AppMessageClient *client) {
  return client->status.send_kind == APP_MESSAGE_SEND_RECONCILE
      ? MAX_RECONCILE_ATTEMPTS : MAX_PRIMARY_ATTEMPTS;
}

static void reset_request(AppMessageClient *client) {
  cancel_timer(client);
  client->active = false;
  client->busy_retries = 0;
  client->attempt_token = 0;
  client->status.operation = 0;
  client->operation_type = APP_MESSAGE_OPERATION_READ;
  client->status.send_kind = APP_MESSAGE_SEND_PRIMARY;
  client->primary_attempts = 0;
  client->reconcile_attempts = 0;
  client->acknowledged = false;
  client->delivery_unknown = false;
  client->request_id[0] = '\0';
  notify_state(client, APP_MESSAGE_CLIENT_IDLE);
  if (client->error_state == ERROR_WAITING_ACK) {
    client->error_state = ERROR_IDLE;
  }
  try_send_error(client);
}

static void fail_request(
    AppMessageClient *client,
    AppMessageClientFailure failure,
    AppMessageResult result) {
  cancel_timer(client);
  notify_state(client, APP_MESSAGE_CLIENT_FAILED);
  if (client->config.request_failed) {
    AppMessageFailureInfo info = {
      .failure = failure,
      .result = result,
      .delivery = client->acknowledged ? APP_MESSAGE_DELIVERY_ACKNOWLEDGED
          : client->delivery_unknown ? APP_MESSAGE_DELIVERY_UNKNOWN
          : failure == APP_MESSAGE_FAILURE_DELIVERY &&
                result != APP_MSG_SEND_TIMEOUT
              ? APP_MESSAGE_DELIVERY_NOT_SENT
              : APP_MESSAGE_DELIVERY_UNKNOWN,
      .operation = client->status.operation,
      .send_kind = client->status.send_kind,
      .request_id = client->request_id,
    };
    client->config.request_failed(&info, client->config.context);
  }
  reset_request(client);
}

static void retry_or_fail(
    AppMessageClient *client,
    AppMessageClientFailure failure,
    AppMessageResult result) {
  if (failure == APP_MESSAGE_FAILURE_OUTBOX_TIMEOUT ||
      result == APP_MSG_SEND_TIMEOUT) {
    client->delivery_unknown = true;
  }
  if (attempts(client) >= max_attempts(client)) {
    fail_request(client, failure, result);
    return;
  }
  notify_state(client, APP_MESSAGE_CLIENT_BACKING_OFF);
  arm_timer(client, RETRY_BACKOFF_MS * attempts(client));
}

static bool tuple_integer(const Tuple *tuple, int64_t *value) {
  if (!tuple || !value ||
      (tuple->type != TUPLE_UINT && tuple->type != TUPLE_INT)) return false;
  if (tuple->type == TUPLE_UINT) {
    if (tuple->length == 1) *value = tuple->value->uint8;
    else if (tuple->length == 2) *value = tuple->value->uint16;
    else if (tuple->length == 4) *value = tuple->value->uint32;
    else return false;
  } else if (tuple->length == 1) *value = tuple->value->int8;
  else if (tuple->length == 2) *value = tuple->value->int16;
  else if (tuple->length == 4) *value = tuple->value->int32;
  else return false;
  return true;
}

bool app_message_tuple_uint(const Tuple *tuple, uint32_t *value) {
  int64_t number;
  if (!value || !tuple_integer(tuple, &number) || number < 0 || number > UINT32_MAX) return false;
  *value = (uint32_t)number;
  return true;
}

bool app_message_tuple_int(const Tuple *tuple, int32_t *value) {
  int64_t number;
  if (!value || !tuple_integer(tuple, &number) ||
      number < INT32_MIN || number > INT32_MAX) return false;
  *value = (int32_t)number;
  return true;
}

bool app_message_tuple_cstring(const Tuple *tuple, const char **value) {
  if (!tuple || !value || tuple->type != TUPLE_CSTRING || !tuple->length) {
    return false;
  }
  const char *text = tuple->value->cstring;
  const char *end = memchr(text, '\0', tuple->length);
  if (!end || end != text + tuple->length - 1) return false;
  *value = text;
  return true;
}

bool app_message_tuple_data(
    const Tuple *tuple, const uint8_t **value, uint16_t *length) {
  if (!tuple || !value || !length || tuple->type != TUPLE_BYTE_ARRAY) {
    return false;
  }
  *value = tuple->value->data;
  *length = tuple->length;
  return true;
}

static bool parse_uint16_id(const char *text, uint16_t *value) {
  if (!text || !text[0] || !value) return false;
  uint32_t result = 0;
  for (const char *cursor = text; *cursor; cursor++) {
    if (*cursor < '0' || *cursor > '9') return false;
    result = result * 10 + (uint32_t)(*cursor - '0');
    if (result > UINT16_MAX) return false;
  }
  if (result == 0) return false;
  *value = (uint16_t)result;
  return true;
}

static bool decode_request_id(
    const AppMessageClient *client,
    DictionaryIterator *iterator,
    char *buffer,
    size_t buffer_size) {
  Tuple *tuple = dict_find(iterator, client->config.protocol.request_id_key);
  if (!tuple) return false;
  if (client->config.protocol.request_id_codec == APP_MESSAGE_ID_CSTRING) {
    const char *value;
    if (!app_message_tuple_cstring(tuple, &value)) return false;
    size_t length = tuple->length - 1;
    if (!length || length >= buffer_size) return false;
    snprintf(buffer, buffer_size, "%s", value);
    return true;
  }
  uint32_t number;
  if (!app_message_tuple_uint(tuple, &number) || number == 0 || number > UINT16_MAX) return false;
  snprintf(buffer, buffer_size, "%u", (unsigned)number);
  return true;
}

static DictionaryResult write_envelope(
    AppMessageClient *client, DictionaryIterator *iterator) {
  DictionaryResult result = dict_write_uint8(
      iterator, client->config.protocol.protocol_key,
      client->config.protocol.protocol_version);
  if (result != DICT_OK) return result;
  uint8_t command = client->status.send_kind == APP_MESSAGE_SEND_RECONCILE
      ? client->config.protocol.reconcile_command : client->status.operation;
  result = dict_write_uint8(iterator, client->config.protocol.command_key, command);
  if (result != DICT_OK) return result;
  if (client->config.protocol.request_id_codec == APP_MESSAGE_ID_CSTRING) {
    result = dict_write_cstring(
        iterator, client->config.protocol.request_id_key, client->request_id);
  } else {
    uint16_t numeric_id;
    if (!parse_uint16_id(client->request_id, &numeric_id)) return DICT_INVALID_ARGS;
    result = dict_write_uint16(
        iterator, client->config.protocol.request_id_key, numeric_id);
  }
  if (result != DICT_OK) return result;
  return dict_write_uint8(
      iterator, APP_MESSAGE_INTERNAL_ATTEMPT_KEY, client->attempt_token);
}

static AppMessageResult send_dictionary(AppMessageClient *client) {
  DictionaryIterator *iterator;
  AppMessageResult result = app_message_outbox_begin(&iterator);
  if (result != APP_MSG_OK) {
    report_app_message(client, "app_message_outbox_begin", result,
        "sending AppMessage to phone");
    return result;
  }
  DictionaryResult dictionary = write_envelope(client, iterator);
  const char *function = "write_envelope";
  if (dictionary == DICT_OK && client->config.write_payload) {
    function = "write_payload";
    dictionary = client->config.write_payload(
        iterator, &client->status, client->config.context);
  }
  if (dictionary != DICT_OK) {
    report_source(client, (ErrorValue){
      .function = function, .code = dictionary,
      .symbol = dictionary_symbol(dictionary),
    }, "sending AppMessage to phone");
    return APP_MSG_BUFFER_OVERFLOW;
  }
  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    report_app_message(client, "app_message_outbox_send", result,
        "sending AppMessage to phone");
  }
  return result;
}

static void send_attempt(AppMessageClient *client) {
  if (!client->active) return;
  cancel_timer(client);
  uint8_t *count = client->status.send_kind == APP_MESSAGE_SEND_RECONCILE
      ? &client->reconcile_attempts : &client->primary_attempts;
  client->attempt_token++;
  if (!client->attempt_token) client->attempt_token++;
  AppMessageResult result = send_dictionary(client);
  // BUSY means this logical attempt never entered the outbox. It can happen
  // when a timed-out diagnostic callback is merely late, so retry it without
  // spending the business operation's bounded delivery attempts.
  if (result == APP_MSG_BUSY) {
    if (++client->busy_retries >= MAX_BUSY_RETRIES) {
      fail_request(client, APP_MESSAGE_FAILURE_DELIVERY, result);
    } else {
      notify_state(client, APP_MESSAGE_CLIENT_BACKING_OFF);
      arm_timer(client, RETRY_BACKOFF_MS * client->busy_retries);
    }
    return;
  }
  client->busy_retries = 0;
  (*count)++;
  if (result == APP_MSG_OK) {
    if (client->error_state == ERROR_OUTBOX) {
      client->error_state = ERROR_IDLE;
    }
    notify_state(client, APP_MESSAGE_CLIENT_WAITING_OUTBOX);
    arm_timer(client, OUTBOX_TIMEOUT_MS);
    return;
  }
  retry_or_fail(client, APP_MESSAGE_FAILURE_DELIVERY, result);
}

static void start_reconcile(AppMessageClient *client) {
  if (!client->config.protocol.reconcile_command) {
    fail_request(client, APP_MESSAGE_FAILURE_RESPONSE_TIMEOUT, APP_MSG_OK);
    return;
  }
  client->status.send_kind = APP_MESSAGE_SEND_RECONCILE;
  client->reconcile_attempts = 0;
  send_attempt(client);
}

static void response_timed_out(AppMessageClient *client) {
  report_app_message(
      client, "waiting for phone response", APP_MSG_SEND_TIMEOUT,
      client->status.send_kind == APP_MESSAGE_SEND_RECONCILE
          ? "reconciling AppMessage request" : "waiting for AppMessage response");
  if (client->operation_type == APP_MESSAGE_OPERATION_READ) {
    client->status.send_kind = APP_MESSAGE_SEND_PRIMARY;
    if (client->primary_attempts < MAX_PRIMARY_ATTEMPTS) {
      notify_state(client, APP_MESSAGE_CLIENT_BACKING_OFF);
      arm_timer(client, RETRY_BACKOFF_MS * client->primary_attempts);
    } else {
      fail_request(client, APP_MESSAGE_FAILURE_RESPONSE_TIMEOUT, APP_MSG_OK);
    }
    return;
  }
  if (client->status.send_kind != APP_MESSAGE_SEND_RECONCILE) {
    start_reconcile(client);
  } else if (client->reconcile_attempts < MAX_RECONCILE_ATTEMPTS) {
    notify_state(client, APP_MESSAGE_CLIENT_BACKING_OFF);
    arm_timer(client, RETRY_BACKOFF_MS * client->reconcile_attempts);
  } else {
    fail_request(client, APP_MESSAGE_FAILURE_RECONCILE_TIMEOUT, APP_MSG_OK);
  }
}

static void timer_fired(void *context) {
  AppMessageClient *client = context;
  client->timer = NULL;
  if (!client->active) return;
  switch (client->status.state) {
    case APP_MESSAGE_CLIENT_WAITING_READY:
    case APP_MESSAGE_CLIENT_BACKING_OFF:
      send_attempt(client);
      break;
    case APP_MESSAGE_CLIENT_WAITING_OUTBOX:
      report_app_message(
          client, "app_message_outbox_send callback", APP_MSG_SEND_TIMEOUT,
          "waiting for AppMessage outbox acknowledgement");
      retry_or_fail(
          client, APP_MESSAGE_FAILURE_OUTBOX_TIMEOUT, APP_MSG_SEND_TIMEOUT);
      break;
    case APP_MESSAGE_CLIENT_WAITING_RESPONSE:
      response_timed_out(client);
      break;
    default:
      break;
  }
}

static bool is_ready_message(
    const AppMessageClient *client, DictionaryIterator *iterator) {
  uint32_t protocol;
  uint32_t command;
  return app_message_tuple_uint(
             dict_find(iterator, client->config.protocol.protocol_key), &protocol) &&
      protocol == client->config.protocol.protocol_version &&
      app_message_tuple_uint(
          dict_find(iterator, client->config.protocol.command_key), &command) &&
      command == client->config.protocol.ready_command;
}

static bool tuple_is_command(DictionaryIterator *iterator, uint8_t command) {
  uint32_t value;
  return app_message_tuple_uint(dict_find(iterator, PEBBLE_ERROR_COMMAND_KEY), &value) &&
      value == command;
}

static void inbox_received(DictionaryIterator *iterator, void *context) {
  (void)context;
  AppMessageClient *client = s_open_client;
  if (!client || !client->opened) return;
  if (is_ready_message(client, iterator)) {
    client->phone_ready = true;
    uint32_t enabled;
    if (client->config.errors &&
        app_message_tuple_uint(dict_find(iterator, PEBBLE_ERROR_ENABLED_KEY), &enabled)) {
      bool reporting_enabled = enabled != 0;
      error_reporter_set_enabled(client->config.errors, reporting_enabled);
      if (!reporting_enabled && client->error_state != ERROR_IDLE) {
        cancel_timer(client);
        client->error_state = ERROR_IDLE;
        if (client->active) send_attempt(client);
      }
    }
    if (client->error_state != ERROR_IDLE) {
      client->error_state = ERROR_IDLE;
    }
    if (client->active && client->status.state == APP_MESSAGE_CLIENT_WAITING_READY) {
      send_attempt(client);
    } else {
      try_send_error(client);
    }
    return;
  }
  if (tuple_is_command(iterator, PEBBLE_ERROR_COMMAND_ACK)) {
    if (client->config.errors &&
        error_reporter_accept_ack(client->config.errors, iterator)) {
      bool business_waiting = client->active &&
          client->error_state != ERROR_IDLE;
      if (business_waiting) cancel_timer(client);
      client->error_state = ERROR_IDLE;
      if (business_waiting) send_attempt(client);
      else if (!client->active) try_send_error(client);
    }
    return;
  }

  char response_id[APP_MESSAGE_CLIENT_ID_CAPACITY];
  if (!decode_request_id(client, iterator, response_id, sizeof(response_id))) {
    if (client->config.unsolicited_received) {
      client->config.unsolicited_received(
          iterator, client->config.context);
    }
    return;
  }
  if (!client->active || strcmp(response_id, client->request_id) != 0) {
    if (client->config.errors) {
      ERROR_REPORT(client->config.errors, ((ErrorValue){
        .function = "inbox_received", .code = 0,
        .symbol = "STALE_RESPONSE", .message = NULL,
      }), "correlating AppMessage response");
    }
    return;
  }
  if (!client->config.response_received) return;
  AppMessageResponseAction action = client->config.response_received(
      iterator, &client->status, client->config.context);
  if (!client->active || strcmp(response_id, client->request_id) != 0) return;
  if (action == APP_MESSAGE_RESPONSE_MORE) {
    cancel_timer(client);
    client->acknowledged = true;
    if (client->operation_type == APP_MESSAGE_OPERATION_MUTATION) {
      client->status.send_kind = APP_MESSAGE_SEND_PRIMARY;
      client->reconcile_attempts = 0;
    }
    notify_state(client, APP_MESSAGE_CLIENT_WAITING_RESPONSE);
    arm_timer(client, RESPONSE_TIMEOUT_MS);
  } else if (action == APP_MESSAGE_RESPONSE_DONE) {
    reset_request(client);
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  (void)context;
  AppMessageClient *client = s_open_client;
  if (!client || !client->opened) return;
  if (client->error_state == ERROR_IDLE) {
    report_app_message(
        client, "app_message inbox", reason, "receiving AppMessage from phone");
  }
}

static bool handle_error_outbox(
    AppMessageClient *client, DictionaryIterator *iterator, bool sent) {
  if (!client || !client->opened ||
      !tuple_is_command(iterator, PEBBLE_ERROR_COMMAND_IMPORT)) return false;
  if (client->error_state == ERROR_OUTBOX) {
    client->error_state = sent ? ERROR_WAITING_ACK : ERROR_IDLE;
    if (client->active &&
        client->status.state == APP_MESSAGE_CLIENT_BACKING_OFF) {
      cancel_timer(client);
      client->busy_retries = 0;
      send_attempt(client);
    }
  } else if (client->active && client->busy_retries &&
      client->status.state == APP_MESSAGE_CLIENT_BACKING_OFF) {
    cancel_timer(client);
    client->busy_retries = 0;
    send_attempt(client);
  }
  return true;
}

static bool callback_matches(
    AppMessageClient *client, DictionaryIterator *iterator) {
  char request_id[APP_MESSAGE_CLIENT_ID_CAPACITY];
  if (!client->active ||
      !decode_request_id(client, iterator, request_id, sizeof(request_id)) ||
      strcmp(request_id, client->request_id) != 0) return false;
  uint32_t token;
  return app_message_tuple_uint(dict_find(iterator, APP_MESSAGE_INTERNAL_ATTEMPT_KEY), &token) &&
      token != 0 && token == client->attempt_token &&
      client->status.state == APP_MESSAGE_CLIENT_WAITING_OUTBOX;
}

static void outbox_sent(DictionaryIterator *iterator, void *context) {
  (void)context;
  AppMessageClient *client = s_open_client;
  if (handle_error_outbox(client, iterator, true)) return;
  if (!client || !client->opened || !callback_matches(client, iterator)) return;
  cancel_timer(client);
  client->acknowledged = true;
  notify_state(client, APP_MESSAGE_CLIENT_WAITING_RESPONSE);
  arm_timer(client, RESPONSE_TIMEOUT_MS);
}

static void outbox_failed(
    DictionaryIterator *iterator, AppMessageResult reason, void *context) {
  (void)context;
  AppMessageClient *client = s_open_client;
  if (handle_error_outbox(client, iterator, false)) return;
  if (!client || !client->opened || !callback_matches(client, iterator)) {
    if (client && client->opened) {
      report_app_message(client, "app_message_outbox_send callback", reason,
          "handling late AppMessage failure");
    }
    return;
  }
  cancel_timer(client);
  report_app_message(
      client, "app_message_outbox_send callback", reason,
      "sending AppMessage to phone");
  retry_or_fail(client, APP_MESSAGE_FAILURE_DELIVERY, reason);
}

static void try_send_error(AppMessageClient *client) {
  if (!client || !client->opened || !client->phone_ready || client->active ||
      client->error_state != ERROR_IDLE ||
      !client->config.errors ||
      !error_reporter_has_pending(client->config.errors)) return;
  DictionaryIterator *iterator;
  AppMessageResult result = app_message_outbox_begin(&iterator);
  if (result == APP_MSG_OK &&
      error_reporter_write_pending(client->config.errors, iterator) != DICT_OK) {
    result = APP_MSG_BUFFER_OVERFLOW;
  } else if (result == APP_MSG_OK) {
    result = app_message_outbox_send();
  }
  if (result == APP_MSG_OK) {
    client->error_state = ERROR_OUTBOX;
  }
}

static void error_available(void *context) {
  AppMessageClient *client = context;
  if (client && client->error_state != ERROR_IDLE) {
    client->error_state = ERROR_IDLE;
  }
  try_send_error(client);
}

AppMessageClient *app_message_client_open(
    const AppMessageClientConfig *config, AppMessageResult *open_result) {
  if (open_result) *open_result = APP_MSG_INVALID_ARGS;
  if (!config || !config->inbox_size || !config->outbox_size ||
      !config->response_received || s_open_client) return NULL;
  AppMessageClient *client = calloc(1, sizeof(*client));
  if (!client) {
    ERROR_REPORT(config->errors, ((ErrorValue){
      .function = "calloc", .code = 0,
      .symbol = "NULL_RETURN",
    }), "opening AppMessage client");
    if (open_result) *open_result = APP_MSG_OUT_OF_MEMORY;
    return NULL;
  }
  client->config = *config;
  client->status.request_id = client->request_id;
  client->status.state = APP_MESSAGE_CLIENT_IDLE;
  if (client->config.errors) {
    error_reporter_attach(client->config.errors, error_available, client);
  }
  s_open_client = client;
  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_sent(outbox_sent);
  app_message_register_outbox_failed(outbox_failed);
  AppMessageResult result = app_message_open(
      client->config.inbox_size, client->config.outbox_size);
  if (result != APP_MSG_OK) {
    report_app_message(
        client, "app_message_open", result, "opening AppMessage channel");
    error_reporter_attach(client->config.errors, NULL, NULL);
    app_message_deregister_callbacks();
    s_open_client = NULL;
    free(client);
    if (open_result) *open_result = result;
    return NULL;
  }
  client->opened = true;
  if (open_result) *open_result = APP_MSG_OK;
  return client;
}

void app_message_client_close(AppMessageClient *client) {
  if (!client) return;
  cancel_timer(client);
  client->active = false;
  client->opened = false;
  error_reporter_attach(client->config.errors, NULL, NULL);
  if (s_open_client == client) {
    app_message_deregister_callbacks();
    s_open_client = NULL;
  }
  free(client);
}

static bool assign_request_id(AppMessageClient *client, const char *request_id) {
  if (!request_id) {
    if (client->config.protocol.request_id_codec != APP_MESSAGE_ID_UINT16) return false;
    client->next_numeric_id++;
    if (!client->next_numeric_id) client->next_numeric_id++;
    snprintf(client->request_id, sizeof(client->request_id), "%u",
             client->next_numeric_id);
    return true;
  }
  if (!request_id[0] || strlen(request_id) >= sizeof(client->request_id)) return false;
  if (client->config.protocol.request_id_codec == APP_MESSAGE_ID_UINT16) {
    uint16_t numeric_id;
    if (!parse_uint16_id(request_id, &numeric_id)) return false;
    if (numeric_id > client->next_numeric_id) client->next_numeric_id = numeric_id;
  }
  snprintf(client->request_id, sizeof(client->request_id), "%s", request_id);
  return true;
}

AppMessageStartResult app_message_client_start(
    AppMessageClient *client,
    uint8_t operation,
    AppMessageOperationType operation_type,
    const char *request_id,
    AppMessageSendKind initial_send_kind) {
  if (!client || !client->opened || !operation ||
      (initial_send_kind == APP_MESSAGE_SEND_RECONCILE &&
       !client->config.protocol.reconcile_command)) return APP_MESSAGE_START_INVALID;
  if (client->active) {
    bool same_id = request_id
        ? strcmp(client->request_id, request_id) == 0 : true;
    return client->status.operation == operation &&
            client->operation_type == operation_type && same_id
        ? APP_MESSAGE_START_COALESCED : APP_MESSAGE_START_BUSY;
  }
  if (!assign_request_id(client, request_id)) return APP_MESSAGE_START_INVALID;
  if (client->error_state == ERROR_WAITING_ACK) {
    client->error_state = ERROR_IDLE;
  }
  bool wait_for_error_outbox = client->error_state == ERROR_OUTBOX;
  client->active = true;
  client->status.operation = operation;
  client->operation_type = operation_type;
  client->status.send_kind = initial_send_kind;
  client->primary_attempts = 0;
  client->reconcile_attempts = 0;
  client->acknowledged = initial_send_kind == APP_MESSAGE_SEND_RECONCILE;
  client->delivery_unknown = false;
  client->attempt_token = 0;
  client->busy_retries = 0;
  if (wait_for_error_outbox) {
    notify_state(client, APP_MESSAGE_CLIENT_BACKING_OFF);
    arm_timer(client, OUTBOX_TIMEOUT_MS);
  } else if (client->phone_ready) {
    send_attempt(client);
  } else {
    notify_state(client, APP_MESSAGE_CLIENT_WAITING_READY);
    arm_timer(client, READY_GRACE_MS);
  }
  return APP_MESSAGE_START_STARTED;
}

bool app_message_client_is_active(const AppMessageClient *client) {
  return client && client->active;
}

bool app_message_client_has_request(
    const AppMessageClient *client, const char *request_id) {
  return client && client->active && request_id &&
      strcmp(client->request_id, request_id) == 0;
}

const AppMessageClientStatus *app_message_client_status(
    const AppMessageClient *client) {
  return client ? &client->status : NULL;
}

void app_message_client_cancel(AppMessageClient *client) {
  if (client && client->active) reset_request(client);
}
