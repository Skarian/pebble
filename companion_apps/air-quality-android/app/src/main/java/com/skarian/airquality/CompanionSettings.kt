package com.skarian.airquality

import android.content.Context

class CompanionSettings(context: Context) {
    private val preferences = context.getSharedPreferences("airquality.settings.v1", Context.MODE_PRIVATE)

    var sensorAddress: String?
        get() = preferences.getString("sensor_address", null)
        set(value) { preferences.edit().putString("sensor_address", value).apply() }

    var sensorName: String?
        get() = preferences.getString("sensor_name", null)
        set(value) { preferences.edit().putString("sensor_name", value).apply() }

    var watchName: String
        get() = preferences.getString("watch_name", "HOME") ?: "HOME"
        set(value) {
            preferences.edit().putString("watch_name", value.trim().uppercase().take(20).ifEmpty { "HOME" }).apply()
        }

    var monitoringEnabled: Boolean
        get() = preferences.getBoolean("monitoring", false)
        set(value) { preferences.edit().putBoolean("monitoring", value).apply() }

    var historyImportedAddress: String?
        get() = preferences.getString("history_imported_address", null)
        set(value) { preferences.edit().putString("history_imported_address", value).apply() }

    var historyAttemptedAddress: String?
        get() = preferences.getString("history_attempted_address", null)
        set(value) { preferences.edit().putString("history_attempted_address", value).apply() }
}
