package com.skarian.agentscompanion

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.termux.shared.termux.TermuxConstants
import java.net.URLEncoder
import java.util.UUID

class TermuxCommandRunner(private val context: Context) {
    fun refreshAgents(
        requestId: String = UUID.randomUUID().toString(),
        watchId: String? = null,
    ): String = execute(
        kind = KIND_AGENTS,
        arguments = arrayOf("agents", "list", "--json"),
        stdin = null,
        mode = null,
        requestId = requestId,
        watchId = watchId,
    )

    fun doctor(): String = execute(
        kind = KIND_DOCTOR,
        arguments = arrayOf("doctor", "--json"),
        stdin = null,
        mode = null,
    )

    fun send(
        agentId: String,
        text: String,
        mode: ExecutionMode,
        requestId: String = UUID.randomUUID().toString(),
    ): String {
        require(agentId.matches(Regex("[a-z][a-z0-9-]*"))) { "Invalid agent id." }
        require(text.isNotBlank()) { "Message is empty." }
        val outputFlag = if (mode == ExecutionMode.STREAM) "--stream" else "--json"
        return execute(
            kind = KIND_SEND,
            arguments = arrayOf("send", agentId, "--stdin", outputFlag),
            stdin = text,
            mode = mode,
            requestId = requestId,
        )
    }

    fun sendStream(
        requestId: String,
        agentId: String,
        text: String,
        callbackPort: Int,
        callbackToken: String,
    ) {
        require(agentId.matches(Regex("[a-z][a-z0-9-]*"))) { "Invalid agent id." }
        require(text.isNotBlank()) { "Message is empty." }
        execute(
            kind = KIND_SEND,
            arguments = arrayOf("send", agentId, "--stdin", "--stream"),
            stdin = text,
            mode = ExecutionMode.STREAM,
            requestId = requestId,
            streamCallback = StreamCallback(callbackPort, callbackToken),
        )
    }

    private fun execute(
        kind: String,
        arguments: Array<String>,
        stdin: String?,
        mode: ExecutionMode?,
        requestId: String = UUID.randomUUID().toString(),
        streamCallback: StreamCallback? = null,
        watchId: String? = null,
    ): String {
        val callback = Intent(context, TermuxResultReceiver::class.java)
            .setData(Uri.parse(callbackIdentity(kind, requestId, watchId)))
            .putExtra(EXTRA_REQUEST_ID, requestId)
            .putExtra(EXTRA_KIND, kind)
            .putExtra(EXTRA_MODE, mode?.name)
            .apply { watchId?.let { putExtra(EXTRA_WATCH_ID, it) } }
        val flags = PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            "$requestId\u0000${watchId.orEmpty()}".hashCode(),
            callback,
            flags,
        )

        val loginCommand = if (streamCallback == null) {
            TermuxLoginCommand.build(ROUTER_COMMAND, arrayOf(SHELL_NAME, *arguments))
        } else {
            TermuxLoginCommand.build(
                STREAM_COMMAND,
                arrayOf(
                    SHELL_NAME,
                    NODE_STREAM_BRIDGE,
                    streamCallback.port.toString(),
                    requestId,
                    streamCallback.token,
                    *arguments,
                ),
            )
        }
        val shellArguments = arrayOf("-lc", loginCommand)
        val command = Intent().apply {
            setClassName(
                TermuxConstants.TERMUX_PACKAGE_NAME,
                TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE_NAME,
            )
            action = TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.ACTION_RUN_COMMAND
            putExtra(
                TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.EXTRA_COMMAND_PATH,
                "$PREFIX/bin/login",
            )
            putExtra(TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.EXTRA_ARGUMENTS, shellArguments)
            putExtra(TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.EXTRA_WORKDIR, HOME)
            putExtra(TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.EXTRA_BACKGROUND, true)
            putExtra(TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.EXTRA_PENDING_INTENT, pendingIntent)
            stdin?.let {
                putExtra(TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.EXTRA_STDIN, it)
            }
        }
        requireNotNull(context.startService(command)) { "Termux did not accept the command." }
        return requestId
    }

    companion object {
        const val ACTION_RESULT_UPDATED = "com.skarian.agentscompanion.RESULT_UPDATED"
        const val EXTRA_REQUEST_ID = "request_id"
        const val EXTRA_KIND = "kind"
        const val EXTRA_MODE = "mode"
        const val EXTRA_WATCH_ID = "watch_id"
        const val KIND_AGENTS = "agents"
        const val KIND_SEND = "send"
        const val KIND_DOCTOR = "doctor"
        private const val PREFIX = "/data/data/com.termux/files/usr"
        private const val HOME = "/data/data/com.termux/files/home"
        private const val SHELL_NAME = "agents-companion"
        private const val ROUTER_COMMAND = "exec codex-router \"\$@\""
        private const val STREAM_COMMAND = "exec node -e \"\$1\" \"\${@:2}\""
        internal fun callbackIdentity(kind: String, requestId: String, watchId: String? = null) =
            "agents://termux-result/$kind/$requestId" +
                (watchId?.let { "?watch=" + URLEncoder.encode(it, "UTF-8") } ?: "")
        private val NODE_STREAM_BRIDGE = """
            const net = require("net");
            const fs = require("fs");
            const { spawn } = require("child_process");
            const [portText, requestId, token, ...routerArgs] = process.argv.slice(1);
            const child = spawn("codex-router", routerArgs, { stdio: ["inherit", "pipe", "inherit"] });
            let buffer = "";
            let pending = Promise.resolve();
            let callbackFailure = null;
            let sequence = 0;
            let terminal = "";
            function forward(line) {
              if (!line) return;
              sequence += 1;
              try {
                const parsed = JSON.parse(line);
                if (parsed.type === "completed" || parsed.type === "failed") terminal = line;
              } catch (_) {}
              pending = pending.then(() => new Promise((resolve, reject) => {
                const socket = net.createConnection({ host: "127.0.0.1", port: Number(portText) }, () => {
                  socket.end(JSON.stringify({ requestId, token, sequence, line }) + "\n");
                });
                socket.once("close", resolve);
                socket.once("error", reject);
              })).catch(error => { callbackFailure = callbackFailure || error; });
            }
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", chunk => {
              buffer += chunk;
              const lines = buffer.split("\n");
              buffer = lines.pop();
              lines.forEach(forward);
            });
            child.stdout.on("end", () => { if (buffer) forward(buffer); });
            child.once("error", error => { console.error(error.message); process.exit(127); });
            child.once("close", code => pending.then(() => {
              if (terminal) fs.writeSync(1, terminal + "\n");
              if (callbackFailure) {
                console.error("stream callback failed: " + callbackFailure.message);
                process.exit(91);
              }
              process.exit(code == null ? 1 : code);
            }));
        """.trimIndent()
    }

    private data class StreamCallback(val port: Int, val token: String)
}

internal object TermuxLoginCommand {
    private const val BASH = "/data/data/com.termux/files/usr/bin/bash"

    /**
     * The user's configured login shell only interprets this simple, fully quoted command.
     * Bash then runs the bridge syntax consistently while inheriting the initialized login env.
     */
    fun build(script: String, arguments: Array<String>): String = buildString {
        append("exec ")
        append(quote(BASH))
        append(" -c ")
        append(quote(script))
        arguments.forEach { argument ->
            append(' ')
            append(quote(argument))
        }
    }

    internal fun quote(value: String): String = "'" + value.replace("'", "'\"'\"'") + "'"
}
