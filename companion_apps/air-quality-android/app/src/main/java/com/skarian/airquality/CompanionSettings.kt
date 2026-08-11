package com.skarian.airquality

import android.content.Context
import android.content.SharedPreferences
import com.skarian.pebble.errors.ErrorReporter

class CompanionSettings(
    context: Context,
    private val errors: ErrorReporter = airErrorReporter(context.applicationContext),
) {
    private val preferences = context.getSharedPreferences("airquality.settings.v1", Context.MODE_PRIVATE)

    var sensorAddress: String?
        get() = read("reading the selected Aranet address", null) { preferences.getString("sensor_address", null) }
        set(value) { write("saving the selected Aranet address") { putString("sensor_address", value) } }

    var sensorName: String?
        get() = read("reading the selected Aranet name", null) { preferences.getString("sensor_name", null) }
        set(value) { write("saving the selected Aranet name") { putString("sensor_name", value) } }

    var watchName: String
        get() = read("reading the Air Quality watch name", "HOME") {
            preferences.getString("watch_name", "HOME") ?: "HOME"
        }
        set(value) {
            write("saving the Air Quality watch name") {
                putString("watch_name", value.trim().uppercase().take(20).ifEmpty { "HOME" })
            }
        }

    var historyImportedAddress: String?
        get() = read("reading Aranet history state", null) { preferences.getString("history_imported_address", null) }
        set(value) { write("saving Aranet history state") { putString("history_imported_address", value) } }

    var historyAttemptedAddress: String?
        get() = read("reading Aranet history attempt state", null) { preferences.getString("history_attempted_address", null) }
        set(value) { write("saving Aranet history attempt state") { putString("history_attempted_address", value) } }

    var lastDailySyncAttemptAt: Long
        get() = read("reading the last Air Quality sync attempt", 0L) { preferences.getLong("last_daily_sync_attempt_at", 0) }
        set(value) { write("saving the last Air Quality sync attempt") { putLong("last_daily_sync_attempt_at", value) } }

    var lastDailySyncSuccessAt: Long
        get() = read("reading the last successful Air Quality sync", 0L) { preferences.getLong("last_daily_sync_success_at", 0) }
        set(value) { write("saving the last successful Air Quality sync") { putLong("last_daily_sync_success_at", value) } }

    private fun write(whileDoing: String, update: SharedPreferences.Editor.() -> Unit) {
        try {
            check(preferences.edit().apply(update).commit()) { "SharedPreferences commit returned false." }
        } catch (error: Throwable) {
            errors.report(error, whileDoing)
        }
    }

    private fun <T> read(whileDoing: String, fallback: T, block: () -> T): T = try {
        block()
    } catch (error: Throwable) {
        errors.report(error, whileDoing)
        fallback
    }
}
