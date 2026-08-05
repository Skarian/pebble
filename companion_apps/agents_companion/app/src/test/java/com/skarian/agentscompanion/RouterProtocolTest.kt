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
}
