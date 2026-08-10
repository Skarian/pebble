package com.skarian.agentscompanion

import android.Manifest
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.Executors

class RouterRunService : Service() {
    private val executor = Executors.newSingleThreadExecutor(); private var server: ServerSocket? = null; private var activeRequestId: String? = null
    private val heartbeatHandler = Handler(Looper.getMainLooper())
    private val heartbeat = object : Runnable {
        override fun run() {
            val requestId = activeRequestId ?: return
            CompanionState(this@RouterRunService).updateTurn(requestId) {
                if (it.state == TurnState.RUNNING) it.copy(updatedAt = it.updatedAt + 1) else it
            }
            heartbeatHandler.postDelayed(this, HEARTBEAT_MS)
        }
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int { if (intent?.action == ACTION_START) startRun(intent); return START_NOT_STICKY }
    override fun onCreate() { super.onCreate(); CompanionNotifications.createChannel(this) }
    override fun onDestroy() { heartbeatHandler.removeCallbacks(heartbeat); runCatching { server?.close() }; executor.shutdownNow(); super.onDestroy() }

    private fun startRun(intent: Intent) {
        startForeground(CompanionNotifications.ACTIVE_NOTIFICATION_ID, CompanionNotifications.active(this, "Starting agent turn…"))
        val requestId=intent.getStringExtra(EXTRA_REQUEST_ID) ?: return stopSelf(); val agentId=intent.getStringExtra(EXTRA_AGENT_ID) ?: return stopSelf(); val text=intent.getStringExtra(EXTRA_TEXT) ?: return stopSelf()
        val state=CompanionState(this); val stored=state.loadTurn()
        if (activeRequestId != null || stored?.requestId != requestId || stored.state != TurnState.QUEUED) return stopSelf()
        activeRequestId=requestId; val token=UUID.randomUUID().toString()
        runCatching {
            ServerSocket(0,8,InetAddress.getByName("127.0.0.1")).also { socket ->
                server=socket; executor.execute { acceptEvents(socket,requestId,token) }
                val admitted=state.updateTurn(requestId) { it.copy(state=TurnState.RUNNING,eventType="accepted",sequence=1) } ?: error("Could not persist admission.")
                check(admitted.state == TurnState.RUNNING && admitted.eventType == "accepted") { "Turn is no longer queued." }
                deliver(admitted)
                heartbeatHandler.postDelayed(heartbeat, HEARTBEAT_MS)
                TermuxCommandRunner(this).sendStream(requestId,agentId,text,socket.localPort,token)
            }
        }.onFailure { failRun(requestId,"Could not start live stream: ${it.message}","bridge_start_failed") }
    }

    private fun acceptEvents(socket: ServerSocket, requestId: String, token: String) {
        try {
            while (!socket.isClosed) socket.accept().use { client ->
                client.soTimeout=5_000
                val payload=client.getInputStream().bufferedReader().readLine()?.take(300_000) ?: return@use
                val envelope=JSONObject(payload); if(envelope.optString("requestId")!=requestId || envelope.optString("token")!=token) return@use
                val event=RouterProtocol.parseResult(envelope.getString("line"),ExecutionMode.STREAM).single()
                val sequence=(envelope.getInt("sequence")+1).coerceAtMost(65535)
                val terminal=event.type=="completed" || event.type=="failed"
                val updated=CompanionState(this).updateTurn(requestId) { current ->
                    if(sequence<=current.sequence || current.state==TurnState.TERMINAL) current else current.copy(state=if(terminal) TurnState.TERMINAL else TurnState.RUNNING,eventType=event.type,text=event.text,code=event.code.orEmpty(),ambiguous=event.ambiguous,sequence=sequence)
                } ?: return@use
                if(updated.sequence==sequence) {
                    if (updated.text.isNotBlank()) {
                        val historyId = if (updated.state == TurnState.TERMINAL) "${updated.requestId}/terminal" else "${updated.requestId}/event/${updated.sequence}"
                        CompanionState(this).appendHistory(CachedMessage(historyId, updated.agentId, updated.requestId, updated.sequence, false, updated.text))
                    }
                    deliver(updated)
                }
                notifyText(event.text.ifBlank { event.type })
                if(terminal) { socket.close(); stopSelf() }
            }
        } catch (_: java.net.SocketException) { }
        catch (error: Exception) { failRun(requestId,"Live stream failed: ${error.message}","stream_lost", ambiguous=true) }
    }

    private fun deliver(turn: StoredTurn) {
        runCatching {
            runBlocking {
                val kind = when {
                    turn.ambiguous -> PhoneEvent.STATUS_UNKNOWN
                    turn.eventType == "completed" -> PhoneEvent.COMPLETED
                    turn.eventType == "failed" -> PhoneEvent.FAILED
                    turn.eventType == "accepted" -> PhoneEvent.ACCEPTED
                    else -> PhoneEvent.COMMENTARY
                }
                val outcome = AgentsAppMessage(this@RouterRunService).sendTextEvent(
                    turn.session, kind, turn.requestId, turn.text, turn.code,
                    turn.sequence, turn.ambiguous,
                )
                if (!outcome.delivered) {
                    CompanionState(this@RouterRunService).saveBridgeError(
                        "Could not send turn update (${outcome.failure}).",
                    )
                }
            }
        }.onFailure {
            CompanionState(this).saveBridgeError("Could not send turn update.")
        }
    }
    private fun failRun(requestId:String,message:String,code:String,ambiguous:Boolean=false) { val turn=CompanionState(this).updateTurn(requestId){it.copy(state=TurnState.TERMINAL,eventType="failed",text=message,code=code,ambiguous=ambiguous,sequence=(it.sequence+1).coerceAtMost(65535))}; turn?.let(::deliver); stopSelf() }
    private fun notifyText(text:String) { if(Build.VERSION.SDK_INT<33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED) getSystemService(NotificationManager::class.java).notify(CompanionNotifications.ACTIVE_NOTIFICATION_ID,CompanionNotifications.active(this,text)) }

    companion object {
        private const val ACTION_START="com.skarian.agentscompanion.START_STREAM"; private const val EXTRA_AGENT_ID="agent_id"; private const val EXTRA_TEXT="text"; private const val EXTRA_REQUEST_ID="request_id"
        private const val HEARTBEAT_MS = 15_000L
        fun start(context:Context,agentId:String,text:String,requestId:String):String { require(text.isNotBlank()); ContextCompat.startForegroundService(context,Intent(context,RouterRunService::class.java).setAction(ACTION_START).putExtra(EXTRA_REQUEST_ID,requestId).putExtra(EXTRA_AGENT_ID,agentId).putExtra(EXTRA_TEXT,text)); return requestId }
    }
}
