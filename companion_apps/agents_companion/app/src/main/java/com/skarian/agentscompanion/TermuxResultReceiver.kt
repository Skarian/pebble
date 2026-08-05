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
        val mode=intent.getStringExtra(TermuxCommandRunner.EXTRA_MODE)?.let { runCatching { ExecutionMode.valueOf(it) }.getOrNull() }
        val bundle=intent.getBundleExtra(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE) ?: return
        val result=StoredResult(requestId,kind,mode,bundle.getString(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_STDOUT,""),bundle.getString(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_STDERR,""),bundle.getInt(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_EXIT_CODE,-1),bundle.getInt(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_ERR,-1).takeIf{it>0}?:0,bundle.getString(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_ERRMSG,""))
        val state=CompanionState(context); state.saveResult(result)
        val pending=goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try { when(kind) {
                TermuxCommandRunner.KIND_AGENTS -> handleAgents(context,state,result)
                TermuxCommandRunner.KIND_DOCTOR -> handleDoctor(state,result)
                TermuxCommandRunner.KIND_SEND -> handleTurn(context,state,result,mode ?: ExecutionMode.FINAL_JSON)
            } } catch(error:Exception) { state.saveBridgeError("Could not process Termux result: ${error.message}") } finally { context.sendBroadcast(Intent(TermuxCommandRunner.ACTION_RESULT_UPDATED).setPackage(context.packageName).putExtra(TermuxCommandRunner.EXTRA_REQUEST_ID,requestId)); pending.finish() }
        }
    }

    private suspend fun handleAgents(context:Context,state:CompanionState,result:StoredResult) {
        val parsed=if(result.exitCode==0) runCatching { RouterProtocol.parseAgents(result.stdout).also { PebbleProtocol.agents(it,result.requestId) } }.getOrNull() else null
        val session=state.loadPebbleSession()
        if(parsed!=null) { state.saveAgents(parsed); if(session!=null) PebbleTransport(context).sendAgents(session,parsed,result.requestId) }
        else if(session!=null) PebbleTransport(context).sendTextEvent(session,PhoneEvent.AGENTS_FAILED,result.requestId,result.stderr.ifBlank { result.errorMessage.ifBlank { "Could not refresh agents." } },if(result.exitCode==0) "invalid_agents" else "refresh_failed",1)
    }
    private fun handleDoctor(state:CompanionState,result:StoredResult) { val doctor=runCatching { RouterProtocol.parseDoctor(result.stdout) }.getOrNull(); state.saveDoctor(if(doctor!=null) DoctorStatus(doctor.ok,doctor.checks.joinToString("\n"){"${if(it.ok)"OK" else "FAIL"}  ${it.summary}"}) else DoctorStatus(false,result.stderr.ifBlank { result.errorMessage.ifBlank { "Doctor failed." } })) }
    private suspend fun handleTurn(context:Context,state:CompanionState,result:StoredResult,mode:ExecutionMode) {
        val terminal=runCatching { RouterProtocol.parseResult(result.stdout,mode).lastOrNull()?.takeIf { it.type=="completed" || it.type=="failed" } }.getOrNull()
        val turn=state.updateTurn(result.requestId) { current ->
            if(current.state==TurnState.TERMINAL && current.eventType=="completed") current
            else if(terminal!=null) current.copy(state=TurnState.TERMINAL,eventType=terminal.type,text=terminal.text,code=terminal.code.orEmpty(),ambiguous=terminal.ambiguous,sequence=(current.sequence+1).coerceAtMost(65535))
            else current.copy(state=TurnState.TERMINAL,eventType="failed",text="The agent may have received your message.",code="status_unknown",ambiguous=true,sequence=(current.sequence+1).coerceAtMost(65535))
        } ?: return
        val kind=when { turn.ambiguous->PhoneEvent.STATUS_UNKNOWN; turn.eventType=="completed"->PhoneEvent.COMPLETED; else->PhoneEvent.FAILED }
        PebbleTransport(context).sendTextEvent(turn.session,kind,turn.requestId,turn.text,turn.code,turn.sequence,turn.ambiguous)
        context.stopService(Intent(context, RouterRunService::class.java))
        if(turn.eventType=="completed") CompanionNotifications.showResult(context,"Agent replied",turn.text) else if(!turn.ambiguous) CompanionNotifications.showResult(context,"Agent turn failed",turn.text)
    }
}
