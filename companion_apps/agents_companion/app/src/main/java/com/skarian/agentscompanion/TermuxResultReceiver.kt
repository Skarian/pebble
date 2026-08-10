package com.skarian.agentscompanion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.termux.shared.termux.TermuxConstants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class TermuxResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val requestId=intent.getStringExtra(TermuxCommandRunner.EXTRA_REQUEST_ID) ?: return; val kind=intent.getStringExtra(TermuxCommandRunner.EXTRA_KIND) ?: return
        val watchId = intent.getStringExtra(TermuxCommandRunner.EXTRA_WATCH_ID)
        val mode=intent.getStringExtra(TermuxCommandRunner.EXTRA_MODE)?.let { runCatching { ExecutionMode.valueOf(it) }.getOrNull() }
        val bundle=intent.getBundleExtra(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE) ?: return
        val result=StoredResult(requestId,kind,mode,bundle.getString(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_STDOUT,""),bundle.getString(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_STDERR,""),bundle.getInt(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_EXIT_CODE,-1),bundle.getInt(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_ERR,-1).takeIf{it>0}?:0,bundle.getString(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_ERRMSG,""))
        val state=CompanionState(context); state.saveResult(result)
        val pending=goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try { when(kind) {
                TermuxCommandRunner.KIND_AGENTS -> handleAgents(context,state,result,watchId)
                TermuxCommandRunner.KIND_DOCTOR -> handleDoctor(state,result)
                TermuxCommandRunner.KIND_SEND -> handleTurn(context,state,result,mode ?: ExecutionMode.FINAL_JSON)
            } } catch(error:Exception) { state.saveBridgeError("Could not process Termux result: ${error.message}") } finally { context.sendBroadcast(Intent(TermuxCommandRunner.ACTION_RESULT_UPDATED).setPackage(context.packageName).putExtra(TermuxCommandRunner.EXTRA_REQUEST_ID,requestId)); pending.finish() }
        }
    }

    private suspend fun handleAgents(
        context: Context,
        state: CompanionState,
        result: StoredResult,
        watchId: String?,
    ) {
        val response = parseAgentRefresh(result)
        response.agents?.let(state::saveAgents)
        val appContext = context.applicationContext
        val messages = AgentsAppMessage(appContext)
        val watch = watchId?.let { PebbleSession(AgentsPebbleListenerService.WATCHAPP_UUID, it) }
        val target = watch?.let {
            messages.completeRead(it, AGENT_REFRESH_OPERATION, result.requestId) { replayWatch ->
                finishAgentRefresh(
                    appContext, CompanionState(appContext), replayWatch, result.requestId, response,
                )
            }
        }
        finishAgentRefresh(appContext, state, target, result.requestId, response)
    }
    private fun handleDoctor(state:CompanionState,result:StoredResult) { val doctor=runCatching { RouterProtocol.parseDoctor(result.stdout) }.getOrNull(); state.saveDoctor(if(doctor!=null) DoctorStatus(doctor.ok,doctor.checks.joinToString("\n"){"${if(it.ok)"OK" else "FAIL"}  ${it.summary}"}) else DoctorStatus(false,result.stderr.ifBlank { result.errorMessage.ifBlank { "Doctor failed." } })) }
    private suspend fun handleTurn(context:Context,state:CompanionState,result:StoredResult,mode:ExecutionMode) {
        val terminal=runCatching { RouterProtocol.parseResult(result.stdout,mode).lastOrNull()?.takeIf { it.type=="completed" || it.type=="failed" } }.getOrNull()
        val turn=state.updateTurn(result.requestId) { current ->
            if(current.state==TurnState.TERMINAL && current.eventType=="completed") current
            else if(terminal!=null) current.copy(state=TurnState.TERMINAL,eventType=terminal.type,text=terminal.text,code=terminal.code.orEmpty(),ambiguous=terminal.ambiguous,sequence=(current.sequence+1).coerceAtMost(65535))
            else current.copy(state=TurnState.TERMINAL,eventType="failed",text="The agent may have received your message.",code="status_unknown",ambiguous=true,sequence=(current.sequence+1).coerceAtMost(65535))
        } ?: return
        if (turn.text.isNotBlank()) state.appendHistory(CachedMessage("${turn.requestId}/terminal", turn.agentId, turn.requestId, turn.sequence, false, turn.text))
        val kind=when { turn.ambiguous->PhoneEvent.STATUS_UNKNOWN; turn.eventType=="completed"->PhoneEvent.COMPLETED; else->PhoneEvent.FAILED }
        val outcome = AgentsAppMessage(context).sendTextEvent(
            turn.session, kind, turn.requestId, turn.text, turn.code,
            turn.sequence, turn.ambiguous,
        )
        if (!outcome.delivered) {
            state.saveBridgeError("Could not deliver the terminal turn (${outcome.failure}).")
        }
        context.stopService(Intent(context, RouterRunService::class.java))
        if(turn.eventType=="completed") CompanionNotifications.showResult(context,"Agent replied",turn.text) else if(!turn.ambiguous) CompanionNotifications.showResult(context,"Agent turn failed",turn.text)
    }
}

internal data class AgentRefreshReply(val agents: List<AgentSummary>?, val category: String)

internal fun parseAgentRefresh(result: StoredResult): AgentRefreshReply {
    val agents = if (result.exitCode != 0) null else runCatching {
        RouterProtocol.parseAgents(result.stdout).also { PebbleProtocol.agents(it, result.requestId) }
    }.getOrNull()
    return AgentRefreshReply(agents, when {
        result.exitCode != 0 -> "refresh_failed"
        agents == null -> "invalid_agents"
        else -> "ok"
    })
}

internal suspend fun finishAgentRefresh(
    context: Context, state: CompanionState, session: PebbleSession?,
    requestId: String, reply: AgentRefreshReply,
) {
    val messages = AgentsAppMessage(context)
    messages.record(AGENT_REFRESH_OPERATION, requestId, "domain_terminal", reply.category, session)
    session ?: return
    val outcome = reply.agents?.let { messages.sendAgents(session, it, requestId) } ?:
        messages.sendTextEvent(
            session, PhoneEvent.AGENTS_FAILED, requestId,
            "Could not refresh agents.", reply.category, 1,
        )
    if (!outcome.delivered) state.saveBridgeError(
        "Could not deliver the agent refresh (${outcome.failure}).",
    )
}
