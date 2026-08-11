#ifndef APP_MESSAGE_CLIENT_H
#define APP_MESSAGE_CLIENT_H

#include <pebble.h>
#include <error_reporter.h>

#define APP_MESSAGE_CLIENT_ID_CAPACITY 65

typedef enum {
  APP_MESSAGE_ID_UINT16 = 0,
  APP_MESSAGE_ID_CSTRING,
} AppMessageRequestIdCodec;

typedef enum {
  APP_MESSAGE_OPERATION_READ = 0,
  APP_MESSAGE_OPERATION_MUTATION,
} AppMessageOperationType;

typedef enum {
  APP_MESSAGE_SEND_PRIMARY = 0,
  APP_MESSAGE_SEND_RECONCILE,
} AppMessageSendKind;

typedef enum {
  APP_MESSAGE_CLIENT_IDLE = 0,
  APP_MESSAGE_CLIENT_WAITING_READY,
  APP_MESSAGE_CLIENT_BACKING_OFF,
  APP_MESSAGE_CLIENT_WAITING_OUTBOX,
  APP_MESSAGE_CLIENT_WAITING_RESPONSE,
  APP_MESSAGE_CLIENT_FAILED,
} AppMessageClientState;

typedef enum {
  APP_MESSAGE_FAILURE_DELIVERY = 1,
  APP_MESSAGE_FAILURE_OUTBOX_TIMEOUT,
  APP_MESSAGE_FAILURE_RESPONSE_TIMEOUT,
  APP_MESSAGE_FAILURE_RECONCILE_TIMEOUT,
} AppMessageClientFailure;

typedef enum {
  APP_MESSAGE_DELIVERY_NOT_SENT = 0,
  APP_MESSAGE_DELIVERY_UNKNOWN,
  APP_MESSAGE_DELIVERY_ACKNOWLEDGED,
} AppMessageDelivery;

typedef enum {
  APP_MESSAGE_START_STARTED = 0,
  APP_MESSAGE_START_COALESCED,
  APP_MESSAGE_START_BUSY,
  APP_MESSAGE_START_INVALID,
} AppMessageStartResult;

typedef enum {
  APP_MESSAGE_RESPONSE_IGNORE = 0,
  APP_MESSAGE_RESPONSE_MORE,
  APP_MESSAGE_RESPONSE_DONE,
} AppMessageResponseAction;

typedef struct AppMessageClient AppMessageClient;

typedef struct {
  AppMessageClientState state;
  AppMessageSendKind send_kind;
  uint8_t operation;
  const char *request_id;
} AppMessageClientStatus;

typedef struct {
  AppMessageClientFailure failure;
  AppMessageResult result;
  AppMessageDelivery delivery;
  uint8_t operation;
  AppMessageSendKind send_kind;
  const char *request_id;
} AppMessageFailureInfo;

typedef DictionaryResult (*AppMessageWritePayload)(
    DictionaryIterator *iterator,
    const AppMessageClientStatus *status,
    void *context);

typedef AppMessageResponseAction (*AppMessageResponseReceived)(
    DictionaryIterator *iterator,
    const AppMessageClientStatus *status,
    void *context);

typedef void (*AppMessageUnsolicitedReceived)(
    DictionaryIterator *iterator,
    void *context);

typedef void (*AppMessageStateChanged)(
    const AppMessageClientStatus *status,
    void *context);

typedef void (*AppMessageRequestFailed)(
    const AppMessageFailureInfo *failure,
    void *context);

typedef struct {
  uint32_t protocol_key;
  uint32_t command_key;
  uint32_t request_id_key;
  uint8_t protocol_version;
  uint8_t ready_command;
  uint8_t reconcile_command;
  AppMessageRequestIdCodec request_id_codec;
} AppMessageProtocol;

typedef struct {
  uint32_t inbox_size;
  uint32_t outbox_size;
  AppMessageProtocol protocol;
  AppMessageWritePayload write_payload;
  AppMessageResponseReceived response_received;
  AppMessageUnsolicitedReceived unsolicited_received;
  AppMessageStateChanged state_changed;
  AppMessageRequestFailed request_failed;
  ErrorReporter *errors;
  void *context;
} AppMessageClientConfig;

bool app_message_tuple_uint(const Tuple *tuple, uint32_t *value);
bool app_message_tuple_int(const Tuple *tuple, int32_t *value);
bool app_message_tuple_cstring(const Tuple *tuple, const char **value);
bool app_message_tuple_data(
    const Tuple *tuple, const uint8_t **value, uint16_t *length);

AppMessageClient *app_message_client_open(
    const AppMessageClientConfig *config, AppMessageResult *result);
void app_message_client_close(AppMessageClient *client);

AppMessageStartResult app_message_client_start(
    AppMessageClient *client,
    uint8_t operation,
    AppMessageOperationType operation_type,
    const char *request_id,
    AppMessageSendKind initial_send_kind);

bool app_message_client_is_active(const AppMessageClient *client);
bool app_message_client_has_request(
    const AppMessageClient *client, const char *request_id);
const AppMessageClientStatus *app_message_client_status(
    const AppMessageClient *client);
void app_message_client_cancel(AppMessageClient *client);

#endif
