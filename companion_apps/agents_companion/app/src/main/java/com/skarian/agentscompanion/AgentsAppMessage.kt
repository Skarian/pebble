package com.skarian.agentscompanion

import android.content.Context
import com.skarian.pebble.appmessage.AppMessageSession
import com.skarian.pebble.errors.ErrorReporter
import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import java.util.UUID

data class PebbleSession(val appUuid: UUID, val watchId: String)

internal const val AGENT_REFRESH_OPERATION = "refresh_agents"
internal const val AGENT_HISTORY_OPERATION = "history"

/** Agents dictionaries and projections; AppMessage mechanics live in the shared session. */
internal class AgentsAppMessage(context: Context) {
    private val session = appMessageSession(context)

    fun open(watch: PebbleSession) = session.open(watch.watchId)

    suspend fun announceReady(watch: PebbleSession) =
        session.announceReady(watch.watchId, PebbleProtocol.ready())

    suspend fun repeatReadyForOpenWatches() =
        session.repeatReadyForOpenWatches(PebbleProtocol.ready())

    fun close(watch: PebbleSession) = session.close(watch.watchId)

    suspend fun receiveWatchError(watch: PebbleSession, data: PebbleDictionary) =
        session.receiveWatchError(watch.watchId, data)

    suspend fun send(
        watch: PebbleSession,
        data: Map<UInt, PebbleDictionaryItem>,
        operation: String,
        requestId: String,
    ) = session.send(watch.watchId, operation, requestId, data)

    suspend fun sendAgents(
        watch: PebbleSession,
        agents: List<AgentSummary>,
        requestId: String? = null,
        cached: Boolean = false,
    ) = send(
        watch,
        PebbleProtocol.agents(agents, requestId, cached),
        "agents",
        requestId ?: "session",
    )

    suspend fun sendTextEvent(
        watch: PebbleSession,
        kind: PhoneEvent,
        requestId: String,
        text: String,
        code: String? = null,
        sequence: Int = 0,
        ambiguous: Boolean = false,
    ): AppMessageSession.Delivery {
        val projected = PebbleProtocol.projectText(text)
        val chunks = PebbleProtocol.chunkText(projected.text)
        val flags = (if (projected.truncated) PebbleProtocol.FLAG_TRUNCATED else 0) or
            (if (ambiguous) PebbleProtocol.FLAG_AMBIGUOUS else 0)
        return session.sendBatch(
            watch.watchId,
            "turn_update",
            requestId,
            chunks.mapIndexed { index, chunk ->
                PebbleProtocol.event(
                    kind, requestId, chunk, code, index, chunks.size, sequence, flags,
                )
            },
        )
    }

    suspend fun sendHistory(
        watch: PebbleSession,
        requestId: String,
        messages: List<CachedMessage>,
    ): AppMessageSession.Delivery {
        val snapshot = projectHistoryForWatch(messages)
        val batch = buildList {
            for ((messageIndex, message) in snapshot.withIndex()) {
                val projected = PebbleProtocol.projectText(message.text)
                val chunks = PebbleProtocol.chunkText(projected.text)
                val flags = (if (projected.truncated) PebbleProtocol.FLAG_TRUNCATED else 0) or
                    (if (message.user) PebbleProtocol.FLAG_USER else 0)
                chunks.forEachIndexed { chunkIndex, chunk ->
                    add(PebbleProtocol.event(
                        PhoneEvent.HISTORY_ITEM,
                        requestId,
                        chunk,
                        chunkIndex = chunkIndex,
                        chunkCount = chunks.size,
                        sequence = messageIndex + 1,
                        flags = flags,
                    ))
                }
            }
            add(PebbleProtocol.event(
                PhoneEvent.HISTORY_END,
                requestId,
                sequence = snapshot.size,
            ))
        }
        return session.sendBatch(watch.watchId, "history", requestId, batch)
    }

    fun beginRead(
        watch: PebbleSession,
        operation: String,
        requestId: String,
        identity: String = "",
    ) = session.beginRead(watch.watchId, operation, requestId, identity)

    fun completeRead(
        watch: PebbleSession,
        operation: String,
        requestId: String,
        replay: suspend (PebbleSession) -> Unit,
    ): PebbleSession? = if (
        session.completeRead(watch.watchId, operation, requestId) { replay(watch) }
    ) watch else null

    fun abandonRead(watch: PebbleSession, operation: String, requestId: String) =
        session.abandonRead(watch.watchId, operation, requestId)

    companion object {
        fun appMessageSession(context: Context) = AppMessageSession(
            context.applicationContext,
            AgentsPebbleListenerService.WATCHAPP_UUID,
            agentsErrorReporter(context),
            "agents/watch@${BuildConfig.VERSION_NAME}",
        )
    }
}

internal fun agentsErrorReporter(context: Context): ErrorReporter = ErrorReporter.create(
    context.applicationContext,
    "agents/android@${BuildConfig.VERSION_NAME}",
) { CompanionState(context.applicationContext, ErrorReporter.Disabled).sensitiveErrorValues() }
