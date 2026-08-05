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
    fun `authoritative correction advances beyond provisional unknown`() {
        val session = PebbleSession(java.util.UUID.randomUUID(), "watch")
        val unknown = StoredTurn("r", "home", "hash", TurnState.TERMINAL, session,
            eventType = "failed", text = "Unknown", ambiguous = true, sequence = 2)
        val completed = unknown.copy(eventType = "completed", text = "Done", ambiguous = false, sequence = 2)
        val normalized = normalizeTurnUpdate(unknown, completed, 100)
        assertEquals(3, normalized.sequence)
        assertEquals("completed", normalized.eventType)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `incompatible agent snapshot is rejected instead of truncated`() {
        PebbleProtocol.agents((1..17).map { AgentSummary("agent-$it", "Agent $it") })
    }
}
