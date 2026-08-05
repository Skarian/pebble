package com.skarian.agentscompanion

import android.content.Context
import org.json.JSONObject

data class StoredResult(val requestId: String, val kind: String, val mode: ExecutionMode?, val stdout: String,
                        val stderr: String, val exitCode: Int, val errorCode: Int, val errorMessage: String)
enum class TurnState { QUEUED, RUNNING, TERMINAL }
data class StoredTurn(
    val requestId: String, val agentId: String, val transcriptHash: String, val state: TurnState,
    val session: PebbleSession, val eventType: String = "accepted", val text: String = "",
    val code: String = "", val ambiguous: Boolean = false, val sequence: Int = 0,
    val updatedAt: Long = System.currentTimeMillis(),
)
enum class TurnClaim { CLAIMED, DUPLICATE, BUSY }
data class DoctorStatus(val ok: Boolean, val summary: String)

internal fun normalizeTurnUpdate(current: StoredTurn, transformed: StoredTurn, now: Long): StoredTurn {
    val semanticChange = transformed.state != current.state || transformed.eventType != current.eventType ||
        transformed.text != current.text || transformed.code != current.code || transformed.ambiguous != current.ambiguous
    val sequenced = if (semanticChange && transformed.sequence <= current.sequence) {
        transformed.copy(sequence = (current.sequence + 1).coerceAtMost(65535))
    } else transformed
    return when {
        sequenced.sequence < current.sequence -> current
        current.state == TurnState.TERMINAL && sequenced.state != TurnState.TERMINAL -> current
        else -> sequenced.copy(updatedAt = now)
    }
}

class CompanionState(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    fun saveAgents(agents: List<AgentSummary>) { preferences.edit().putString(KEY_AGENTS, RouterProtocol.agentsToJson(agents)).putLong(KEY_AGENTS_UPDATED_AT, System.currentTimeMillis()).apply() }
    fun loadAgents() = preferences.getString(KEY_AGENTS, null)?.let { runCatching { RouterProtocol.parseAgents(it) }.getOrDefault(emptyList()) } ?: emptyList()
    fun agentsUpdatedAt() = preferences.getLong(KEY_AGENTS_UPDATED_AT, 0L)
    fun saveDoctor(status: DoctorStatus) { preferences.edit().putBoolean(KEY_DOCTOR_OK, status.ok).putString(KEY_DOCTOR_SUMMARY, status.summary).putLong(KEY_DOCTOR_UPDATED_AT, System.currentTimeMillis()).apply() }
    fun loadDoctor() = preferences.getString(KEY_DOCTOR_SUMMARY, null)?.let { DoctorStatus(preferences.getBoolean(KEY_DOCTOR_OK, false), it) }
    fun doctorUpdatedAt() = preferences.getLong(KEY_DOCTOR_UPDATED_AT, 0L)
    fun savePebbleSession(session: PebbleSession) { preferences.edit().putString(KEY_PEBBLE_UUID, session.appUuid.toString()).putString(KEY_PEBBLE_WATCH, session.watchId).putLong(KEY_PEBBLE_OPENED_AT, System.currentTimeMillis()).apply() }
    fun loadPebbleSession(): PebbleSession? { val u = preferences.getString(KEY_PEBBLE_UUID, null) ?: return null; val w = preferences.getString(KEY_PEBBLE_WATCH, null) ?: return null; return runCatching { PebbleSession(java.util.UUID.fromString(u), w) }.getOrNull() }
    fun clearPebbleSession(session: PebbleSession) { if (loadPebbleSession() == session) preferences.edit().remove(KEY_PEBBLE_UUID).remove(KEY_PEBBLE_WATCH).apply() }
    fun pebbleOpenedAt() = preferences.getLong(KEY_PEBBLE_OPENED_AT, 0L)
    fun saveBridgeError(message: String) { preferences.edit().putString(KEY_BRIDGE_ERROR, message).apply() }
    fun loadBridgeError() = preferences.getString(KEY_BRIDGE_ERROR, "").orEmpty()

    fun claimTurn(turn: StoredTurn): TurnClaim = synchronized(TURN_LOCK) {
        val existing = loadTurn()
        if (existing?.requestId == turn.requestId) return@synchronized TurnClaim.DUPLICATE
        val now = System.currentTimeMillis()
        val stale = existing != null && when (existing.state) {
            TurnState.QUEUED -> now - existing.updatedAt > QUEUE_LEASE_TIMEOUT_MS
            TurnState.RUNNING -> now - existing.updatedAt > RUNNING_LEASE_TIMEOUT_MS
            TurnState.TERMINAL -> true
        }
        if (existing != null && existing.state != TurnState.TERMINAL && !stale) return@synchronized TurnClaim.BUSY
        if (saveTurn(turn)) TurnClaim.CLAIMED else TurnClaim.BUSY
    }
    private fun saveTurn(turn: StoredTurn): Boolean = preferences.edit().putString(KEY_TURN, turnJson(turn).toString()).commit()
    fun loadTurn(): StoredTurn? = preferences.getString(KEY_TURN, null)?.let { raw -> runCatching { parseTurn(JSONObject(raw)) }.getOrNull() }
    fun updateTurn(requestId: String, touch: Boolean = true, transform: (StoredTurn) -> StoredTurn): StoredTurn? = synchronized(TURN_LOCK) {
        val current = loadTurn()?.takeIf { it.requestId == requestId } ?: return@synchronized null
        val transformed = transform(current)
        val next = normalizeTurnUpdate(current, transformed, if (touch) System.currentTimeMillis() else current.updatedAt)
        if (next == current || saveTurn(next)) next else null
    }

    fun saveResult(result: StoredResult) { val json = JSONObject().put("requestId", result.requestId).put("kind", result.kind).put("mode", result.mode?.name).put("stdout", result.stdout.take(300000)).put("stderr", result.stderr.take(8192)).put("exitCode", result.exitCode).put("errorCode", result.errorCode).put("errorMessage", result.errorMessage.take(2048)); preferences.edit().putString("result_${result.kind}", json.toString()).apply() }
    fun loadResult(kind: String = TermuxCommandRunner.KIND_SEND): StoredResult? = preferences.getString("result_$kind", null)?.let { raw -> runCatching { val j=JSONObject(raw); StoredResult(j.getString("requestId"),j.getString("kind"),j.optString("mode").takeIf(String::isNotEmpty)?.let(ExecutionMode::valueOf),j.optString("stdout"),j.optString("stderr"),j.optInt("exitCode",-1),j.optInt("errorCode"),j.optString("errorMessage")) }.getOrNull() }

    private fun turnJson(t: StoredTurn) = JSONObject().put("requestId",t.requestId).put("agentId",t.agentId).put("transcriptHash",t.transcriptHash).put("state",t.state.name).put("uuid",t.session.appUuid.toString()).put("watch",t.session.watchId).put("eventType",t.eventType).put("text",t.text).put("code",t.code).put("ambiguous",t.ambiguous).put("sequence",t.sequence).put("updatedAt",t.updatedAt)
    private fun parseTurn(j: JSONObject) = StoredTurn(j.getString("requestId"),j.getString("agentId"),j.getString("transcriptHash"),TurnState.valueOf(j.getString("state")),PebbleSession(java.util.UUID.fromString(j.getString("uuid")),j.getString("watch")),j.optString("eventType","accepted"),j.optString("text"),j.optString("code"),j.optBoolean("ambiguous"),j.optInt("sequence"),j.optLong("updatedAt"))
    companion object { private val TURN_LOCK = Any(); private const val QUEUE_LEASE_TIMEOUT_MS=15_000L; private const val RUNNING_LEASE_TIMEOUT_MS=45_000L; private const val PREFERENCES="agents_companion"; private const val KEY_AGENTS="agents"; private const val KEY_AGENTS_UPDATED_AT="agents_updated_at"; private const val KEY_DOCTOR_OK="doctor_ok"; private const val KEY_DOCTOR_SUMMARY="doctor_summary"; private const val KEY_DOCTOR_UPDATED_AT="doctor_updated_at"; private const val KEY_PEBBLE_UUID="pebble_uuid"; private const val KEY_PEBBLE_WATCH="pebble_watch"; private const val KEY_PEBBLE_OPENED_AT="pebble_opened_at"; private const val KEY_BRIDGE_ERROR="bridge_error"; private const val KEY_TURN="active_turn_v2" }
}
