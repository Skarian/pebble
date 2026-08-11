package com.skarian.agentscompanion

import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RouterProtocolTest {
    @Test
    fun `login command shell-quotes every argument`() {
        val command = TermuxLoginCommand.build(
            "printf '%s\\n' \"\$@\"",
            arrayOf("agents-companion", "plain", "quote's value", "\$(unsafe)"),
        )

        assertTrue(command.startsWith("exec '/data/data/com.termux/files/usr/bin/bash' -c "))
        assertTrue(command.contains("'quote'\"'\"'s value'"))
        assertTrue(command.contains("'\$(unsafe)'"))
    }

    @Test
    fun `Termux callbacks retain distinct durable identities`() {
        assertTrue(TermuxCommandRunner.callbackIdentity("send", "old-request") !=
            TermuxCommandRunner.callbackIdentity("send", "new-request"))
        assertTrue(TermuxCommandRunner.callbackIdentity("agents", "same-request") !=
            TermuxCommandRunner.callbackIdentity("send", "same-request"))
        assertTrue(TermuxCommandRunner.callbackIdentity("agents", "same-request", "watch-a") !=
            TermuxCommandRunner.callbackIdentity("agents", "same-request", "watch-b"))
    }

    @Test
    fun `agents preserve configured order`() {
        val agents = RouterProtocol.parseAgents(
            """[{"id":"home","label":"Home"},{"id":"pebble","label":"Pebble"}]""",
        )

        assertEquals(listOf("home", "pebble"), agents.map { it.id })
        assertEquals(listOf("Home", "Pebble"), agents.map { it.label })
    }

    @Test
    fun `final json parses one completed event`() {
        val events = RouterProtocol.parseResult(
            """{"type":"completed","text":"Done."}""",
            ExecutionMode.FINAL_JSON,
        )

        assertEquals(1, events.size)
        assertEquals("completed", events.single().type)
        assertEquals("Done.", events.single().text)
    }

    @Test
    fun `stream parses semantic json lines`() {
        val events = RouterProtocol.parseResult(
            """
            {"type":"reasoning","text":"Checking."}
            {"type":"commentary","text":"Still working."}
            {"type":"completed","text":"Done."}
            """.trimIndent(),
            ExecutionMode.STREAM,
        )

        assertEquals(listOf("reasoning", "commentary", "completed"), events.map { it.type })
    }

    @Test
    fun `failed event preserves code and ambiguity`() {
        val event = RouterProtocol.parseResult(
            """{"type":"failed","code":"app_server_disconnected","text":"Uncertain.","ambiguous":true}""",
            ExecutionMode.FINAL_JSON,
        ).single()

        assertEquals("app_server_disconnected", event.code)
        assertTrue(event.ambiguous)
        assertFalse(event.text.isBlank())
    }

    @Test
    fun `watch send defaults to streaming`() {
        val request = PebbleProtocol.parseWatchRequest(
            mapOf(
                PebbleProtocol.KEY_KIND to PebbleDictionaryItem.UInt32(WatchCommand.SEND.wireValue.toUInt()),
                PebbleProtocol.KEY_PROTOCOL to PebbleDictionaryItem.UInt32(PebbleProtocol.VERSION.toUInt()),
                PebbleProtocol.KEY_REQUEST_ID to PebbleDictionaryItem.Text("request-1"),
                PebbleProtocol.KEY_AGENT_ID to PebbleDictionaryItem.Text("home"),
                PebbleProtocol.KEY_TEXT to PebbleDictionaryItem.Text("Turn off the light."),
            ),
        )

        assertEquals(WatchCommand.SEND, request.command)
        assertEquals("home", request.agentId)
        assertEquals(ExecutionMode.STREAM, request.mode)
    }

    @Test
    fun `watch history request carries only agent and request identity`() {
        val request = PebbleProtocol.parseWatchRequest(mapOf(
            PebbleProtocol.KEY_KIND to PebbleDictionaryItem.UInt32(WatchCommand.HISTORY.wireValue.toUInt()),
            PebbleProtocol.KEY_PROTOCOL to PebbleDictionaryItem.UInt32(PebbleProtocol.VERSION.toUInt()),
            PebbleProtocol.KEY_REQUEST_ID to PebbleDictionaryItem.Text("history-1"),
            PebbleProtocol.KEY_AGENT_ID to PebbleDictionaryItem.Text("home"),
        ))
        assertEquals(WatchCommand.HISTORY, request.command)
        assertEquals("home", request.agentId)
    }

    @Test
    fun `history is deduplicated and bounded per agent`() {
        val messages = (1..22).fold(emptyList<CachedMessage>()) { current, sequence ->
            mergeHistory(current, CachedMessage("r/$sequence", "home", "r", sequence, false, "message $sequence", sequence.toLong()))
        }
        val corrected = mergeHistory(messages, CachedMessage("r/22", "home", "r", 23, false, "corrected", 99))
        assertEquals(20, corrected.size)
        assertEquals("message 3", corrected.first().text)
        assertEquals("corrected", corrected.last().text)
    }

    @Test
    fun `watch history projection respects item and aggregate byte limits`() {
        val messages = (1..20).map { CachedMessage("r-$it", "home", "r-$it", it, false, "x".repeat(2000), it.toLong()) }
        val projected = projectHistoryForWatch(messages)
        assertTrue(projected.size <= PebbleProtocol.MAX_HISTORY_ITEMS)
        assertTrue(projected.sumOf { it.text.toByteArray().size + 1 } <= PebbleProtocol.MAX_HISTORY_BYTES)
        assertEquals("r-20", projected.last().requestId)
    }

    @Test
    fun `agent response uses stable paired keys`() {
        val message = PebbleProtocol.agents(
            listOf(AgentSummary("home", "Home"), AgentSummary("pebble", "Pebble")),
        )

        assertEquals(PhoneEvent.AGENTS.wireValue, message.getValue(PebbleProtocol.KEY_KIND).value)
        assertEquals(2.toUByte(), message.getValue(PebbleProtocol.KEY_AGENT_COUNT).value)
        assertEquals("home", message.getValue(PebbleProtocol.KEY_AGENT_BASE).value)
        assertEquals("Home", message.getValue(PebbleProtocol.KEY_AGENT_BASE + 1u).value)
    }

    @Test
    fun `response text chunks on utf8 boundaries`() {
        val text = "abc🙂def🙂ghi"
        val chunks = PebbleProtocol.chunkText(text, maxBytes = 7)

        assertEquals(text, chunks.joinToString(""))
        assertTrue(chunks.all { it.toByteArray(Charsets.UTF_8).size <= 7 })
    }

    @Test
    fun `watch projection is bounded and visibly marked`() {
        val projected = PebbleProtocol.projectText("🙂".repeat(2000))
        assertTrue(projected.truncated)
        assertTrue(projected.text.endsWith("[TRUNCATED ON WATCH]"))
        assertTrue(projected.text.toByteArray(Charsets.UTF_8).size <= PebbleProtocol.MAX_WATCH_TEXT_BYTES)
        assertTrue(PebbleProtocol.chunkText(projected.text).size <= PebbleProtocol.MAX_CHUNKS)
    }

    @Test
    fun `terminal state cannot regress to running`() {
        val session = PebbleSession(java.util.UUID.randomUUID(), "watch")
        val terminal = StoredTurn("r", "home", "hash", TurnState.TERMINAL, session,
            eventType = "completed", text = "Done", sequence = 4)
        val attempted = terminal.copy(state = TurnState.RUNNING, eventType = "commentary", text = "Late", sequence = 3)
        assertEquals(terminal, normalizeTurnUpdate(terminal, attempted, 99))
    }

    @Test
    fun `duplicate request id must match agent and transcript identity`() {
        val session = PebbleSession(java.util.UUID.randomUUID(), "watch")
        val stored = StoredTurn("same-id", "home", "hash-a", TurnState.RUNNING, session)
        assertEquals(
            TurnClaim.DUPLICATE,
            classifyTurnClaim(stored, stored.copy(session = session.copy(watchId = "rebound")), stored.updatedAt),
        )
        assertEquals(
            TurnClaim.CONFLICT,
            classifyTurnClaim(stored, stored.copy(agentId = "other"), stored.updatedAt),
        )
        assertEquals(
            TurnClaim.CONFLICT,
            classifyTurnClaim(stored, stored.copy(transcriptHash = "hash-b"), stored.updatedAt),
        )
    }

    @Test
    fun `heartbeat touch advances the running turn timestamp`() {
        val session = PebbleSession(java.util.UUID.randomUUID(), "watch")
        val running = StoredTurn("r", "home", "hash", TurnState.RUNNING, session, updatedAt = 10)
        val normalized = normalizeTurnUpdate(running, running.copy(updatedAt = 11), 500)
        assertEquals(500, normalized.updatedAt)
    }

    @Test
    fun `authoritative correction advances beyond provisional unknown`() {
        val session = PebbleSession(java.util.UUID.randomUUID(), "watch")
        val unknown = StoredTurn("r", "home", "hash", TurnState.TERMINAL, session,
            eventType = "failed", text = "Unknown", ambiguous = true, sequence = 2)
        val completed = unknown.copy(eventType = "completed", text = "Done", ambiguous = false, sequence = 2)
        val normalized = normalizeTurnUpdate(unknown, completed, 100)
        assertEquals(3, normalized.sequence)
        assertEquals("completed", normalized.eventType)
    }

    @Test
    fun `agent refresh result categories do not expose router payloads`() {
        fun stored(stdout: String, exitCode: Int = 0) = StoredResult(
            "refresh-3", TermuxCommandRunner.KIND_AGENTS, null, stdout,
            "private stderr", exitCode, 0, "private error",
        )
        val valid = parseAgentRefresh(stored("""[{"id":"home","label":"Home"}]"""))
        val invalid = parseAgentRefresh(stored("secret@example.com is not JSON"))
        val failed = parseAgentRefresh(stored("private stdout", exitCode = 7))
        assertEquals(listOf("ok", "invalid_agents", "refresh_failed"),
            listOf(valid.category, invalid.category, failed.category))
        assertEquals("invalid_agents", invalid.category)
        assertEquals(null, invalid.agents)
        assertFalse(invalid.toString().contains("secret@example.com"))
        assertTrue(invalid.category.matches(Regex("[a-z_]+")))
    }

    @Test
    fun `agent refresh reports the original parser and Termux failures`() {
        val reported = mutableListOf<Any>()
        val invalid = StoredResult(
            "refresh-4", TermuxCommandRunner.KIND_AGENTS, null, "not json",
            "", 0, 0, "",
        )
        val failed = invalid.copy(stdout = "", stderr = "socket failed", exitCode = 17, errorCode = 4)

        parseAgentRefresh(invalid, reported::add)
        parseAgentRefresh(failed, reported::add)

        assertTrue(reported[0] is org.json.JSONException)
        val execution = reported[1] as Map<*, *>
        assertEquals(17, execution["exitCode"])
        assertEquals(4, execution["errorCode"])
        assertEquals(TermuxCommandRunner.KIND_AGENTS, execution["kind"])
        assertEquals("", execution["standardOutput"])
        assertEquals("socket failed", execution["standardError"])
    }

    @Test(expected = IllegalArgumentException::class)
    fun `incompatible agent snapshot is rejected instead of truncated`() {
        PebbleProtocol.agents((1..17).map { AgentSummary("agent-$it", "Agent $it") })
    }
}
