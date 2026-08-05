package com.skarian.agentscompanion

import org.json.JSONArray
import org.json.JSONObject

data class AgentSummary(val id: String, val label: String)

enum class ExecutionMode {
    FINAL_JSON,
    STREAM,
}

data class RouterEvent(
    val type: String,
    val text: String,
    val code: String? = null,
    val ambiguous: Boolean = false,
)

data class RouterDoctor(val ok: Boolean, val checks: List<DoctorStatus>)

object RouterProtocol {
    fun parseAgents(raw: String): List<AgentSummary> {
        val array = JSONArray(raw)
        return buildList {
            for (index in 0 until array.length()) {
                val item = array.getJSONObject(index)
                val id = item.getString("id")
                val label = item.getString("label")
                require(id.isNotBlank()) { "Agent id is empty at index $index." }
                require(label.isNotBlank()) { "Agent label is empty at index $index." }
                add(AgentSummary(id, label))
            }
        }
    }

    fun parseResult(raw: String, mode: ExecutionMode): List<RouterEvent> = when (mode) {
        ExecutionMode.FINAL_JSON -> listOf(parseEvent(JSONObject(raw.trim())))
        ExecutionMode.STREAM -> raw.lineSequence()
            .filter { it.isNotBlank() }
            .map { parseEvent(JSONObject(it)) }
            .toList()
    }

    fun agentsToJson(agents: List<AgentSummary>): String = JSONArray().apply {
        agents.forEach { agent ->
            put(JSONObject().put("id", agent.id).put("label", agent.label))
        }
    }.toString()

    fun parseDoctor(raw: String): RouterDoctor {
        val json = JSONObject(raw.trim())
        val checksJson = json.getJSONArray("checks")
        val checks = buildList {
            for (index in 0 until checksJson.length()) {
                val check = checksJson.getJSONObject(index)
                add(
                    DoctorStatus(
                        ok = check.getBoolean("ok"),
                        summary = "${check.getString("name")}: ${check.getString("text")}",
                    ),
                )
            }
        }
        return RouterDoctor(json.getBoolean("ok"), checks)
    }

    private fun parseEvent(json: JSONObject): RouterEvent {
        val type = json.getString("type")
        require(type in setOf("reasoning", "commentary", "completed", "failed")) {
            "Unknown router event type: $type"
        }
        return RouterEvent(
            type = type,
            text = json.optString("text"),
            code = json.optString("code").takeIf { it.isNotEmpty() },
            ambiguous = json.optBoolean("ambiguous", false),
        )
    }
}
