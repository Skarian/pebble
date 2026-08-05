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
        val requestId = intent.getStringExtra(TermuxCommandRunner.EXTRA_REQUEST_ID) ?: return
        val kind = intent.getStringExtra(TermuxCommandRunner.EXTRA_KIND) ?: return
        val mode = intent.getStringExtra(TermuxCommandRunner.EXTRA_MODE)
            ?.let { runCatching { ExecutionMode.valueOf(it) }.getOrNull() }
        val bundle = intent.getBundleExtra(
            TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE,
        ) ?: return
        val result = StoredResult(
            requestId = requestId,
            kind = kind,
            mode = mode,
            stdout = bundle.getString(
                TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_STDOUT,
                "",
            ),
            stderr = bundle.getString(
                TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_STDERR,
                "",
            ),
            exitCode = bundle.getInt(
                TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_EXIT_CODE,
                -1,
            ),
            errorCode = bundle.getInt(
                TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_ERR,
                -1,
            ).takeIf { it > 0 } ?: 0,
            errorMessage = bundle.getString(
                TermuxConstants.TERMUX_APP.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE_ERRMSG,
                "",
            ),
        )
        val state = CompanionState(context)
        state.saveResult(result)
        if (kind == TermuxCommandRunner.KIND_AGENTS && result.exitCode == 0) {
            runCatching { RouterProtocol.parseAgents(result.stdout) }
                .onSuccess(state::saveAgents)
        }
        if (kind == TermuxCommandRunner.KIND_DOCTOR) {
            val doctor = runCatching { RouterProtocol.parseDoctor(result.stdout) }.getOrNull()
            val status = if (doctor != null) {
                DoctorStatus(
                    doctor.ok,
                    doctor.checks.joinToString("\n") { check ->
                        "${if (check.ok) "OK" else "FAIL"}  ${check.summary}"
                    },
                )
            } else {
                DoctorStatus(false, result.stderr.ifBlank { result.errorMessage.ifBlank { "Doctor failed." } })
            }
            state.saveDoctor(status)
        }
        if (mode == ExecutionMode.STREAM) {
            RouterRunService.finish(context, requestId)
        }
        context.sendBroadcast(
            Intent(TermuxCommandRunner.ACTION_RESULT_UPDATED)
                .setPackage(context.packageName)
                .putExtra(TermuxCommandRunner.EXTRA_REQUEST_ID, requestId),
        )

        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val session = state.loadPebbleSession()
                if (session != null && kind == TermuxCommandRunner.KIND_AGENTS && result.exitCode == 0) {
                    PebbleTransport(context).sendAgents(session, state.loadAgents())
                }
                if (session != null && kind == TermuxCommandRunner.KIND_SEND &&
                    mode == ExecutionMode.FINAL_JSON
                ) {
                    val event = runCatching {
                        RouterProtocol.parseResult(result.stdout, ExecutionMode.FINAL_JSON).single()
                    }.getOrElse {
                        RouterEvent("failed", result.stderr.ifBlank { "Router command failed." }, "bridge_failed")
                    }
                    PebbleTransport(context).sendTextEvent(
                        session,
                        if (event.type == "completed") PhoneEvent.COMPLETED else PhoneEvent.FAILED,
                        requestId,
                        event.text,
                        event.code,
                    )
                }
            } catch (error: Exception) {
                state.saveBridgeError("Could not update the watch: ${error.message}")
            } finally {
                pending.finish()
            }
        }

        if (kind == TermuxCommandRunner.KIND_SEND) {
            val finalEvent = runCatching {
                RouterProtocol.parseResult(result.stdout, mode ?: ExecutionMode.FINAL_JSON).last()
            }.getOrNull()
            if (finalEvent?.type == "completed") {
                CompanionNotifications.showResult(context, "Agent replied", finalEvent.text)
            } else if (result.exitCode != 0 || finalEvent?.type == "failed") {
                CompanionNotifications.showResult(
                    context,
                    "Agent turn failed",
                    finalEvent?.text ?: result.stderr.ifBlank { "The router command failed." },
                )
            }
        }
    }
}
