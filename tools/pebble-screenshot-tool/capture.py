#!/usr/bin/env python3

import argparse
import atexit
import hashlib
import json
import os
import re
import signal
import socket
import sys
import tempfile
import threading
import time
import zipfile
from argparse import Namespace
from uuid import UUID

import png
from libpebble2.communication import PebbleConnection
from libpebble2.communication.transports.websocket import MessageTargetPhone, WebsocketTransport
from libpebble2.communication.transports.websocket.protocol import (
    WebSocketInstallBundle, WebSocketInstallStatus
)
from libpebble2.communication.transports.qemu.protocol import QemuButton
from libpebble2.exceptions import TimeoutError
from libpebble2.protocol.apps import (
    AppRunState, AppRunStateRequest, AppRunStateStart, AppRunStateStop
)
from libpebble2.protocol.screenshots import (
    ScreenshotHeader, ScreenshotRequest, ScreenshotResponse
)
from libpebble2.services.screenshot import Screenshot
from libpebble2.services.install import AppInstaller
from libpebble2.services.appmessage import (
    AppMessageService, CString, Int8, Int16, Int32, Uint8, Uint16, Uint32
)
from libpebble2.services.voice import VoiceService, SetupResult, TranscriptionResult
from pebble_tool.commands.base import PebbleTransportPhone, PebbleTransportQemu
from pebble_tool.commands.emucontrol import send_data_to_qemu
from pebble_tool.sdk import sdk_manager
from pebble_tool.sdk.emulator import ManagedEmulatorTransport


BUTTONS = {
    "back": QemuButton.Button.Back,
    "up": QemuButton.Button.Up,
    "select": QemuButton.Button.Select,
    "down": QemuButton.Button.Down,
}
MONITOR_KEYS = {
    "back": "left",
    "up": "up",
    "select": "right",
    "down": "down",
}
APP_MESSAGE_TYPES = {
    "cstring": CString,
    "int8": Int8,
    "int16": Int16,
    "int32": Int32,
    "uint8": Uint8,
    "uint16": Uint16,
    "uint32": Uint32,
}
DISPLAY_SAMPLE_INTERVAL = 0.1
DISPLAY_QUIET_PERIOD = 0.4


class VoiceHarness:
    def __init__(self, connection):
        self.service = VoiceService(connection)
        self.transcription = ""
        self.result = TranscriptionResult.Success
        self.app_uuid = None
        self.service.register_handler("session_setup", self._session_setup)
        self.service.register_handler("audio_stop", self._audio_stop)

    def configure(self, config):
        config = config or {}
        self.transcription = config.get("transcription", "")
        error = config.get("error")
        self.result = {
            "connectivity": TranscriptionResult.FailNoInternet,
            "no-speech": TranscriptionResult.FailSpeechNotRecognized,
            "recognizer": TranscriptionResult.FailRecognizerError,
        }.get(error, TranscriptionResult.Success)

    def _session_setup(self, app_uuid, encoder_info):
        self.app_uuid = app_uuid
        self.service.send_session_setup_result(SetupResult.Success, app_uuid)

    def _audio_stop(self):
        words = [part.strip() for part in re.split(r"(\W)", self.transcription) if part.strip()]
        words = [part if re.match(r"\w", part) else "\b" + part for part in words]
        self.service.send_stop_audio()
        self.service.send_dictation_result(
            result=self.result,
            sentences=[words] if self.result == TranscriptionResult.Success else None,
            app_uuid=self.app_uuid,
        )


class BridgeHarness:
    def __init__(self, appmessage, target):
        self.appmessage = appmessage
        self.target = target
        self.config = {}
        self.last_request_id = ""
        self.event_sequence = 0
        self.request_agents = {}
        self.history = {}
        appmessage.register_handler("appmessage", self._receive)

    def configure(self, config):
        self.config = config or {}
        events = self.config.get("pushEvents", [])
        if events and self.last_request_id:
            threading.Thread(
                target=self._send_events,
                args=(self.last_request_id, events),
                daemon=True,
            ).start()

    def _receive(self, transaction_id, app_uuid, data):
        if app_uuid != self.target:
            return
        threading.Thread(target=self._respond, args=(data,), daemon=True).start()

    def _respond(self, data):
        kind = data.get(0)
        if kind == 1:
            if "agents" not in self.config:
                return
            agents = self.config["agents"]
            message = {0: {"type": "uint8", "value": 10},
                       9: {"type": "uint8", "value": 1},
                       5: {"type": "uint8", "value": len(agents)}}
            if data.get(1):
                message[1] = {"type": "cstring", "value": data[1]}
            for index, agent in enumerate(agents):
                message[str(100 + index * 2)] = {"type": "cstring", "value": agent["id"]}
                message[str(101 + index * 2)] = {"type": "cstring", "value": agent["label"]}
            send_app_message(self.appmessage, self.target, message)
        elif kind == 2:
            request_id = data.get(1, "")
            agent_id = data.get(2, "")
            self.last_request_id = request_id
            self.request_agents[request_id] = agent_id
            if data.get(3):
                self.history.setdefault(agent_id, []).append({"user": True, "text": data[3]})
            self.event_sequence = 0
            events = self.config.get("events", [{"kind": 11}])
            self._send_events(request_id, events)
        elif kind == 4:
            self._send_history(data.get(1, ""), data.get(2, ""))

    def _send_events(self, request_id, events):
        for event in events:
            time.sleep(event.get("delayMs", 0) / 1000)
            self.event_sequence += 1
            message = {
                "0": {"type": "uint8", "value": event["kind"]},
                "1": {"type": "cstring", "value": request_id},
                "7": {"type": "uint16", "value": event.get("chunkIndex", 0)},
                "8": {"type": "uint16", "value": event.get("chunkCount", 1)},
                "9": {"type": "uint8", "value": 1},
                "10": {"type": "uint16", "value": event.get("sequence", self.event_sequence)},
                "11": {"type": "uint8", "value": event.get("flags", 0)},
            }
            if "text" in event:
                message["3"] = {"type": "cstring", "value": event["text"]}
                if event["kind"] in (12, 13, 14, 15) and event["text"]:
                    agent_id = self.request_agents.get(request_id, "")
                    self.history.setdefault(agent_id, []).append({"user": False, "text": event["text"]})
            if "code" in event:
                message["6"] = {"type": "cstring", "value": event["code"]}
            send_app_message(self.appmessage, self.target, message)

    @staticmethod
    def _chunks(text, limit=700):
        result = []
        remaining = text
        while remaining:
            end = len(remaining)
            while end > 0 and len(remaining[:end].encode("utf-8")) > limit:
                end -= 1
            result.append(remaining[:end])
            remaining = remaining[end:]
        return result or [""]

    def _send_history(self, request_id, agent_id):
        messages = self.history.get(agent_id, [])[-16:]
        for sequence, item in enumerate(messages, 1):
            chunks = self._chunks(item["text"][:5600])
            for index, chunk in enumerate(chunks):
                send_app_message(self.appmessage, self.target, {
                    "0": {"type": "uint8", "value": 17},
                    "1": {"type": "cstring", "value": request_id},
                    "3": {"type": "cstring", "value": chunk},
                    "7": {"type": "uint16", "value": index},
                    "8": {"type": "uint16", "value": len(chunks)},
                    "9": {"type": "uint8", "value": 1},
                    "10": {"type": "uint16", "value": sequence},
                    "11": {"type": "uint8", "value": 8 if item["user"] else 0},
                })
        send_app_message(self.appmessage, self.target, {
            "0": {"type": "uint8", "value": 18},
            "1": {"type": "cstring", "value": request_id},
            "9": {"type": "uint8", "value": 1},
            "10": {"type": "uint16", "value": len(messages)},
        })


def main():
    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--emulator")
    target.add_argument("--qemu")
    target.add_argument("--phone")
    parser.add_argument("--platform", default="emery")
    parser.add_argument("--output")
    parser.add_argument("--pbw", required=True)
    parser.add_argument("--button", action="append", choices=BUTTONS, default=[])
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--running", action="store_true")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--monitor-port", type=int)
    args = parser.parse_args()
    if not 0 < args.timeout <= 300:
        parser.error("--timeout must be greater than 0 and at most 300 seconds")
    if not args.serve and not args.output:
        parser.error("--output is required unless --serve is used")

    if not args.qemu and "PEBBLE_QEMU_PATH" not in os.environ:
        version = sdk_manager.get_current_sdk()
        qemu = os.path.join(sdk_manager.root_path_for_sdk(version), "toolchain", "bin", "qemu-pebble")
        if os.path.isfile(qemu):
            os.environ["PEBBLE_QEMU_PATH"] = qemu

    if args.phone:
        options = Namespace(phone=args.phone)
        launcher = None
        handler = PebbleTransportPhone
    elif args.qemu:
        options = Namespace(qemu=args.qemu, pypkjs=False, platform=args.platform, sdk=None)
        launcher = None
        handler = PebbleTransportQemu
    else:
        version = sdk_manager.get_current_sdk()
        launcher = ManagedEmulatorTransport(args.emulator, version, vnc_enabled=False)
        atexit.register(stop_owned_qemu, launcher)
        # Current Emery firmware may not emit the SDK console marker. Older
        # platforms do, and need that event before the direct Pebble handshake.
        if args.emulator == "emery":
            launcher._wait_for_qemu = lambda: None
        status("starting QEMU")
        bounded(args.timeout, "starting QEMU", launcher._spawn_qemu)
        options = Namespace(
            qemu="localhost:{}".format(launcher.qemu_port),
            pypkjs=False,
            platform=args.platform,
            sdk=None,
        )
        handler = PebbleTransportQemu

    status("connecting directly to QEMU")
    transport, connection = bounded(
        args.timeout, "connecting to Pebble", connect, handler, options
    )
    if launcher:
        transport.qemu_monitor_port = launcher.qemu_monitor_port
    elif args.monitor_port:
        transport.qemu_monitor_port = args.monitor_port
    status("emulator connected")
    session_appmessage = AppMessageService(connection) if args.serve else None

    expected = read_pbw_uuid(args.pbw)
    lifecycle = connection.get_endpoint_queue(AppRunState)
    running = connection.send_and_read(
        AppRunState(data=AppRunStateRequest()), AppRunState, timeout=args.timeout
    ).data.uuid
    if args.running:
        if running != expected:
            raise RuntimeError("Expected app is not running: expected {}, running {}".format(
                expected, running or "none"
            ))
    else:
        status("installing app")
        bounded(args.timeout, "installing app", install, connection, transport, args.pbw, args.timeout)
        status("app installed")
        running = connection.send_and_read(
            AppRunState(data=AppRunStateRequest()), AppRunState, timeout=args.timeout
        ).data.uuid
        if running != expected:
            status("launching installed app")
            connection.send_packet(AppRunState(data=AppRunStateStart(uuid=expected)))
        deadline = time.monotonic() + args.timeout
        while running != expected:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("Installed app did not enter the foreground: expected {}, running {}".format(
                    expected, running
                ))
            try:
                state = lifecycle.get(timeout=remaining).data
            except TimeoutError:
                raise RuntimeError(
                    "Timed out waiting for the installed app: expected {}, running {}".format(
                        expected, running or "none"
                    )
                )
            if isinstance(state, AppRunStateStart):
                running = state.uuid
            elif isinstance(state, AppRunStateStop) and state.uuid == running:
                running = None
    status("app is in foreground")
    if not args.serve:
        wait_for_stable_display(transport, args.timeout)
        status("initial display is stable")

    if args.serve:
        voice = VoiceHarness(connection)
        bridge = BridgeHarness(session_appmessage, expected)
        try:
            serve(connection, transport, expected, args.timeout, session_appmessage,
                  launcher.qemu_pid if launcher else None, voice, bridge)
        finally:
            close_transport(transport)
            stop_owned_qemu(launcher)
        return

    running = capture(connection, transport, expected, args.timeout, args.button, args.output)

    while True:
        try:
            state = lifecycle.get(timeout=0).data
        except TimeoutError:
            break
        if isinstance(state, AppRunStateStart):
            running = state.uuid
        elif isinstance(state, AppRunStateStop) and state.uuid == running:
            running = None
    lifecycle.close()

    if running != expected:
        raise RuntimeError("Installed app is not in the foreground: expected {}, running {}".format(
            expected, running or "none"
        ))

    print("PEBBLE_SCREENSHOT_RUNNING_UUID={}".format(running), flush=True)

    close_transport(transport)


def stop_owned_qemu(launcher):
    """Stop only the QEMU process spawned by this capture helper, then reap it."""
    if not launcher or not launcher.qemu_pid:
        return
    pid = launcher.qemu_pid
    launcher.qemu_pid = None
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


def capture(connection, transport, expected, timeout, buttons, output,
            appmessage=None, message=None, skip_stable=False, wait_ms=0):
    for button_spec in buttons:
        if isinstance(button_spec, str):
            button = button_spec
            duration_ms = 100
        else:
            button = button_spec.get("button")
            duration_ms = int(button_spec.get("durationMs", 100))
        if button not in BUTTONS or not 1 <= duration_ms <= 10000:
            raise RuntimeError("Capture session received an unsupported button action")
        status("pressing {} for {}ms".format(button, duration_ms))
        monitor_port = getattr(transport, "qemu_monitor_port", None)
        if monitor_port and isinstance(transport, WebsocketTransport) and duration_ms == 100:
            qemu_monitor(monitor_port, "sendkey {}".format(MONITOR_KEYS[button]),
                         time.monotonic() + timeout)
        else:
            send_data_to_qemu(transport, QemuButton(state=BUTTONS[button]))
            time.sleep(duration_ms / 1000)
            send_data_to_qemu(transport, QemuButton(state=0))
        verify_foreground(connection, expected, timeout)

    if message is not None:
        send_app_message(appmessage, expected, message)

    if wait_ms:
        time.sleep(wait_ms / 1000)

    running = verify_foreground(connection, expected, timeout)
    if not skip_stable:
        wait_for_stable_display(transport, timeout)
        status("final display is stable")
    status("capturing raw screenshot")
    image = grab_screenshot(connection, timeout)
    png.from_array(image, mode="RGB;8").save(output)
    return running


def serve(connection, transport, expected, timeout, appmessage, qemu_pid=None,
          voice=None, bridge=None):
    print(json.dumps({
        "event": "ready", "uuid": str(expected), "qemuPid": qemu_pid
    }), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request.get("command") == "close":
                return
            if request.get("command") != "capture":
                raise RuntimeError("Unsupported capture session command")
            output = request.get("output")
            buttons = request.get("buttons", [])
            if not output:
                raise RuntimeError("Capture session output is required")
            if voice:
                voice.configure(request.get("voice"))
            if bridge:
                bridge.configure(request.get("bridge"))
            running = capture(connection, transport, expected, timeout, buttons, output,
                              appmessage, request.get("message"),
                              request.get("skipStable", False), request.get("waitMs", 0))
            print(json.dumps({
                "event": "captured", "output": output, "uuid": str(running)
            }), flush=True)
        except Exception as error:
            print(json.dumps({"event": "error", "message": str(error)}), flush=True)


def send_app_message(service, target, dictionary):
    if service is None:
        raise RuntimeError("AppMessage is only available in capture session mode")
    encoded = {}
    for key, item in dictionary.items():
        value_type = APP_MESSAGE_TYPES.get(item.get("type"))
        if value_type is None:
            raise RuntimeError("Unsupported AppMessage value type")
        encoded[int(key)] = value_type(item.get("value"))
    acknowledgements = set()
    ready = threading.Event()

    def acknowledge(transaction_id, app_uuid):
        acknowledgements.add(transaction_id)
        ready.set()

    handle = service.register_handler("ack", acknowledge)
    try:
        transaction_id = service.send_message(target, encoded)
        deadline = time.monotonic() + 5
        while transaction_id not in acknowledgements:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not ready.wait(remaining):
                raise RuntimeError("Timed out waiting for AppMessage acknowledgement")
            ready.clear()
    finally:
        service.unregister_handler(handle)


def status(message):
    print("[capture] {}".format(message), file=sys.stderr, flush=True)


def bounded(timeout, label, function, *args):
    previous = signal.getsignal(signal.SIGALRM)

    def expire(signum, frame):
        raise RuntimeError("Timed out {}".format(label))

    signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, timeout)
    try:
        return function(*args)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def grab_screenshot(connection, timeout):
    screenshot = Screenshot(connection)
    queue = connection.get_endpoint_queue(ScreenshotResponse)
    deadline = time.monotonic() + timeout
    try:
        connection.send_packet(ScreenshotRequest())
        first = queue.get(timeout=deadline - time.monotonic()).data
        header = ScreenshotHeader.parse(first)[0]
        if header.response_code != ScreenshotHeader.ResponseCode.OK:
            raise RuntimeError("Screenshot failed: {}".format(header.response_code))
        data = header.data
        expected_size = screenshot._get_expected_bytes(header)
        while len(data) < expected_size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("Timed out receiving the emulator screenshot")
            data += queue.get(timeout=remaining).data
        return screenshot._decode_image(header, data)
    except TimeoutError:
        raise RuntimeError("Timed out receiving the emulator screenshot")
    finally:
        queue.close()


def connect(handler, options):
    transport = handler.get_transport(options)
    connection = PebbleConnection(transport)
    connection.connect()
    connection.run_async()
    handler.post_connect(connection)
    return transport, connection


def close_transport(transport):
    if getattr(transport, "ws", None):
        transport.ws.close()
    elif getattr(transport, "socket", None):
        transport.socket.close()


def read_pbw_uuid(path):
    with zipfile.ZipFile(path) as bundle:
        return UUID(str(json.loads(bundle.read("appinfo.json"))["uuid"]))


def install(connection, transport, pbw, timeout):
    if isinstance(transport, WebsocketTransport):
        with open(pbw, "rb") as bundle:
            transport.send_packet(
                WebSocketInstallBundle(pbw=bundle.read()), target=MessageTargetPhone()
            )
        result = connection.read_transport_message(
            MessageTargetPhone, WebSocketInstallStatus, timeout=timeout
        )
        if result.status != WebSocketInstallStatus.StatusCode.Success:
            raise RuntimeError("App install failed")
    else:
        AppInstaller(connection, pbw).install()


def verify_foreground(connection, expected, timeout):
    running = connection.send_and_read(
        AppRunState(data=AppRunStateRequest()), AppRunState, timeout=timeout
    ).data.uuid
    if running != expected:
        raise RuntimeError("Installed app is not in the foreground: expected {}, running {}".format(
            expected, running or "none"
        ))
    return running


def wait_for_stable_display(transport, timeout, quiet_period=DISPLAY_QUIET_PERIOD):
    port = getattr(transport, "qemu_monitor_port", None)
    if not port:
        return

    deadline = time.monotonic() + timeout
    previous = None
    unchanged_since = None
    with tempfile.TemporaryDirectory(prefix="pebble-display-") as directory:
        frame = 0
        while time.monotonic() < deadline:
            path = os.path.join(directory, "frame-{}.png".format(frame))
            qemu_monitor(port, "screendump {} -f png".format(path), deadline)
            if not os.path.exists(path):
                raise RuntimeError("QEMU reported a screenshot without creating it")
            with open(path, "rb") as image:
                digest = hashlib.sha256(image.read()).digest()
            now = time.monotonic()
            if digest != previous:
                unchanged_since = now
            elif now - unchanged_since >= quiet_period:
                return
            previous = digest
            frame += 1
            time.sleep(DISPLAY_SAMPLE_INTERVAL)
    raise RuntimeError("Timed out waiting for the emulator display to stabilize")


def qemu_monitor(port, command, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError("Timed out waiting for the emulator display to stabilize")
    with socket.create_connection(("127.0.0.1", int(port)), timeout=remaining) as monitor:
        read_monitor_prompt(monitor, deadline)
        monitor.sendall((command + "\n").encode())
        read_monitor_prompt(monitor, deadline)


def read_monitor_prompt(monitor, deadline):
    response = b""
    while not response.rstrip().endswith(b"(qemu)"):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Timed out waiting for the QEMU monitor")
        monitor.settimeout(remaining)
        chunk = monitor.recv(4096)
        if not chunk:
            raise RuntimeError("QEMU monitor disconnected before completing a command")
        response = (response + chunk)[-8192:]


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Capture failed: {}".format(error), file=sys.stderr, flush=True)
        sys.exit(1)
