package com.skarian.agentscompanion

import io.rebble.pebblekit2.client.BasePebbleListenerService
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import io.rebble.pebblekit2.common.model.ReceiveResult
import io.rebble.pebblekit2.common.model.WatchIdentifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.UUID

class AgentsPebbleListenerService : BasePebbleListenerService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onAppOpened(watchappUUID: UUID, watch: WatchIdentifier) {
        if (watchappUUID != WATCHAPP_UUID) return
        val session = PebbleSession(watchappUUID, watch.value)
        val state = CompanionState(this)
        state.savePebbleSession(session)
        scope.launch {
            val cached = state.loadAgents()
            if (cached.isNotEmpty()) PebbleTransport(this@AgentsPebbleListenerService).sendAgents(session, cached)
            runCatching { TermuxCommandRunner(this@AgentsPebbleListenerService).refreshAgents() }
                .onFailure { state.saveBridgeError(it.message ?: "Could not refresh agents.") }
        }
    }

    override fun onAppClosed(watchappUUID: UUID, watch: WatchIdentifier) {
        if (watchappUUID != WATCHAPP_UUID) return
        CompanionState(this).clearPebbleSession(PebbleSession(watchappUUID, watch.value))
    }

    override suspend fun onMessageReceived(
        watchappUUID: UUID,
        data: Map<UInt, PebbleDictionaryItem>,
        watch: WatchIdentifier,
    ): ReceiveResult {
        if (watchappUUID != WATCHAPP_UUID) return ReceiveResult.Nack
        val state = CompanionState(this)
        val session = PebbleSession(watchappUUID, watch.value)
        state.savePebbleSession(session)
        return try {
            val request = PebbleProtocol.parseWatchRequest(data)
            when (request.command) {
                WatchCommand.REFRESH_AGENTS -> TermuxCommandRunner(this).refreshAgents()
                WatchCommand.SEND -> {
                    val agentId = requireNotNull(request.agentId)
                    require(state.loadAgents().any { it.id == agentId }) { "Unknown agent id." }
                    val requestId = requireNotNull(request.requestId)
                    if (!state.claimRequestId(requestId)) {
                        scope.launch { replayRequest(session, requestId, state) }
                        return ReceiveResult.Ack
                    }
                    runCatching {
                        if (request.mode == ExecutionMode.STREAM) {
                            RouterRunService.start(this, agentId, requireNotNull(request.text), requestId)
                        } else {
                            TermuxCommandRunner(this).send(
                                agentId,
                                requireNotNull(request.text),
                                request.mode,
                                requestId,
                            )
                        }
                    }.onFailure { state.releaseRequestId(requestId) }.getOrThrow()
                    scope.launch {
                        runCatching {
                            PebbleTransport(this@AgentsPebbleListenerService).send(
                                session,
                                PebbleProtocol.event(PhoneEvent.ACCEPTED, requestId),
                            )
                        }.onFailure {
                            state.saveBridgeError("Could not acknowledge the watch request: ${it.message}")
                        }
                    }
                }
            }
            ReceiveResult.Ack
        } catch (error: Exception) {
            state.saveBridgeError(error.message ?: "Watch request failed.")
            ReceiveResult.Nack
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun replayRequest(
        session: PebbleSession,
        requestId: String,
        state: CompanionState,
    ) {
        val result = state.loadResult()?.takeIf { it.requestId == requestId }
        val event = result?.let {
            runCatching {
                RouterProtocol.parseResult(it.stdout, it.mode ?: ExecutionMode.FINAL_JSON).last()
            }.getOrNull()
        } ?: state.loadStream()?.takeIf { it.requestId == requestId && it.rawOutput.isNotBlank() }?.let {
            runCatching { RouterProtocol.parseResult(it.rawOutput, ExecutionMode.STREAM).last() }.getOrNull()
        }
        val transport = PebbleTransport(this)
        if (event == null) {
            transport.send(session, PebbleProtocol.event(PhoneEvent.ACCEPTED, requestId))
        } else {
            transport.sendTextEvent(
                session,
                when (event.type) {
                    "completed" -> PhoneEvent.COMPLETED
                    "failed" -> PhoneEvent.FAILED
                    else -> PhoneEvent.COMMENTARY
                },
                requestId,
                event.text,
                event.code,
            )
        }
    }

    companion object {
        val WATCHAPP_UUID: UUID = UUID.fromString("bba3f38f-53e5-458b-9d5f-0bcdb68ffd47")
    }
}
