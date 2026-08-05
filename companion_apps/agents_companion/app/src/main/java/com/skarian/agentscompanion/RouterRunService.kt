package com.skarian.agentscompanion

import android.app.NotificationManager
import android.app.Service
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking

class RouterRunService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private var server: ServerSocket? = null
    private var activeRequestId: String? = null
    private var callbackToken: String? = null
    private var rawOutput = StringBuilder()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startRun(intent)
            ACTION_FINISH -> finishRun(intent.getStringExtra(EXTRA_REQUEST_ID))
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        server?.close()
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun startRun(intent: Intent) {
        if (activeRequestId != null) return
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return stopSelf()
        val agentId = intent.getStringExtra(EXTRA_AGENT_ID) ?: return stopSelf()
        val text = intent.getStringExtra(EXTRA_TEXT) ?: return stopSelf()
        activeRequestId = requestId
        callbackToken = UUID.randomUUID().toString()
        CompanionState(this).startStream(requestId)
        startForeground(
            CompanionNotifications.ACTIVE_NOTIFICATION_ID,
            CompanionNotifications.active(this, "Waiting for router events…"),
        )

        runCatching {
            ServerSocket(0, 8, InetAddress.getByName("127.0.0.1")).also { socket ->
                server = socket
                executor.execute { acceptEvents(socket, requestId, callbackToken!!) }
                TermuxCommandRunner(this).sendStream(
                    requestId = requestId,
                    agentId = agentId,
                    text = text,
                    callbackPort = socket.localPort,
                    callbackToken = callbackToken!!,
                )
            }
        }.onFailure { error ->
            failRun(requestId, "Could not start live stream: ${error.message}")
        }
    }

    private fun acceptEvents(socket: ServerSocket, requestId: String, token: String) {
        try {
            while (!socket.isClosed) {
                socket.accept().use { client ->
                    val payload = client.getInputStream().bufferedReader().readLine() ?: continue
                    val envelope = JSONObject(payload)
                    if (envelope.optString("requestId") != requestId ||
                        envelope.optString("token") != token
                    ) continue
                    val line = envelope.getString("line")
                    RouterProtocol.parseResult(line, ExecutionMode.STREAM)
                    if (rawOutput.isNotEmpty()) rawOutput.append('\n')
                    rawOutput.append(line)
                    CompanionState(this).saveStream(
                        StoredStream(requestId, rawOutput.toString(), running = true),
                    )
                    notifyUpdated(requestId)
                    val event = RouterProtocol.parseResult(line, ExecutionMode.STREAM).single()
                    CompanionState(this).loadPebbleSession()?.let { session ->
                        val kind = when (event.type) {
                            "completed" -> PhoneEvent.COMPLETED
                            "failed" -> PhoneEvent.FAILED
                            else -> PhoneEvent.COMMENTARY
                        }
                        runCatching {
                            runBlocking {
                                PebbleTransport(this@RouterRunService).sendTextEvent(
                                    session,
                                    kind,
                                    requestId,
                                    event.text,
                                    event.code,
                                )
                            }
                        }.onFailure {
                            CompanionState(this).saveBridgeError(
                                "Could not send ${event.type} to the watch: ${it.message}",
                            )
                        }
                    }
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                        PackageManager.PERMISSION_GRANTED
                    ) {
                        notificationManager.notify(
                            CompanionNotifications.ACTIVE_NOTIFICATION_ID,
                            CompanionNotifications.active(this, event.text.ifBlank { event.type }),
                        )
                    }
                }
            }
        } catch (_: java.net.SocketException) {
            // Expected when the terminal result closes the short-lived callback server.
        } catch (error: Exception) {
            failRun(requestId, "Live stream failed: ${error.message}")
        }
    }

    private fun finishRun(requestId: String?) {
        if (requestId == null || requestId != activeRequestId) return
        CompanionState(this).saveStream(
            StoredStream(requestId, rawOutput.toString(), running = false),
        )
        notifyUpdated(requestId)
        stopSelf()
    }

    private fun failRun(requestId: String, message: String) {
        CompanionState(this).saveStream(
            StoredStream(requestId, rawOutput.toString(), running = false, errorMessage = message),
        )
        notifyUpdated(requestId)
        stopSelf()
    }

    private fun notifyUpdated(requestId: String) {
        sendBroadcast(
            Intent(TermuxCommandRunner.ACTION_RESULT_UPDATED)
                .setPackage(packageName)
                .putExtra(TermuxCommandRunner.EXTRA_REQUEST_ID, requestId),
        )
    }

    private val notificationManager: NotificationManager
        get() = getSystemService(NotificationManager::class.java)

    override fun onCreate() {
        super.onCreate()
        CompanionNotifications.createChannel(this)
    }

    companion object {
        private const val ACTION_START = "com.skarian.agentscompanion.START_STREAM"
        private const val ACTION_FINISH = "com.skarian.agentscompanion.FINISH_STREAM"
        private const val EXTRA_AGENT_ID = "agent_id"
        private const val EXTRA_TEXT = "text"
        private const val EXTRA_REQUEST_ID = "request_id"
        fun start(
            context: Context,
            agentId: String,
            text: String,
            requestId: String = UUID.randomUUID().toString(),
        ): String {
            require(text.isNotBlank()) { "Message is empty." }
            ContextCompat.startForegroundService(
                context,
                Intent(context, RouterRunService::class.java)
                    .setAction(ACTION_START)
                    .putExtra(EXTRA_REQUEST_ID, requestId)
                    .putExtra(EXTRA_AGENT_ID, agentId)
                    .putExtra(EXTRA_TEXT, text),
            )
            return requestId
        }

        fun finish(context: Context, requestId: String) {
            context.startService(
                Intent(context, RouterRunService::class.java)
                    .setAction(ACTION_FINISH)
                    .putExtra(EXTRA_REQUEST_ID, requestId),
            )
        }
    }
}
