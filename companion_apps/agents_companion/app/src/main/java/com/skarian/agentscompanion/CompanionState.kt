package com.skarian.agentscompanion

import android.content.Context
import org.json.JSONObject

data class StoredResult(
    val requestId: String,
    val kind: String,
    val mode: ExecutionMode?,
    val stdout: String,
    val stderr: String,
    val exitCode: Int,
    val errorCode: Int,
    val errorMessage: String,
)

data class StoredStream(
    val requestId: String,
    val rawOutput: String,
    val running: Boolean,
    val errorMessage: String = "",
)

data class DoctorStatus(val ok: Boolean, val summary: String)

class CompanionState(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun saveAgents(agents: List<AgentSummary>) {
        preferences.edit()
            .putString(KEY_AGENTS, RouterProtocol.agentsToJson(agents))
            .putLong(KEY_AGENTS_UPDATED_AT, System.currentTimeMillis())
            .apply()
    }

    fun loadAgents(): List<AgentSummary> = preferences.getString(KEY_AGENTS, null)
        ?.let { runCatching { RouterProtocol.parseAgents(it) }.getOrDefault(emptyList()) }
        ?: emptyList()

    fun agentsUpdatedAt(): Long = preferences.getLong(KEY_AGENTS_UPDATED_AT, 0L)

    fun saveDoctor(status: DoctorStatus) {
        preferences.edit()
            .putBoolean(KEY_DOCTOR_OK, status.ok)
            .putString(KEY_DOCTOR_SUMMARY, status.summary)
            .putLong(KEY_DOCTOR_UPDATED_AT, System.currentTimeMillis())
            .apply()
    }

    fun loadDoctor(): DoctorStatus? = preferences.getString(KEY_DOCTOR_SUMMARY, null)?.let {
        DoctorStatus(preferences.getBoolean(KEY_DOCTOR_OK, false), it)
    }

    fun doctorUpdatedAt(): Long = preferences.getLong(KEY_DOCTOR_UPDATED_AT, 0L)

    fun savePebbleSession(session: PebbleSession) {
        preferences.edit()
            .putString(KEY_PEBBLE_UUID, session.appUuid.toString())
            .putString(KEY_PEBBLE_WATCH, session.watchId)
            .putLong(KEY_PEBBLE_OPENED_AT, System.currentTimeMillis())
            .apply()
    }

    fun loadPebbleSession(): PebbleSession? {
        val uuid = preferences.getString(KEY_PEBBLE_UUID, null) ?: return null
        val watch = preferences.getString(KEY_PEBBLE_WATCH, null) ?: return null
        return runCatching { PebbleSession(java.util.UUID.fromString(uuid), watch) }.getOrNull()
    }

    fun clearPebbleSession(session: PebbleSession) {
        if (loadPebbleSession() == session) {
            preferences.edit().remove(KEY_PEBBLE_UUID).remove(KEY_PEBBLE_WATCH).apply()
        }
    }

    fun pebbleOpenedAt(): Long = preferences.getLong(KEY_PEBBLE_OPENED_AT, 0L)

    fun saveBridgeError(message: String) {
        preferences.edit().putString(KEY_BRIDGE_ERROR, message).apply()
    }

    fun loadBridgeError(): String = preferences.getString(KEY_BRIDGE_ERROR, "").orEmpty()

    @Synchronized
    fun claimRequestId(requestId: String): Boolean {
        val existing = preferences.getStringSet(KEY_REQUEST_IDS, emptySet()).orEmpty()
        if (requestId in existing) return false
        val updated = (existing.toList().takeLast(MAX_REQUEST_IDS - 1) + requestId).toSet()
        return preferences.edit().putStringSet(KEY_REQUEST_IDS, updated).commit()
    }

    @Synchronized
    fun releaseRequestId(requestId: String) {
        val existing = preferences.getStringSet(KEY_REQUEST_IDS, emptySet()).orEmpty()
        preferences.edit().putStringSet(KEY_REQUEST_IDS, existing - requestId).commit()
    }

    fun saveResult(result: StoredResult) {
        val json = JSONObject()
            .put("requestId", result.requestId)
            .put("kind", result.kind)
            .put("mode", result.mode?.name)
            .put("stdout", result.stdout)
            .put("stderr", result.stderr)
            .put("exitCode", result.exitCode)
            .put("errorCode", result.errorCode)
            .put("errorMessage", result.errorMessage)
        preferences.edit().putString(KEY_RESULT, json.toString()).apply()
    }

    fun loadResult(): StoredResult? = preferences.getString(KEY_RESULT, null)?.let { raw ->
        runCatching {
            val json = JSONObject(raw)
            StoredResult(
                requestId = json.getString("requestId"),
                kind = json.getString("kind"),
                mode = json.optString("mode").takeIf { it.isNotEmpty() }?.let(ExecutionMode::valueOf),
                stdout = json.optString("stdout"),
                stderr = json.optString("stderr"),
                exitCode = json.optInt("exitCode", -1),
                errorCode = json.optInt("errorCode", 0),
                errorMessage = json.optString("errorMessage"),
            )
        }.getOrNull()
    }

    fun startStream(requestId: String) = saveStream(StoredStream(requestId, "", true))

    fun saveStream(stream: StoredStream) {
        val json = JSONObject()
            .put("requestId", stream.requestId)
            .put("rawOutput", stream.rawOutput)
            .put("running", stream.running)
            .put("errorMessage", stream.errorMessage)
        preferences.edit().putString(KEY_STREAM, json.toString()).commit()
    }

    fun loadStream(): StoredStream? = preferences.getString(KEY_STREAM, null)?.let { raw ->
        runCatching {
            val json = JSONObject(raw)
            StoredStream(
                requestId = json.getString("requestId"),
                rawOutput = json.optString("rawOutput"),
                running = json.optBoolean("running"),
                errorMessage = json.optString("errorMessage"),
            )
        }.getOrNull()
    }

    companion object {
        private const val PREFERENCES = "agents_companion"
        private const val KEY_AGENTS = "agents"
        private const val KEY_RESULT = "latest_result"
        private const val KEY_STREAM = "latest_stream"
        private const val KEY_AGENTS_UPDATED_AT = "agents_updated_at"
        private const val KEY_DOCTOR_OK = "doctor_ok"
        private const val KEY_DOCTOR_SUMMARY = "doctor_summary"
        private const val KEY_DOCTOR_UPDATED_AT = "doctor_updated_at"
        private const val KEY_PEBBLE_UUID = "pebble_uuid"
        private const val KEY_PEBBLE_WATCH = "pebble_watch"
        private const val KEY_PEBBLE_OPENED_AT = "pebble_opened_at"
        private const val KEY_BRIDGE_ERROR = "bridge_error"
        private const val KEY_REQUEST_IDS = "request_ids"
        private const val MAX_REQUEST_IDS = 32
    }
}
