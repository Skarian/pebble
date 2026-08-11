package com.skarian.pebble.errors

import android.app.*
import android.content.Context
import android.text.InputType
import android.util.Log
import android.view.ViewGroup.LayoutParams
import android.widget.*
import androidx.work.*
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
/** Records original errors before retry, fallback, or UI translation. */
fun interface ErrorReporter {
    fun report(originalError: Any, whileDoing: String)
    val enabled: Boolean get() = false
    suspend fun importWatch(source: String, generation: Long, sequence: Long, atEpochSeconds: Long,
                            payload: String, dropped: Long): Boolean = false
    fun status() = Status(false, 0)
    fun configure(enabled: Boolean, diagnosticKey: String? = null) = Unit
    fun sendNow() = Unit
    fun clear() = Unit
    fun openSettings(activity: Activity, onChanged: () -> Unit = {}) = Unit

    data class Status(val enabled: Boolean, val queued: Int)

    companion object {
        val Disabled = ErrorReporter { _, _ -> }
        internal const val ENDPOINT = "https://pebble.exe.xyz"
        internal const val WORK = "pebble-error-upload"
        internal const val FILE = "pebble-errors-v1.json"

        fun create(context: Context, source: String,
                   sensitiveValues: () -> Collection<String> = { emptyList() }): ErrorReporter {
            require(source.isNotBlank())
            val app = context.applicationContext
            return synchronized(reporters) { reporters.getOrPut(source) {
                AndroidErrorReporter(source, Preferences(app),
                    ErrorJournal(FileStore(File(app.noBackupFilesDir, FILE))), sensitiveValues,
                    { policy -> schedule(app, policy) },
                    { WorkManager.getInstance(app).cancelUniqueWork(WORK) },
                ).also(::installUncaughtHandler)
            } }
        }

        private fun schedule(context: Context, policy: ExistingWorkPolicy) {
            val request = OneTimeWorkRequestBuilder<ErrorUploadWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context).enqueueUniqueWork(WORK, policy, request)
        }
        private val reporters = mutableMapOf<String, ErrorReporter>()
        private val handlerLock = Any()
        private var handlerInstalled = false
        private fun installUncaughtHandler(reporter: ErrorReporter) = synchronized(handlerLock) {
            if (!handlerInstalled) {
                Thread.setDefaultUncaughtExceptionHandler(ReportingUncaughtHandler(
                    reporter, Thread.getDefaultUncaughtExceptionHandler(),
                ))
                handlerInstalled = true
            }
        }
    }
}

internal data class Config(val key: String = "") { val usable get() = key.isNotBlank() }
internal interface Settings { fun read(): Config; fun write(value: Config) }
internal class Preferences(context: Context) : Settings {
    private val values = context.getSharedPreferences("pebble_errors", Context.MODE_PRIVATE)
    override fun read() = Config(values.getString("key_v1", "").orEmpty())
    override fun write(value: Config) { check(values.edit().putString("key_v1", value.key)
        .remove("enabled_v1").remove("url_v1").commit()) {
        "Could not save error-reporting settings." } }
}

internal class ReportingUncaughtHandler(
    private val reporter: ErrorReporter,
    private val delegate: Thread.UncaughtExceptionHandler?,
) : Thread.UncaughtExceptionHandler {
    override fun uncaughtException(thread: Thread, error: Throwable) {
        try {
            if (reporter.enabled) reporter.report(
                error, "handling an uncaught exception on ${thread.name.take(64)}",
            )
        } catch (reportingFailure: Throwable) {
            Log.e("PebbleErrors", "Could not preserve an uncaught exception", reportingFailure)
        } finally {
            delegate?.uncaughtException(thread, error)
        }
    }
}

internal class AndroidErrorReporter(
    private val source: String, private val settings: Settings, private val journal: ErrorJournal,
    private val secrets: () -> Collection<String>, private val schedule: (ExistingWorkPolicy) -> Unit,
    private val cancel: () -> Unit,
) : ErrorReporter {
    private val lock = Any()
    private var config = preserve(settings::read).getOrNull()?.takeIf(Config::usable)

    init {
        synchronized(lock) {
            if (config != null && preserve(journal::size).getOrDefault(0) > 0) {
                preserve { schedule(ExistingWorkPolicy.KEEP) }
            }
        }
    }

    override val enabled get() = synchronized(lock) { config != null }

    override fun report(originalError: Any, whileDoing: String) = synchronized(lock) {
        val current = config ?: return@synchronized
        preserve { journal.add(Capture.error(source, whileDoing, originalError, secrets(current))) }
            .onSuccess { preserve { schedule(ExistingWorkPolicy.KEEP) } }
    }

    override suspend fun importWatch(source: String, generation: Long, sequence: Long, atEpochSeconds: Long,
                                     payload: String, dropped: Long): Boolean {
        return withContext(Dispatchers.IO) { synchronized(lock) {
            val current = config ?: return@synchronized false
            preserve { journal.add(Capture.watch(source, generation, sequence, atEpochSeconds, payload, dropped, secrets(current))) }
                .onSuccess { preserve { schedule(ExistingWorkPolicy.KEEP) } }.isSuccess
        } }
    }

    override fun status(): ErrorReporter.Status = synchronized(lock) {
        val active = config != null
        val queued = if (active) preserve(journal::size).getOrDefault(0) else 0
        ErrorReporter.Status(active, queued)
    }

    override fun configure(enabled: Boolean, diagnosticKey: String?) {
        if (!enabled) {
            synchronized(lock) {
                config = null
                val settingsFailure = runCatching { settings.write(Config()) }.exceptionOrNull()
                preserve(cancel)
                val clearFailure = preserve(journal::clear).exceptionOrNull()
                (settingsFailure ?: clearFailure)?.let { throw it }
            }
            return
        }
        synchronized(lock) {
            val previous = config
            val key = diagnosticKey?.trim()?.takeIf(String::isNotBlank) ?: previous?.key.orEmpty()
            require(key.isNotBlank()) { "A Diagnostic key is required." }
            if (previous == null) preserve(journal::clear).getOrThrow()
            val next = Config(key)
            settings.write(next); config = next
            schedule(if (previous != null && previous.key != key) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP)
        }
    }

    override fun sendNow() { synchronized(lock) {
        if (config != null) preserve { schedule(ExistingWorkPolicy.REPLACE) }
    } }
    override fun clear() = synchronized(lock) { preserve(journal::clear); Unit }
    override fun openSettings(activity: Activity, onChanged: () -> Unit) = settingsDialog(activity, this, onChanged)
    private fun secrets(config: Config) = listOf(config.key) + runCatching(secrets).getOrDefault(emptyList())
    private fun <T> preserve(block: () -> T) = runCatching(block).onFailure { Log.e("PebbleErrors", "Could not preserve an error", it) }
}

private fun settingsDialog(activity: Activity, reporter: ErrorReporter, changed: () -> Unit) {
    val initial = reporter.status(); val density = activity.resources.displayMetrics.density
    val content = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding((20 * density).toInt(), 0, (20 * density).toInt(), 0) }
    val enabled = CheckBox(activity).apply { text = "Send errors to Pebble Diagnostics"; isChecked = initial.enabled }
    val key = EditText(activity).apply { hint = "Diagnostic key (blank keeps saved key)"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
    val status = TextView(activity); val clear = Button(activity).apply { text = "Clear queued errors" }
    listOf(TextView(activity).apply { text = "Optional errors only; successful activity and app content are not sent. Create or recreate the Diagnostic key at ${ErrorReporter.ENDPOINT}/diagnostics." }, enabled, key, status, clear)
        .forEach { content.addView(it, LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT) }
    fun render() { reporter.status().let { status.text = "${if (it.enabled) "Enabled" else "Disabled"} · ${it.queued} queued"; clear.isEnabled = it.queued > 0 } }
    fun save() = runCatching { reporter.configure(enabled.isChecked, key.text.toString()) }
        .onFailure { Toast.makeText(activity, it.message ?: "Could not save settings.", Toast.LENGTH_LONG).show() }
        .onSuccess { key.text.clear(); render(); changed() }.isSuccess
    val dialog = AlertDialog.Builder(activity).setTitle("Error reporting").setView(content)
        .setPositiveButton("Save", null).setNeutralButton("Send now", null).setNegativeButton("Close", null).create()
    clear.setOnClickListener { reporter.clear(); render(); changed() }
    dialog.setOnShowListener {
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { if (save()) dialog.dismiss() }
        dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener { if (save()) reporter.sendNow() }
    }
    render(); dialog.show()
}
