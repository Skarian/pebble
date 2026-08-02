package com.skarian.airquality

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AranetHistoryProtocolTest {
    @Test
    fun encodesV2RequestAndParsesTemperaturePacket() {
        assertArrayEquals(
            byteArrayOf(0x61, 0x01, 0xDE.toByte(), 0x01),
            AranetHistoryProtocol.request(AranetHistoryProtocol.PARAM_TEMPERATURE, 478),
        )
        val packet = packet(parameter = 1, interval = 300, total = 500, age = 42, start = 498,
            rawValues = intArrayOf(440, 442, 444))
        val parsed = AranetHistoryProtocol.parse(packet)!!
        assertEquals(300, parsed.intervalSeconds)
        assertEquals(500, parsed.totalReadings)
        assertEquals(498, parsed.startIndex)
        assertEquals(listOf(440, 442, 444), parsed.values)
        assertEquals(220, AranetHistoryProtocol.decode(1, parsed.values[0]))
    }

    @Test
    fun decodesCanonicalUnitsAndRejectsMagicValues() {
        assertEquals(612, AranetHistoryProtocol.decode(4, 612))
        assertEquals(460, AranetHistoryProtocol.decode(2, 46))
        assertEquals(10086, AranetHistoryProtocol.decode(3, 10086))
        assertNull(AranetHistoryProtocol.decode(4, 0x8001))
        assertNull(AranetHistoryProtocol.decode(1, 0x4001))
    }

    @Test
    fun parsesSingleByteHumidityPayload() {
        val packet = ByteArray(13)
        packet[0] = 2
        putU16(packet, 1, 300)
        putU16(packet, 3, 100)
        putU16(packet, 5, 10)
        putU16(packet, 7, 98)
        packet[9] = 3
        packet[10] = 45
        packet[11] = 46
        packet[12] = 47
        assertEquals(listOf(45, 46, 47), AranetHistoryProtocol.parse(packet)?.values)
    }

    private fun packet(
        parameter: Int,
        interval: Int,
        total: Int,
        age: Int,
        start: Int,
        rawValues: IntArray,
    ): ByteArray = ByteArray(10 + rawValues.size * 2).also { bytes ->
        bytes[0] = parameter.toByte()
        putU16(bytes, 1, interval)
        putU16(bytes, 3, total)
        putU16(bytes, 5, age)
        putU16(bytes, 7, start)
        bytes[9] = rawValues.size.toByte()
        rawValues.forEachIndexed { index, value -> putU16(bytes, 10 + index * 2, value) }
    }

    private fun putU16(bytes: ByteArray, offset: Int, value: Int) {
        bytes[offset] = (value and 0xff).toByte()
        bytes[offset + 1] = (value ushr 8).toByte()
    }
}
