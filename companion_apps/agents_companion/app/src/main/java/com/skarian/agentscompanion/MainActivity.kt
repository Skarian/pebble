package com.skarian.agentscompanion

import android.Manifest
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.format.DateUtils
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import io.rebble.pebblekit2.client.DefaultPebbleAndroidAppPicker
import io.rebble.pebblekit2.client.DefaultPebbleInfoRetriever
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private lateinit var state: CompanionState
    private lateinit var runner: TermuxCommandRunner
    private lateinit var overallStatus: TextView
    private lateinit var termuxStatus: TextView
    private lateinit var agentsStatus: TextView
    private lateinit var pebbleStatus: TextView
    private lateinit var latestStatus: TextView
    private lateinit var progress: ProgressBar
    private lateinit var grantTermux: Button
    private lateinit var grantNotifications: Button
    private lateinit var refreshAgents: Button
    private lateinit var runDoctor: Button
    private var activeRequestId: String? = null
    private var pebbleJob: Job? = null
    private var connectedWatches = "Checking Core…"

    private val termuxPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { render() }

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { render() }

    private val resultReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val requestId = intent?.getStringExtra(TermuxCommandRunner.EXTRA_REQUEST_ID)
            if (activeRequestId == null || activeRequestId == requestId) activeRequestId = null
            render()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        state = CompanionState(this)
        runner = TermuxCommandRunner(this)
        bindViews()

        grantTermux.setOnClickListener { termuxPermission.launch(TERMUX_RUN_COMMAND_PERMISSION) }
        grantNotifications.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        refreshAgents.setOnClickListener { startCommand("Refreshing agents…") { runner.refreshAgents() } }
        runDoctor.setOnClickListener { startCommand("Checking router setup…", runner::doctor) }
        findViewById<Button>(R.id.copyDiagnosticsButton).setOnClickListener {
            val diagnostics = AgentsAppMessage.appMessageSession(this)
            diagnostics.replayLogcat()
            getSystemService(ClipboardManager::class.java).setPrimaryClip(
                ClipData.newPlainText("Agents connection diagnostics", diagnostics.exportLog()),
            )
            latestStatus.text = "Diagnostics copied."
        }
        AgentsAppMessage.appMessageSession(this).replayLogcat()
        render()
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(TermuxCommandRunner.ACTION_RESULT_UPDATED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(resultReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(resultReceiver, filter)
        }
        pebbleJob = lifecycleScope.launch {
            val picker = DefaultPebbleAndroidAppPicker.getInstance(this@MainActivity)
            val selected = runCatching { picker.getCurrentlySelectedApp() }.getOrNull()
            DefaultPebbleInfoRetriever(this@MainActivity).getConnectedWatches()
                .catch { error ->
                    connectedWatches = "Core unavailable: ${error.message ?: "provider error"}"
                    render()
                }
                .collect { watches ->
                    connectedWatches = if (watches.isEmpty()) {
                        "${selected ?: "No Pebble provider selected"}\nNo watch connected"
                    } else {
                        buildString {
                            append(selected ?: "Pebble provider")
                            append('\n')
                            append(watches.joinToString("\n") { "${it.name} · ${it.platform}" })
                        }
                    }
                    render()
                }
        }
    }

    override fun onStop() {
        pebbleJob?.cancel()
        unregisterReceiver(resultReceiver)
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun bindViews() {
        overallStatus = findViewById(R.id.overallStatus)
        termuxStatus = findViewById(R.id.termuxStatus)
        agentsStatus = findViewById(R.id.agentsStatus)
        pebbleStatus = findViewById(R.id.pebbleStatus)
        latestStatus = findViewById(R.id.latestStatus)
        progress = findViewById(R.id.progressBar)
        grantTermux = findViewById(R.id.grantTermuxButton)
        grantNotifications = findViewById(R.id.grantNotificationsButton)
        refreshAgents = findViewById(R.id.refreshAgentsButton)
        runDoctor = findViewById(R.id.runDoctorButton)
    }

    private fun startCommand(label: String, command: () -> String) {
        runCatching(command)
            .onSuccess {
                activeRequestId = it
                latestStatus.text = label
                renderActions()
            }
            .onFailure {
                activeRequestId = null
                state.saveBridgeError(it.message ?: "Could not start Termux command.")
                render()
            }
    }

    private fun render() {
        val termuxInstalled = runCatching { packageManager.getPackageInfo("com.termux", 0) }.isSuccess
        val runPermission = checkSelfPermission(TERMUX_RUN_COMMAND_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED
        val notificationsGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val agents = state.loadAgents()
        val doctor = state.loadDoctor()

        overallStatus.text = when {
            !termuxInstalled -> "Setup needed: install Termux"
            !runPermission -> "Setup needed: grant Termux access"
            agents.isEmpty() -> "Setup needed: refresh agents"
            doctor?.ok == false -> "Router needs attention"
            else -> "Ready"
        }
        termuxStatus.text = buildString {
            append(if (termuxInstalled) "✓ Termux installed" else "✗ Termux not installed")
            append('\n')
            append(if (runPermission) "✓ Run-command access granted" else "✗ Run-command access not granted")
            append('\n')
            append(if (notificationsGranted) "✓ Result notifications enabled" else "○ Result notifications disabled")
            doctor?.let {
                append("\n${if (it.ok) "✓" else "✗"} Codex Router doctor")
                append(" · ${relativeTime(state.doctorUpdatedAt())}")
            }
        }
        agentsStatus.text = if (agents.isEmpty()) {
            "No cached agents. Refresh after configuring ~/.codex-router.toml in Termux."
        } else {
            agents.joinToString("\n") { "${it.label}  ·  ${it.id}" } +
                "\nUpdated ${relativeTime(state.agentsUpdatedAt())}"
        }
        pebbleStatus.text = buildString {
            append(connectedWatches)
            state.loadPebbleSession()?.let {
                append("\nAgents watchapp active · ${relativeTime(state.pebbleOpenedAt())}")
            } ?: append("\nAgents watchapp not active")
        }
        latestStatus.text = renderLatest(doctor)
        renderActions(termuxInstalled, runPermission, notificationsGranted)
    }

    private fun renderLatest(doctor: DoctorStatus?): String {
        if (activeRequestId != null) return latestStatus.text.toString()
        val turn = state.loadTurn()
        if (turn != null && turn.state != TurnState.TERMINAL) return "Agent turn in progress"
        val result = state.loadResult()
        if (result?.kind == TermuxCommandRunner.KIND_SEND) {
            val event = runCatching {
                RouterProtocol.parseResult(result.stdout, result.mode ?: ExecutionMode.FINAL_JSON).last()
            }.getOrNull()
            return when {
                event?.type == "completed" -> "Last agent turn completed successfully."
                event?.type == "failed" -> "Last agent turn failed: ${event.code ?: "router error"}"
                result.exitCode != 0 -> "Last Termux command failed with exit ${result.exitCode}."
                else -> "Last agent result is unavailable."
            }
        }
        val bridgeError = state.loadBridgeError()
        if (bridgeError.isNotBlank()) return bridgeError
        return doctor?.summary ?: "No agent turns yet."
    }

    private fun renderActions(
        termuxInstalled: Boolean = runCatching { packageManager.getPackageInfo("com.termux", 0) }.isSuccess,
        runPermission: Boolean = checkSelfPermission(TERMUX_RUN_COMMAND_PERMISSION) == PackageManager.PERMISSION_GRANTED,
        notificationsGranted: Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED,
    ) {
        val idle = activeRequestId == null
        progress.visibility = if (idle) View.GONE else View.VISIBLE
        grantTermux.visibility = if (termuxInstalled && !runPermission) View.VISIBLE else View.GONE
        grantNotifications.visibility = if (!notificationsGranted) View.VISIBLE else View.GONE
        refreshAgents.isEnabled = termuxInstalled && runPermission && idle
        runDoctor.isEnabled = termuxInstalled && runPermission && idle
    }

    private fun relativeTime(timestamp: Long): String = if (timestamp == 0L) {
        "never"
    } else {
        DateUtils.getRelativeTimeSpanString(timestamp).toString()
    }

    companion object {
        private const val TERMUX_RUN_COMMAND_PERMISSION = "com.termux.permission.RUN_COMMAND"
    }
}
