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
import java.security.MessageDigest
import java.util.UUID

class AgentsPebbleListenerService : BasePebbleListenerService() {
    override val coroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onAppOpened(watchappUUID: UUID, watch: WatchIdentifier) {
        if (watchappUUID != WATCHAPP_UUID) return
        val session = PebbleSession(watchappUUID, watch.value); val state = CompanionState(this)
        state.savePebbleSession(session)
        coroutineScope.launch {
            state.loadAgents().takeIf { it.isNotEmpty() }?.let { runCatching { PebbleTransport(this@AgentsPebbleListenerService).sendAgents(session, it, cached = true) } }
            runCatching { TermuxCommandRunner(this@AgentsPebbleListenerService).refreshAgents() }.onFailure { state.saveBridgeError(it.message ?: "Could not refresh agents.") }
        }
    }

    override fun onAppClosed(watchappUUID: UUID, watch: WatchIdentifier) { if (watchappUUID == WATCHAPP_UUID) CompanionState(this).clearPebbleSession(PebbleSession(watchappUUID, watch.value)) }

    override suspend fun onMessageReceived(watchappUUID: UUID, data: Map<UInt, PebbleDictionaryItem>, watch: WatchIdentifier): ReceiveResult {
        if (watchappUUID != WATCHAPP_UUID) return ReceiveResult.Nack
        val state = CompanionState(this); val session = PebbleSession(watchappUUID, watch.value); state.savePebbleSession(session)
        return try {
            val request = PebbleProtocol.parseWatchRequest(data)
            when (request.command) {
                WatchCommand.REFRESH_AGENTS -> TermuxCommandRunner(this).refreshAgents(request.requestId ?: UUID.randomUUID().toString())
                WatchCommand.RECONCILE -> coroutineScope.launch { replayTurn(session, requireNotNull(request.requestId), state, rebind = true) }
                WatchCommand.HISTORY -> coroutineScope.launch {
                    val agentId = requireNotNull(request.agentId)
                    PebbleTransport(this@AgentsPebbleListenerService).sendHistory(session, requireNotNull(request.requestId), state.loadHistory(agentId))
                }
                WatchCommand.SEND -> {
                    val agentId = requireNotNull(request.agentId); val requestId = requireNotNull(request.requestId); val text = requireNotNull(request.text)
                    if (state.loadAgents().none { it.id == agentId }) {
                        coroutineScope.launch { PebbleTransport(this@AgentsPebbleListenerService).sendTextEvent(session, PhoneEvent.FAILED, requestId, "That saved agent is no longer available.", "agent_unavailable", 1) }
                        return ReceiveResult.Ack
                    }
                    val turn = StoredTurn(requestId, agentId, sha256(text), TurnState.QUEUED, session)
                    when (state.claimTurn(turn)) {
                        TurnClaim.DUPLICATE -> coroutineScope.launch { replayTurn(session, requestId, state, rebind = true) }
                        TurnClaim.BUSY -> coroutineScope.launch { PebbleTransport(this@AgentsPebbleListenerService).sendTextEvent(session, PhoneEvent.FAILED, requestId, "Another agent turn is already running.", "busy", 1) }
                        TurnClaim.CLAIMED -> runCatching {
                            state.appendHistory(CachedMessage("$requestId/user", agentId, requestId, 0, true, text))
                            RouterRunService.start(this, agentId, text, requestId)
                        }.onFailure { error ->
                            val failed = state.updateTurn(requestId) { it.copy(state=TurnState.TERMINAL,eventType="failed",text="Could not start the agent turn.",code="bridge_start_failed",sequence=1) }
                            failed?.let { state.appendHistory(CachedMessage("${it.requestId}/terminal", it.agentId, it.requestId, it.sequence, false, it.text)) }
                            failed?.let { coroutineScope.launch { replayTurn(session, requestId, state) } }; throw error
                        }
                    }
                }
            }
            ReceiveResult.Ack
        } catch (error: Exception) { state.saveBridgeError(error.message ?: "Watch request failed."); ReceiveResult.Nack }
    }

    override fun onDestroy() { coroutineScope.cancel(); super.onDestroy() }

    private suspend fun replayTurn(session: PebbleSession, requestId: String, state: CompanionState, rebind: Boolean = false) {
        var turn = state.loadTurn()?.takeIf { it.requestId == requestId }
        if (turn == null) { PebbleTransport(this).sendTextEvent(session, PhoneEvent.STATUS_UNKNOWN, requestId, "The agent may have received your message.", "status_unknown", 1, true); return }
        if (rebind && turn.session != session) turn = state.updateTurn(requestId, touch = false) { it.copy(session=session) } ?: turn
        if (turn.state == TurnState.QUEUED) {
            turn = if (System.currentTimeMillis() - turn.updatedAt > QUEUE_LEASE_TIMEOUT_MS) {
                val now = System.currentTimeMillis()
                state.updateTurn(requestId) {
                    if (it.state == TurnState.QUEUED && now - it.updatedAt > QUEUE_LEASE_TIMEOUT_MS) {
                        it.copy(state=TurnState.TERMINAL,eventType="failed",text="The agent may have received your message.",code="status_unknown",ambiguous=true,sequence=maxOf(2,it.sequence + 1))
                    } else it
                } ?: turn
            } else turn.copy(eventType="accepted",text="",code="",ambiguous=false,sequence=maxOf(1,turn.sequence))
        } else if (turn.state == TurnState.RUNNING && System.currentTimeMillis() - turn.updatedAt > LEASE_TIMEOUT_MS) {
            val now = System.currentTimeMillis()
            turn = state.updateTurn(requestId) {
                if (it.state == TurnState.RUNNING && now - it.updatedAt > LEASE_TIMEOUT_MS) {
                    it.copy(state=TurnState.TERMINAL,eventType="failed",text="The agent may have received your message.",code="status_unknown",ambiguous=true,sequence=(it.sequence+1).coerceAtMost(65535))
                } else it
            } ?: turn
        }
        val kind = when { turn.ambiguous -> PhoneEvent.STATUS_UNKNOWN; turn.eventType == "completed" -> PhoneEvent.COMPLETED; turn.eventType == "failed" -> PhoneEvent.FAILED; turn.eventType == "accepted" -> PhoneEvent.ACCEPTED; else -> PhoneEvent.COMMENTARY }
        PebbleTransport(this).sendTextEvent(session, kind, requestId, turn.text, turn.code, turn.sequence, turn.ambiguous)
    }

    private fun sha256(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
    companion object { val WATCHAPP_UUID: UUID = UUID.fromString("bba3f38f-53e5-458b-9d5f-0bcdb68ffd47"); private const val QUEUE_LEASE_TIMEOUT_MS = 15_000L; private const val LEASE_TIMEOUT_MS = 45_000L }
}
